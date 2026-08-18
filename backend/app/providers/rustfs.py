"""RustFS（S3 兼容）对象存储：图片上传、删除（文档 10.5 / 14.4）。"""
import asyncio
import uuid
from datetime import datetime, timezone

import boto3
from botocore.config import Config as BotoConfig

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_CONTENT_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}


class RustFSProvider:
    def __init__(self) -> None:
        settings = get_settings()
        self._settings = settings
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.rustfs_endpoint,
            aws_access_key_id=settings.rustfs_access_key,
            aws_secret_access_key=settings.rustfs_secret_key,
            config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    def build_object_key(self, family_id: int, ext: str) -> str:
        """对象路径：items/{family_id}/{yyyyMM}/{uuid}.{ext}（文档 10.5）。"""
        month = datetime.now(timezone.utc).strftime("%Y%m")
        return f"items/{family_id}/{month}/{uuid.uuid4().hex}.{ext}"

    def public_url(self, object_key: str) -> str:
        return f"{self._settings.rustfs_public_base_url.rstrip('/')}/{object_key}"

    async def upload_image(self, object_key: str, content: bytes, ext: str) -> str:
        def _put() -> None:
            self._client.put_object(
                Bucket=self._settings.rustfs_bucket,
                Key=object_key,
                Body=content,
                ContentType=_CONTENT_TYPES.get(ext, "application/octet-stream"),
            )

        await asyncio.to_thread(_put)
        return self.public_url(object_key)

    async def delete_object(self, object_key: str) -> None:
        def _delete() -> None:
            self._client.delete_object(Bucket=self._settings.rustfs_bucket, Key=object_key)

        try:
            await asyncio.to_thread(_delete)
        except Exception:
            logger.warning("删除对象失败：%s", object_key)


rustfs_provider = RustFSProvider()
