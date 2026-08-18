"""统一错误定义与响应结构（文档 13.1 / 13.6）。"""
from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class AppError(Exception):
    """业务错误，序列化为统一错误响应。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable


# 文档 13.6 错误码
def auth_required(message: str = "登录已失效，请重新登录") -> AppError:
    return AppError("AUTH_REQUIRED", message, status_code=401)


def family_forbidden(message: str = "没有该家庭组的访问权限") -> AppError:
    return AppError("FAMILY_FORBIDDEN", message, status_code=403)


def image_invalid(message: str = "图片格式或大小不符合要求") -> AppError:
    return AppError("IMAGE_INVALID", message, status_code=400)


def image_upload_failed(message: str = "图片上传失败，请重试") -> AppError:
    return AppError("IMAGE_UPLOAD_FAILED", message, status_code=502, retryable=True)


def audio_too_short(message: str = "录音太短，请重新录入") -> AppError:
    return AppError("AUDIO_TOO_SHORT", message, status_code=400)


def transcribe_failed(message: str = "语音识别失败，请重试") -> AppError:
    return AppError("TRANSCRIBE_FAILED", message, status_code=502, retryable=True)


def record_parse_failed(message: str = "请重新说清楚物品和位置") -> AppError:
    return AppError("RECORD_PARSE_FAILED", message, status_code=422)


def record_failed(message: str = "入库失败，请重试") -> AppError:
    return AppError("RECORD_FAILED", message, status_code=500, retryable=True)


def search_failed(message: str = "查找失败，请重试") -> AppError:
    return AppError("SEARCH_FAILED", message, status_code=502, retryable=True)


def not_found(message: str = "记录不存在") -> AppError:
    return AppError("NOT_FOUND", message, status_code=404)


def rate_limited(message: str = "操作太频繁，请稍后重试") -> AppError:
    return AppError("RATE_LIMITED", message, status_code=429, retryable=True)


def ok(request: Request, data: Any) -> dict:
    return {"data": data, "request_id": getattr(request.state, "request_id", "")}


def error_body(request: Request, code: str, message: str, retryable: bool) -> dict:
    return {
        "error": {"code": code, "message": message, "retryable": retryable},
        "request_id": getattr(request.state, "request_id", ""),
    }


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(request, exc.code, exc.message, exc.retryable),
    )


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content=error_body(request, "VALIDATION_ERROR", "请求参数不正确", False),
    )


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content=error_body(request, "INTERNAL_ERROR", "服务异常，请重试", True),
    )
