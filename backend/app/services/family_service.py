"""家庭组：创建、改名、邀请、加入、成员管理（文档 7 章）。"""
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, auth_required, family_forbidden, not_found
from app.core.security import create_signed_token, normalize_user_code, verify_signed_token
from app.models.tables import Family, FamilyMember, utcnow
from app.repositories import repos


async def require_membership(db: AsyncSession, family_id: int, user_id: int) -> FamilyMember:
    """后端不信任客户端 family_id，必须校验成员关系（文档 7.4 / 14.2）。"""
    member = await repos.get_membership(db, family_id, user_id)
    if member is None:
        raise family_forbidden()
    return member


async def lock_membership_scope(
    db: AsyncSession, user_id: int, family_id: int
) -> tuple[FamilyMember, Family]:
    """统一按家庭、用户、成员顺序加锁，与默认设置及家庭清理保持一致。"""
    family = await repos.get_family_for_update(db, family_id)
    if family is None:
        raise family_forbidden()
    user = await repos.get_user_for_update(db, user_id)
    if user is None:
        raise auth_required()
    member = await repos.get_membership_for_update(db, family_id, user_id)
    if member is None:
        raise family_forbidden()
    return member, family


async def require_owner(db: AsyncSession, family_id: int, user_id: int) -> FamilyMember:
    member = await require_membership(db, family_id, user_id)
    if member.role != "owner":
        raise family_forbidden("仅家庭组所有者可执行该操作")
    return member


async def list_families(db: AsyncSession, user_id: int) -> list[dict]:
    """一次聚合查询读取家庭资料及成员数。"""
    return await repos.list_user_family_summaries(db, user_id)


async def set_default_family(db: AsyncSession, user_id: int, family_id: int) -> dict:
    """成员可设置自己的默认家庭；重复设置保持幂等，不改变成员关系。"""
    await lock_membership_scope(db, user_id, family_id)
    user = await repos.get_user(db, user_id)
    user.default_family_id = family_id
    await db.commit()
    return {"default_family_id": family_id}


async def create_family(db: AsyncSession, user_id: int, name: str) -> dict:
    family = Family(name=name, owner_user_id=user_id)
    db.add(family)
    await db.flush()
    db.add(FamilyMember(family_id=family.id, user_id=user_id, role="owner"))
    await db.commit()
    return {"id": family.id, "name": family.name, "owner_user_id": user_id, "role": "owner", "member_count": 1}


async def rename_family(db: AsyncSession, family_id: int, user_id: int, name: str) -> dict:
    await require_owner(db, family_id, user_id)
    family = await repos.get_family_for_update(db, family_id)
    if family is None:
        raise not_found("家庭组不存在")
    family.name = name
    family.revision += 1
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
    family = await repos.get_family_for_update(db, family_id)
    if family is None:
        raise not_found("家庭组不存在")
    existing = await repos.get_membership(db, family_id, user_id)
    if existing is None:
        db.add(FamilyMember(family_id=family_id, user_id=user_id, role="member"))
        family.revision += 1
        await db.commit()
    return {"family_id": family_id, "family_name": preview["family_name"]}


async def add_member_by_code(db: AsyncSession, family_id: int, operator_id: int, user_code: str) -> dict:
    """所有者填写对方的用户 ID，直接把对方加入家庭组（未认证小程序无法分享邀请卡片）。"""
    await require_owner(db, family_id, operator_id)
    code = normalize_user_code(user_code)
    target = await repos.get_user_by_code(db, code) if code else None
    if target is None:
        raise not_found("未找到该用户ID，请核对后重试")
    family = await repos.get_family_for_update(db, family_id)
    if family is None:
        raise not_found("家庭组不存在")
    if await repos.get_membership(db, family_id, target.id) is not None:
        raise AppError("ALREADY_MEMBER", "对方已经在该家庭组中", status_code=400)
    db.add(FamilyMember(family_id=family_id, user_id=target.id, role="member"))
    family.revision += 1
    await db.commit()
    return {"user_id": target.id, "nickname": target.nickname, "avatar_url": target.avatar_url, "role": "member"}


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
    family = await repos.get_family_for_update(db, family_id)
    if family is None:
        raise not_found("家庭组不存在")
    member = await repos.get_membership_for_update(db, family_id, operator_id)
    if member is None:
        raise family_forbidden()
    if operator_id == target_user_id:
        if member.role == "owner":
            raise AppError("OWNER_CANNOT_LEAVE", "所有者需先转让或解散家庭组", status_code=400)
    elif member.role != "owner":
        raise family_forbidden("仅家庭组所有者可移除成员")

    target = await repos.get_membership_for_update(db, family_id, target_user_id)
    if target is None:
        raise not_found("成员不存在")
    if target.role == "owner" and operator_id != target_user_id:
        raise family_forbidden("不能移除家庭组所有者")
    await repos.clear_default_family(db, family_id, target_user_id)
    await db.delete(target)
    family.revision += 1
    await db.commit()


