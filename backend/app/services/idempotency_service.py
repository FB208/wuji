import hashlib
import json
import uuid
from datetime import timedelta

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import (
    AppError,
    family_forbidden,
    idempotency_conflict,
    idempotency_key_invalid,
    record_attempt_expired,
    record_processing,
)
from app.core.logging import get_logger
from app.models.tables import IdempotencyRecord, utcnow
from app.repositories import repos

logger = get_logger(__name__)

LEASE_SECONDS = 120
RESPONSE_TTL = timedelta(days=7)

IDEM_KEY_MIN_LEN = 16
IDEM_KEY_MAX_LEN = 128


def validate_idem_key(idem_key: str | None) -> str:
    if (
        not idem_key
        or not (IDEM_KEY_MIN_LEN <= len(idem_key) <= IDEM_KEY_MAX_LEN)
        or any(ch.isspace() for ch in idem_key)
    ):
        raise idempotency_key_invalid()
    return idem_key


def request_hash(operation: str, payload: dict) -> str:
    body = {"operation": operation, **payload}
    canonical = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _new_lease() -> tuple[str, object]:
    return uuid.uuid4().hex, utcnow() + timedelta(seconds=LEASE_SECONDS)


def _stored_error(record: IdempotencyRecord) -> AppError:
    try:
        body = json.loads(record.error_json or "{}")
    except json.JSONDecodeError:
        body = {}
    return AppError(
        body.get("code") or "RECORD_FAILED",
        body.get("message") or "入库失败，请重试",
        status_code=int(body.get("status_code") or 500),
        retryable=False,
    )


async def _evaluate_existing(
    record: IdempotencyRecord, operation: str, family_id: int, req_hash: str
) -> dict | None:
    now = utcnow()
    if record.operation != operation or record.family_id != family_id:
        raise idempotency_conflict("同一 Idempotency-Key 的请求内容不一致")
    if record.request_hash is not None and record.request_hash != req_hash:
        raise idempotency_conflict("同一 Idempotency-Key 的请求内容不一致")
    if record.state == "completed":
        if record.response_expires_at is not None and record.response_expires_at > now:
            return json.loads(record.response_json)
        raise record_attempt_expired()
    if record.state == "failed":
        body = json.loads(record.error_json or "{}")
        if not body.get("retryable", True):
            raise _stored_error(record)
    elif record.lease_until is not None and record.lease_until > now:
        raise record_processing()
    token, until = _new_lease()
    record.state = "processing"
    record.lease_token = token
    record.lease_until = until
    record.error_json = None
    return None


async def reserve(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    operation: str,
    idem_key: str,
    req_hash: str,
) -> IdempotencyRecord | dict:
    record = await repos.get_idempotency_for_update(db, user_id, idem_key)
    if record is not None:
        replay = await _evaluate_existing(record, operation, family_id, req_hash)
        return replay if replay is not None else record
    token, until = _new_lease()
    record = IdempotencyRecord(
        user_id=user_id,
        idem_key=idem_key,
        operation=operation,
        family_id=family_id,
        request_hash=req_hash,
        state="processing",
        lease_token=token,
        lease_until=until,
    )
    try:
        async with db.begin_nested():
            db.add(record)
            await db.flush()
    except IntegrityError:
        record = await repos.get_idempotency_for_update(db, user_id, idem_key)
        if record is None:
            raise
        replay = await _evaluate_existing(record, operation, family_id, req_hash)
        return replay if replay is not None else record
    return record


async def mark_failed(
    db: AsyncSession, user_id: int, idem_key: str, lease_token: str, exc: AppError
) -> None:
    try:
        async with db.begin():
            await db.execute(
                update(IdempotencyRecord)
                .where(
                    IdempotencyRecord.user_id == user_id,
                    IdempotencyRecord.idem_key == idem_key,
                    IdempotencyRecord.state == "processing",
                    IdempotencyRecord.lease_token == lease_token,
                )
                .values(
                    state="failed",
                    error_json=json.dumps(
                        {
                            "code": exc.code,
                            "message": exc.message,
                            "retryable": exc.retryable,
                            "status_code": exc.status_code,
                        },
                        ensure_ascii=False,
                    ),
                    lease_token=None,
                    lease_until=None,
                )
            )
    except Exception as inner:
        logger.error("幂等失败标记写入失败：%s", inner)


def complete(record: IdempotencyRecord, result: dict) -> None:
    record.state = "completed"
    record.response_json = json.dumps(result, ensure_ascii=False)
    record.error_json = None
    record.response_expires_at = utcnow() + RESPONSE_TTL
    record.lease_token = None
    record.lease_until = None
