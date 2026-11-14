import os
import sys
from pathlib import Path

import httpx
import pytest

os.environ.setdefault("AWS_ACCESS_KEY_ID", "test-dummy")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test-dummy")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture(autouse=True)
def block_real_http_calls(monkeypatch):
    original_send = httpx.AsyncClient.send

    async def send(client, request, *args, **kwargs):
        if isinstance(client._transport_for_url(request.url), httpx.AsyncHTTPTransport):
            raise AssertionError("测试不得调用真实第三方 HTTP 服务，请使用 MockTransport 或 ASGITransport")
        return await original_send(client, request, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
