#!/usr/bin/env python3
"""按 build_v3_final.py 五项公式，用 jdyChinaDate 截到 T 重算仪表盘应收。

应收(对手×公司) = 发票 + 期初 − 银行流水 − 承兑 − 其他收付款
日期一律 jdyChinaDate（T16:00Z = 中国次日）；date 为空的行不过滤。

读 data/jdy-source/raw/（银行用 raw，客户 lookup 行与 bank_tx_dedup 金额一致）。
输出 CSV: company, party_code, amount（company = 京泰/东方）。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
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
BK_AMTS = ("_widget_1743315566310", "_widget_1743315566312", "_widget_1743315566307")
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


def on_or_before(iso, as_of: str) -> bool:
    d = jdyChinaDate(iso)
    if d is None:
        return True
    return d <= as_of


def bank_amount(row: dict) -> float:
    vals = []
    for f in BK_AMTS:
        v = W(row, f)
        if v not in (None, "", 0, 0.0):
            vals.append(abs(float(v)))
    return max(vals) if vals else 0.0


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
        amt = float(W(r, INV_AMT) or 0)
        cp = str(W(r, INV_CO) or "").strip()
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
        comp[code][str(W(r, OP_CO) or "").strip()]["opening"] += float(W(r, OP_AMT) or 0)

    for r in load_json(raw / "bank_tx.json"):
        lk = str(W(r, BK_LK) or "").strip()
        if not lk:
            continue
        if str(W(r, BK_PT) or "").strip() in BK_PT_SKIP:
            continue
        if not on_or_before(W(r, BK_DATE), as_of):
            continue
        amt = bank_amount(r)
        signed = amt if str(W(r, BK_DIR) or "").strip() == "收入" else -amt
        comp[lk][str(W(r, BK_CO) or "").strip()]["bank"] += signed

    for r in load_json(raw / "bills.json"):
        if str(W(r, BL_PT) or "").strip() != "客户":
            continue
        code = str(W(r, BL_CODE) or "").strip()
        if not code:
            continue
        if not on_or_before(W(r, BL_DATE), as_of):
            continue
        amt = float(W(r, BL_AMT) or 0)
        if str(W(r, BL_DIR) or "").strip() != "收入":
            amt = -amt
        comp[code][str(W(r, BL_CO) or "").strip()]["bills"] += amt

    for r in load_json(raw / "other_pay.json"):
        if str(W(r, OT_PT) or "").strip() != "客户":
            continue
        code = str(W(r, OT_CODE) or "").strip()
        if not code:
            continue
        if not on_or_before(W(r, OT_DATE), as_of):
            continue
        amt = float(W(r, OT_AMT) or 0)
        if str(W(r, OT_DIR) or "").strip() != "收入":
            amt = -amt
        comp[code][str(W(r, OT_CO) or "").strip()]["other_pay"] += amt

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
