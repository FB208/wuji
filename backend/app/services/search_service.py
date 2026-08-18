"""语音 / 文字查找：语义服务只返回候选 item_id，真实数据从 MySQL 读取（文档 5 / 10.4）。"""
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.providers.semantic import semantic_provider
from app.providers.speech import speech_provider
from app.repositories import repos
from app.services.family_service import require_membership

logger = get_logger(__name__)

MAX_CANDIDATES = 5
MAX_CONTEXT_TURNS = 6

NOT_FOUND_PROMPT = "未找到记录，可换个说法。"
MULTIPLE_PROMPT = "找到多条记录，请继续说明颜色、用途或型号。"


def _normalize_context(context: dict[str, Any] | None) -> dict[str, Any]:
    """整理上下文：最多保留最近 6 轮（文档 1.4 / 5.5）。"""
    if not context:
        return {"initial_query": None, "shown_item_ids": [], "excluded_item_ids": []}
    turns = context.get("turns") or []
    turns = turns[-MAX_CONTEXT_TURNS:]
    shown: list[int] = []
    excluded: list[int] = []
    initial_query = None
    for turn in turns:
        if initial_query is None and turn.get("query"):
            initial_query = turn["query"]
        for i in turn.get("item_ids") or []:
            if int(i) not in shown:
                shown.append(int(i))
        for i in turn.get("excluded_item_ids") or []:
            if int(i) not in excluded:
                excluded.append(int(i))
    return {"initial_query": initial_query, "shown_item_ids": shown, "excluded_item_ids": excluded}


async def _search(
    db: AsyncSession, user_id: int, family_id: int, query: str, context: dict[str, Any] | None
) -> dict[str, Any]:
    await require_membership(db, family_id, user_id)

    items = await repos.list_active_items(db, family_id)
    if not items:
        return {"status": "not_found", "prompt": NOT_FOUND_PROMPT, "items": []}

    ctx = _normalize_context(context)
    summary = [
        {"id": i.id, "name": i.name, "location_text": i.location_text, "record_text": i.record_text}
        for i in items
        if i.id not in ctx["excluded_item_ids"]
    ]
    if not summary:
        return {"status": "not_found", "prompt": NOT_FOUND_PROMPT, "items": []}

    result = await semantic_provider.search_items(query, ctx, summary)

    # 语义服务返回的 item_id 必须再次按 family_id 查询后才能使用（文档 14.2）
    valid_ids = [i for i in result["item_ids"] if i not in ctx["excluded_item_ids"]][:MAX_CANDIDATES]
    matched = await repos.list_active_items_by_ids(db, family_id, valid_ids)

    if not matched:
        return {"status": "not_found", "prompt": NOT_FOUND_PROMPT, "items": []}

    status = "found" if len(matched) == 1 else "multiple"
    prompt = None if status == "found" else (result.get("prompt") or MULTIPLE_PROMPT)
    return {
        "status": status,
        "prompt": prompt,
        "items": [
            {"id": i.id, "name": i.name, "location_text": i.location_text, "image_url": i.image_url}
            for i in matched
        ],
    }


async def search_by_text(
    db: AsyncSession, user_id: int, family_id: int, query: str, context: dict[str, Any] | None
) -> dict[str, Any]:
    result = await _search(db, user_id, family_id, query, context)
    result["transcript"] = None
    return result


async def search_by_audio(
    db: AsyncSession,
    user_id: int,
    family_id: int,
    audio: bytes,
    audio_ext: str,
    context: dict[str, Any] | None,
) -> dict[str, Any]:
    transcript = await speech_provider.transcribe(audio, audio_ext)
    result = await _search(db, user_id, family_id, transcript, context)
    result["transcript"] = transcript
    return result
