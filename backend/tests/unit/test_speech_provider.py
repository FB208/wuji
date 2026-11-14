"""语音转写 provider 单元测试：2.0 标准版 submit + query 轮询（全部 mock）。"""
import contextlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.errors import AppError
from app.providers import speech as sp

pytestmark = pytest.mark.unit

_SETTINGS = dict(
    volc_speech_base_url="https://openspeech.bytedance.com",
    volc_speech_api_key="test-api-key",
    volc_speech_resource_id="volc.seedasr.auc",
    volc_speech_poll_interval_seconds=0.001,
    volc_speech_max_wait_seconds=60.0,
)


def _settings(**overrides):
    return SimpleNamespace(**{**_SETTINGS, **overrides})


def _rustfs_mock():
    m = SimpleNamespace()
    m.build_tmp_audio_key = lambda ext: f"speech-tmp/test.{ext}"
    m.upload_object = AsyncMock()
    m.public_url = lambda key: f"https://img.test/{key}"
    m.delete_object = AsyncMock()
    return m


def _handler(submit_code="20000000", query_codes=("20000000",), text="螺丝刀在阳台"):
    """按路径分发 submit/query；query 按序消费状态码序列（末位重复）。返回 (handler, requests)。"""
    calls = {"q": 0}
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("/submit"):
            return httpx.Response(
                200, headers={"X-Api-Status-Code": submit_code, "X-Api-Message": "OK"}
            )
        idx = min(calls["q"], len(query_codes) - 1)
        calls["q"] += 1
        code = query_codes[idx]
        body = {"result": {"text": text}} if code == "20000000" else {}
        return httpx.Response(
            200, json=body, headers={"X-Api-Status-Code": code, "X-Api-Message": "OK"}
        )

    return handler, requests


_REAL_CLIENT = httpx.AsyncClient


def _client(transport):
    def factory(**kwargs):
        kwargs["transport"] = transport
        return _REAL_CLIENT(**kwargs)

    return factory


@contextlib.contextmanager
def _patched(handler, settings=None):
    rustfs = _rustfs_mock()
    with (
        patch.object(sp.httpx, "AsyncClient", _client(httpx.MockTransport(handler))),
        patch.object(sp, "rustfs_provider", rustfs),
        patch.object(sp, "get_settings", return_value=settings or _settings()),
    ):
        yield rustfs


async def test_transcribe_polls_until_success():
    handler, requests = _handler(query_codes=("20000001", "20000002", "20000000"))
    with _patched(handler) as rustfs:
        text = await sp.speech_provider.transcribe(b"audio-bytes", "mp3")

    assert text == "螺丝刀在阳台"
    rustfs.upload_object.assert_awaited_once()
    rustfs.delete_object.assert_awaited_once_with("speech-tmp/test.mp3")

    submit_req, *query_reqs = requests
    assert submit_req.url.path == "/api/v3/auc/bigmodel/submit"
    assert len(query_reqs) == 3
    assert all(r.url.path == "/api/v3/auc/bigmodel/query" for r in query_reqs)

    body = json.loads(submit_req.content)
    assert body["audio"]["url"] == "https://img.test/speech-tmp/test.mp3"
    assert body["audio"]["format"] == "mp3"
    assert body["request"]["model_name"] == "bigmodel"

    assert len({r.headers["X-Api-Request-Id"] for r in requests}) == 1
    assert all(r.headers["X-Api-Key"] == "test-api-key" for r in requests)
    assert all(r.headers["X-Api-Resource-Id"] == "volc.seedasr.auc" for r in requests)
    assert submit_req.headers["X-Api-Sequence"] == "-1"
    assert "X-Api-Sequence" not in query_reqs[0].headers


async def test_submit_failure_raises():
    handler, _ = _handler(submit_code="45000001")
    with _patched(handler) as rustfs:
        with pytest.raises(AppError) as ei:
            await sp.speech_provider.transcribe(b"audio-bytes", "mp3")
    assert ei.value.code == "TRANSCRIBE_FAILED"
    rustfs.delete_object.assert_awaited_once()


async def test_silent_audio_message():
    handler, _ = _handler(query_codes=("20000003",))
    with _patched(handler):
        with pytest.raises(AppError) as ei:
            await sp.speech_provider.transcribe(b"audio-bytes", "mp3")
    assert ei.value.code == "TRANSCRIBE_FAILED"
    assert "没有识别到有效内容" in ei.value.message


async def test_empty_result_text():
    handler, _ = _handler(query_codes=("20000000",), text="")
    with _patched(handler):
        with pytest.raises(AppError) as ei:
            await sp.speech_provider.transcribe(b"audio-bytes", "mp3")
    assert ei.value.code == "TRANSCRIBE_FAILED"


async def test_poll_timeout():
    handler, _ = _handler(query_codes=("20000001",))
    settings = _settings(volc_speech_max_wait_seconds=0)
    with _patched(handler, settings):
        with pytest.raises(AppError) as ei:
            await sp.speech_provider.transcribe(b"audio-bytes", "mp3")
    assert ei.value.code == "TRANSCRIBE_FAILED"
    assert "超时" in ei.value.message