async def transfer_ownership(db: AsyncSession, family_id: int, operator_id: int, target_user_id: int) -> dict:
    """所有者把家庭组转让给其他成员（文档 7.2）。"""
    member = await require_owner(db, family_id, operator_id)
    target = await repos.get_membership(db, family_id, target_user_id)
    if target is None or target_user_id == operator_id:
        raise not_found("成员不存在")
    family = await repos.get_family_for_update(db, family_id)
    if family is None:
        raise not_found("家庭组不存在")
    member.role = "member"
    target.role = "owner"
    family.owner_user_id = target_user_id
    family.revision += 1
    await db.commit()
    return {"family_id": family_id, "owner_user_id": target_user_id}


async def _retire_family_images(db: AsyncSession, family_id: int) -> None:
    """家庭组删除前，其物品图片按延迟清理规则登记（文档 6.4）。"""
    settings = get_settings()
    delete_after = utcnow() + timedelta(days=settings.deleted_image_retain_days)
    for image_url in await repos.list_family_image_urls(db, family_id):
        await repos.mark_image_pending_delete(db, image_url, delete_after)


async def _dissolve_locked(db: AsyncSession, family_id: int) -> None:
    """锁定家庭并清理成员的默认偏好及家庭资源。"""
    family = await repos.get_family_for_update(db, family_id)
    if family is None:
        raise not_found("家庭组不存在")
    await repos.clear_default_family(db, family_id)
    await _retire_family_images(db, family_id)
    await db.delete(family)


async def dissolve_family(db: AsyncSession, family_id: int, operator_id: int) -> None:
    """所有者解散家庭组：成员关系与物品记录随家庭组删除（文档 7.2）。"""
    await require_owner(db, family_id, operator_id)
    await _dissolve_locked(db, family_id)
    await db.commit()


async def purge_deleted_items(db: AsyncSession, family_id: int, user_id: int) -> int:
    """永久清理本家庭组已软删除的物品记录，图片进入立即清理（文档 8.5）。"""
    await require_membership(db, family_id, user_id)
    family = await repos.get_family_for_update(db, family_id)
    if family is None:
        raise not_found("家庭组不存在")
    deleted = await repos.list_deleted_items(db, family_id)
    now = utcnow()
    for item in deleted:
        await repos.mark_image_pending_delete(db, item.image_url, now)
        await db.delete(item)
    if deleted:
        family.revision += 1
    await db.commit()
    return len(deleted)


async def delete_account(db: AsyncSession, user_id: int) -> None:
    """账号注销：退出非本人家庭组，解散本人拥有的家庭组（文档 14.3）。"""
    from app.services.profile_service import delete_owned_avatar
    for family, role in await repos.list_user_families(db, user_id):
        if role == "owner":
            await _dissolve_locked(db, family.id)
        else:
            member = await repos.get_membership(db, family.id, user_id)
            if member is not None:
                await db.delete(member)
            locked = await repos.get_family_for_update(db, family.id)
            if locked is not None:
                locked.revision += 1
    await repos.delete_idempotency_for_user(db, user_id)
    user = await repos.get_user(db, user_id)
    if user is not None:
        await delete_owned_avatar(user_id, user.avatar_url)
        await db.delete(user)
    await db.commit()
