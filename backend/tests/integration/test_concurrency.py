import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.tables import Family, IdempotencyRecord, Item
from app.services import idempotency_service as idem_svc
from app.services import record_service as rs
from tests.integration import helpers
from tests.integration.conftest import TestSession

pytestmark = pytest.mark.integration

KEY = "r" * 32


async def _count(db, family_id):
    return (
        await db.execute(select(func.count()).select_from(Item).where(Item.family_id == family_id, Item.status == 1))
    ).scalar_one()


async def _token(db, family_id, user_id):
    key = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
    url = f"http://img.test/{key}"
    await helpers.register_image(db, family_id, user_id, key, url)
    await db.commit()
    return helpers.make_image_token(family_id, key, url)


async def test_revision_change_recomputes_once(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    user_id, family_id = user.id, family.id
    token = await _token(db, family_id, user_id)
    entered, gate = asyncio.Event(), asyncio.Event()

    async def slow_judge(*a, **kw):
        entered.set()
        await gate.wait()
        return helpers.fake_judge(name="x", location_text="y")

    judge = AsyncMock(side_effect=slow_judge)

    async def call():
        async with TestSession() as s:
            with patch.object(rs.semantic_provider, "judge_record", new=judge):
                return await rs.record_item(s, user_id, family_id, token, "收东西", KEY)

    task = asyncio.create_task(call())
    try:
        await asyncio.wait_for(entered.wait(), 10)
        async with TestSession() as s2:
            async with s2.begin():
                await s2.execute(update(Family).where(Family.id == family_id).values(revision=Family.revision + 1))
    finally:
        gate.set()
    out = await task
    assert out["operation"] == "create"
    assert judge.await_count >= 2
    rev = (await db.execute(select(Family.revision).where(Family.id == family_id))).scalar_one()
    assert rev == 3


async def test_replay_does_not_require_valid_token(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    user_id, family_id = user.id, family.id
    token = await _token(db, family_id, user_id)

    with patch.object(rs.semantic_provider, "judge_record", new=AsyncMock(return_value=helpers.fake_judge())):
        first = await rs.record_item(db, user_id, family_id, token, "收东西", KEY)
    assert first["operation"] == "create"

    with patch.object(rs, "verify_signed_token", return_value=None):
        again = await rs.record_item(db, user_id, family_id, token, "收东西", KEY)
        assert again == first
        with pytest.raises(AppError) as ei:
            await rs.record_item(db, user_id, family_id, token, "收东西", uuid.uuid4().hex)
        assert ei.value.code == "IMAGE_INVALID"


async def test_reserve_recovers_real_unique_conflict(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    user_id, family_id = user.id, family.id
    token = await _token(db, family_id, user_id)
    req_hash = idem_svc.request_hash("record", {"family_id": family_id, "image_token": token, "transcript": "收东西"})

    existing = IdempotencyRecord(
        user_id=user_id, idem_key=KEY, operation="record", family_id=family_id,
        request_hash=req_hash, state="processing",
        lease_token="other", lease_until=__import__("datetime").datetime.now() + __import__("datetime").timedelta(seconds=120),
    )
    db.add(existing)
    await db.commit()

    from app.repositories import repos

    calls = {"n": 0}
    real = repos.get_idempotency_for_update

    async def race_first(d, u, k):
        calls["n"] += 1
        if calls["n"] == 1:
            return None
        return await real(d, u, k)

    async with db.begin():
        from app.services.family_service import lock_membership_scope
        await lock_membership_scope(db, user_id, family_id)
        with patch.object(repos, "get_idempotency_for_update", side_effect=race_first):
            with pytest.raises(AppError) as ei:
                await idem_svc.reserve(db, user_id, family_id, "record", KEY, req_hash)
            assert ei.value.code == "RECORD_PROCESSING"
        probe = await db.execute(select(IdempotencyRecord.id).where(IdempotencyRecord.idem_key == KEY))
        assert probe.scalar_one() == existing.id


async def test_stale_expected_version_rejected(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    item = await helpers.make_item(db, family.id)
    await db.commit()
    user_id, family_id, item_id = user.id, family.id, item.id

    async with TestSession() as s_a:
        loaded = await s_a.get(Item, item_id)
        assert loaded is not None
        await s_a.commit()

        async with TestSession() as s_b:
            await rs.patch_item(s_b, user_id, family_id, item_id, "B先改", None, None, expected_version=1)

        with pytest.raises(AppError) as ei:
            await rs.patch_item(s_a, user_id, family_id, item_id, "A旧版本", None, None, expected_version=1)
        assert ei.value.code == "VERSION_CONFLICT"

    name = (await db.execute(select(Item.name).where(Item.id == item_id))).scalar_one()
    assert name == "B先改"


async def test_failed_non_retryable_replays_without_reexecution(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await helpers.seed_items(db, family.id, 500)
    await db.commit()
    user_id, family_id = user.id, family.id
    token = await _token(db, family_id, user_id)

    judge = AsyncMock(return_value=helpers.fake_judge())
    with patch.object(rs.semantic_provider, "judge_record", new=judge):
        with pytest.raises(AppError) as ei:
            await rs.record_item(db, user_id, family_id, token, "收东西", KEY)
        assert ei.value.code == "FAMILY_ITEMS_FULL"
    calls = judge.await_count

    with patch.object(rs.semantic_provider, "judge_record", new=judge):
        with pytest.raises(AppError) as ei:
            await rs.record_item(db, user_id, family_id, token, "收东西", KEY)
        assert ei.value.code == "FAMILY_ITEMS_FULL"
        assert judge.await_count == calls
    assert ei.value.retryable is False
    assert ei.value.code == "FAMILY_ITEMS_FULL"


async def test_item_out_updated_at_has_tz(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await db.commit()
    user_id, family_id = user.id, family.id
    token = await _token(db, family_id, user_id)
    with patch.object(rs.semantic_provider, "judge_record", new=AsyncMock(return_value=helpers.fake_judge())):
        res = await rs.record_item(db, user_id, family_id, token, "收东西", KEY)
    from datetime import datetime
    parsed = datetime.fromisoformat(res["item"]["updated_at"])
    assert parsed.tzinfo is not None
