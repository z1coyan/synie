#!/usr/bin/env python3
"""按 build_v3_final.py 五项公式，用 jdyChinaDate 截到 T 重算仪表盘应收。

应收(对手×公司) = 发票 + 期初 − 银行流水 − 承兑 − 其他收付款
日期一律 jdyChinaDate（T16:00Z = 中国次日）；date 为空的行不过滤。

读 data/jdy-source/raw/。银行金额按方向取位 + biz_key 去重（与
bank_tx_dedup / rule_clean 同一套）；若找得到
.scratch/jdy-migration/clean/bank_tx_dedup.json 则对照断言。

输出 CSV: company, party_code, amount（仅 京泰/东方）。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from china_date import jdyChinaDate  # noqa: E402

W = lambda r, k: r.get(k)

# 与 .scratch/align/build_v3_final.py 同一套 widget
INV_DIR = "_widget_1744503948247"
INV_CODE = "_widget_1743342957313"  # 7313 lookup
INV_AMT = "_widget_1743342957261"
INV_CO = "_widget_1743342957286"
INV_DATE = "_widget_1743342957248"

OP_CODE = "_widget_1744555025639"
OP_NAME = "_widget_1744555025640"
OP_CO = "_widget_1744594140640"
OP_AMT = "_widget_1744555025642"
OP_DATE = "_widget_1744555025641"

BK_LK = "_widget_1743315566328"  # 66328 lookup
BK_PT = "_widget_1743315566301"
BK_CO = "_widget_1743315566288"
BK_DIR = "_widget_1743315566308"
BK_DATE = "_widget_1743315074734"
BK_ACC = "_widget_1743315566287"
BK_CP = "_widget_1743315566297"
BK_AMT_A = "_widget_1743315566307"
BK_AMT_B = "_widget_1743315566310"  # 收入位
BK_AMT_C = "_widget_1743315566312"  # 支出位
BK_PT_SKIP = ("其他", "供应商", "内部划转")

BL_PT = "_widget_1743297238037"
BL_CODE = "_widget_1743297238044"  # 8044 lookup
BL_AMT = "_widget_1743297238058"
BL_DIR = "_widget_1743258245015"
BL_CO = "_widget_1743305307840"
BL_DATE = "_widget_1743258245012"

OT_PT = "_widget_1744593672547"
OT_CODE = "_widget_1744593672557"  # 2557 lookup（编号，不是 2556）
OT_AMT = "_widget_1744593672537"
OT_DIR = "_widget_1744593672538"
OT_CO = "_widget_1744682104128"
OT_DATE = "_widget_1744593437697"

COMPANY_MAP = {"京泰": "京泰", "JT": "京泰", "东方": "东方", "DF": "东方"}


def find_source(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    env = os.environ.get("JDY_SOURCE")
    if env:
        return Path(env)
    starts = [Path.cwd(), Path(__file__).resolve().parent]
    for start in starts:
        for p in [start, *start.parents]:
            cand = p / "data" / "jdy-source"
            if (cand / "raw" / "invoices.json").is_file():
                return cand
    raise SystemExit("找不到 data/jdy-source/raw/invoices.json；传 --source-dir 或设 JDY_SOURCE")


def find_bank_dedup(source: Path) -> Path | None:
    starts = [source, Path.cwd(), Path(__file__).resolve().parent]
    for start in starts:
        for p in [start, *start.parents]:
            cand = p / ".scratch" / "jdy-migration" / "clean" / "bank_tx_dedup.json"
            if cand.is_file():
                return cand
    return None


def on_or_before(iso, as_of: str) -> bool:
    d = jdyChinaDate(iso)
    if d is None:
        return True
    return d <= as_of


def norm_company(cp) -> str | None:
    return COMPANY_MAP.get(str(cp or "").strip())


def lookup_label(v) -> str:
    if isinstance(v, dict):
        return str(v.get("label") or "").strip()
    if v is None:
        return ""
    return str(v).strip()


def money_key(amount: float) -> str:
    d = Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return format(d, "f")


def bank_amount_by_dir(row: dict) -> tuple[float, str]:
    """与 rule_clean / bank_tx_dedup 同一取位：收入用 B，支出用 C，否则 A，再 max abs。"""
    direction = str(W(row, BK_DIR) or "").strip()
    amt_a, amt_b, amt_c = W(row, BK_AMT_A), W(row, BK_AMT_B), W(row, BK_AMT_C)
    if direction == "收入":
        amount = amt_b if amt_b not in (None, 0, 0.0, "") else amt_a
    elif direction == "支出":
        amount = amt_c if amt_c not in (None, 0, 0.0, "") else amt_a
    else:
        amount = amt_a
    if amount in (None, "", 0, 0.0):
        cands = [abs(float(x)) for x in (amt_a, amt_b, amt_c) if x not in (None, "")]
        amount = max(cands) if cands else 0.0
    return float(amount), direction


def bank_biz_key(row: dict) -> str:
    date_iso = jdyChinaDate(W(row, BK_DATE))
    acc = lookup_label(W(row, BK_ACC))
    amt, _ = bank_amount_by_dir(row)
    cp = str(W(row, BK_CP) or "").strip()
    return f"{date_iso}|{acc}|{money_key(amt)}|{cp}"


def dedup_bank_rows(rows: list) -> list:
    seen: dict[str, object] = {}
    kept = []
    for row in rows:
        key = bank_biz_key(row)
        if key in seen:
            continue
        seen[key] = row.get("_id")
        kept.append(row)
    return kept


def formula_bank_signed(row: dict) -> float | None:
    lk = str(W(row, BK_LK) or "").strip()
    if not lk:
        return None
    if str(W(row, BK_PT) or "").strip() in BK_PT_SKIP:
        return None
    amt, direction = bank_amount_by_dir(row)
    return amt if direction == "收入" else -amt


def assert_bank_vs_dedup(raw_rows: list, source: Path) -> None:
    path = find_bank_dedup(source)
    if path is None:
        print("bank_tx_dedup.json 未找到，跳过流水对照", file=sys.stderr)
        return
    ours = {}
    for row in dedup_bank_rows(raw_rows):
        signed = formula_bank_signed(row)
        if signed is None:
            continue
        ours[row.get("_id")] = signed
    theirs = {}
    for t in load_json(path):
        signed = formula_bank_signed(t)
        if signed is None:
            continue
        c = t.get("_clean") or {}
        amt = float(c.get("amount") or 0)
        direction = c.get("direction") or str(W(t, BK_DIR) or "").strip()
        theirs[t.get("_id")] = amt if direction == "收入" else -amt
    only_ours = set(ours) - set(theirs)
    only_theirs = set(theirs) - set(ours)
    amt_diff = [
        (i, ours[i], theirs[i])
        for i in ours.keys() & theirs.keys()
        if abs(ours[i] - theirs[i]) > 0.01
    ]
    if only_ours or only_theirs or amt_diff:
        raise SystemExit(
            f"流水与 {path} 不一致: only_raw={len(only_ours)} "
            f"only_dedup={len(only_theirs)} amt_diff={len(amt_diff)}"
        )


def load_json(path: Path):
    if not path.is_file():
        raise SystemExit(f"缺少源文件: {path}")
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def compute(source: Path, as_of: str):
    raw = source / "raw"
    # comp[code][company][term]
    comp: dict[str, dict[str, dict[str, float]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(float))
    )

    for r in load_json(raw / "invoices.json"):
        if not on_or_before(W(r, INV_DATE), as_of):
            continue
        code = str(W(r, INV_CODE) or "").strip()
        if not code:
            continue
        cp = norm_company(W(r, INV_CO))
        if cp is None:
            continue
        amt = float(W(r, INV_AMT) or 0)
        direction = str(W(r, INV_DIR) or "").strip()
        if direction == "开出":
            comp[code][cp]["invoice"] += amt
        elif direction == "开入":
            # 开入且带 7313 = 客户红票，记负（实证仅户 56 / 9）
            comp[code][cp]["invoice"] -= amt

    for r in load_json(raw / "opening_ar.json"):
        if not on_or_before(W(r, OP_DATE), as_of):
            continue
        code = str(W(r, OP_CODE) or "").strip()
        name = str(W(r, OP_NAME) or "").strip()
        if not code or code == "9999" or "测试" in name:
            continue
        cp = norm_company(W(r, OP_CO))
        if cp is None:
            continue
        comp[code][cp]["opening"] += float(W(r, OP_AMT) or 0)

    raw_bank = load_json(raw / "bank_tx.json")
    assert_bank_vs_dedup(raw_bank, source)
    for r in dedup_bank_rows(raw_bank):
        signed = formula_bank_signed(r)
        if signed is None:
            continue
        if not on_or_before(W(r, BK_DATE), as_of):
            continue
        cp = norm_company(W(r, BK_CO))
        if cp is None:
            continue
        comp[str(W(r, BK_LK) or "").strip()][cp]["bank"] += signed

    for r in load_json(raw / "bills.json"):
        if str(W(r, BL_PT) or "").strip() != "客户":
            continue
        code = str(W(r, BL_CODE) or "").strip()
        if not code:
            continue
        if not on_or_before(W(r, BL_DATE), as_of):
            continue
        cp = norm_company(W(r, BL_CO))
        if cp is None:
            continue
        amt = float(W(r, BL_AMT) or 0)
        if str(W(r, BL_DIR) or "").strip() != "收入":
            amt = -amt
        comp[code][cp]["bills"] += amt

    for r in load_json(raw / "other_pay.json"):
        if str(W(r, OT_PT) or "").strip() != "客户":
            continue
        code = str(W(r, OT_CODE) or "").strip()
        if not code:
            continue
        if not on_or_before(W(r, OT_DATE), as_of):
            continue
        cp = norm_company(W(r, OT_CO))
        if cp is None:
            continue
        amt = float(W(r, OT_AMT) or 0)
        if str(W(r, OT_DIR) or "").strip() != "收入":
            amt = -amt
        comp[code][cp]["other_pay"] += amt

    rows = []
    for code, by_co in comp.items():
        for cp, f in by_co.items():
            amt = round(
                f.get("invoice", 0)
                + f.get("opening", 0)
                - f.get("bank", 0)
                - f.get("bills", 0)
                - f.get("other_pay", 0),
                2,
            )
            rows.append({"company": cp, "party_code": code, "amount": f"{amt:.2f}"})
    rows.sort(key=lambda r: (r["party_code"], r["company"]))
    return rows


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="JDY 五项公式截日重算（只读源 JSON，不写库）")
    p.add_argument("--as-of", required=True, metavar="YYYY-MM-DD", help="含当日")
    p.add_argument("--source-dir", default=None, help="data/jdy-source 目录")
    p.add_argument("-o", "--output", default="-", help="CSV 路径，默认 stdout")
    args = p.parse_args(argv)
    as_of = args.as_of.strip()
    if len(as_of) != 10 or as_of[4] != "-" or as_of[7] != "-":
        raise SystemExit("--as-of 必须是 YYYY-MM-DD")

    rows = compute(find_source(args.source_dir), as_of)
    out = sys.stdout if args.output == "-" else open(args.output, "w", newline="", encoding="utf-8")
    close = out is not sys.stdout
    try:
        w = csv.DictWriter(out, fieldnames=["company", "party_code", "amount"])
        w.writeheader()
        w.writerows(rows)
    finally:
        if close:
            out.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
