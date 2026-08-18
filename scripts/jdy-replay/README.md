# jdy-replay 校验脚本

只读。不 `--apply`，不跑 W0–W8，不对生产写库。

权威日期：`china_date.py` 的 `jdyChinaDate`（T16:00Z = 中国次日）。

## formula_asof.py

与 `.scratch/align/build_v3_final.py` 同一五项（发票 7313 / 期初 raw / 流水 66328 / 承兑 raw 净额 / 其他收付款 2557），日期用 `jdyChinaDate` 截到 T。源：`data/jdy-source/raw/`。

```bash
# 仓库根；本机无 data/jdy-source 时加 --source-dir
python3 scripts/jdy-replay/formula_asof.py --as-of 2023-12-31 -o /tmp/formula_asof.csv
# 列：company, party_code, amount（京泰/东方）
```

历史闸：2023-12-31、2024-12-31、2025-12-31。今天对仪表盘用较晚的 T（或 `jdy_targets_v3.csv` 展开进 `verify_today.sql`）。

## verify_*.sql

均 `psql -v ON_ERROR_STOP=1`。需要目标表的先 `\copy` 再跑查询。

| 脚本 | 何时 | 怎么跑 | 绿 |
|---|---|---|---|
| `verify_today.sql` | W6 后今天 | 建/载入 `replay_targets(company,party_code,amount)` 后 `\i` | 1122 `code='1122'` vs 目标，`\|diff\|>0.01` 0 行 |
| `verify_role_vs_code.sql` | 任一 asOf | `-v as_of=YYYY-MM-DD` | receivable 轧差 − 1122 = 0 |
| `verify_identity.sql` | **W6 前** | `-v window_start='2026-08-18 16:00:00'` | 0004–0007 1122 == 发票 + 新接收 + 客户退回 + 0001N；对不上不删找平 |
| `verify_asof.sql` | W8 截日 | 先 `formula_asof.py --as-of T`，`\copy replay_formula_asof`，`-v as_of=T` | `posting_date<=T` 1122 vs 公式，主集 0 超差 |
| `verify_1124.sql` | W5 后 | 第 2 段要 W5 前表 `replay_1124_non_jdy_snap` | JDY 备注头 = remain+remarks；非 JDY 有 GL = 0；非 JDY vs 快照 |
| `verify_1121.sql` | W4/W8 | 白名单填 2217.64 那张 `voucher_no` | 科目 vs `acc_bill_holding` 按公司。**不对 AR/AP 报表** |
| `verify_no_plug.sql` | W5+W6 后 | 直接 `-f` | `A(J)-20200101-0004`..`0008` 三表 + 审计 = 0 |

`verify_identity.sql` 里 `known_gaps` 默认空。W6 把未导票 / 538 / 补记等逐项写进 VALUES，主集 gap 合计必须 0。
