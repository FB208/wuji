"""JWT 访问令牌、签名令牌（邀请 / 图片）与简单限流。"""
import base64
import hashlib
import hmac
import json
import secrets
import time
from collections import defaultdict, deque
from typing import Any

from app.core.config import get_settings
from app.core.errors import auth_required, rate_limited


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _sign(payload_b64: str, secret: str) -> str:
    sig = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    return _b64encode(sig)


USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # 去掉易混淆的 0/O/1/I/L
USER_CODE_LENGTH = 8


def generate_user_code() -> str:
    """生成 8 位随机用户 ID（约 8.5e11 种组合）。"""
    return "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(USER_CODE_LENGTH))


def normalize_user_code(raw: str) -> str:
    """用户输入的 ID 去空格并转大写。"""
    return "".join(raw.split()).upper()


def create_signed_token(payload: dict[str, Any], *, ttl_seconds: int, purpose: str) -> str:
    """生成带过期时间和用途的签名令牌（用于访问令牌、邀请令牌、图片令牌）。"""
    settings = get_settings()
    body = dict(payload)
    body["exp"] = int(time.time()) + ttl_seconds
    body["purpose"] = purpose
    payload_b64 = _b64encode(json.dumps(body, separators=(",", ":")).encode("utf-8"))
    return f"{payload_b64}.{_sign(payload_b64, settings.jwt_secret)}"


def verify_signed_token(token: str, *, purpose: str) -> dict[str, Any] | None:
    """校验令牌签名、过期时间和用途，失败返回 None。"""
    settings = get_settings()
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(payload_b64, settings.jwt_secret)):
        return None
    try:
        body = json.loads(_b64decode(payload_b64))
    except Exception:
        return None
    if body.get("purpose") != purpose:
        return None
    if int(body.get("exp", 0)) < time.time():
        return None
    return body


def create_access_token(user_id: int) -> str:
    settings = get_settings()
    return create_signed_token(
        {"uid": user_id},
        ttl_seconds=settings.jwt_access_ttl_minutes * 60,
        purpose="access",
    )


def parse_access_token(token: str) -> int:
    body = verify_signed_token(token, purpose="access")
    if body is None or "uid" not in body:
        raise auth_required()
    return int(body["uid"])


class RateLimiter:
    """内存滑动窗口限流：登录、录入和查找接口分别设置用户级限流（文档 14.2）。"""

    def __init__(self) -> None:
        self._buckets: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str, *, limit: int, window_seconds: int) -> None:
        now = time.time()
        bucket = self._buckets[key]
        while bucket and bucket[0] < now - window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            raise rate_limited()
        bucket.append(now)


rate_limiter = RateLimiter()
