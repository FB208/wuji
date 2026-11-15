"""入库四态：delete / confirm / resolve / restore 在真实 MySQL 上的集成流程。"""
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security import create_signed_token, verify_signed_token
from app.models.tables import Item, UploadedImage
from app.services import record_service as rs
from tests.integration import helpers

pytestmark = pytest.mark.integration

IMAGE_URL_PREFIX = "http://img.test"


async def _count_items(db: AsyncSession, family_id: int, status: int = 1) -> int:
    return (
        await db.execute(
            select(func.count()).select_from(Item).where(
                Item.family_id == family_id, Item.status == status
            )
        )
    ).scalar_one()


async def _register_image_token(db: AsyncSession, family_id: int, user_id: int):
    object_key = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
    url = f"{IMAGE_URL_PREFIX}/{object_key}"
    await helpers.register_image(db, family_id, user_id, object_key, url)
    await db.commit()
    return helpers.make_image_token(family_id, object_key, url)


async def _record(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    *,
    judge: dict,
    token: str | None = None,
    key: str | None = None,
    transcript: str = "语音描述",
) -> dict:
    if token is None:
        token = await _register_image_token(db, family_id, user_id)
    with patch.object(rs.semantic_provider, "judge_record", new=AsyncMock(return_value=judge)):
        return await rs.record_item(
            db, user_id, family_id, token, transcript, key or uuid.uuid4().hex
        )


async def _confirm(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    *,
    action,
    cands: list[int],
    name: str = "椅子",
    location: str = "卧室",
    token: str | None = None,
    key: str | None = None,
) -> dict:
    return await _record(
        db, user_id, family_id,
        judge=helpers.fake_judge(
            operation="confirm", action=action, target_item_id=None,
            name=name, location_text=location, candidate_item_ids=cands,
        ),
        token=token, key=key,
    )


async def _bound_registration_count(db: AsyncSession, item_id: int) -> int:
    return (
        await db.execute(
            select(func.count()).select_from(UploadedImage).where(
                UploadedImage.bound_item_id == item_id
            )
        )
    ).scalar_one()


