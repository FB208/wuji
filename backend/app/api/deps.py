"""公共依赖：登录用户解析。"""
from fastapi import Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import auth_required
from app.core.security import parse_access_token
from app.db.session import get_db
from app.models.tables import User
from app.repositories import repos


async def get_current_user(
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization.startswith("Bearer "):
        raise auth_required()
    user_id = parse_access_token(authorization[7:].strip())
    async with db.begin():
        user = await repos.get_user(db, user_id)
    if user is None:
        raise auth_required()
    return user
