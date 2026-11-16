"""长期物品对话：入口校验家庭归属，业务内部直接使用已确定的范围。"""
import asyncio

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import ok
from app.db.session import get_db
from app.models.tables import User
from app.repositories import repos
from app.schemas.chat import ChatMessageRequest, InventoryItem
from app.services import chat_service, tasks
from app.services.agent_process import agent_process
from app.services.family_service import require_membership

router = APIRouter()


@router.delete("/chat/history")
async def clear_history(
    request: Request,
    family_id: int = Query(gt=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """清空本人在指定家庭的原始历史和模型上下文。"""
    async with db.begin():
        await require_membership(db, family_id, user.id)
    await agent_process.request("clear", {"user_id": user.id, "family_id": family_id})
    return ok(request, None)


@router.get("/chat/history")
async def chat_history(
    request: Request,
    family_id: int = Query(gt=0),
    before: str | None = Query(default=None, min_length=1),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """按原始消息游标读取历史，并返回当前家庭仍在生成的任务。"""
    async with db.begin():
        await require_membership(db, family_id, user.id)
    params: dict[str, int | str] = {"user_id": user.id, "family_id": family_id}
    if before is not None:
        params["before"] = before
    # 先取任务引用，读取历史期间任务结束时仍能通过快照补齐最终消息。
    active = tasks.find_by_idem(user.id, f"chat:{family_id}")
    result = await agent_process.request("history", params)
    return ok(request, {**result, "active_task": tasks.snapshot(active) if active else None})


@router.post("/chat/messages")
async def send_message(
    request: Request,
    body: ChatMessageRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """取得本轮最新库存后释放事务，再通过现有任务机制执行 Agent。"""
    async with db.begin():
        await require_membership(db, body.family_id, user.id)
        records = await repos.list_active_items(db, body.family_id)
        items: list[InventoryItem] = [{
            "id": item.id,
            "name": item.name,
            "location_text": item.location_text,
            "record_text": item.record_text,
            "image_url": item.image_url,
        } for item in records]
    task = tasks.create("chat", user.id, idem_key=f"chat:{body.family_id}")
    asyncio.create_task(chat_service.run_chat_task(task.id, user.id, body.family_id, body.text, items))
    return ok(request, {"task_id": task.id})
