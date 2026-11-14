"""火山引擎大模型录音文件识别 2.0 标准版（submit + query 轮询）。

标准版仅接收音频公网 URL：录音先上传 RustFS 临时对象，取公开链接提交识别，
轮询拿到结果后删除临时对象。语音服务只负责转写，不负责业务判断（文档 11.4）。
"""
import asyncio
import time
import uuid

import httpx

from app.core.config import get_settings
from app.core.errors import transcribe_failed
from app.core.logging import get_logger
from app.providers.rustfs import rustfs_provider

logger = get_logger(__name__)

_FORMAT_BY_EXT = {
    "mp3": "mp3", "wav": "wav", "ogg": "ogg",
    "aac": "aac", "m4a": "m4a", "spx": "spx", "amr": "amr",
}
_CONTENT_TYPE_BY_EXT = {
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
    "aac": "audio/aac", "m4a": "audio/mp4",
}

_STATUS_SUCCESS = "20000000"
_STATUS_PENDING = {"20000001", "20000002"}  # 处理中 / 排队中
_STATUS_SILENT = "20000003"  # 静音音频


class VolcSpeechProvider:
    @staticmethod
    def _submit_url(settings) -> str:
        return f"{settings.volc_speech_base_url.rstrip('/')}/api/v3/auc/bigmodel/submit"

    @staticmethod
    def _query_url(settings) -> str:
        return f"{settings.volc_speech_base_url.rstrip('/')}/api/v3/auc/bigmodel/query"

    @staticmethod
    def _headers(settings, request_id: str, *, submit: bool) -> dict:
        headers = {
            "X-Api-Key": settings.volc_speech_api_key,
            "X-Api-Resource-Id": settings.volc_speech_resource_id,
            "X-Api-Request-Id": request_id,
        }
        if submit:
            headers["X-Api-Sequence"] = "-1"
        return headers

    async def transcribe(self, audio: bytes, ext: str = "mp3") -> str:
        """上传临时音频并提交识别任务，轮询至出结果，返回转写文字。失败抛出 TRANSCRIBE_FAILED。"""
        settings = get_settings()
        started = time.monotonic()
        task_id = str(uuid.uuid4())
        logger.info("语音转写开始 task_id=%s bytes=%d ext=%s", task_id, len(audio), ext)
        object_key = rustfs_provider.build_tmp_audio_key(ext)
        await rustfs_provider.upload_object(
            object_key, audio, _CONTENT_TYPE_BY_EXT.get(ext, "application/octet-stream")
        )
        audio_url = rustfs_provider.public_url(object_key)
        logger.info(
            "语音临时对象就绪 task_id=%s 上传耗时=%.1fs url=%s",
            task_id, time.monotonic() - started, audio_url,
        )
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                await self._submit(client, settings, task_id, audio_url, ext)
                text = await self._poll(client, settings, task_id)
                logger.info(
                    "语音转写完成 task_id=%s 总耗时=%.1fs 字数=%d",
                    task_id, time.monotonic() - started, len(text),
                )
                return text
        finally:
            try:
                await rustfs_provider.delete_object(object_key)
            except Exception:
                logger.warning("临时语音对象清理失败：%s", object_key)

    async def _submit(self, client, settings, task_id: str, audio_url: str, ext: str) -> None:
        payload = {
            "audio": {"url": audio_url, "format": _FORMAT_BY_EXT.get(ext, "mp3")},
            "request": {"model_name": "bigmodel"},
        }
        try:
            resp = await client.post(
                self._submit_url(settings),
                json=payload,
                headers=self._headers(settings, task_id, submit=True),
            )
        except httpx.HTTPError as exc:
            logger.error("语音识别任务提交失败：%s", exc)
            raise transcribe_failed() from exc
        code = resp.headers.get("X-Api-Status-Code", "")
        if resp.status_code != 200 or code != _STATUS_SUCCESS:
            logger.error(
                "语音识别提交返回异常：http=%s api_status=%s msg=%s",
                resp.status_code, code, resp.headers.get("X-Api-Message", ""),
            )
            raise transcribe_failed()
        logger.info("语音识别提交成功 task_id=%s", task_id)

    async def _poll(self, client, settings, task_id: str) -> str:
        deadline = time.monotonic() + settings.volc_speech_max_wait_seconds
        url = self._query_url(settings)
        headers = self._headers(settings, task_id, submit=False)
        round_no = 0
        while True:
            try:
                resp = await client.post(url, json={}, headers=headers)
            except httpx.HTTPError as exc:
                logger.error("语音识别结果查询失败 task_id=%s：%s", task_id, exc)
                raise transcribe_failed() from exc

            code = resp.headers.get("X-Api-Status-Code", "")
            round_no += 1
            logger.info(
                "语音识别轮询 task_id=%s 第%d轮 api_status=%s msg=%s",
                task_id, round_no, code, resp.headers.get("X-Api-Message", ""),
            )
            if resp.status_code == 200 and code == _STATUS_SUCCESS:
                try:
                    text = (resp.json().get("result") or {}).get("text", "")
                except Exception as exc:
                    raise transcribe_failed() from exc
                text = (text or "").strip()
                if not text:
                    raise transcribe_failed("没有识别到有效内容，请重新说一次")
                return text
            if code in _STATUS_PENDING:
                if time.monotonic() >= deadline:
                    raise transcribe_failed("语音识别超时，请重试")
                await asyncio.sleep(settings.volc_speech_poll_interval_seconds)
                continue
            logger.error(
                "语音识别查询返回异常 task_id=%s 第%d轮：http=%s api_status=%s msg=%s",
                task_id, round_no, resp.status_code, code, resp.headers.get("X-Api-Message", ""),
            )
            if code == _STATUS_SILENT:
                raise transcribe_failed("没有识别到有效内容，请重新说一次")
            raise transcribe_failed()


speech_provider = VolcSpeechProvider()
