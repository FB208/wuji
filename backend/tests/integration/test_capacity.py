"""容量上限：500 条时可 move/edit 不可 create；499 并发 create 只有一个成功。"""
import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.tables import Item
from app.services import record_service as rs
from tests.integration import helpers
from tests.integration.conftest import TestSession

pytestmark = pytest.mark.integration


async def _count(db: AsyncSession, family_id: int) -> int:
    return (
        await db.execute(
            select(func.count()).select_from(Item).where(
                Item.family_id == family_id, Item.status == 1
            )
        )
    ).scalar_one()


async def _make_token(user_id: int, family_id: int):
    async with TestSession() as db:
        object_key = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
        url = f"http://img.test/{object_key}"
        await helpers.register_image(db, family_id, user_id, object_key, url)
        await db.commit()
        return helpers.make_image_token(family_id, object_key, url)


async def test_500_allows_move_blocks_create(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await helpers.seed_items(db, family.id, 500, created_by=user.id)
    target = (await db.execute(select(Item).where(Item.family_id == family.id).limit(1))).scalar_one()
    await db.commit()
    user_id, family_id, target_id = user.id, family.id, target.id
    assert await _count(db, family_id) == 500

    object_key = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
    url = f"http://img.test/{object_key}"
    await helpers.register_image(db, family_id, user_id, object_key, url)
    await db.commit()
    token = helpers.make_image_token(family_id, object_key, url)

    with patch.object(
        rs.semantic_provider,
        "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge(name="x", location_text="y")),
    ):
        with pytest.raises(AppError) as ei:
            await rs.record_item(db, user_id, family_id, token, "新增一个", uuid.uuid4().hex)
        assert ei.value.code == "FAMILY_ITEMS_FULL"

    object_key2 = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
    url2 = f"http://img.test/{object_key2}"
    await helpers.register_image(db, family_id, user_id, object_key2, url2)
    await db.commit()
    token2 = helpers.make_image_token(family_id, object_key2, url2)
    with patch.object(
        rs.semantic_provider,
        "judge_record",
        new=AsyncMock(
            return_value=helpers.fake_judge(
                operation="move", target_item_id=target_id, name="", location_text="新位置"
            )
        ),
    ):
        res = await rs.record_item(db, user_id, family_id, token2, "挪个位置", uuid.uuid4().hex)
    assert res["operation"] == "move"
    assert res["item"]["id"] == target_id
    assert await _count(db, family_id) == 500


async def test_499_concurrent_creates_only_one_succeeds(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await helpers.seed_items(db, family.id, 499, created_by=user.id)
    await db.commit()
    user_id, family_id = user.id, family.id

    tokens = [await _make_token(user_id, family_id) for _ in range(2)]

    async def call(token: str):
        async with TestSession() as s:
            return await rs.record_item(s, user_id, family_id, token, "新增", uuid.uuid4().hex)

    with patch.object(
        rs.semantic_provider,
        "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge(name="x", location_text="y")),
    ):
        results = await asyncio.gather(call(tokens[0]), call(tokens[1]), return_exceptions=True)
    successes = [r for r in results if isinstance(r, dict)]
    fulls = [r for r in results if isinstance(r, AppError) and r.code == "FAMILY_ITEMS_FULL"]
    others = [r for r in results if r not in successes and r not in fulls]
    assert len(successes) == 1, f"unexpected results: {results!r}"
    assert len(fulls) == 1
    assert not others
    assert await _count(db, family_id) == 500
