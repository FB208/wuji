import json
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.core.errors import AppError
from app.models.tables import utcnow
from app.services import idempotency_service as svc

pytestmark = pytest.mark.unit


def _record(**kw):
    defaults = {
        "operation": "record",
        "family_id": 1,
        "request_hash": "h" * 64,
        "state": "processing",
        "lease_token": "tok",
        "lease_until": utcnow() + timedelta(seconds=120),
        "response_json": json.dumps({"item": {"id": 5}}),
        "response_expires_at": utcnow() + timedelta(days=7),
        "error_json": None,
    }
    defaults.update(kw)
    return SimpleNamespace(**defaults)


class TestValidateKey:
    @pytest.mark.parametrize("key", [None, "", "short", "x" * 129, "a b" + "x" * 20])
    def test_rejects(self, key):
        with pytest.raises(AppError) as ei:
            svc.validate_idem_key(key)
        assert ei.value.code == "VALIDATION_ERROR"

    def test_accepts(self):
        key = "k" * 16
        assert svc.validate_idem_key(key) == key
        assert svc.validate_idem_key("k" * 128) == "k" * 128


class TestRequestHash:
    def test_deterministic(self):
        p = {"family_id": 2, "image_token": "t", "transcript": "数据线放书房"}
        assert svc.request_hash("record", p) == svc.request_hash(
            "record", {"transcript": "数据线放书房", "family_id": 2, "image_token": "t"}
        )

    @pytest.mark.parametrize(
        "change",
        [
            {"family_id": 3},
            {"image_token": "t2"},
            {"transcript": "数据线放客厅"},
        ],
    )
    def test_sensitive_to_payload(self, change):
        base = {"family_id": 2, "image_token": "t", "transcript": "数据线放书房"}
        other = dict(base, **change)
        assert svc.request_hash("record", base) != svc.request_hash("record", other)

    def test_sensitive_to_operation(self):
        p = {"family_id": 2, "image_token": "t", "transcript": "x"}
        assert svc.request_hash("record", p) != svc.request_hash("edit", p)


class TestEvaluateExisting:
    async def test_scope_mismatch_family(self):
        rec = _record(family_id=1)
        with pytest.raises(AppError) as ei:
            await svc._evaluate_existing(rec, "record", 2, "h" * 64)
        assert ei.value.code == "IDEMPOTENCY_CONFLICT"

    async def test_scope_mismatch_payload(self):
        rec = _record(request_hash="a" * 64)
        with pytest.raises(AppError) as ei:
            await svc._evaluate_existing(rec, "record", 1, "b" * 64)
        assert ei.value.code == "IDEMPOTENCY_CONFLICT"

    async def test_completed_replay(self):
        rec = _record(state="completed")
        out = await svc._evaluate_existing(rec, "record", 1, "h" * 64)
        assert out == {"item": {"id": 5}}

    async def test_completed_expired_rejected(self):
        rec = _record(state="completed", response_expires_at=utcnow() - timedelta(seconds=1))
        with pytest.raises(AppError) as ei:
            await svc._evaluate_existing(rec, "record", 1, "h" * 64)
        assert ei.value.status_code == 410

    async def test_processing_valid_lease_rejected(self):
        rec = _record(state="processing", lease_until=utcnow() + timedelta(seconds=60))
        with pytest.raises(AppError) as ei:
            await svc._evaluate_existing(rec, "record", 1, "h" * 64)
        assert ei.value.code == "RECORD_PROCESSING"
        assert ei.value.retryable is True
        assert ei.value.retry_after == 2

    async def test_processing_expired_lease_reclaimed(self):
        rec = _record(state="processing", lease_until=utcnow() - timedelta(seconds=1),
                      lease_token="old")
        out = await svc._evaluate_existing(rec, "record", 1, "h" * 64)
        assert out is None
        assert rec.state == "processing"
        assert rec.lease_token != "old"
        assert rec.lease_until > utcnow()

    async def test_failed_retryable_reclaimed(self):
        rec = _record(state="failed", lease_token=None, lease_until=None,
                      error_json='{"code":"X","retryable":true}')
        out = await svc._evaluate_existing(rec, "record", 1, "h" * 64)
        assert out is None
        assert rec.state == "processing"
        assert rec.lease_token is not None
        assert rec.error_json is None

    async def test_failed_non_retryable_replays_error(self):
        rec = _record(
            state="failed", lease_token=None, lease_until=None,
            error_json='{"code":"FAMILY_ITEMS_FULL","message":"满","status_code":400,"retryable":false}',
        )
        with pytest.raises(AppError) as ei:
            await svc._evaluate_existing(rec, "record", 1, "h" * 64)
        assert ei.value.code == "FAMILY_ITEMS_FULL"
        assert ei.value.status_code == 400
        assert ei.value.retryable is False
