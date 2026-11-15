"""入库语义判断离线评测：transcript → 期望 operation/目标。

直连真实语义 provider（读取 backend/.env 配置），用于 prompt 调优回归，
不进 CI。用法：

    cd backend && python ../scripts/eval_record_judge.py
    python ../scripts/eval_record_judge.py --verbose   # 打印每条返回细节

期望字段：
  op       期望 operation：create / move / delete / confirm
  target   move/delete 期望命中的物品名（仅注释用途，断言按 candidate 命中）
  cands    confirm 期望候选集合包含的物品 id（按名字解析）
  action   confirm 期望 action（可选断言）
"""
import argparse
import asyncio
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from app.core.errors import AppError  # noqa: E402
from app.providers.semantic import semantic_provider  # noqa: E402

# 公共物品池：id 与 make_item 一致，可按用例裁剪。
POOL = {
    "椅子-客厅": {"id": 1, "name": "椅子", "location_text": "客厅"},
    "椅子-书房": {"id": 2, "name": "椅子", "location_text": "书房"},
    "椅子-阳台": {"id": 3, "name": "椅子", "location_text": "阳台"},
    "水杯-厨房": {"id": 4, "name": "水杯", "location_text": "厨房"},
    "剪刀-抽屉": {"id": 5, "name": "剪刀", "location_text": "抽屉"},
    "拖把-阳台": {"id": 6, "name": "拖把", "location_text": "阳台"},
}


def items(*names: str) -> list[dict]:
    return [dict(POOL[n]) for n in names]


CASES = [
    # ---- 明确 create ----
    dict(t="新买了一个水杯放在餐桌上", pool=[], op="create",
         note="无同名物品，静态陈述→新增"),
    dict(t="又买了一把椅子放在卧室", pool=items("椅子-客厅"), op="create",
         note="“又买了”明确新增，即使有同名"),
    dict(t="客厅里有一把椅子", pool=[], op="create",
         note="空池静态陈述→新增"),
    # ---- 明确 move ----
    dict(t="把椅子从客厅挪到卧室了", pool=items("椅子-客厅"), op="move",
         cands=["椅子-客厅"], note="位移动词+原位置吻合，唯一同名→move"),
    dict(t="椅子搬到书房去了", pool=items("椅子-客厅"), op="move",
         cands=["椅子-客厅"], note="位移动词，唯一同名→move"),
    dict(t="我把剪刀从抽屉拿到厨房了", pool=items("剪刀-抽屉"), op="move",
         cands=["剪刀-抽屉"], note="原位置吻合→move"),
    # ---- 明确 delete ----
    dict(t="拖把坏了扔掉了", pool=items("拖把-阳台"), op="delete",
         cands=["拖把-阳台"], note="“扔掉”唯一同名→delete"),
    dict(t="那个水杯不要了", pool=items("水杯-厨房"), op="delete",
         cands=["水杯-厨房"], note="“不要了”唯一同名→delete"),
    # ---- confirm：行为/目标无法唯一确定 ----
    dict(t="椅子在卧室", pool=items("椅子-客厅", "椅子-书房"), op="confirm",
         note="静态陈述+多同名，LLM 自判无法确定"),
    dict(t="把椅子挪到卧室", pool=items("椅子-客厅", "椅子-书房", "椅子-阳台"),
         op="confirm", action="move", note="明确 move 但多候选无法区分"),
    dict(t="椅子扔了", pool=items("椅子-客厅", "椅子-书房"), op="confirm",
         action="delete", note="明确 delete 但多候选"),
    dict(t="椅子在卧室", pool=items("椅子-客厅"), op="confirm",
         note="单同名静态陈述：LLM 可自行判 create 或 confirm，记录分布"),
    # ---- 边界：模糊动词 ----
    dict(t="我把椅子放卧室了", pool=items("椅子-客厅"), op=None,
         note="“放”歧义：create/move/confirm 均记录，观察分布"),
]


def resolve_cands(case_cands):
    """把期望候选名解析为 POOL 中的物品 id 集合。"""
    if not case_cands:
        return None
    return {POOL[n]["id"] for n in case_cands}


async def run_case(case, verbose):
    pool = case["pool"]
    try:
        out = await semantic_provider.judge_record(case["t"], pool)
    except AppError as e:
        return case, {"operation": f"ERROR:{e.code}", "raw": None}, False
    if verbose:
        print(f"    raw → {out}")
    expect_op = case["op"]
    ok = expect_op is None or out["operation"] == expect_op
    if ok and expect_op in ("move", "delete"):
        want = resolve_cands(case.get("cands"))
        if want:
            ok = out.get("target_item_id") in want or set(
                out.get("candidate_item_ids") or []
            ) == want
    if ok and expect_op == "confirm" and case.get("action"):
        ok = out.get("action") == case["action"]
    return case, out, ok


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    results = []
    for case in CASES:
        case, out, ok = await run_case(case, args.verbose)
        results.append((case, out, ok))
        mark = "PASS" if ok else "MISS"
        cands = out.get("candidate_item_ids") or []
        print(
            f"[{mark}] {case['t']!r}\n"
            f"    期望={case['op']} 实际={out['operation']}"
            f" action={out.get('action')} target={out.get('target_item_id')} cands={cands}\n"
            f"    说明: {case['note']}"
        )

    total = sum(1 for c in CASES if c["op"] is not None)
    passed = sum(1 for c, o, ok in results if ok and c["op"] is not None)
    unjudged = sum(1 for c in CASES if c["op"] is None)
    print(f"\n== {passed}/{total} 通过（{unjudged} 条边界用例仅观察） ==")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    asyncio.run(main())
