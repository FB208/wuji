"""火山引擎大模型录音文件识别 2.0 标准版（submit + query 轮询）。

音频以 base64 内嵌提交（audio.data）：省掉"上传对象存储 → 火山回拉"一跳，
避免火山机房拉取自建 RustFS 慢导致的长 Processing。语音服务只负责转写（文档 11.4）。
"""
import asyncio
import base64
import time
import uuid
from typing import Callable

import httpx

from app.core.config import get_settings
from app.core.errors import transcribe_failed
from app.core.logging import get_logger

logger = get_logger(__name__)

_FORMAT_BY_EXT = {
    "mp3": "mp3", "wav": "wav", "ogg": "ogg",
    "aac": "aac", "m4a": "m4a", "spx": "spx", "amr": "amr",
}

_STATUS_SUCCESS = "20000000"
_STATUS_PENDING = {"20000001", "20000002"}  # 处理中 / 排队中
_STATUS_SILENT = "20000003"  # 静音音频

# 阶段回调：on_stage(stage, detail)，供任务注册表推进进度；可选
StageCallback = Callable[[str, str], None]


def _emit(on_stage: StageCallback | None, stage: str, detail: str = "") -> None:
    if on_stage is not None:
        on_stage(stage, detail)


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

    async def transcribe(
        self, audio: bytes, ext: str = "mp3", on_stage: StageCallback | None = None
    ) -> str:
        """base64 内嵌提交识别任务，轮询至出结果，返回转写文字。失败抛出 TRANSCRIBE_FAILED。"""
        settings = get_settings()
        started = time.monotonic()
        task_id = str(uuid.uuid4())
        audio_b64 = base64.b64encode(audio).decode("ascii")
        logger.info(
            "语音转写开始 task_id=%s bytes=%d ext=%s b64_len=%d",
            task_id, len(audio), ext, len(audio_b64),
        )
        async with httpx.AsyncClient(timeout=60) as client:
            _emit(on_stage, "asr_submit")
            await self._submit(client, settings, task_id, audio_b64, ext)
            _emit(on_stage, "asr_submitted")
            text = await self._poll(client, settings, task_id, on_stage)
            logger.info(
                "语音转写完成 task_id=%s 总耗时=%.1fs 字数=%d",
                task_id, time.monotonic() - started, len(text),
            )
            return text

    async def _submit(self, client, settings, task_id: str, audio_b64: str, ext: str) -> None:
        payload = {
            "audio": {"data": audio_b64, "format": _FORMAT_BY_EXT.get(ext, "mp3")},
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

    async def _poll(
        self, client, settings, task_id: str, on_stage: StageCallback | None = None
    ) -> str:
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
            _emit(on_stage, "asr_polling", str(round_no))
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
