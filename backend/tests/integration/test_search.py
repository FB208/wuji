import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.tables import FamilyMember, Item, UploadedImage
from app.services import idempotency_service as idem_svc
from app.services import record_service as rs
from app.services import search_service as ss
from tests.integration import helpers
from tests.integration.conftest import TestSession

pytestmark = pytest.mark.integration

KEY = "s" * 32


async def _token(db, family_id, user_id):
    key = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
    url = f"http://img.test/{key}"
    await helpers.register_image(db, family_id, user_id, key, url)
    await db.commit()
    return helpers.make_image_token(family_id, key, url)


async def _count(db, family_id):
    return (
        await db.execute(select(func.count()).select_from(Item).where(Item.family_id == family_id, Item.status == 1))
    ).scalar_one()


async def test_member_removed_during_model_call_forbidden(db: AsyncSession):
    owner = await helpers.make_user(db)
    member = await helpers.make_user(db)
    family = await helpers.make_family(db, owner)
    await helpers.add_member(db, family.id, member.id)
    item = await helpers.make_item(db, family.id)
    await db.commit()
    member_id, family_id, item_id = member.id, family.id, item.id

    async def kick(query, ctx, pool):
        async with TestSession() as s2:
            row = (await s2.execute(
                select(FamilyMember).where(
                    FamilyMember.family_id == family_id, FamilyMember.user_id == member_id
                )
            )).scalar_one()
            await s2.delete(row)
            await s2.commit()
        return {"status": "found", "item_ids": [item_id], "prompt": None}

    with patch.object(ss.semantic_provider, "search_items", new=AsyncMock(side_effect=kick)):
        with pytest.raises(AppError) as ei:
            await ss.search_by_text(db, member_id, family_id, "找东西", None)
        assert ei.value.code == "FAMILY_FORBIDDEN"


async def test_item_deleted_during_model_call_not_returned(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(db, family.id)
    await db.commit()
    user_id, family_id, item_id = user.id, family.id, item.id

    async def wipe(query, ctx, pool):
        async with TestSession() as s2:
            row = await s2.get(Item, item_id)
            row.status = 0
            await s2.commit()
        return {"status": "found", "item_ids": [item_id], "prompt": None}

    with patch.object(ss.semantic_provider, "search_items", new=AsyncMock(side_effect=wipe)):
        out = await ss.search_by_text(db, user_id, family_id, "找东西", None)
    assert out["status"] == "not_found"
    assert out["items"] == []


async def test_audio_no_membership_no_asr(db: AsyncSession):
    user = await helpers.make_user(db)
    other = await helpers.make_user(db)
    family = await helpers.make_family(db, owner=other)
    await db.commit()
    with patch.object(ss.speech_provider, "transcribe", new=AsyncMock()) as t:
        with pytest.raises(AppError) as ei:
            await ss.search_by_audio(db, user.id, family.id, b"x" * 2000, "mp3", None)
        assert ei.value.code == "FAMILY_FORBIDDEN"
        assert t.await_count == 0


async def test_context_other_family_rejected(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await helpers.make_item(db, family.id)
    await db.commit()
    with patch.object(ss.semantic_provider, "search_items", new=AsyncMock()) as m:
        with pytest.raises(AppError) as ei:
            await ss.search_by_text(db, user.id, family.id, "找", {"family_id": 999})
        assert ei.value.code == "SEARCH_CONTEXT_MISMATCH"
        assert m.await_count == 0


async def test_foreign_model_ids_not_returned(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(db, family.id)
    await db.commit()
    family_id, item_id = family.id, item.id

    with patch.object(ss.semantic_provider, "search_items", new=AsyncMock(
        return_value={"status": "multiple", "item_ids": [item_id, 99999], "prompt": None}
    )):
        out = await ss.search_by_text(db, user.id, family_id, "找", None)
    assert out["status"] == "found"
    assert [i["id"] for i in out["items"]] == [item_id]
