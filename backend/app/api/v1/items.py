"""媒体、语音、入库、查找与物品维护接口（文档 13.2～13.5）。"""
import json

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import AppError, audio_too_long, audio_too_short, ok, search_failed
from app.core.logging import get_logger
from app.core.security import rate_limiter
from app.db.session import get_db
from app.models.tables import User
from app.providers.speech import speech_provider
from app.schemas.schemas import (
    ItemPatchRequest,
    ItemRecordRequest,
    SearchTextRequest,
)
from app.services import record_service, search_service
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


# ---------- 语音转写 ----------
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
    transcript = await speech_provider.transcribe(content, _audio_ext(audio.filename))
    return ok(request, {"transcript": transcript})


# ---------- 入库 ----------
@router.post("/items/record")
async def record_item(
    request: Request,
    body: ItemRecordRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rate_limiter.check(f"record:{user.id}", limit=20, window_seconds=60)
    data = await record_service.record_item(
        db, user.id, body.family_id, body.image_token, body.transcript, idempotency_key
    )
    return ok(request, data)


# ---------- 查找 ----------
@router.post("/items/search/audio")
async def search_audio(
    request: Request,
    family_id: int = Form(...),
    audio: UploadFile = File(...),
    context_json: str | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rate_limiter.check(f"search:{user.id}", limit=30, window_seconds=60)
    content = await audio.read()
    if len(content) < MIN_AUDIO_BYTES:
        raise audio_too_short()
    if len(content) > MAX_AUDIO_BYTES:
        raise audio_too_long()
    logger.info("收到查找录音 user=%d bytes=%d name=%s", user.id, len(content), audio.filename)
    context = None
    if context_json:
        try:
            context = json.loads(context_json)
        except json.JSONDecodeError as exc:
            raise AppError("VALIDATION_ERROR", "查找上下文格式无效", status_code=400, retryable=False) from exc
    data = await search_service.search_by_audio(
        db, user.id, family_id, content, _audio_ext(audio.filename), context
    )
    return ok(request, data)


@router.post("/items/search/text")
async def search_text(
    request: Request,
    body: SearchTextRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rate_limiter.check(f"search:{user.id}", limit=30, window_seconds=60)
    data = await search_service.search_by_text(db, user.id, body.family_id, body.query, body.context)
    return ok(request, data)


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
