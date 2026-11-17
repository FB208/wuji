"""账号资料保存与自有头像清理。"""
import asyncio
import io
import re
import uuid

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.logging import get_logger
from app.models.tables import User
from app.providers.rustfs import rustfs_provider
from app.services.auth_service import user_payload

logger = get_logger(__name__)
MAX_AVATAR_BYTES = 5 * 1024 * 1024


def normalize_avatar(content: bytes) -> bytes:
    """验证真实图片并缩放为不超过 512px 的头像，去除原始元数据。"""
    if not content or len(content) > MAX_AVATAR_BYTES:
        raise AppError("INVALID_AVATAR", "头像大小须在 5MB 以内", status_code=400)
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"} or image.width * image.height > 16_000_000:
                raise ValueError("unsupported image")
            image.load()
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((512, 512))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=90)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise AppError("INVALID_AVATAR", "请选择有效的 JPG、PNG 或 WebP 图片", status_code=400) from exc


async def delete_owned_avatar(user_id: int, avatar_url: str | None) -> None:
    """仅删除当前用户头像目录内由服务端生成的对象。"""
    prefix = rustfs_provider.public_url(f"avatars/{user_id}/")
    if not avatar_url or not avatar_url.startswith(prefix):
        return
    filename = avatar_url[len(prefix):]
    if not re.fullmatch(r"[0-9a-f]{32}\.jpg", filename):
        return
    await rustfs_provider.delete_object(f"avatars/{user_id}/{filename}")


async def update_profile(
    db: AsyncSession, user_id: int, nickname: str, avatar: bytes | None = None,
) -> dict:
    """串行更新账号资料，头像上传完成后再提交昵称和头像。"""
    nickname = nickname.strip()
    if not 1 <= len(nickname) <= 32:
        raise AppError("INVALID_NICKNAME", "昵称须为 1～32 个字符", status_code=400)
    content = await asyncio.to_thread(normalize_avatar, avatar) if avatar is not None else None
    user = await db.scalar(
        select(User).where(User.id == user_id).with_for_update().execution_options(populate_existing=True)
    )
    if user is None:
        raise AppError("AUTH_REQUIRED", "请重新登录", status_code=401)
    old_avatar = user.avatar_url
    new_avatar = None
    try:
        if content is not None:
            key = f"avatars/{user_id}/{uuid.uuid4().hex}.jpg"
            new_avatar = await rustfs_provider.upload_image(key, content, "jpg")
            user.avatar_url = new_avatar
        user.nickname = nickname
        await db.flush()
        result = user_payload(user)
        await db.commit()
    except Exception:
        await db.rollback()
        if new_avatar:
            await delete_owned_avatar(user_id, new_avatar)
        raise
    if new_avatar:
        try:
            await delete_owned_avatar(user_id, old_avatar)
        except Exception:
            logger.exception("清理旧头像失败 user=%d", user_id)
    return result
