"""幂等与执行租约：同键单次写入、范围冲突、租约接管、放弃与过期。"""
import asyncio
import json
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.tables import FamilyMember, IdempotencyRecord, Item, utcnow
from app.services import idempotency_service as idem_svc
from app.services import record_service as rs
from app.services.family_service import lock_membership_scope
from tests.integration import helpers
from tests.integration.conftest import TestSession

pytestmark = pytest.mark.integration

KEY = "k" * 32


async def _count(db: AsyncSession, family_id: int) -> int:
    return (
        await db.execute(
            select(func.count()).select_from(Item).where(
                Item.family_id == family_id, Item.status == 1
            )
        )
    ).scalar_one()


async def _image(db: AsyncSession, family_id: int, user_id: int) -> str:
    object_key = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
    url = f"http://img.test/{object_key}"
    await helpers.register_image(db, family_id, user_id, object_key, url)
    await db.commit()
    return helpers.make_image_token(family_id, object_key, url)


def _req_hash(family_id: int, image_token: str, transcript: str) -> str:
    return idem_svc.request_hash(
        "record", {"family_id": family_id, "image_token": image_token, "transcript": transcript}
    )


async def test_same_key_sequential_replays_once(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    token = await _image(db, family.id, user.id)

    with patch.object(
        rs.semantic_provider, "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge(name="数据线", location_text="书房")),
    ) as j:
        first = await rs.record_item(db, user.id, family.id, token, "收数据线", KEY)
        second = await rs.record_item(db, user.id, family.id, token, "收数据线", KEY)
        assert j.await_count == 1
    assert first == second
    assert await _count(db, family.id) == 1


async def test_same_key_concurrent_single_write(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    token = await _image(db, family.id, user.id)

    async def call():
        async with TestSession() as s:
            return await rs.record_item(s, user.id, family.id, token, "收数据线", KEY)

    with patch.object(
        rs.semantic_provider, "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge(name="数据线", location_text="书房")),
    ):
        results = await asyncio.gather(call(), call(), return_exceptions=True)
    successes = [r for r in results if isinstance(r, dict)]
    processing = [r for r in results if isinstance(r, AppError) and r.code == "RECORD_PROCESSING"]
    conflicts = [r for r in results if isinstance(r, AppError) and r.code == "IDEMPOTENCY_CONFLICT"]
    assert len(successes) + len(processing) == 2, results
    assert not conflicts, results
    if len(successes) == 2:
        assert successes[0] == successes[1]
    assert await _count(db, family.id) == 1


async def test_cross_family_same_key_conflict(db: AsyncSession):
    user = await helpers.make_user(db)
    fam_a = await helpers.make_family(db, user, name="家A")
    fam_b = await helpers.make_family(db, user, name="家B")
    await db.commit()
    token_a = await _image(db, fam_a.id, user.id)
    token_b = await _image(db, fam_b.id, user.id)

    with patch.object(
        rs.semantic_provider, "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge()),
    ):
        await rs.record_item(db, user.id, fam_a.id, token_a, "收东西", KEY)
        with pytest.raises(AppError) as ei:
            await rs.record_item(db, user.id, fam_b.id, token_b, "收东西", KEY)
        assert ei.value.code == "IDEMPOTENCY_CONFLICT"
        assert ei.value.status_code == 409


async def test_same_family_different_payload_conflict(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    token = await _image(db, family.id, user.id)

    with patch.object(
        rs.semantic_provider, "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge()),
    ):
        await rs.record_item(db, user.id, family.id, token, "收东西", KEY)
        with pytest.raises(AppError) as ei:
            await rs.record_item(db, user.id, family.id, token, "另一条录音", KEY)
        assert ei.value.code == "IDEMPOTENCY_CONFLICT"


async def test_removed_member_cannot_use_cached_result(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    token = await _image(db, family.id, user.id)

    with patch.object(
        rs.semantic_provider, "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge()),
    ):
        await rs.record_item(db, user.id, family.id, token, "收东西", KEY)

    member = (
        await db.execute(
            select(FamilyMember).where(
                FamilyMember.family_id == family.id, FamilyMember.user_id == user.id
            )
        )
    ).scalar_one()
    await db.delete(member)
    await db.commit()

    with patch.object(
        rs.semantic_provider, "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge()),
    ):
        with pytest.raises(AppError) as ei:
            await rs.record_item(db, user.id, family.id, token, "收东西", KEY)
        assert ei.value.code == "FAMILY_FORBIDDEN"


async def test_processing_state_rejected(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    token = await _image(db, family.id, user.id)

    rec = IdempotencyRecord(
        user_id=user.id, idem_key=KEY, operation="record", family_id=family.id,
        request_hash=_req_hash(family.id, token, "收东西"),
        state="processing", lease_token="lease-1", lease_until=utcnow() + timedelta(seconds=120),
    )
    db.add(rec)
    await db.commit()

    with pytest.raises(AppError) as ei:
        await rs.record_item(db, user.id, family.id, token, "收东西", KEY)
    assert ei.value.code == "RECORD_PROCESSING"
    assert ei.value.retryable is True
    assert getattr(ei.value, "retry_after", None) == 2


async def test_expired_response_rejected(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    token = await _image(db, family.id, user.id)

    user_id, family_id = user.id, family.id
    rec = IdempotencyRecord(
        user_id=user_id, idem_key=KEY, operation="record", family_id=family_id,
        request_hash=_req_hash(family_id, token, "收东西"),
        state="completed",
        response_json=json.dumps({"operation": "create", "item": {"id": 1}}),
        response_expires_at=utcnow() - timedelta(seconds=1),
    )
    db.add(rec)
    await db.commit()

    with pytest.raises(AppError) as ei:
        await rs.record_item(db, user.id, family_id, token, "收东西", KEY)
    assert ei.value.status_code == 410
    assert await _count(db, family_id) == 0


async def test_stale_lease_owner_cannot_commit(db: AsyncSession):
    """过期租约被新执行接管后，旧执行者的晚到提交必须被拒绝。"""
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    token = await _image(db, family.id, user.id)

    rec = IdempotencyRecord(
        user_id=user.id, idem_key=KEY, operation="record", family_id=family.id,
        request_hash=_req_hash(family.id, token, "收东西"),
        state="processing", lease_token="stale-lease", lease_until=utcnow() - timedelta(seconds=1),
    )
    db.add(rec)
    await db.commit()

    user_id, family_id = user.id, family.id
    with patch.object(
        rs.semantic_provider, "judge_record",
        new=AsyncMock(return_value=helpers.fake_judge(name="x", location_text="y")),
    ):
        res = await rs.record_item(db, user_id, family_id, token, "收东西", KEY)
    assert res["operation"] == "create"

    object_key2 = f"items/{family.id}/t/{uuid.uuid4().hex}.jpg"
    url2 = f"http://img.test/{object_key2}"
    await helpers.register_image(db, family.id, user.id, object_key2, url2)
    await db.commit()
    image2 = {"object_key": object_key2, "image_url": url2}

    from app.models.tables import Family

    fam = (await db.execute(select(Family).where(Family.id == family_id))).scalar_one()
    fam_revision = fam.revision
    await db.rollback()
    with pytest.raises(AppError) as ei:
        await rs._finalize(
            db, user_id, family_id, KEY, "stale-lease", fam_revision,
            helpers.fake_judge(name="x", location_text="y"), "收东西", image2, 0,
        )
    assert ei.value.status_code in (409, 410)
    assert await _count(db, family_id) == 1


