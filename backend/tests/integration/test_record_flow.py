"""入库主流程：真实 MySQL 上 create/move/edit 与服务器默认值读取。"""
import uuid
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.tables import Family, IdempotencyRecord, Item, UploadedImage
from app.services import record_service as rs
from tests.integration import helpers

pytestmark = pytest.mark.integration

IMAGE_URL_PREFIX = "http://img.test"


async def _fresh_family(db: AsyncSession, family_id: int) -> Family:
    return (await db.execute(select(Family).where(Family.id == family_id))).scalar_one()


async def _count_items(db: AsyncSession, family_id: int) -> int:
    return (
        await db.execute(
            select(Item).where(Item.family_id == family_id, Item.status == 1)
        )
    ).scalars().all().__len__()


async def _record(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    *,
    judge: dict,
    transcript: str = "把东西放好",
    key: str | None = None,
) -> dict:
    object_key = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
    url = f"{IMAGE_URL_PREFIX}/{object_key}"
    await helpers.register_image(db, family_id, user_id, object_key, url)
    await db.commit()
    token = helpers.make_image_token(family_id, object_key, url)
    with patch.object(rs.semantic_provider, "judge_record", new=AsyncMock(return_value=judge)) as j:
        result = await rs.record_item(
            db, user_id, family_id, token, transcript, key or uuid.uuid4().hex
        )
    result["_judge_mock"] = j
    return result


async def test_create_success_with_server_defaults(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    user_id, family_id = user.id, family.id

    res = await _record(db, user_id, family_id, judge=helpers.fake_judge(name="数据线", location_text="书房抽屉"))
    assert res["operation"] == "create"
    item = res["item"]
    assert item["id"]
    assert item["name"] == "数据线"
    assert item["version"] == 1
    assert item["updated_at"] is not None
    datetime.fromisoformat(item["updated_at"])

    family2 = await _fresh_family(db, family.id)
    assert family2.revision == 2

    reg = (
        await db.execute(select(UploadedImage).where(UploadedImage.bound_item_id == item["id"]))
    ).scalar_one()
    assert reg.delete_after is None

    idem = (
        await db.execute(select(IdempotencyRecord))
    ).scalar_one()
    assert idem.state == "completed"
    assert idem.response_expires_at is not None
    assert idem.lease_token is None


async def test_move_success_no_missing_greenlet(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(db, family.id, name="旧名", location_text="旧位置")
    old_url = item.image_url
    await helpers.register_image(db, family.id, user.id, "items/old.jpg", old_url)
    await db.commit()
    user_id, family_id, item_id = user.id, family.id, item.id

    res = await _record(
        db, user_id, family_id,
        judge=helpers.fake_judge(operation="move", target_item_id=item_id, name="", location_text="卧室柜子"),
    )
    assert res["operation"] == "move"
    assert res["item"]["id"] == item.id
    assert res["item"]["location_text"] == "卧室柜子"
    assert res["item"]["name"] == "旧名"
    assert res["item"]["version"] == 2
    assert await _count_items(db, family.id) == 1

    retired = (
        await db.execute(select(UploadedImage).where(UploadedImage.image_url == old_url))
    ).scalar_one()
    assert retired.delete_state == "pending_delete"
    assert retired.delete_after is not None


async def test_move_invalid_target_falls_back_to_create(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    user_id, family_id = user.id, family.id

    res = await _record(
        db, user_id, family_id,
        judge=helpers.fake_judge(operation="move", target_item_id=99999, name="新物", location_text="新位"),
    )
    assert res["operation"] == "create"
    assert await _count_items(db, family.id) == 1


async def test_move_target_out_of_scope_falls_back(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    other = await helpers.make_family(db, user, name="另一个家")
    other_item = await helpers.make_item(db, other.id)
    deleted_item = await helpers.make_item(db, family.id, status=0)
    await db.commit()
    user_id, family_id = user.id, family.id

    for tid in (other_item.id, deleted_item.id, "abc"):
        res = await _record(
            db, user_id, family_id,
            judge=helpers.fake_judge(operation="move", target_item_id=tid, name="x", location_text="y"),
        )
        assert res["operation"] == "create"


async def test_judge_output_length_validation(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(db, family.id)
    await db.commit()
    user_id, family_id, item_id = user.id, family.id, item.id

    with pytest.raises(AppError) as ei:
        await _record(db, user_id, family_id, judge=helpers.fake_judge(name="x" * 129, location_text="ok"))
    assert ei.value.code == "RECORD_PARSE_FAILED"

    with pytest.raises(AppError) as ei:
        await _record(
            db, user_id, family_id,
            judge=helpers.fake_judge(operation="move", target_item_id=item_id, name="n", location_text="x" * 256),
        )
    assert ei.value.code == "RECORD_PARSE_FAILED"
    item2 = await db.get(Item, item_id)
    assert item2.location_text == "客厅抽屉"
    assert item2.version == 1
