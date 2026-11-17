"""微信登录：code 换取身份，首次登录自动创建“我的家”（文档 7.1）。"""
import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import get_logger
from app.core.security import create_access_token, generate_user_code
from app.models.tables import Family, FamilyMember, User
from app.repositories import repos

logger = get_logger(__name__)

WECHAT_CODE2SESSION_URL = "https://api.weixin.qq.com/sns/jscode2session"


async def _code2session(code: str) -> dict:
    settings = get_settings()
    params = {
        "appid": settings.wechat_app_id,
        "secret": settings.wechat_app_secret,
        "js_code": code,
        "grant_type": "authorization_code",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(WECHAT_CODE2SESSION_URL, params=params)
        body = resp.json()
    except Exception as exc:
        logger.error("微信登录请求失败：%s", exc)
        raise AppError("AUTH_REQUIRED", "微信登录失败，请重试", status_code=502, retryable=True) from exc

    if "openid" not in body:
        logger.warning("微信登录返回异常：errcode=%s", body.get("errcode"))
        raise AppError("AUTH_REQUIRED", "微信登录失败，请重新进入", status_code=401)
    return body


def user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "user_code": user.user_code,
        "nickname": user.nickname,
        "avatar_url": user.avatar_url,
        "default_family_id": user.default_family_id,
    }


async def _new_user_code(db: AsyncSession) -> str:
    for _ in range(10):
        code = generate_user_code()
        if await repos.get_user_by_code(db, code) is None:
            return code
    raise AppError("INTERNAL_ERROR", "生成用户ID失败，请重试", status_code=500, retryable=True)


async def wechat_login(
    db: AsyncSession, code: str, nickname: str | None, avatar_url: str | None
) -> dict:
    session = await _code2session(code)
    openid: str = session["openid"]
    unionid: str | None = session.get("unionid")

    user = await repos.get_user_by_openid(db, openid)
    if user is None:
        user = User(
            openid=openid,
            user_code=await _new_user_code(db),
            unionid=unionid,
            nickname=nickname,
            avatar_url=avatar_url,
        )
        db.add(user)
        await db.flush()
        # 首次登录自动创建个人家庭组“我的家”
        family = Family(name="我的家", owner_user_id=user.id)
        db.add(family)
        await db.flush()
        db.add(FamilyMember(family_id=family.id, user_id=user.id, role="owner"))
        await db.commit()
        current_family_id = family.id
    else:
        families = await repos.list_user_families(db, user.id)
        if families:
            family_ids = {family.id for family, _ in families}
            current_family_id = (
                user.default_family_id if user.default_family_id in family_ids else families[0][0].id
            )
        else:
            # 兜底：用户存在但没有任何家庭组
            family = Family(name="我的家", owner_user_id=user.id)
            db.add(family)
            await db.flush()
            db.add(FamilyMember(family_id=family.id, user_id=user.id, role="owner"))
            current_family_id = family.id
        await db.commit()

    return {
        "access_token": create_access_token(user.id),
        "user": user_payload(user),
        "current_family_id": current_family_id,
    }