async def test_delete_success_no_image_bound(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(
        db, family.id, name="旧拖把", location_text="阳台", image_url=f"{IMAGE_URL_PREFIX}/old.jpg"
    )
    await helpers.register_image(db, family.id, user.id, "items/old.jpg", f"{IMAGE_URL_PREFIX}/old.jpg")
    await db.commit()

    res = await _record(
        db, user.id, family.id,
        judge=helpers.fake_judge(
            operation="delete", target_item_id=item.id, name="", location_text="",
            candidate_item_ids=[item.id],
        ),
    )
    assert res["operation"] == "delete"
    assert res["previous"]["name"] == "旧拖把"
    assert res["previous"]["location_text"] == "阳台"

    item2 = await db.get(Item, item.id)
    assert item2.status == 0 and item2.deleted_at is not None and item2.version == 2

    old_reg = (
        await db.execute(
            select(UploadedImage).where(UploadedImage.image_url == f"{IMAGE_URL_PREFIX}/old.jpg")
        )
    ).scalar_one()
    assert old_reg.delete_state == "pending_delete" and old_reg.delete_after is not None
    # delete 不消费新上传图片：不应有任何登记绑定到该物品
    assert await _bound_registration_count(db, item.id) == 0


async def test_confirm_result_and_replay(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    chair1 = await helpers.make_item(db, family.id, name="椅子", location_text="客厅")
    chair2 = await helpers.make_item(db, family.id, name="椅子", location_text="书房")
    await db.commit()
    token = await _register_image_token(db, family.id, user.id)
    key = uuid.uuid4().hex

    res = await _confirm(db, user.id, family.id, action="move", cands=[chair2.id, chair1.id], token=token, key=key)
    assert res["operation"] == "confirm" and res["action"] == "move"
    assert [c["id"] for c in res["candidates"]] == [chair2.id, chair1.id]
    assert res["candidates"][0]["image_url"]
    body = verify_signed_token(res["record_token"], purpose="record_confirm")
    assert body["cands"] == [chair2.id, chair1.id] and body["action"] == "move"
    assert body["name"] == "椅子" and body["location"] == "卧室"

    # 确认未决不写物品、不绑图
    assert await _count_items(db, family.id) == 2
    bound = (
        await db.execute(
            select(UploadedImage).where(UploadedImage.bound_item_id.isnot(None))
        )
    ).scalars().all()
    assert bound == []
    await db.commit()  # 上面的裸 SELECT 占用了 session 事务，先释放

    # 同 key 重放返回同一份确认结果（token 一致）
    replay = await _confirm(db, user.id, family.id, action="move", cands=[chair2.id, chair1.id], token=token, key=key)
    assert replay["operation"] == "confirm"
    assert replay["record_token"] == res["record_token"]


async def test_resolve_move(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    chair1 = await helpers.make_item(db, family.id, name="椅子", location_text="客厅")
    chair2 = await helpers.make_item(db, family.id, name="椅子", location_text="书房")
    await db.commit()

    res = await _confirm(db, user.id, family.id, action="move", cands=[chair1.id, chair2.id])
    out = await rs.resolve_record(
        db, user.id, family.id, res["record_token"], {"item_id": chair1.id}, uuid.uuid4().hex
    )
    assert out["operation"] == "move" and out["item"]["id"] == chair1.id
    assert out["item"]["location_text"] == "卧室"
    assert out["previous"]["location_text"] == "客厅"
    item = await db.get(Item, chair1.id)
    assert item.location_text == "卧室" and item.version == 2
    assert await _bound_registration_count(db, chair1.id) == 1


async def test_resolve_create_escape(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    chair1 = await helpers.make_item(db, family.id, name="椅子", location_text="客厅")
    await db.commit()

    res = await _confirm(db, user.id, family.id, action=None, cands=[chair1.id])
    out = await rs.resolve_record(
        db, user.id, family.id, res["record_token"], {"create": True}, uuid.uuid4().hex
    )
    assert out["operation"] == "create"
    assert out["item"]["name"] == "椅子" and out["item"]["location_text"] == "卧室"
    assert await _count_items(db, family.id) == 2


async def test_resolve_delete(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    chair1 = await helpers.make_item(db, family.id, name="椅子", location_text="客厅")
    chair2 = await helpers.make_item(db, family.id, name="椅子", location_text="书房")
    await db.commit()

    res = await _confirm(db, user.id, family.id, action="delete", cands=[chair1.id, chair2.id])
    out = await rs.resolve_record(
        db, user.id, family.id, res["record_token"], {"item_id": chair1.id}, uuid.uuid4().hex
    )
    assert out["operation"] == "delete" and out["item"]["id"] == chair1.id
    item = await db.get(Item, chair1.id)
    assert item.status == 0 and item.deleted_at is not None
    assert await _bound_registration_count(db, chair1.id) == 0


async def test_resolve_rejects_out_of_candidates(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    chair1 = await helpers.make_item(db, family.id, name="椅子", location_text="客厅")
    chair2 = await helpers.make_item(db, family.id, name="椅子", location_text="书房")
    await db.commit()

    res = await _confirm(db, user.id, family.id, action="move", cands=[chair1.id])
    with pytest.raises(AppError) as ei:
        await rs.resolve_record(
            db, user.id, family.id, res["record_token"], {"item_id": chair2.id}, uuid.uuid4().hex
        )
    assert ei.value.code == "VALIDATION_ERROR"


async def test_resolve_expired_token(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    other = await helpers.make_family(db, user, name="另一个家")
    await db.commit()
    uid, fid = user.id, family.id  # 服务抛错后 rollback 会 expire ORM 对象，先快照 id

    bad = create_signed_token(
        {"fid": other.id, "key": "k", "url": "u", "transcript": "t",
         "name": "n", "location": "l", "action": None, "cands": []},
        ttl_seconds=3600, purpose="record_confirm",
    )
    for token in ("bad.token.xx", bad):
        with pytest.raises(AppError) as ei:
            await rs.resolve_record(
                db, uid, fid, token, {"create": True}, uuid.uuid4().hex
            )
        assert ei.value.code == "RECORD_CONFIRM_EXPIRED"


async def test_resolve_target_gone(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    chair1 = await helpers.make_item(db, family.id, name="椅子", location_text="客厅")
    await db.commit()

    # move 目标在确认期间被删 → 按 create 兜底
    res = await _confirm(db, user.id, family.id, action="move", cands=[chair1.id])
    await rs.delete_item(db, user.id, family.id, chair1.id, expected_version=1)
    out = await rs.resolve_record(
        db, user.id, family.id, res["record_token"], {"item_id": chair1.id}, uuid.uuid4().hex
    )
    assert out["operation"] == "create" and out["item"]["id"] != chair1.id

    # delete 目标在确认期间被删 → NOT_FOUND
    chair2 = await helpers.make_item(db, family.id, name="椅子", location_text="书房")
    await db.commit()
    res2 = await _confirm(db, user.id, family.id, action="delete", cands=[chair2.id])
    await rs.delete_item(db, user.id, family.id, chair2.id, expected_version=1)
    with pytest.raises(AppError) as ei:
        await rs.resolve_record(
            db, user.id, family.id, res2["record_token"], {"item_id": chair2.id}, uuid.uuid4().hex
        )
    assert ei.value.code == "NOT_FOUND"


async def test_resolve_replay(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    chair1 = await helpers.make_item(db, family.id, name="椅子", location_text="客厅")
    await db.commit()

    res = await _confirm(db, user.id, family.id, action="move", cands=[chair1.id])
    key = uuid.uuid4().hex
    out1 = await rs.resolve_record(db, user.id, family.id, res["record_token"], {"item_id": chair1.id}, key)
    out2 = await rs.resolve_record(db, user.id, family.id, res["record_token"], {"item_id": chair1.id}, key)
    assert out1 == out2
    assert await _count_items(db, family.id) == 1


async def test_restore_item(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(
        db, family.id, name="旧拖把", location_text="阳台", image_url=f"{IMAGE_URL_PREFIX}/old.jpg"
    )
    await helpers.register_image(db, family.id, user.id, "items/old.jpg", f"{IMAGE_URL_PREFIX}/old.jpg")
    await db.commit()

    uid, fid, item_id = user.id, family.id, item.id
    res = await _record(
        db, uid, fid,
        judge=helpers.fake_judge(
            operation="delete", target_item_id=item_id, name="", location_text="",
            candidate_item_ids=[item_id],
        ),
    )
    assert res["operation"] == "delete"

    out = await rs.restore_item(db, uid, fid, item_id, expected_version=res["item"]["version"])
    assert out["id"] == item_id and out["version"] == res["item"]["version"] + 1
    item2 = await db.get(Item, item_id)
    assert item2.status == 1 and item2.deleted_at is None
    old_reg = (
        await db.execute(
            select(UploadedImage).where(UploadedImage.image_url == f"{IMAGE_URL_PREFIX}/old.jpg")
        )
    ).scalar_one()
    assert old_reg.delete_state == "none" and old_reg.delete_after is None
    await db.commit()

    # 已恢复（active）物品不在软删集合 → NOT_FOUND
    with pytest.raises(AppError) as ei:
        await rs.restore_item(db, uid, fid, item_id, expected_version=res["item"]["version"])
    assert ei.value.code == "NOT_FOUND"

    # 再次删除后用过期版本恢复 → VERSION_CONFLICT
    await rs.delete_item(db, uid, fid, item_id, expected_version=out["version"])
    with pytest.raises(AppError) as ei:
        await rs.restore_item(db, uid, fid, item_id, expected_version=res["item"]["version"])
    assert ei.value.code == "VERSION_CONFLICT"
    with pytest.raises(AppError) as ei:
        await rs.restore_item(db, uid, fid, item_id, expected_version=99)
    assert ei.value.code == "VERSION_CONFLICT"

    # 从未删除的物品 → NOT_FOUND
    chair = await helpers.make_item(db, fid)
    await db.commit()
    chair_id = chair.id
    with pytest.raises(AppError) as ei:
        await rs.restore_item(db, uid, fid, chair_id, expected_version=1)
    assert ei.value.code == "NOT_FOUND"
