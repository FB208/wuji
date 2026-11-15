"""收纳多轮问答、操作保存与本轮结果更正。"""
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable, cast

from sqlalchemy import delete

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import (
    AppError,
    image_invalid,
    image_upload_failed,
    version_conflict,
)
from app.core.logging import get_logger
from app.core.security import create_signed_token, verify_signed_token
from app.models.tables import Item, RecordSession, UploadedImage, utcnow
from app.providers.rustfs import rustfs_provider
from app.providers.semantic import RecordJudgeOut, semantic_provider
from app.repositories import repos
from app.schemas.schemas import ItemRecordRequest, RecordContext, RecordDecision, RecordUndo
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

# 阶段回调：on_stage(stage, detail)，供任务注册表推进进度；可选
StageCallback = Callable[[str, str], None]


def _emit(on_stage: StageCallback | None, stage: str, detail: str = "") -> None:
    if on_stage is not None:
        on_stage(stage, detail)


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
    body: ItemRecordRequest,
    image_id: int | None,
    idem_key: str,
    on_stage: StageCallback | None = None,
) -> dict:
    """接续本轮问答；只换照片时直接更新图片并保留原话及操作快照。"""
    async with db.begin():
        if body.event == "start":
            await db.execute(delete(RecordSession).where(RecordSession.user_id == user_id))
            context: RecordContext = {"turns": [], "pending": None, "image_id": None, "last_result": None}
            undo: RecordUndo = {"created_item_id": None, "item": None, "images": []}
            session = RecordSession(
                id=uuid.uuid4().hex, user_id=user_id, family_id=body.family_id,
                context_json=json.dumps(context), undo_json=json.dumps(undo),
            )
            db.add(session)
        else:
            session = await db.get(RecordSession, body.session_id)
            context = json.loads(session.context_json)
            undo = json.loads(session.undo_json)
        session_id = session.id
        if image_id is not None:
            context["image_id"] = image_id
        context["turns"].append({
            "role": "user", "event": body.event, "transcript": body.transcript,
            "operation": body.operation, "target_item_id": body.target_item_id,
        })
        if body.event == "revise" and body.transcript is None:
            _emit(on_stage, "writing")
            result = dict(context["last_result"])
            item = await db.get(Item, result["item"]["id"])
            registration = await db.get(UploadedImage, image_id)
            # 新图也纳入本轮快照，后续更正操作时一起恢复图片关联。
            undo["images"].append({
                "id": registration.id, "bound_item_id": registration.bound_item_id,
                "delete_state": registration.delete_state,
                "delete_after": registration.delete_after.isoformat() if registration.delete_after else None,
            })
            await _retire_image(db, item.image_url)
            item.image_url = registration.image_url
            item.version += 1
            registration.bound_item_id = item.id
            if item.status == 0:
                await _retire_image(db, registration.image_url)
            family = await repos.get_family(db, body.family_id)
            family.revision += 1
            await db.flush()
            await db.refresh(item)
            result["item"] = _item_out(item)
            context["last_result"] = result
            context["pending"] = None
            context["turns"].append({"role": "assistant", **result})
            session.context_json = json.dumps(context, ensure_ascii=False)
            session.undo_json = json.dumps(undo, ensure_ascii=False)
            record = await repos.get_idempotency_for_update(db, user_id, idem_key)
            idempotency_service.complete(record, result)
            return result

        items = await repos.list_active_items(db, body.family_id)
        # 修改时只在内存中还原操作前的物品，已保存结果暂时不变。
        item_view = {item.id: _item_out(item) for item in items}
        if undo["created_item_id"] is not None:
            item_view.pop(undo["created_item_id"], None)
        if undo["item"] is not None:
            before = undo["item"]
            item_view[before["id"]] = dict(before)

    if body.event == "photo":
        judge = RecordJudgeOut.model_construct(**context["pending"])
    else:
        _emit(on_stage, "judging")
        judge = await semantic_provider.judge_record(
            body.transcript or "", list(item_view.values()), context=context,
        )
    context["pending"] = cast(RecordDecision, judge.model_dump())
    if judge.status == "ask":
        result = {
            "session_id": session_id, "status": "ask",
            "question_type": judge.question_type, "prompt": judge.prompt,
            "candidates": [
                {key: item_view[item_id][key] for key in ("id", "name", "location_text", "image_url")}
                for item_id in judge.candidate_item_ids
            ],
        }
    elif judge.operation == "create" and context["image_id"] is None:
        result = {"session_id": session_id, "status": "need_photo", "prompt": "请拍照或选择照片，完成这件物品的新增。"}
    else:
        _emit(on_stage, "writing")
        return await _finalize(db, user_id, body.family_id, session_id, context, undo, judge, idem_key)

    context["turns"].append({"role": "assistant", **result})
    async with db.begin():
        session.context_json = json.dumps(context, ensure_ascii=False)
        record = await repos.get_idempotency_for_update(db, user_id, idem_key)
        idempotency_service.complete(record, result)
    return result


