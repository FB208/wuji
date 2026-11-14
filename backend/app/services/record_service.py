"""收纳入库：图片上传、image_token、create/move 判断与写库（文档 4 / 10 / 13.3）。"""
from datetime import timedelta, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import (
    AppError,
    family_forbidden,
    image_invalid,
    image_upload_failed,
    record_failed,
    record_parse_failed,
    record_attempt_superseded,
    version_conflict,
)
from app.core.logging import get_logger
from app.core.security import create_signed_token, verify_signed_token
from app.models.tables import Item, UploadedImage, utcnow
from app.providers.rustfs import rustfs_provider
from app.providers.semantic import SemanticBudget, semantic_provider
from app.repositories import repos
from app.services import idempotency_service
from app.services.family_service import lock_membership_scope, require_membership

logger = get_logger(__name__)

_ALLOWED_EXTS = {"jpg", "jpeg", "png", "webp"}
# 文件头魔数校验（文档 14.2：校验扩展名、MIME、文件头和大小）
_MAGIC_PREFIXES = {
    "jpg": [b"\xff\xd8\xff"],
    "jpeg": [b"\xff\xd8\xff"],
    "png": [b"\x89PNG\r\n\x1a\n"],
    "webp": [b"RIFF"],
}

_MAX_NAME_LEN = 128
_MAX_LOCATION_LEN = 255


class _FamilyRevisionChanged(Exception):
    pass


def _validate_image(content: bytes, ext: str) -> None:
    settings = get_settings()
    if ext not in _ALLOWED_EXTS:
        raise image_invalid("仅支持 JPG、PNG、WEBP 图片")
    if len(content) > settings.max_image_mb * 1024 * 1024:
        raise image_invalid(f"图片不能超过 {settings.max_image_mb}MB")
    if not any(content.startswith(prefix) for prefix in _MAGIC_PREFIXES[ext]):
        raise image_invalid("图片内容无效，请重新拍摄")


async def upload_image(db: AsyncSession, user_id: int, family_id: int, filename: str, content: bytes) -> dict:
    """上传图片到 RustFS，登记待用记录，签发 image_token。"""
    await require_membership(db, family_id, user_id)
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    if ext == "jpeg":
        ext = "jpg"
    _validate_image(content, ext or "jpg")

    object_key = rustfs_provider.build_object_key(family_id, ext or "jpg")
    try:
        image_url = await rustfs_provider.upload_image(object_key, content, ext or "jpg")
    except Exception as exc:
        logger.error("RustFS 上传失败：%s", exc)
        raise image_upload_failed() from exc

    db.add(
        UploadedImage(
            family_id=family_id,
            uploader_user_id=user_id,
            object_key=object_key,
            image_url=image_url,
        )
    )
    await db.commit()

    settings = get_settings()
    image_token = create_signed_token(
        {"key": object_key, "url": image_url, "fid": family_id},
        ttl_seconds=settings.image_token_ttl_minutes * 60,
        purpose="image",
    )
    return {"image_url": image_url, "image_token": image_token}


def resolve_image_token(image_token: str, family_id: int) -> dict:
    """从 image_token 取得由本系统上传的 image_url（文档 13.3 后端入库顺序 2）。"""
    body = verify_signed_token(image_token, purpose="image")
    if body is None or int(body.get("fid", 0)) != family_id:
        raise image_invalid("图片已失效，请重新拍摄")
    return {"object_key": body["key"], "image_url": body["url"]}


def _item_out(item: Item) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "location_text": item.location_text,
        "record_text": item.record_text,
        "image_url": item.image_url,
        "version": item.version,
        "updated_at": (
            item.updated_at.replace(tzinfo=timezone.utc).isoformat()
            if item.updated_at
            else None
        ),
    }


def _check_image_registration(
    registration: UploadedImage | None, family_id: int, *, for_bind: bool
) -> UploadedImage:
    if registration is None or registration.family_id != family_id:
        raise image_invalid("图片已失效，请重新拍摄")
    if registration.delete_state != "none":
        raise image_invalid("图片已失效，请重新拍摄")
    if for_bind and registration.bound_item_id is not None:
        raise image_invalid("图片已被使用，请重新拍摄")
    return registration


