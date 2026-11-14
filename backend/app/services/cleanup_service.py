"""定时清理任务：删除未入库图片和延迟清理的旧图片（文档 4.5 / 6.4 / 10.3）。"""
import asyncio
from datetime import datetime, timedelta, timezone

from app.core.logging import get_logger
from app.db.session import SessionLocal
from app.providers.rustfs import rustfs_provider
from app.repositories import repos

logger = get_logger(__name__)

CLEANUP_INTERVAL_SECONDS = 3600
UNUSED_IMAGE_RETAIN_HOURS = 24


async def cleanup_once() -> int:
    """删除可清理图片，返回删除数量。"""
    unused_before = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        hours=UNUSED_IMAGE_RETAIN_HOURS
    )
    deleted = 0
    async with SessionLocal() as db:
        images = await repos.list_cleanable_images(db, unused_before)
        for image in images:
            try:
                await rustfs_provider.delete_object(image.object_key)
            except Exception as exc:
                logger.warning("删除对象失败，保留登记待下轮重试：%s %s", image.object_key, exc)
                continue
            await db.delete(image)
            deleted += 1
        await db.commit()
    if deleted:
        logger.info("图片清理完成：%s 张", deleted)
    return deleted


async def cleanup_loop() -> None:
    while True:
        try:
            await cleanup_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("图片清理任务异常：%s", exc)
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
