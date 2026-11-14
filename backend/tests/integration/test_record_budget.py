import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.tables import IdempotencyRecord, Item
from app.services import record_service as rs
from tests.integration import helpers

pytestmark = pytest.mark.integration

KEY = "b" * 32


async def _token(db, family_id, user_id):
    key = f"items/{family_id}/t/{uuid.uuid4().hex}.jpg"
    url = f"http://img.test/{key}"
    await helpers.register_image(db, family_id, user_id, key, url)
    await db.commit()
    return helpers.make_image_token(family_id, key, url)


async def test_revision_rejudge_shares_budget(db: AsyncSession):
    user = await helpers.make_user(db)
    family = await helpers.make_family(db, user)
    await helpers.seed_items(db, family.id, 500, created_by=user.id)
    await db.commit()
    user_id, family_id = user.id, family.id
    token = await _token(db, family_id, user_id)
    calls = []
    used_budgets = []

    async def fake_chat(prompt, payload):
        calls.append(payload)
        batch = payload.get("existing_items") or payload.get("items")
        from app.providers.semantic_contracts import RECORD_SYSTEM_PROMPT
        if prompt is not RECORD_SYSTEM_PROMPT:
            return {"item_ids": [i["id"] for i in batch[:5]]}
        return {
            "operation": "move", "target_item_id": batch[0]["id"],
            "name": "", "location_text": "新位", "candidate_item_ids": [batch[0]["id"]],
        }

    real_judge = rs.semantic_provider.judge_record
    budgets_seen = []

    async def spy_judge(transcript, summary, *, budget=None):
        budgets_seen.append(budget)
        return await real_judge(transcript, summary, budget=budget)

    real_finalize = rs._finalize
    first = {"done": False}

    async def flaky_finalize(*args, **kwargs):
        if not first["done"]:
            first["done"] = True
            raise rs._FamilyRevisionChanged()
        return await real_finalize(*args, **kwargs)

    with (
        patch.object(sem_provider := rs.semantic_provider, "judge_record", new=AsyncMock(side_effect=spy_judge)),
        patch.object(rs.semantic_provider, "_chat", side_effect=fake_chat),
        patch.object(rs, "_finalize", side_effect=flaky_finalize),
    ):
        with pytest.raises(AppError) as ei:
            await rs.record_item(db, user_id, family_id, token, "把东西挪个位置", KEY)

    assert ei.value.code == "VERSION_CONFLICT"
    assert ei.value.status_code == 409
    assert ei.value.retryable is True
    assert budgets_seen[0] is budgets_seen[1]
    assert len(budgets_seen) == 2
    assert len(calls) == 8, len(calls)

    rec = (
        await db.execute(select(IdempotencyRecord).where(IdempotencyRecord.idem_key == KEY))
    ).scalar_one()
    assert rec.state == "failed"
    count = (
        await db.execute(select(func.count()).select_from(Item).where(Item.family_id == family_id))
    ).scalar_one()
    assert count == 500