def _validate_name_location(name: Any, location_text: Any, *, name_required: bool) -> None:
    if name is not None and not isinstance(name, str):
        raise record_parse_failed("请重新说清楚物品和位置")
    if name_required and not name:
        logger.warning("入库校验拒绝：名称为空 name=%r location=%r", name, location_text)
        raise record_parse_failed()
    if isinstance(name, str) and len(name) > _MAX_NAME_LEN:
        raise record_parse_failed("名称或位置过长，请重新描述")
    if not isinstance(location_text, str) or not location_text:
        logger.warning("入库校验拒绝：位置为空 name=%r location=%r", name, location_text)
        raise record_parse_failed("请重新说清楚物品和位置")
    if len(location_text) > _MAX_LOCATION_LEN:
        raise record_parse_failed("名称或位置过长，请重新描述")


def _parse_target_item_id(raw: Any) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str) and raw.isdigit():
        return int(raw)
    return None


def _items_summary(items: list[Item]) -> list[dict]:
    return [
        {"id": i.id, "name": i.name, "location_text": i.location_text, "record_text": i.record_text}
        for i in items
    ]


async def _retire_image(db: AsyncSession, image_url: str) -> None:
    """旧照片进入延迟清理（文档 10.3）。"""
    settings = get_settings()
    delete_after = utcnow() + timedelta(days=settings.deleted_image_retain_days)
    await repos.mark_image_pending_delete(db, image_url, delete_after)


async def _lock_scope(db: AsyncSession, user_id: int, family_id: int):
    return await lock_membership_scope(db, user_id, family_id)


async def record_item(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    image_token: str,
    transcript: str,
    idem_key: str | None,
) -> dict:
    """入库主流程：语义判断 create/move，事务写库，幂等返回。"""
    logger.info("入库开始 user=%d family=%d transcript=%r", user_id, family_id, transcript)
    key = idempotency_service.validate_idem_key(idem_key)
    req_hash = idempotency_service.request_hash(
        "record",
        {"family_id": family_id, "image_token": image_token, "transcript": transcript},
    )
    async with db.begin():
        _, family = await _lock_scope(db, user_id, family_id)
        reserved = await idempotency_service.reserve(
            db, user_id, family_id, "record", key, req_hash
        )
        if isinstance(reserved, dict):
            return reserved
        image = resolve_image_token(image_token, family_id)
        registration = _check_image_registration(
            await repos.get_uploaded_image_by_key_for_update(db, image["object_key"]),
            family_id,
            for_bind=True,
        )
        items = await repos.list_active_items(db, family_id)
        summary = _items_summary(items)
        revision_seen = family.revision
        registration_id = registration.id
        lease_token = reserved.lease_token

    try:
        result = await _execute_with_retry(
            db, user_id, family_id, key, lease_token, revision_seen,
            summary, transcript, image, registration_id,
        )
    except AppError as exc:
        await idempotency_service.mark_failed(db, user_id, key, lease_token, exc)
        raise
    except Exception as exc:
        await idempotency_service.mark_failed(db, user_id, key, lease_token, record_failed())
        logger.error("入库写库失败：%s", exc)
        raise record_failed() from exc
    return result


async def _execute_with_retry(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    idem_key: str,
    lease_token: str,
    revision_seen: int,
    summary: list[dict],
    transcript: str,
    image: dict,
    registration_id: int,
) -> dict:

    budget = SemanticBudget.from_settings()
    if not await idempotency_service.renew_lease(db, user_id, idem_key, lease_token):
        raise record_attempt_superseded()
    judge = await semantic_provider.judge_record(transcript, summary, budget=budget)
    try:
        return await _finalize(
            db, user_id, family_id, idem_key, lease_token,
            revision_seen, judge, transcript, image, registration_id,
        )
    except _FamilyRevisionChanged:
        pass
    async with db.begin():
        _, family = await _lock_scope(db, user_id, family_id)
        record = await repos.get_idempotency_for_update(db, user_id, idem_key)
        idempotency_service.assert_lease_current(record, lease_token)
        items = await repos.list_active_items(db, family_id)
        summary = _items_summary(items)
        revision_seen = family.revision
    if not await idempotency_service.renew_lease(db, user_id, idem_key, lease_token):
        raise record_attempt_superseded()
    try:
        judge = await semantic_provider.judge_record(transcript, summary, budget=budget)
    except AppError as exc:
        if exc.code == "SEMANTIC_BUDGET_EXCEEDED":
            raise version_conflict("家庭数据已变化，请重试") from exc
        raise
    try:
        return await _finalize(
            db, user_id, family_id, idem_key, lease_token,
            revision_seen, judge, transcript, image, registration_id,
        )
    except _FamilyRevisionChanged:
        raise version_conflict("家庭数据已变化，请重试")


