"""收纳入库：图片上传、image_token、create/move 判断与写库（文档 4 / 10 / 13.3）。"""
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import (
    AppError,
    image_invalid,
    image_upload_failed,
    record_failed,
    record_parse_failed,
)
from app.core.logging import get_logger
from app.core.security import create_signed_token, verify_signed_token
from app.models.tables import IdempotencyRecord, Item, UploadedImage
from app.providers.rustfs import rustfs_provider
from app.providers.semantic import semantic_provider
from app.repositories import repos
from app.services.family_service import require_membership

logger = get_logger(__name__)

_ALLOWED_EXTS = {"jpg", "jpeg", "png", "webp"}
# 文件头魔数校验（文档 14.2：校验扩展名、MIME、文件头和大小）
_MAGIC_PREFIXES = {
    "jpg": [b"\xff\xd8\xff"],
    "jpeg": [b"\xff\xd8\xff"],
    "png": [b"\x89PNG\r\n\x1a\n"],
    "webp": [b"RIFF"],
}


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

    db.add(UploadedImage(family_id=family_id, object_key=object_key, image_url=image_url, used=0))
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
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


async def _mark_image_used(db: AsyncSession, object_key: str) -> None:
    record = await repos.get_uploaded_image_by_key(db, object_key)
    if record is not None:
        record.used = 1
        record.delete_after = None


async def _retire_image(db: AsyncSession, image_url: str) -> None:
    """旧照片进入延迟清理（文档 10.3）。"""
    settings = get_settings()
    delete_after = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(
        days=settings.deleted_image_retain_days
    )
    await repos.mark_image_pending_delete(db, image_url, delete_after)


async def record_item(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    image_token: str,
    transcript: str,
    idem_key: str | None,
) -> dict:
    """入库主流程：语义判断 create/move，事务写库，幂等返回。"""
    await require_membership(db, family_id, user_id)

    # 幂等：网络重试不得重复创建记录（文档 13.1）
    if idem_key:
        existing = await repos.get_idempotency(db, user_id, idem_key)
        if existing is not None:
            return json.loads(existing.response_json)

    image = resolve_image_token(image_token, family_id)

    settings = get_settings()
    if await repos.count_active_items(db, family_id) >= settings.max_family_items:
        raise AppError("FAMILY_ITEMS_FULL", "该家庭组物品记录已达上限", status_code=400)

    # 读取当前家庭组有效物品摘要，交给语义服务判断
    items = await repos.list_active_items(db, family_id)
    summary = [
        {"id": i.id, "name": i.name, "location_text": i.location_text, "record_text": i.record_text}
        for i in items
    ]
    judge = await semantic_provider.judge_record(transcript, summary)

    name = judge["name"]
    location_text = judge["location_text"]

    operation = judge["operation"]
    target: Item | None = None
    if operation == "move":
        target_id = judge.get("target_item_id")
        if target_id is not None:
            target = await repos.get_active_item(db, family_id, int(target_id))
        if target is None:
            # move 目标无效或不属于当前家庭组时按 create 处理（文档 4.5）
            operation = "create"

    if operation == "create":
        if not name or not location_text:
            raise record_parse_failed()
        if len(name) > 128 or len(location_text) > 255:
            raise record_parse_failed("名称或位置过长，请重新描述")
        item = Item(
            family_id=family_id,
            created_by=user_id,
            name=name,
            location_text=location_text,
            record_text=transcript,
            image_url=image["image_url"],
            status=1,
        )
        db.add(item)
    else:
        assert target is not None
        if not location_text:
            raise record_parse_failed("没有听清新位置，请重新描述")
        old_image_url = target.image_url
        # 覆盖位置、记录文字、照片；名称为空则保留原名称（文档 10.3）
        target.location_text = location_text[:255]
        target.record_text = transcript
        target.image_url = image["image_url"]
        if name:
            target.name = name[:128]
        if old_image_url != image["image_url"]:
            await _retire_image(db, old_image_url)
        item = target

    await _mark_image_used(db, image["object_key"])

    try:
        await db.flush()
        result = {"operation": operation, "item": _item_out(item)}
        if idem_key:
            db.add(
                IdempotencyRecord(
                    user_id=user_id, idem_key=idem_key, response_json=json.dumps(result, ensure_ascii=False)
                )
            )
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.error("入库写库失败：%s", exc)
        raise record_failed() from exc

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
) -> dict:
    await require_membership(db, family_id, user_id)
    item = await repos.get_active_item(db, family_id, item_id)
    if item is None:
        from app.core.errors import not_found

        raise not_found("物品记录不存在")
    if name:
        item.name = name[:128]
    if location_text:
        item.location_text = location_text[:255]
    if image_token:
        image = resolve_image_token(image_token, family_id)
        if item.image_url != image["image_url"]:
            await _retire_image(db, item.image_url)
        item.image_url = image["image_url"]
        await _mark_image_used(db, image["object_key"])
    await db.commit()
    await db.refresh(item)
    return _item_out(item)


async def delete_item(db: AsyncSession, user_id: int, family_id: int, item_id: int) -> None:
    """软删除；对应图片软删除 7 天后清理（文档 6.4）。"""
    await require_membership(db, family_id, user_id)
    item = await repos.get_active_item(db, family_id, item_id)
    if item is None:
        from app.core.errors import not_found

        raise not_found("物品记录不存在")
    item.status = 0
    item.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await _retire_image(db, item.image_url)
    await db.commit()
