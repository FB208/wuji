import json
import uuid

import httpx
import pytest
from unittest.mock import AsyncMock, patch
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.security import create_access_token
from app.main import app
from app.providers import speech as speech_mod
from app.services import search_service as ss
from tests.integration import helpers
from tests.integration.conftest import TestSession

pytestmark = pytest.mark.integration


@pytest.fixture
def api_client():
    async def override_db():
        async with TestSession() as s:
            yield s

    app.dependency_overrides[get_db] = override_db
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")
    yield client
    app.dependency_overrides.clear()


def _headers(user_id: int) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


async def test_text_bad_context_rejected(db: AsyncSession, api_client):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    resp = await api_client.post(
        "/api/v1/items/search/text",
        json={"family_id": family.id, "query": "找", "context": {"turns": [{"query": "q", "item_ids": [True]}]}},
        headers=_headers(user.id),
    )
    assert resp.status_code in (400, 422)
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_audio_bad_json_and_non_object(db: AsyncSession, api_client):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    files = {"audio": ("a.mp3", b"x" * 2000, "audio/mpeg")}
    data = {"family_id": str(family.id), "context_json": "{bad json"}
    resp = await api_client.post(
        "/api/v1/items/search/audio", files=files, data=data, headers=_headers(user.id)
    )
    assert resp.status_code == 400

    data["context_json"] = "[1,2]"
    resp = await api_client.post(
        "/api/v1/items/search/audio", files=files, data=data, headers=_headers(user.id)
    )
    assert resp.status_code == 400


async def test_audio_bool_ids_and_cross_family(db: AsyncSession, api_client):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    files = {"audio": ("a.mp3", b"x" * 2000, "audio/mpeg")}

    data = {"family_id": str(family.id), "context_json": json.dumps({"excluded_item_ids": [True]})}
    resp = await api_client.post(
        "/api/v1/items/search/audio", files=files, data=data, headers=_headers(user.id)
    )
    assert resp.status_code == 422

    data["context_json"] = json.dumps({"family_id": 999})
    resp = await api_client.post(
        "/api/v1/items/search/audio", files=files, data=data, headers=_headers(user.id)
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "SEARCH_CONTEXT_MISMATCH"


async def test_audio_no_permission_no_asr(db: AsyncSession, api_client):
    user = await helpers.make_user(db)
    other = await helpers.make_user(db)
    family = await helpers.make_family(db, other)
    await db.commit()
    files = {"audio": ("a.mp3", b"x" * 2000, "audio/mpeg")}
    with patch.object(speech_mod.speech_provider, "transcribe", new=AsyncMock()) as t:
        resp = await api_client.post(
            "/api/v1/items/search/audio",
            files=files,
            data={"family_id": str(family.id)},
            headers=_headers(user.id),
        )
    assert resp.status_code == 403
    assert t.await_count == 0


async def test_text_context_other_family_rejected(db: AsyncSession, api_client):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await helpers.make_item(db, family.id)
    await db.commit()
    with patch.object(ss.semantic_provider, "search_items", new=AsyncMock()) as m:
        resp = await api_client.post(
            "/api/v1/items/search/text",
            json={"family_id": family.id, "query": "找", "context": {"family_id": 999}},
            headers=_headers(user.id),
        )
    assert resp.status_code == 409
    assert m.await_count == 0