async def _finalize(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    idem_key: str,
    lease_token: str,
    revision_seen: int,
    judge: dict,
    transcript: str,
    image: dict,
    registration_id: int,
) -> dict:
    async with db.begin():
        _, family = await _lock_scope(db, user_id, family_id)
        record = await repos.get_idempotency_for_update(db, user_id, idem_key)
        idempotency_service.assert_lease_current(record, lease_token)
        if family.revision != revision_seen:
            raise _FamilyRevisionChanged()

        operation = judge["operation"]
        name = judge["name"]
        location_text = judge["location_text"]

        target: Item | None = None
        if operation == "move":
            target_id = _parse_target_item_id(judge.get("target_item_id"))
            if target_id is not None:
                target = await repos.get_active_item_for_update(db, family_id, target_id)
            if target is None:
                # move 目标无效或不属于当前家庭组时按 create 处理（文档 4.5）
                operation = "create"

        if operation == "create":
            _validate_name_location(name, location_text, name_required=True)
            settings = get_settings()
            if await repos.count_active_items(db, family_id) >= settings.max_family_items:
                raise AppError("FAMILY_ITEMS_FULL", "该家庭组物品记录已达上限", status_code=400)
            item = Item(
                family_id=family_id,
                created_by=user_id,
                name=name,
                location_text=location_text,
                record_text=transcript,
                image_url=image["image_url"],
                status=1,
                version=1,
            )
            db.add(item)
        else:
            assert target is not None
            _validate_name_location(name, location_text, name_required=False)
            old_image_url = target.image_url
            target.location_text = location_text
            target.record_text = transcript
            target.image_url = image["image_url"]
            if name:
                target.name = name
            target.version += 1
            if old_image_url != image["image_url"]:
                await _retire_image(db, old_image_url)
            item = target

        await db.flush()

        registration = _check_image_registration(
            await repos.get_uploaded_image_by_key_for_update(db, image["object_key"]),
            family_id,
            for_bind=True,
        )
        registration.bound_item_id = item.id
        registration.delete_after = None

        family.revision += 1
        await db.flush()
        await db.refresh(item)

        result = {"operation": operation, "item": _item_out(item)}
        idempotency_service.complete(record, result)
        logger.info(
            "入库完成 user=%d family=%d operation=%s item_id=%d",
            user_id, family_id, operation, item.id,
        )
        return result


# ---------- 物品维护（文档 6 章） ----------
async def list_items(
    db: AsyncSession, user_id: int, family_id: int, q: str | None, page: int, page_size: int
) -> dict:
    await require_membership(db, family_id, user_id)
    items, total = await repos.search_items_page(db, family_id, q, page, page_size)
    return {
        "items": [_item_out(i) for i in items],
        "page": page,
        "page_size": page_size,
        "total": total,
    }


async def get_item_detail(db: AsyncSession, user_id: int, family_id: int, item_id: int) -> dict:
    await require_membership(db, family_id, user_id)
    item = await repos.get_active_item(db, family_id, item_id)
    if item is None:
        from app.core.errors import not_found

        raise not_found("物品记录不存在")
    return _item_out(item)


async def patch_item(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    item_id: int,
    name: str | None,
    location_text: str | None,
    image_token: str | None,
    expected_version: int,
) -> dict:
    async with db.begin():
        _, family = await _lock_scope(db, user_id, family_id)
        item = await repos.get_active_item_for_update(db, family_id, item_id)
        if item is None:
            from app.core.errors import not_found

            raise not_found("物品记录不存在")
        if item.version != expected_version:
            raise version_conflict()
        if name:
            item.name = name
        if location_text:
            item.location_text = location_text
        if image_token:
            image = resolve_image_token(image_token, family_id)
            registration = _check_image_registration(
                await repos.get_uploaded_image_by_key_for_update(db, image["object_key"]),
                family_id,
                for_bind=True,
            )
            if item.image_url != image["image_url"]:
                await _retire_image(db, item.image_url)
            item.image_url = image["image_url"]
            registration.bound_item_id = item.id
            registration.delete_after = None
        item.version += 1
        family.revision += 1
        await db.flush()
        await db.refresh(item)
        return _item_out(item)


async def delete_item(
    db: AsyncSession, user_id: int, family_id: int, item_id: int, expected_version: int
) -> None:
    """软删除；对应图片软删除 7 天后清理（文档 6.4）。"""
    async with db.begin():
        _, family = await _lock_scope(db, user_id, family_id)
        item = await repos.get_active_item_for_update(db, family_id, item_id)
        if item is None:
            from app.core.errors import not_found

            raise not_found("物品记录不存在")
        if item.version != expected_version:
            raise version_conflict()
        item.status = 0
        item.deleted_at = utcnow()
        item.version += 1
        await _retire_image(db, item.image_url)
        family.revision += 1
