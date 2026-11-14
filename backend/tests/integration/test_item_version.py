"""手工修改/删除的 expected_version 并发保护。"""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.tables import Family, Item, UploadedImage
from app.services import record_service as rs
from tests.integration import helpers

pytestmark = pytest.mark.integration


async def _family(db: AsyncSession, family_id: int) -> Family:
    return (await db.execute(select(Family).where(Family.id == family_id))).scalar_one()


async def test_patch_and_delete_version_checks(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(db, family.id)
    await db.commit()
    user_id, family_id, item_id = user.id, family.id, item.id

    out = await rs.patch_item(
        db, user_id, family_id, item_id, "新名字", "新位置", None, expected_version=1
    )
    assert out["version"] == 2
    assert out["name"] == "新名字"

    with pytest.raises(AppError) as ei:
        await rs.patch_item(
            db, user_id, family_id, item_id, "又改", None, None, expected_version=1
        )
    assert ei.value.code == "VERSION_CONFLICT"

    with pytest.raises(AppError) as ei:
        await rs.delete_item(db, user_id, family_id, item_id, expected_version=1)
    assert ei.value.code == "VERSION_CONFLICT"

    await rs.delete_item(db, user_id, family_id, item_id, expected_version=2)
    item2 = await db.get(Item, item_id)
    assert item2.status == 0
    assert item2.version == 3
    assert item2.deleted_at is not None

    fam = await _family(db, family_id)
    assert fam.revision == 3


async def test_patch_with_image_binds_once(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(db, family.id)
    old_url = item.image_url
    await helpers.register_image(db, family.id, user.id, "items/old.jpg", old_url)
    object_key = f"items/{family.id}/t/{uuid.uuid4().hex}.jpg"
    new_url = f"http://img.test/{object_key}"
    reg = await helpers.register_image(db, family.id, user.id, object_key, new_url)
    await db.commit()
    token = helpers.make_image_token(family.id, object_key, new_url)

    user_id, family_id, item_id = user.id, family.id, item.id
    out = await rs.patch_item(
        db, user_id, family_id, item_id, None, None, token, expected_version=1
    )
    assert out["image_url"] == new_url
    reg2 = await db.get(UploadedImage, reg.id)
    assert reg2.bound_item_id == item_id

    other_item = await helpers.make_item(db, family_id)
    await db.commit()
    with pytest.raises(AppError) as ei:
        await rs.patch_item(
            db, user_id, family_id, other_item.id, None, None, token, expected_version=1
        )
    assert ei.value.code == "IMAGE_INVALID"


async def test_record_and_patch_share_version_space(db: AsyncSession):
    """并发：record 的 move 与 patch 后版本递增一致。"""
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(db, family.id)
    await db.commit()
    user_id, family_id, item_id = user.id, family.id, item.id

    out = await rs.patch_item(
        db, user_id, family_id, item_id, "先改", None, None, expected_version=1
    )
    assert out["version"] == 2
    with pytest.raises(AppError):
        await rs.patch_item(
            db, user_id, family_id, item_id, "后改", None, None, expected_version=1
        )
    item2 = await db.get(Item, item_id)
    assert item2.name == "先改"
