import asyncio
import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.errors import AppError
from app.providers import semantic as sem
from app.providers.semantic_contracts import RECORD_SYSTEM_PROMPT, SEARCH_SYSTEM_PROMPT


def _resp(content: str, status: int = 200) -> httpx.Response:
    body = {"choices": [{"message": {"content": content}}]}
    return httpx.Response(status, json=body)


_REQUESTS: list[httpx.Request] = []


def _capture(request: httpx.Request, content: str, status: int = 200):
    _REQUESTS.append(request)
    return _resp(content, status)


_REAL_CLIENT = httpx.AsyncClient


def _client(transport: httpx.MockTransport):
    def factory(**kwargs):
        kwargs["transport"] = transport
        return _REAL_CLIENT(**kwargs)
    return factory


async def _chat_with(content: str, status: int = 200):
    transport = httpx.MockTransport(lambda request: _capture(request, content, status))
    _REQUESTS.clear()
    with patch.object(sem.httpx, "AsyncClient", _client(transport)):
        out = await sem.semantic_provider._chat("sys", {"x": 1})
    body = json.loads(_REQUESTS[0].content)
    assert body["stream"] is False
    assert body["max_tokens"] == 1024
    return out


async def test_pure_and_fenced_json():
    assert await _chat_with('{"a": 1}') == {"a": 1}
    assert await _chat_with('```json\n{"a": 1}\n```') == {"a": 1}


@pytest.mark.parametrize("bad", [
    '说明 {"a": 1}',
    '{"a": 1} 尾部',
    '{"a": 1}{"b": 2}',
    '{"a": 1, "a": 2}',
    '{"a": NaN}',
    '{"a": Infinity}',
    '[1, 2]',
    '"text"',
    '',
])
async def test_invalid_json_rejected(bad):
    with pytest.raises((ValueError, json.JSONDecodeError)):
        await _chat_with(bad)


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_upstream_retryable(status):
    transport = httpx.MockTransport(lambda request: _resp("{}", status))
    with patch.object(sem.httpx, "AsyncClient", _client(transport)):
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider._chat("sys", {"x": 1})
    assert ei.value.retryable is True
    assert ei.value.status_code in (502, 503)


async def test_response_over_limit_rejected():
    transport = httpx.MockTransport(lambda request: _resp('{"a": "' + "x" * 70000 + '"}'))
    with patch.object(sem.httpx, "AsyncClient", _client(transport)):
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", [])
    assert ei.value.code == "RECORD_PARSE_FAILED"
    assert ei.value.retryable is False


def _item(i):
    return {"id": i, "name": f"物品{i}", "location_text": f"位置{i}", "record_text": "x" * 10}


async def test_record_create_move():
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(
        return_value={"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": []}
    )):
        assert (await sem.semantic_provider.judge_record("t", [_item(1)]))["operation"] == "create"
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(
        return_value={"operation": "move", "target_item_id": 2, "name": "", "location_text": "l", "candidate_item_ids": [2]}
    )):
        assert (await sem.semantic_provider.judge_record("t", [_item(2)]))["operation"] == "move"
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(
        return_value={"operation": "move", "target_item_id": 999, "name": "n", "location_text": "l", "candidate_item_ids": [999]}
    )):
        out = await sem.semantic_provider.judge_record("t", [_item(2)])
        assert out["operation"] == "create"
        assert out["target_item_id"] is None
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(
        return_value={"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": []}
    )):
        out2 = await sem.semantic_provider.judge_record("t", [_item(1), _item(2)])
        assert out2["operation"] == "create"
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(
        return_value={"operation": "clarify", "target_item_id": None, "name": "", "location_text": "l", "candidate_item_ids": [999]}
    )):
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", [_item(1)])
        assert ei.value.code == "RECORD_PARSE_FAILED"


