"""认证与当前用户接口。"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import ok
from app.core.security import rate_limiter
from app.db.session import get_db
from app.models.tables import User
from app.schemas.schemas import WechatLoginRequest
from app.services import auth_service, family_service

router = APIRouter()


@router.post("/auth/wechat-login")
async def wechat_login(
    request: Request, body: WechatLoginRequest, db: AsyncSession = Depends(get_db)
):
    rate_limiter.check(f"login:{request.client.host if request.client else 'unknown'}", limit=10, window_seconds=60)
    data = await auth_service.wechat_login(db, body.code, body.nickname, body.avatar_url)
    return ok(request, data)


@router.get("/me")
async def me(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    families = await family_service.list_families(db, user.id)
    return ok(
        request,
        {
            "user": {"id": user.id, "nickname": user.nickname, "avatar_url": user.avatar_url},
            "families": families,
        },
    )
