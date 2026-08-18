#!/usr/bin/env python3
"""W4 承兑 1122 对齐计划（只读库 + jdy-source，写出 JSON）。

彩排发现：W4 把「不过账」历史 exit 全按客户 ENDORSE 过到 1122，
且 bills.json 客户收入有 341 张在 synie 记成供应商接收（贷 2202）。
本计划把：
  1) 非 K16 客户 ENDORSE 改结算科目 3104（cancel + 再补过）
  2) 1:1 供应商接收改挂客户 + 1122
  3) 同票多户拆段：借 3104 / 贷 1122 日记账
  4) 主集客户 YHDZ 误挂 1123：借 1123 / 贷 1122
  5) 未落地的客户支出：借 1122 / 贷 3104
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from china_date import jdyChinaDate  # noqa: E402
from formula_asof import (  # noqa: E402
    BL_AMT,
    BL_CO,
    BL_CODE,
    BL_DATE,
    BL_DIR,
    BL_PT,
    W,
    find_source,
    load_json,
    norm_company,
    on_or_before,
)

TICKET = "_widget_1743297238052"
EXCEPTIONS = {
    "8038",
    "538",
    "8044",
    "8046",
    "8047",
    "8052",
    "8053",
    "8059",
    "8062",
    "8065",
    "8081",
    "8084",
    "8086",
}


def norm(n: str | None) -> str:
    return (n or "").strip().replace(" ", "")


def psql(dsn_args: list[str], sql: str) -> list[dict]:
    env = os.environ.copy()
    proc = subprocess.run(
        ["psql", *dsn_args, "-v", "ON_ERROR_STOP=1", "-A", "-F", "\t", "-P", "footer=off", "-c", sql],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln and not ln.startswith("SET")]
    if not lines:
        return []
    header = lines[0].split("\t")
    rows = []
    for ln in lines[1:]:
        cols = ln.split("\t")
        rows.append({header[i]: (cols[i] if i < len(cols) else "") for i in range(len(header))})
    return rows


def jdy_customer_bills(source: Path, as_of: str) -> tuple[list[dict], list[dict]]:
    income, expense = [], []
    for r in load_json(source / "raw" / "bills.json"):
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
        rec = {
            "code": code,
            "company": cp,
            "amt": round(float(W(r, BL_AMT) or 0), 2),
            "date": jdyChinaDate(W(r, BL_DATE)),
            "ticket": str(r.get("label") or W(r, TICKET) or "").strip(),
            "jid": r.get("_id"),
        }
        if str(W(r, BL_DIR) or "").strip() == "收入":
            income.append(rec)
        else:
            expense.append(rec)
    return income, expense


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--as-of", default="2026-08-17")
    p.add_argument("--pg-host", default=os.environ.get("PGHOST", "127.0.0.1"))
    p.add_argument("--pg-port", default=os.environ.get("PGPORT", "5441"))
    p.add_argument("--pg-user", default=os.environ.get("PGUSER", "synie"))
    p.add_argument("--pg-db", default=os.environ.get("PGDATABASE", "synie_replay_check"))
    p.add_argument("-o", "--output", default=".scratch/replay/w4_align_plan.json")
    args = p.parse_args(argv)

    dsn = ["-h", args.pg_host, "-p", str(args.pg_port), "-U", args.pg_user, "-d", args.pg_db]
    source = find_source(None)
    income, expense = jdy_customer_bills(source, args.as_of)
    exp_tickets = {norm(r["ticket"]) for r in expense if r["ticket"]}

    synie = psql(
        dsn,
        """
        SELECT t.id, b.bill_no, upper(t.transaction_type) AS typ,
               lower(coalesce(t.party_type,'')) AS ptyp, t.amount::text,
               CASE WHEN co.code IN ('JT','京泰') THEN '京泰'
                    WHEN co.code IN ('DF','东方') THEN '东方' ELSE co.code END AS company,
               coalesce(c.code,'') AS cust_code, coalesce(sa.code,'') AS settle
        FROM acc_bill_transaction t
        JOIN acc_bill b ON b.id = t.bill_id
        JOIN bas_company co ON co.id = t.company_id
        LEFT JOIN sal_customers c ON c.id = t.party_id AND lower(t.party_type)='customer'
        LEFT JOIN bas_account sa ON sa.id = t.settle_account_id
        WHERE t.status = 'audited'
        """,
    )

    cust_txs = [r for r in synie if r["ptyp"] == "customer"]
    syn_cust_nos = {norm(r["bill_no"]) for r in cust_txs}

    exp_keys = {(norm(r["ticket"]), r["code"], r["company"]) for r in expense}
    endorse_reclass = []
    endorse_restore = []
    for r in synie:
        if r["typ"] != "ENDORSE" or r["ptyp"] != "customer":
            continue
        key = (norm(r["bill_no"]), r["cust_code"], r["company"])
        keep = key in exp_keys
        if keep and r["settle"] == "3104":
            endorse_restore.append(r["id"])
        elif (not keep) and r["settle"] != "3104":
            endorse_reclass.append(r["id"])
        elif (not keep) and r["settle"] == "3104":
            continue

    um_income = [r for r in income if norm(r["ticket"]) not in syn_cust_nos]
    by_ticket: dict[str, list[dict]] = defaultdict(list)
    for r in um_income:
        by_ticket[norm(r["ticket"])].append(r)

    recv_by_no: dict[str, list[dict]] = defaultdict(list)
    for r in synie:
        if r["typ"] == "RECEIVE":
            recv_by_no[norm(r["bill_no"])].append(r)

    receive_retarget = []
    split_journals = []
    for ticket, rows in sorted(by_ticket.items()):
        recvs = recv_by_no.get(ticket, [])
        if (
            len(rows) == 1
            and len(recvs) == 1
            and abs(float(recvs[0]["amount"]) - rows[0]["amt"]) <= 0.01
        ):
            receive_retarget.append(
                {
                    "tx_id": recvs[0]["id"],
                    "customer_code": rows[0]["code"],
                    "company": rows[0]["company"],
                    "ticket": rows[0]["ticket"],
                    "amount": f"{rows[0]['amt']:.2f}",
                }
            )
        else:
            for row in rows:
                split_journals.append(
                    {
                        "date": row["date"],
                        "company": row["company"],
                        "customer_code": row["code"],
                        "amount": f"{row['amt']:.2f}",
                        "ticket": row["ticket"],
                        "jid": row["jid"],
                    }
                )

    ar_1123 = psql(
        dsn,
        """
        SELECT c.code AS customer_code,
               CASE WHEN co.code IN ('JT','京泰') THEN '京泰'
                    WHEN co.code IN ('DF','东方') THEN '东方' ELSE co.code END AS company,
               e.posting_date::text AS date,
               (e.credit - e.debit)::text AS amount,
               j.voucher_no
        FROM acc_gl_entry e
        JOIN bas_account a ON a.id = e.account_id
        JOIN acc_gl_journal j ON j.id = e.voucher_id AND e.voucher_type = 'acc.gl_journal'
        JOIN sal_customers c ON c.id = e.party_id
        JOIN bas_company co ON co.id = e.company_id
        WHERE NOT e.is_cancelled AND a.code = '1123' AND e.party_type = 'customer'
          AND e.credit > e.debit
        ORDER BY c.code, e.posting_date
        """,
    )
    ar_reclass_1123 = [
        {
            "date": r["date"],
            "company": r["company"],
            "customer_code": r["customer_code"],
            "amount": f"{float(r['amount']):.2f}",
            "src_voucher_no": r["voucher_no"],
        }
        for r in ar_1123
        if r["customer_code"] not in EXCEPTIONS
    ]

    syn_exp_1122 = {
        (norm(r["bill_no"]), r["cust_code"], r["company"])
        for r in synie
        if r["typ"] == "ENDORSE" and r["ptyp"] == "customer" and r["settle"] == "1122"
    }
    expense_journals = []
    for row in expense:
        if (norm(row["ticket"]), row["code"], row["company"]) in syn_exp_1122:
            continue
        expense_journals.append(
            {
                "date": row["date"],
                "company": row["company"],
                "customer_code": row["code"],
                "amount": f"{row['amt']:.2f}",
                "ticket": row["ticket"],
                "jid": row["jid"],
            }
        )

    plan = {
        "as_of": args.as_of,
        "endorse_reclass": endorse_reclass,
        "endorse_restore": endorse_restore,
        "receive_retarget": receive_retarget,
        "split_journals": split_journals,
        "ar_reclass_1123": ar_reclass_1123,
        "expense_journals": expense_journals,
        "stats": {
            "jdy_income": len(income),
            "jdy_expense": len(expense),
            "endorse_reclass": len(endorse_reclass),
            "endorse_restore": len(endorse_restore),
            "receive_retarget": len(receive_retarget),
            "split_journals": len(split_journals),
            "ar_reclass_1123": len(ar_reclass_1123),
            "expense_journals": len(expense_journals),
            "unmatched_income": len(um_income),
        },
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(plan["stats"], ensure_ascii=False, indent=2))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
