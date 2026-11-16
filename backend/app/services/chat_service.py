"""由内置 Pi 子进程执行的聊天后台任务。"""
from app.core.logging import get_logger
from app.schemas.chat import InventoryItem
from app.services import tasks
from app.services.agent_process import agent_process

logger = get_logger(__name__)


async def run_chat_task(
    task_id: str,
    user_id: int,
    family_id: int,
    text: str,
    items: list[InventoryItem],
) -> None:
    """执行已通过入口校验的消息，库存快照仅作为工具数据源传给 Agent。"""
    tasks.set_stage(task_id, "answering")
    try:
        result = await agent_process.request("turn", {
            "user_id": user_id, "family_id": family_id, "text": text, "items": items,
        }, request_id=task_id, on_progress=lambda progress: tasks.update_progress(task_id, progress))
    except Exception as exc:
        logger.exception("聊天任务失败 task=%s family=%s", task_id, family_id)
        tasks.fail(task_id, exc)
        return
    tasks.finish(task_id, result)