async def _finalize(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    session_id: str,
    context: RecordContext,
    undo: RecordUndo,
    judge: RecordJudgeOut,
    idem_key: str,
) -> dict:
    """在一个事务内撤回上一结果、执行当前操作并保存新的操作快照。"""
    async with db.begin():
        if undo["created_item_id"] is not None:
            previous = await db.get(Item, undo["created_item_id"])
            previous.status = 0
            previous.deleted_at = utcnow()
            previous.version += 1
        if undo["item"] is not None:
            before = undo["item"]
            previous = await db.get(Item, before["id"])
            for field in ("name", "location_text", "record_text", "image_url", "status"):
                setattr(previous, field, before[field])
            previous.deleted_at = datetime.fromisoformat(before["deleted_at"]) if before["deleted_at"] else None
            previous.version += 1
        for before_image in undo["images"]:
            image = await db.get(UploadedImage, before_image["id"])
            image.bound_item_id = before_image["bound_item_id"]
            image.delete_state = before_image["delete_state"]
            image.delete_after = datetime.fromisoformat(before_image["delete_after"]) if before_image["delete_after"] else None
        await db.flush()

        target = await db.get(Item, judge.target_item_id) if judge.target_item_id is not None else None
        registration = await db.get(UploadedImage, context["image_id"]) if context["image_id"] is not None else None
        old_location = target.location_text if target is not None else None
        new_undo: RecordUndo = {"created_item_id": None, "item": None, "images": []}
        images = {}
        if target is not None:
            new_undo["item"] = {
                "id": target.id, "name": target.name, "location_text": target.location_text,
                "record_text": target.record_text, "image_url": target.image_url,
                "status": target.status, "deleted_at": target.deleted_at.isoformat() if target.deleted_at else None,
            }
            old_image = await repos.get_uploaded_image_by_url(db, target.image_url)
            images[old_image.id] = old_image
        if registration is not None and judge.operation != "delete":
            images[registration.id] = registration
        new_undo["images"] = [
            {
                "id": image.id, "bound_item_id": image.bound_item_id,
                "delete_state": image.delete_state,
                "delete_after": image.delete_after.isoformat() if image.delete_after else None,
            }
            for image in images.values()
        ]
        record_text = "\n".join(
            turn["transcript"] for turn in context["turns"]
            if turn["role"] == "user" and turn["transcript"]
        )
        if judge.operation == "create":
            if await repos.count_active_items(db, family_id) >= get_settings().max_family_items:
                raise AppError("FAMILY_ITEMS_FULL", "该家庭组物品记录已达上限", status_code=400)
            item = Item(
                family_id=family_id, created_by=user_id, name=judge.name,
                location_text=judge.location_text, record_text=record_text,
                image_url=registration.image_url, status=1, version=1,
            )
            db.add(item)
            await db.flush()
            new_undo["created_item_id"] = item.id
        else:
            item = target
            if judge.name:
                item.name = judge.name
            item.record_text = record_text
            item.version += 1
            if judge.operation == "delete":
                item.status = 0
                item.deleted_at = utcnow()
                await _retire_image(db, item.image_url)
            else:
                item.location_text = judge.location_text
                if registration is not None:
                    if item.image_url != registration.image_url:
                        await _retire_image(db, item.image_url)
                    item.image_url = registration.image_url
        if registration is not None and judge.operation != "delete":
            registration.bound_item_id = item.id
            registration.delete_state = "none"
            registration.delete_after = None

        family = await repos.get_family(db, family_id)
        family.revision += 1
        await db.flush()
        await db.refresh(item)
        result = {
            "session_id": session_id, "status": "saved", "operation": judge.operation,
            "item": _item_out(item), "old_location": old_location,
            "new_location": item.location_text if judge.operation != "delete" else None,
        }
        context["last_result"] = result
        context["pending"] = None
        context["turns"].append({"role": "assistant", **result})
        session = await db.get(RecordSession, session_id)
        session.context_json = json.dumps(context, ensure_ascii=False)
        session.undo_json = json.dumps(new_undo, ensure_ascii=False)
        record = await repos.get_idempotency_for_update(db, user_id, idem_key)
        idempotency_service.complete(record, result)
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
