"""OpenAI-compatible 文本语义服务（附录 A 协议）。

只接收文字和当前家庭组物品文字摘要，不接收图片（文档 10.5 / 14.3）。
"""
import json
import re
from typing import Any

import httpx

from app.core.config import get_settings
from app.core.errors import record_parse_failed, search_failed
from app.core.logging import get_logger

logger = get_logger(__name__)

_RECORD_SYSTEM_PROMPT = """你是家庭收纳工具的入库判断服务。输入包含 transcript（用户最新一句话）和 existing_items（当前家庭组现有物品摘要）。
你需要判断这句话是「新增物品」还是「移动现有物品」，并提取物品名称和存放位置。

输出约束：
- 只返回一个 JSON 对象，不返回任何说明文字。
- 字段：operation（"create" 或 "move"）、target_item_id（move 时必填，必须来自 existing_items 的 id；create 时为 null）、name（物品名称）、location_text（存放位置）。
- name 和 location_text 必须来自用户文字，不补充未提及的信息。
- 语句包含"现在放到""挪到""换到"等移动语义且能匹配到现有物品时返回 move。
- 无法确定为同一物品时使用 create。
- 无法提取出名称或位置时，对应字段返回空字符串。"""

_SEARCH_SYSTEM_PROMPT = """你是家庭收纳工具的查找服务。输入包含 query（用户最新一句话）、context（初始查询、已展示和已排除的物品 id）和 items（当前家庭组全部有效物品摘要）。
你需要从 items 中找出用户想找的物品。

输出约束：
- 只返回一个 JSON 对象，不返回任何说明文字。
- 字段：status（"found"、"multiple" 或 "not_found"）、item_ids（数组）、prompt（字符串或 null）。
- item_ids 必须来自输入 items 的 id；found 只能包含 1 个；multiple 最多 5 个，按相关度排序。
- 必须排除 context.excluded_item_ids 中的物品。
- 没有可信候选时返回 not_found，item_ids 为空数组，不猜测。
- prompt 使用机械式、无第一人称的简短中文，例如"找到多条记录，请继续说明颜色、用途或型号。"；found 和 not_found 时 prompt 可为 null。"""


def _extract_json(text: str) -> dict[str, Any]:
    """从模型输出中提取 JSON 对象，容忍代码块包裹。"""
    text = text.strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"no json object in output: {text[:200]}")
    return json.loads(match.group(0))


class SemanticProvider:
    async def _chat(self, system_prompt: str, user_payload: dict[str, Any]) -> dict[str, Any]:
        settings = get_settings()
        url = f"{settings.semantic_base_url.rstrip('/')}/chat/completions"
        body = {
            "model": settings.semantic_model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
        }
        headers = {"Authorization": f"Bearer {settings.semantic_api_key}"}
        async with httpx.AsyncClient(timeout=settings.semantic_timeout_seconds) as client:
            resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        return _extract_json(content)

    async def judge_record(self, transcript: str, existing_items: list[dict[str, Any]]) -> dict[str, Any]:
        """入库判断（附录 A.1 / A.2）：返回 operation、target_item_id、name、location_text。"""
        payload = {"transcript": transcript, "existing_items": existing_items}
        try:
            result = await self._chat(_RECORD_SYSTEM_PROMPT, payload)
        except Exception as exc:
            logger.error("入库语义判断失败：%s", exc)
            raise record_parse_failed("入库解析失败，请重新说清楚物品和位置") from exc

        operation = result.get("operation")
        if operation not in ("create", "move"):
            raise record_parse_failed()
        return {
            "operation": operation,
            "target_item_id": result.get("target_item_id"),
            "name": (result.get("name") or "").strip(),
            "location_text": (result.get("location_text") or "").strip(),
        }

    async def search_items(
        self, query: str, context: dict[str, Any], items: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """查找判断（附录 A.3 / A.4）：返回 status、item_ids、prompt。"""
        payload = {"query": query, "context": context, "items": items}
        try:
            result = await self._chat(_SEARCH_SYSTEM_PROMPT, payload)
        except Exception as exc:
            logger.error("查找语义判断失败：%s", exc)
            raise search_failed() from exc

        status = result.get("status")
        if status not in ("found", "multiple", "not_found"):
            raise search_failed()
        item_ids = [int(i) for i in (result.get("item_ids") or []) if isinstance(i, (int, str))]
        return {"status": status, "item_ids": item_ids, "prompt": result.get("prompt")}


semantic_provider = SemanticProvider()
