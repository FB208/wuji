"""家庭组：创建、改名、邀请、加入、成员管理（文档 7 章）。"""
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, family_forbidden, not_found
from app.core.security import create_signed_token, verify_signed_token
from app.models.tables import Family, FamilyMember
from app.repositories import repos


async def require_membership(db: AsyncSession, family_id: int, user_id: int) -> FamilyMember:
    """后端不信任客户端 family_id，必须校验成员关系（文档 7.4 / 14.2）。"""
    member = await repos.get_membership(db, family_id, user_id)
    if member is None:
        raise family_forbidden()
    return member


async def require_owner(db: AsyncSession, family_id: int, user_id: int) -> FamilyMember:
    member = await require_membership(db, family_id, user_id)
    if member.role != "owner":
        raise family_forbidden("仅家庭组所有者可执行该操作")
    return member


async def list_families(db: AsyncSession, user_id: int) -> list[dict]:
    result = []
    for family, role in await repos.list_user_families(db, user_id):
        result.append(
            {
                "id": family.id,
                "name": family.name,
                "owner_user_id": family.owner_user_id,
                "role": role,
                "member_count": await repos.count_family_members(db, family.id),
            }
        )
    return result


async def create_family(db: AsyncSession, user_id: int, name: str) -> dict:
    family = Family(name=name, owner_user_id=user_id)
    db.add(family)
    await db.flush()
    db.add(FamilyMember(family_id=family.id, user_id=user_id, role="owner"))
    await db.commit()
    return {"id": family.id, "name": family.name, "owner_user_id": user_id, "role": "owner", "member_count": 1}


async def rename_family(db: AsyncSession, family_id: int, user_id: int, name: str) -> dict:
    await require_owner(db, family_id, user_id)
    family = await repos.get_family(db, family_id)
    if family is None:
        raise not_found("家庭组不存在")
    family.name = name
    await db.commit()
    return {"id": family.id, "name": family.name, "owner_user_id": family.owner_user_id, "role": "owner"}


def _invite_purpose() -> str:
    return "family_invite"


async def create_invite(db: AsyncSession, family_id: int, user_id: int) -> dict:
    """邀请令牌使用服务端签名生成，有效期 7 天，不需要额外数据表（文档 12.4）。"""
    await require_owner(db, family_id, user_id)
    settings = get_settings()
    ttl_seconds = settings.invite_ttl_days * 24 * 3600
    token = create_signed_token({"fid": family_id}, ttl_seconds=ttl_seconds, purpose=_invite_purpose())
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    return {
        "invite_token": token,
        "share_path": f"pages/family-join/index?invite_token={token}",
        "expires_at": expires_at.isoformat(),
    }


async def preview_invite(db: AsyncSession, invite_token: str) -> dict:
    """加入前必须显示家庭组名称（文档 14.3）。"""
    body = verify_signed_token(invite_token, purpose=_invite_purpose())
    if body is None:
        raise AppError("INVITE_INVALID", "邀请已失效，请让家人重新分享", status_code=400)
    family = await repos.get_family(db, int(body["fid"]))
    if family is None:
        raise AppError("INVITE_INVALID", "家庭组不存在", status_code=400)
    owner = await repos.get_user(db, family.owner_user_id)
    return {
        "family_id": family.id,
        "family_name": family.name,
        "owner_nickname": owner.nickname if owner else None,
    }


async def join_family(db: AsyncSession, user_id: int, invite_token: str) -> dict:
    preview = await preview_invite(db, invite_token)
    family_id = preview["family_id"]
    existing = await repos.get_membership(db, family_id, user_id)
    if existing is None:
        db.add(FamilyMember(family_id=family_id, user_id=user_id, role="member"))
        await db.commit()
    return {"family_id": family_id, "family_name": preview["family_name"]}


async def list_members(db: AsyncSession, family_id: int, user_id: int) -> list[dict]:
    await require_membership(db, family_id, user_id)
    result = []
    for member, user in await repos.list_family_members(db, family_id):
        result.append(
            {
                "user_id": user.id,
                "nickname": user.nickname,
                "avatar_url": user.avatar_url,
                "role": member.role,
                "joined_at": member.created_at.isoformat(),
            }
        )
    return result


async def remove_member(db: AsyncSession, family_id: int, operator_id: int, target_user_id: int) -> None:
    """所有者移除成员；成员可退出（移除自己）；所有者需先转让或解散（文档 7.2）。"""
    member = await require_membership(db, family_id, operator_id)
    if operator_id == target_user_id:
        if member.role == "owner":
            raise AppError("OWNER_CANNOT_LEAVE", "所有者需先转让或解散家庭组", status_code=400)
    elif member.role != "owner":
        raise family_forbidden("仅家庭组所有者可移除成员")

    target = await repos.get_membership(db, family_id, target_user_id)
    if target is None:
        raise not_found("成员不存在")
    if target.role == "owner" and operator_id != target_user_id:
        raise family_forbidden("不能移除家庭组所有者")
    await db.delete(target)
    await db.commit()