@pytest.mark.parametrize("raw", [
    {"operation": "move", "target_item_id": True, "name": "", "location_text": "l", "candidate_item_ids": [1]},
    {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": ["1"]},
    {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": [], "extra": 1},
    {"operation": "create", "target_item_id": None, "name": 1, "location_text": "l", "candidate_item_ids": []},
    {"operation": "move", "target_item_id": 1, "name": "", "location_text": "l", "candidate_item_ids": [1, 2]},
])
async def test_record_schema_rejected(raw):
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(return_value=raw)):
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", [_item(1), _item(2)])
    assert ei.value.code in ("RECORD_PARSE_FAILED",)


async def test_search_status_matrix():
    for raw, expect in [
        ({"status": "found", "item_ids": [1], "prompt": None}, ("found", [1])),
        ({"status": "multiple", "item_ids": [1, 2], "prompt": "p"}, ("multiple", [1, 2])),
        ({"status": "not_found", "item_ids": [], "prompt": "np"}, ("not_found", [])),
        ({"status": "found", "item_ids": [999], "prompt": None}, ("not_found", [])),
        ({"status": "found", "item_ids": [1, 2], "prompt": None}, "error"),
        ({"status": "multiple", "item_ids": [1], "prompt": None}, "error"),
        ({"status": "found", "item_ids": [], "prompt": None}, "error"),
        ({"status": "bad", "item_ids": [], "prompt": None}, "error"),
    ]:
        with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(return_value=raw)):
            if expect == "error":
                with pytest.raises(AppError) as ei:
                    await sem.semantic_provider.search_items("q", {}, [_item(1), _item(2)])
                assert ei.value.code == "SEARCH_FAILED"
            else:
                out = await sem.semantic_provider.search_items("q", {}, [_item(1), _item(2)])
                assert out["status"] == expect[0] and out["item_ids"] == expect[1]


async def test_batch_covers_all_and_budget_precheck():
    items = [_item(i) for i in range(1, 501)]
    for i in items:
        i["record_text"] = "x" * 1000
    calls = []
    concurrency = {"now": 0, "max": 0}

    async def fake_chat(system_prompt, payload):
        calls.append(payload)
        concurrency["now"] += 1
        concurrency["max"] = max(concurrency["max"], concurrency["now"])
        try:
            batch_items = payload.get("existing_items") or payload.get("items")
            if system_prompt is not RECORD_SYSTEM_PROMPT and system_prompt is not SEARCH_SYSTEM_PROMPT:
                return {"item_ids": [i["id"] for i in batch_items[:5]]}
            if system_prompt is RECORD_SYSTEM_PROMPT:
                return {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": []}
            return {"status": "not_found", "item_ids": [], "prompt": None}
        finally:
            concurrency["now"] -= 1

    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat):
        await sem.semantic_provider.judge_record("t", items)
    candidate_items = [i["id"] for c in calls[:-1] for i in (c.get("existing_items") or c.get("items"))]
    assert sorted(candidate_items) == list(range(1, 501))
    assert all(len(c.get("existing_items") or c.get("items")) <= 80 for c in calls[:-1])
    settings = sem.get_settings()
    for c in calls:
        assert len(json.dumps(c, ensure_ascii=False, separators=(",", ":"))) <= 48000 + 4096
    assert len(calls) <= 11
    assert concurrency["max"] <= 2

    calls.clear()
    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat):
        await sem.semantic_provider.search_items("q", {}, items)
    candidate_items = [i["id"] for c in calls[:-1] for i in (c.get("existing_items") or c.get("items"))]
    assert sorted(candidate_items) == list(range(1, 501))
    assert len(calls) <= 11

    huge = [_item(i) for i in range(1, 2001)]
    for i in huge:
        i["record_text"] = "x" * 2000
    calls.clear()
    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat):
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", huge)
    assert ei.value.code == "SEMANTIC_BUDGET_EXCEEDED"
    assert calls == []


async def test_small_set_single_call():
    items = [_item(i) for i in range(1, 4)]
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(
        return_value={"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": []}
    )) as chat:
        await sem.semantic_provider.judge_record("t", items)
    assert chat.await_count == 1


def _items(n, rec=10):
    return [{"id": i, "name": f"物品{i}", "location_text": f"位置{i}", "record_text": "x" * rec} for i in range(1, n + 1)]


def _settings(**overrides):
    return sem.get_settings().model_copy(update=overrides)


