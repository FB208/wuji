"""火山引擎大模型录音文件识别（极速版）HTTP 接口。

语音服务只负责转写，不负责业务判断（文档 11.4）。
"""
import base64
import uuid

import httpx

from app.core.config import get_settings
from app.core.errors import transcribe_failed
from app.core.logging import get_logger

logger = get_logger(__name__)

_FORMAT_BY_EXT = {"mp3": "mp3", "wav": "wav", "aac": "aac", "m4a": "aac", "ogg": "ogg"}


class VolcSpeechProvider:
    async def transcribe(self, audio: bytes, ext: str = "mp3") -> str:
        """提交完整录音文件，返回转写文字。失败抛出 TRANSCRIBE_FAILED。"""
        settings = get_settings()
        headers = {
            "X-Api-App-Key": settings.volc_speech_app_id,
            "X-Api-Access-Key": settings.volc_speech_access_token,
            "X-Api-Resource-Id": settings.volc_speech_resource_id,
            "X-Api-Request-Id": str(uuid.uuid4()),
            "X-Api-Sequence": "-1",
        }
        payload = {
            "user": {"uid": "wuji-backend"},
            "audio": {
                "data": base64.b64encode(audio).decode("ascii"),
                "format": _FORMAT_BY_EXT.get(ext, "mp3"),
            },
            "request": {"model_name": "bigmodel"},
        }
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(settings.volc_speech_endpoint, json=payload, headers=headers)
        except httpx.HTTPError as exc:
            logger.error("语音识别请求失败：%s", exc)
            raise transcribe_failed() from exc

        status_code = resp.headers.get("X-Api-Status-Code", "")
        if resp.status_code != 200 or (status_code and status_code != "20000000"):
            logger.error(
                "语音识别返回异常：http=%s api_status=%s msg=%s",
                resp.status_code,
                status_code,
                resp.headers.get("X-Api-Message", ""),
            )
            raise transcribe_failed()

        try:
            body = resp.json()
            text = (body.get("result") or {}).get("text", "")
        except Exception as exc:
            raise transcribe_failed() from exc

        text = (text or "").strip()
        if not text:
            raise transcribe_failed("没有识别到有效内容，请重新说一次")
        return text


speech_provider = VolcSpeechProvider()
