"""家庭组接口（文档 13.2）。"""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import ok
from app.db.session import get_db
from app.models.tables import User
from app.schemas.schemas import (
    FamilyCreateRequest,
    FamilyJoinRequest,
    FamilyPatchRequest,
    FamilyTransferRequest,
)
from app.services import family_service

router = APIRouter()


@router.get("/families")
async def list_families(
    request: Request, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return ok(request, {"families": await family_service.list_families(db, user.id)})


@router.post("/families")
async def create_family(
    request: Request,
    body: FamilyCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return ok(request, await family_service.create_family(db, user.id, body.name))


# 同时接受 POST：微信小程序 wx.request 不支持 PATCH 方法
@router.api_route("/families/{family_id}", methods=["PATCH", "POST"])
async def rename_family(
    request: Request,
    family_id: int,
    body: FamilyPatchRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return ok(request, await family_service.rename_family(db, family_id, user.id, body.name))


@router.post("/families/{family_id}/invite")
async def create_invite(
    request: Request,
    family_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return ok(request, await family_service.create_invite(db, family_id, user.id))


@router.get("/families/invite-preview")
async def preview_invite(
    request: Request,
    invite_token: str = Query(min_length=1),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return ok(request, await family_service.preview_invite(db, invite_token))


@router.post("/families/join")
async def join_family(
    request: Request,
    body: FamilyJoinRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return ok(request, await family_service.join_family(db, user.id, body.invite_token))


@router.get("/families/{family_id}/members")
async def list_members(
    request: Request,
    family_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return ok(request, {"members": await family_service.list_members(db, family_id, user.id)})


@router.delete("/families/{family_id}/members/{user_id}")
async def remove_member(
    request: Request,
    family_id: int,
    user_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await family_service.remove_member(db, family_id, user.id, user_id)
    return ok(request, {"removed": True})


@router.post("/families/{family_id}/transfer")
async def transfer_family(
    request: Request,
    family_id: int,
    body: FamilyTransferRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    data = await family_service.transfer_ownership(db, family_id, user.id, body.user_id)
    return ok(request, data)


@router.delete("/families/{family_id}")
async def dissolve_family(
    request: Request,
    family_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await family_service.dissolve_family(db, family_id, user.id)
    return ok(request, {"dissolved": True})


@router.post("/families/{family_id}/purge-deleted")
async def purge_deleted_items(
    request: Request,
    family_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    count = await family_service.purge_deleted_items(db, family_id, user.id)
    return ok(request, {"purged": count})