async def test_max_batches_independent():
    big = _items(200)
    fake = _settings(semantic_max_batches=2, semantic_max_calls=100)
    with patch.object(sem, "get_settings", return_value=fake):
        with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock()) as chat:
            with pytest.raises(AppError) as ei:
                await sem.semantic_provider.judge_record("t", big)
    assert ei.value.code == "SEMANTIC_BUDGET_EXCEEDED"
    assert chat.await_count == 0


async def test_max_calls_independent():
    big = _items(200)
    fake = _settings(semantic_max_batches=10, semantic_max_calls=3)
    with patch.object(sem, "get_settings", return_value=fake):
        with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock()) as chat:
            with pytest.raises(AppError) as ei:
                await sem.semantic_provider.judge_record("t", big)
    assert ei.value.code == "SEMANTIC_BUDGET_EXCEEDED"
    assert chat.await_count == 0


async def test_single_item_oversize_zero_calls():
    huge = [{"id": 1, "name": "n" * 60000, "location_text": "l", "record_text": ""}]
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock()) as chat:
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", huge)
    assert ei.value.code == "SEMANTIC_BUDGET_EXCEEDED"
    assert chat.await_count == 0


async def test_candidate_cross_batch_id_filtered():
    items = _items(160)
    final_calls = []

    async def fake_chat(prompt, payload):
        batch = payload.get("existing_items") or payload.get("items")
        if prompt is not sem.RECORD_SYSTEM_PROMPT:
            return {"item_ids": [81] if batch[0]["id"] == 1 else []}
        final_calls.append(payload)
        return {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": []}

    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat):
        await sem.semantic_provider.judge_record("t", items)
    assert final_calls[0]["existing_items"] == []


async def test_move_target_outside_final_input_falls_back():
    items = _items(160)

    async def fake_chat(prompt, payload):
        batch = payload.get("existing_items") or payload.get("items")
        if prompt is not sem.RECORD_SYSTEM_PROMPT:
            return {"item_ids": [batch[0]["id"]]}
        return {"operation": "move", "target_item_id": 160, "name": "", "location_text": "l", "candidate_item_ids": [160]}

    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat):
        out = await sem.semantic_provider.judge_record("t", items)
    assert out["operation"] == "create"


@pytest.mark.parametrize("raw", [
    {"operation": "create", "name": "n", "location_text": "l", "candidate_item_ids": []},
    {"operation": "create", "target_item_id": 1, "name": "n", "location_text": "l", "candidate_item_ids": []},
    {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": [1]},
    {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l"},
    {"operation": "clarify", "target_item_id": None, "name": "", "location_text": "l", "candidate_item_ids": [1]},
    {"status": "found", "item_ids": [1, 2], "prompt": None},
    {"status": "found", "item_ids": [1, 1], "prompt": None},
])
async def test_strict_schema_missing_or_bad(raw):
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(return_value=raw)):
        with pytest.raises(AppError):
            if "operation" in raw:
                await sem.semantic_provider.judge_record("t", [_item(1), _item(2)])
            else:
                await sem.semantic_provider.search_items("q", {}, [_item(1), _item(2)])


async def test_read_timeout_retryable():
    def boom(request):
        raise httpx.ReadTimeout("timeout")

    transport = httpx.MockTransport(boom)
    with patch.object(sem.httpx, "AsyncClient", _client(transport)):
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", [])
    assert ei.value.retryable is True and ei.value.status_code == 503


async def test_total_deadline_retryable():
    started = asyncio.Event()

    async def slow(prompt, payload):
        await asyncio.sleep(5)
        return {"item_ids": []}

    with patch.object(sem.SemanticProvider, "_chat", side_effect=slow):
        with patch.object(sem, "get_settings", return_value=_settings(semantic_total_timeout_seconds=0.05)):
            with pytest.raises(AppError) as ei:
                await sem.semantic_provider.judge_record("t", _items(200))
    assert ei.value.retryable is True and ei.value.status_code == 503


async def test_candidate_failure_cancels_siblings():
    items = _items(200)
    gate = asyncio.Event()
    cancelled = asyncio.Event()
    calls = []

    async def fake_chat(prompt, payload):
        calls.append(payload)
        batch = payload.get("existing_items") or payload.get("items")
        if batch[0]["id"] == 1:
            raise ValueError("bad batch")
        try:
            await gate.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return {"item_ids": [batch[0]["id"]]}

    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat):
        with pytest.raises(Exception):
            await sem.semantic_provider.judge_record("t", items)
    assert cancelled.is_set()
    count = len(calls)
    gate.set()
    await asyncio.sleep(0.05)
    assert len(calls) == count


