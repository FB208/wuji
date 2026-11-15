"""语音 / 文字查找：语义服务只返回候选 item_id，真实数据从 MySQL 读取（文档 5 / 10.4）。"""
import string
import unicodedata
from typing import Any

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import (
    AppError,
    search_context_mismatch,
)
from app.core.logging import get_logger
from app.providers.semantic import semantic_provider
from app.providers.speech import speech_provider
from app.repositories import repos
from app.schemas.schemas import SearchContext
from app.services.family_service import require_membership

logger = get_logger(__name__)

MAX_CANDIDATES = 5
MAX_CONTEXT_TURNS = 6

NOT_FOUND_PROMPT = "未找到记录，可换个说法。"
MULTIPLE_PROMPT = "找到多条记录，请继续说明颜色、用途或型号。"
NEGATE_MULTIPLE_PROMPT = "请指出要排除的物品，或补充颜色、用途、型号。"

_MORE_PHRASES = {"还有吗", "还有别的吗"}
_NEGATE_PHRASES = {"不是这个", "不是这件", "不对"}


def _validate_context(raw: dict[str, Any] | None) -> SearchContext:
    if raw is None:
        return SearchContext()
    if not isinstance(raw, dict):
        raise AppError("VALIDATION_ERROR", "查找上下文格式无效", status_code=400, retryable=False)
    try:
        return SearchContext.model_validate(raw)
    except ValidationError as exc:
        raise AppError("VALIDATION_ERROR", "查找上下文格式无效", status_code=422, retryable=False) from exc


def _phrase(query: str) -> str:
    return "".join(
        c
        for c in query
        if not (
            c.isspace()
            or c in string.punctuation
            or unicodedata.category(c).startswith("P")
        )
    )


def _intersect(ids: list[int], active: set[int]) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for i in ids:
        if i in active and i not in seen:
            seen.add(i)
            out.append(i)
    return out


async def _search(
    db: AsyncSession, user_id: int, family_id: int, query: str, context_raw: dict[str, Any] | None
) -> dict[str, Any]:
    query = query.strip()
    if not query or len(query) > 512:
        raise AppError("VALIDATION_ERROR", "查询内容无效", status_code=422, retryable=False)

    async with db.begin():
        await require_membership(db, family_id, user_id)
        items = await repos.list_active_items(db, family_id)
    active_ids = {i.id for i in items}
    summary = [
        {"id": i.id, "name": i.name, "location_text": i.location_text, "record_text": i.record_text}
        for i in items
    ]

    ctx = _validate_context(context_raw)
    if ctx.family_id is not None and ctx.family_id != family_id:
        raise search_context_mismatch()

    excluded = _intersect(list(ctx.excluded_item_ids), active_ids)
    excluded_set = set(excluded)
    shown = _intersect(list(ctx.shown_item_ids), active_ids)
    last_ids = _intersect(ctx.last_item_ids, active_ids)
    last_status = ctx.last_status

    turns = [{"query": t.query, "status": t.status, "item_ids": _intersect(t.item_ids, active_ids)} for t in ctx.turns]
    if not shown:
        for t in turns:
            for i in t["item_ids"]:
                if i not in shown:
                    shown.append(i)
    if not last_ids and turns:
        last_ids = turns[-1]["item_ids"]
        last_status = last_status or turns[-1]["status"]

    initial_query = ctx.initial_query or (turns[0]["query"] if turns else query)

    phrase = _phrase(query)
    restrict_to_last = False
    if phrase in _MORE_PHRASES:
        for i in shown:
            if i not in excluded_set:
                excluded_set.add(i)
                excluded.append(i)
    elif phrase in _NEGATE_PHRASES:
        if last_status == "found" and len(last_ids) == 1:
            for i in last_ids:
                if i not in excluded_set:
                    excluded_set.add(i)
                    excluded.append(i)
        elif last_status == "multiple":
            restrict_to_last = True

    model_ctx = {
        "initial_query": initial_query,
        "turns": turns,
        "shown_item_ids": shown,
        "excluded_item_ids": list(excluded),
    }

    if restrict_to_last:
        model_result = {"status": "multiple", "item_ids": [i for i in last_ids if i not in excluded_set]}
    else:
        pool = [i for i in summary if i["id"] not in excluded_set]
        if not pool:
            model_result = {"status": "not_found", "item_ids": [], "prompt": None}
        else:
            model_result = await semantic_provider.search_items(query, model_ctx, pool)

    async with db.begin():
        await require_membership(db, family_id, user_id)
        valid_ids = _intersect(
            [i for i in model_result["item_ids"] if i not in excluded_set], active_ids
        )[:MAX_CANDIDATES]
        matched = await repos.list_active_items_by_ids(db, family_id, valid_ids)

    if not matched:
        status = "not_found"
        prompt = NOT_FOUND_PROMPT
    elif len(matched) == 1:
        status = "found"
        prompt = None
    else:
        status = "multiple"
        prompt = NEGATE_MULTIPLE_PROMPT if restrict_to_last else MULTIPLE_PROMPT

    result_ids = [i.id for i in matched]
    new_shown = list(shown)
    for i in result_ids:
        if i not in new_shown:
            new_shown.append(i)
    turns_out = (turns + [{"query": query, "status": status, "item_ids": result_ids}])[-MAX_CONTEXT_TURNS:]

    return {
        "status": status,
        "prompt": prompt,
        "items": [
            {"id": i.id, "name": i.name, "location_text": i.location_text, "image_url": i.image_url}
            for i in matched
        ],
        "context": {
            "family_id": family_id,
            "initial_query": initial_query,
            "turns": turns_out,
            "shown_item_ids": _intersect(new_shown, active_ids),
            "excluded_item_ids": _intersect(list(excluded), active_ids),
            "last_item_ids": result_ids,
            "last_status": status,
        },
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
    ctx = _validate_context(context)
    if ctx.family_id is not None and ctx.family_id != family_id:
        raise search_context_mismatch()
    async with db.begin():
        await require_membership(db, family_id, user_id)
    transcript = await speech_provider.transcribe(audio, audio_ext)
    transcript = (transcript or "").strip()
    if not transcript or len(transcript) > 512:
        raise AppError("VALIDATION_ERROR", "请求内容无效", status_code=422, retryable=False)
    result = await _search(db, user_id, family_id, transcript, context)
    result["transcript"] = transcript
    return result
