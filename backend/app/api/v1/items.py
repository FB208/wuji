"""媒体、语音、入库与物品维护接口。"""
import asyncio
import json

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import (
    AppError,
    audio_too_long,
    audio_too_short,
    not_found,
    ok,
    record_failed,
)
from app.core.logging import get_logger
from app.core.security import rate_limiter
from app.db.session import SessionLocal, get_db
from app.models.tables import RecordSession, User
from app.providers.speech import speech_provider
from app.schemas.schemas import (
    ItemPatchRequest,
    ItemRecordRequest,
)
from app.repositories import repos
from app.services import idempotency_service, record_service, tasks
from app.services.family_service import require_membership

router = APIRouter()
logger = get_logger(__name__)

# 录音下限约 1 秒（文档 1.4）：以最低码率估算的字节数下限
MIN_AUDIO_BYTES = 1000
# 上限 60 秒的宽松字节上限；超长文件直接拒绝
MAX_AUDIO_BYTES = 4 * 1024 * 1024


def _audio_ext(filename: str | None) -> str:
    if filename and "." in filename:
        return filename.rsplit(".", 1)[-1].lower()
    return "mp3"


# ---------- 媒体 ----------
@router.post("/media/images")
async def upload_image(
    request: Request,
    family_id: int = Form(...),
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rate_limiter.check(f"upload:{user.id}", limit=30, window_seconds=60)
    content = await image.read()
    logger.info("收到图片 user=%d bytes=%d name=%s", user.id, len(content), image.filename)
    data = await record_service.upload_image(db, user.id, family_id, image.filename or "", content)
    return ok(request, data)


# ---------- 语音转写（任务化：先拿 task_id，轮询 GET /tasks/{id} 取结果） ----------
@router.post("/speech/transcribe")
async def transcribe(
    request: Request,
    audio: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    rate_limiter.check(f"speech:{user.id}", limit=30, window_seconds=60)
    content = await audio.read()
    if len(content) < MIN_AUDIO_BYTES:
        raise audio_too_short()
    if len(content) > MAX_AUDIO_BYTES:
        raise audio_too_long()
    logger.info("收到录音 user=%d bytes=%d name=%s", user.id, len(content), audio.filename)
    task = tasks.create("speech", user.id)
    asyncio.create_task(_speech_job(task.id, content, _audio_ext(audio.filename)))
    return ok(request, {"task_id": task.id})


async def _speech_job(task_id: str, content: bytes, ext: str) -> None:
    try:
        transcript = await speech_provider.transcribe(
            content, ext, on_stage=lambda s, d="": tasks.set_stage(task_id, s, d)
        )
    except Exception as exc:
        tasks.fail(task_id, exc)
        return
    tasks.finish(task_id, {"transcript": transcript})


# ---------- 入库（任务化） ----------
@router.post("/items/record")
async def record_item(
    request: Request,
    body: ItemRecordRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """在收纳入口处理本次请求资源，再交给后台任务执行。"""
    rate_limiter.check(f"record:{user.id}", limit=20, window_seconds=60)
    key = idempotency_service.validate_idem_key(idempotency_key)
    existing = tasks.find_by_idem(user.id, key)
    if existing is not None:
        return ok(request, {"task_id": existing.id})
    req_hash = idempotency_service.request_hash("record", body.model_dump())
    image_id = None
    async with db.begin():
        await require_membership(db, body.family_id, user.id)
        reserved = await idempotency_service.reserve(db, user.id, body.family_id, "record", key, req_hash)
        if isinstance(reserved, dict):
            task = tasks.create("record", user.id, idem_key=key)
            tasks.finish(task.id, reserved)
            return ok(request, {"task_id": task.id})
        if body.session_id is not None:
            session = await db.get(RecordSession, body.session_id)
            if session is None or session.user_id != user.id or session.family_id != body.family_id:
                raise not_found("本轮记录不存在，请开始下一条")
            context = json.loads(session.context_json)
            pending = context["pending"]
            if body.event == "choose_item" and (pending is None or body.target_item_id not in pending["candidate_item_ids"]):
                raise AppError("VALIDATION_ERROR", "请选择本次列出的物品", status_code=400)
            if body.event == "photo" and (pending is None or pending["status"] != "ready"):
                raise AppError("VALIDATION_ERROR", "请先说明要执行的操作", status_code=400)
        if body.image_token is not None:
            image = record_service.resolve_image_token(body.image_token, body.family_id)
            registration = record_service._check_image_registration(
                await repos.get_uploaded_image_by_key(db, image["object_key"]), body.family_id, for_bind=True,
            )
            image_id = registration.id
        lease_token = reserved.lease_token
    task = tasks.create("record", user.id, idem_key=key)
    asyncio.create_task(_record_job(task.id, user.id, body, image_id, key, lease_token))
    return ok(request, {"task_id": task.id})


async def _record_job(
    task_id: str,
    user_id: int,
    body: ItemRecordRequest,
    image_id: int | None,
    idem_key: str,
    lease_token: str,
) -> None:
    """执行本次收纳输入，并记录任务结果或失败。"""
    async with SessionLocal() as db:
        try:
            data = await record_service.record_item(
                db, user_id, body, image_id, idem_key,
                on_stage=lambda s, d="": tasks.set_stage(task_id, s, d),
            )
        except Exception as exc:
            error = exc if isinstance(exc, AppError) else record_failed()
            await idempotency_service.mark_failed(db, user_id, idem_key, lease_token, error)
            logger.error("收纳处理失败：%s", exc)
            tasks.fail(task_id, error)
            return
    tasks.finish(task_id, data)


# ---------- 任务状态轮询 ----------
@router.get("/tasks/{task_id}")
async def task_status(
    request: Request,
    task_id: str,
    user: User = Depends(get_current_user),
):
    task = tasks.get(task_id, user.id)
    if task is None:
        raise not_found("任务不存在或已过期")
    return ok(request, tasks.snapshot(task))


# ---------- 物品维护 ----------
@router.get("/items")
async def list_items(
    request: Request,
    family_id: int = Query(...),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    data = await record_service.list_items(db, user.id, family_id, q, page, page_size)
    return ok(request, data)


@router.get("/items/{item_id}")
async def item_detail(
    request: Request,
    item_id: int,
    family_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return ok(request, await record_service.get_item_detail(db, user.id, family_id, item_id))


# 同时接受 POST：微信小程序 wx.request 不支持 PATCH 方法
@router.api_route("/items/{item_id}", methods=["PATCH", "POST"])
async def patch_item(
    request: Request,
    item_id: int,
    body: ItemPatchRequest,
    family_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    data = await record_service.patch_item(
        db, user.id, family_id, item_id, body.name, body.location_text, body.image_token,
        body.expected_version,
    )
    return ok(request, data)


@router.delete("/items/{item_id}")
async def delete_item(
    request: Request,
    item_id: int,
    family_id: int = Query(...),
    expected_version: int = Query(..., ge=1),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await record_service.delete_item(db, user.id, family_id, item_id, expected_version)
    return ok(request, {"deleted": True})
