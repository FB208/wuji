"""认证与当前用户接口。"""
from fastapi import APIRouter, Body, Depends, File, Form, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import ok
from app.core.security import rate_limiter
from app.db.session import get_db
from app.models.tables import User
from app.schemas.schemas import WechatLoginRequest
from app.services import auth_service, family_service, profile_service

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
            "user": auth_service.user_payload(user),
            "families": families,
        },
    )


@router.post("/me/profile")
async def update_profile(
    request: Request,
    nickname: str = Body(..., embed=True),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """仅修改昵称时无需上传头像。"""
    rate_limiter.check(f"profile:{user.id}", limit=20, window_seconds=60)
    return ok(request, await profile_service.update_profile(db, user.id, nickname))


@router.post("/me/profile/avatar")
async def update_profile_with_avatar(
    request: Request,
    nickname: str = Form(...),
    avatar: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """一次提交头像和昵称，图片按账号保存。"""
    rate_limiter.check(f"profile:{user.id}", limit=20, window_seconds=60)
    content = await avatar.read(profile_service.MAX_AVATAR_BYTES + 1)
    return ok(request, await profile_service.update_profile(db, user.id, nickname, content))


@router.delete("/me")
async def delete_me(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await family_service.delete_account(db, user.id)
    return ok(request, {"deleted": True})
