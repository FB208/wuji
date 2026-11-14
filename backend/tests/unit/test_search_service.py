from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.core.errors import AppError
from app.services import search_service as svc


def _item(i):
    return SimpleNamespace(id=i, name=f"n{i}", location_text=f"l{i}", record_text="r", image_url=f"u{i}")


class _FakeBegin:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *args):
        return False


class _FakeDB:
    def begin(self):
        return _FakeBegin()


DB = _FakeDB()


@pytest.fixture
def env():
    items = [_item(i) for i in (1, 3, 8, 11)]
    captured = {}

    async def fake_search(query, ctx, pool):
        captured["ctx"] = ctx
        captured["pool"] = [i["id"] for i in pool]
        return {"status": "not_found", "item_ids": [], "prompt": None}

    async def by_ids(db, family_id, ids):
        return [i for i in items if i.id in ids]

    with (
        patch.object(svc, "require_membership", new=AsyncMock()),
        patch.object(svc.repos, "list_active_items", new=AsyncMock(return_value=items)),
        patch.object(svc.repos, "list_active_items_by_ids", new=AsyncMock(side_effect=by_ids)),
        patch.object(svc.semantic_provider, "search_items", new=AsyncMock(side_effect=fake_search)),
    ):
        yield captured


async def test_turns_condition_retained(env):
    ctx = {"turns": [
        {"query": "数据线在哪", "status": "multiple", "item_ids": [3, 8]},
        {"query": "白色的", "status": "multiple", "item_ids": [8]},
    ]}
    await svc._search(DB, 1, 10, "短一点的", ctx)
    sent = env["ctx"]["turns"]
    assert [t["query"] for t in sent] == ["数据线在哪", "白色的"]
    assert env["ctx"]["initial_query"] == "数据线在哪"


async def test_more_phrase_excludes_shown(env):
    ctx = {"turns": [{"query": "数据线", "status": "multiple", "item_ids": [3, 8]}],
           "shown_item_ids": [3, 8]}
    await svc._search(DB, 1, 10, "还有吗", ctx)
    assert set(env["pool"]) == {1, 11}
    assert set(env["ctx"]["excluded_item_ids"]) == {3, 8}


async def test_negate_single_found(env):
    ctx = {"last_status": "found", "last_item_ids": [3]}
    await svc._search(DB, 1, 10, "不是这个", ctx)
    assert 3 in env["ctx"]["excluded_item_ids"]
    assert set(env["pool"]) == {1, 8, 11}


async def test_negate_after_multiple_only_rechecks(env):
    ctx = {"last_status": "multiple", "last_item_ids": [3, 8]}
    out = await svc._search(DB, 1, 10, "不对", ctx)
    assert "pool" not in env and "ctx" not in env
    assert out["context"]["excluded_item_ids"] == []
    assert out["status"] == "multiple"
    assert out["prompt"] == "请指出要排除的物品，或补充颜色、用途、型号。"
    assert sorted(i["id"] for i in out["items"]) == [3, 8]


async def test_foreign_and_deleted_ids_filtered(env):
    ctx = {"turns": [{"query": "q", "status": "found", "item_ids": [3, 999]}],
           "excluded_item_ids": [999]}
    out = await svc._search(DB, 1, 10, "q", ctx)
    assert 999 not in out["context"]["excluded_item_ids"]
    assert all(t["item_ids"] != [999] for t in out["context"]["turns"])


async def test_family_mismatch(env):
    with pytest.raises(AppError) as ei:
        await svc._search(DB, 1, 10, "q", {"family_id": 999})
    assert ei.value.code == "SEARCH_CONTEXT_MISMATCH"
    assert ei.value.status_code == 409


@pytest.mark.parametrize("raw", [
    "not-a-dict",
    {"turns": "abc"},
    {"turns": [{"query": "q", "item_ids": [True]}]},
    {"turns": [{"query": "q", "item_ids": ["abc"]}]},
    {"turns": [{"query": "x" * 513}]},
    {"excluded_item_ids": [-3]},
    {"turns": [{"query": "q", "status": "weird"}]},
    {"unknown_field": 1},
])
async def test_invalid_context(raw, env):
    with pytest.raises(AppError) as ei:
        await svc._search(DB, 1, 10, "q", raw)
    assert ei.value.code == "VALIDATION_ERROR"
    assert ei.value.status_code in (400, 422)


async def test_context_output_shape(env):
    turns = [{"query": f"q{i}", "status": "not_found", "item_ids": []} for i in range(6)]
    out = await svc._search(DB, 1, 10, "第7轮", {"turns": turns, "initial_query": "最初查询"})
    ctx = out["context"]
    assert ctx["initial_query"] == "最初查询"
    assert len(ctx["turns"]) == 6
    assert ctx["turns"][-1]["query"] == "第7轮"
    assert ctx["turns"][0]["query"] == "q1"
    assert ctx["family_id"] == 10
    assert ctx["last_status"] == "not_found"


async def test_found_status_normalized(env):
    async def found(query, ctx, pool):
        return {"status": "found", "item_ids": [3], "prompt": "模型胡话"}

    with patch.object(svc.semantic_provider, "search_items", new=AsyncMock(side_effect=found)):
        out = await svc._search(DB, 1, 10, "q", None)
    assert out["status"] == "found"
    assert out["prompt"] is None
    assert out["items"][0]["id"] == 3
    assert out["context"]["last_item_ids"] == [3]


def test_phrase_normalization():
    assert svc._phrase(" 还 有吗？！ ") == "还有吗"
    assert svc._phrase("还有别的吗。") == "还有别的吗"
    assert svc._phrase("s u3000") == "su3000"
    assert svc._phrase("不 是 这 个！") == "不是这个"
    assert svc._phrase("物品v2.0数据线") == "物品v20数据线"


async def test_initial_query_defaults_to_first_query(env):
    out = await svc._search(DB, 1, 10, "第一次找", None)
    assert out["context"]["initial_query"] == "第一次找"


async def test_excluded_order_preserved(env):
    ctx = {"excluded_item_ids": [11, 1, 3]}
    out = await svc._search(DB, 1, 10, "q", ctx)
    assert out["context"]["excluded_item_ids"] == [11, 1, 3]