async def test_exact_char_budget_assertion():
    items = _items(500, rec=1000)
    calls = []
    concurrency = {"now": 0, "max": 0}

    async def fake_chat(prompt, payload):
        calls.append((prompt, payload))
        concurrency["now"] += 1
        concurrency["max"] = max(concurrency["max"], concurrency["now"])
        await asyncio.sleep(0.01)
        concurrency["now"] -= 1
        batch = payload.get("existing_items") or payload.get("items")
        if prompt is not sem.RECORD_SYSTEM_PROMPT and prompt is not sem.SEARCH_SYSTEM_PROMPT:
            return {"item_ids": [i["id"] for i in batch[:5]]}
        if prompt is sem.RECORD_SYSTEM_PROMPT:
            return {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": []}
        return {"status": "not_found", "item_ids": [], "prompt": None}

    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat):
        await sem.semantic_provider.judge_record("t", items)
        await sem.semantic_provider.search_items("q", {}, items)

    for prompt, payload in calls:
        measure = len(prompt) + len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        assert measure <= 48000, measure
    cand_ids = [
        i["id"]
        for prompt, payload in calls
        for i in (payload.get("existing_items") or payload.get("items"))
    ]
    assert sorted(set(cand_ids)) == list(range(1, 501))
    assert concurrency["max"] == 2


async def test_second_item_oversize_zero_calls():
    items = [_item(1), {"id": 2, "name": "n" * 60000, "location_text": "l", "record_text": ""}]
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock()) as chat:
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", items)
    assert ei.value.code == "SEMANTIC_BUDGET_EXCEEDED"
    assert chat.await_count == 0


class _SlowStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'{"choices":[{"message":{"content":"{'
        await asyncio.sleep(0.04)
        yield b'\\"a\\":1}"}}]}'
        await asyncio.sleep(0.04)
        yield b'   '


async def test_slow_stream_exceeds_call_timeout():
    def handler(request):
        return httpx.Response(200, stream=_SlowStream())

    fake = _settings(semantic_call_timeout_seconds=0.05)
    transport = httpx.MockTransport(handler)
    with patch.object(sem.httpx, "AsyncClient", _client(transport)), patch.object(
        sem, "get_settings", return_value=fake
    ):
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", [])
    assert ei.value.retryable is True and ei.value.status_code == 503


async def test_search_missing_prompt_rejected():
    with patch.object(sem.SemanticProvider, "_chat", new=AsyncMock(
        return_value={"status": "multiple", "item_ids": [1, 2]}
    )):
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.search_items("q", {}, [_item(1), _item(2)])
    assert ei.value.code == "SEARCH_FAILED"


async def test_budget_shared_across_judges():
    budget = sem.SemanticBudget(max_calls=1, deadline=asyncio.get_running_loop().time() + 60)
    calls = []

    async def fake_chat(prompt, payload):
        calls.append(payload)
        return {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": []}

    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat):
        await sem.semantic_provider.judge_record("t", [_item(1)], budget=budget)
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", [_item(1)], budget=budget)
    assert ei.value.code == "SEMANTIC_BUDGET_EXCEEDED"
    assert len(calls) == 1
    assert budget.used_calls == 1


async def test_budget_deadline_not_reset():
    budget = sem.SemanticBudget(max_calls=11, deadline=asyncio.get_running_loop().time() + 0.05)
    await asyncio.sleep(0.1)

    async def fake_chat(prompt, payload):
        return {"operation": "create", "target_item_id": None, "name": "n", "location_text": "l", "candidate_item_ids": []}

    with patch.object(sem.SemanticProvider, "_chat", side_effect=fake_chat) as chat:
        with pytest.raises(AppError) as ei:
            await sem.semantic_provider.judge_record("t", [_item(1)], budget=budget)
    assert ei.value.retryable is True
    assert chat.await_count == 0
    assert budget.used_calls == 0
