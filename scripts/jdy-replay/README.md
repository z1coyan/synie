# jdy-replay 校验脚本

只读。不 `--apply`，不跑 W0–W8，不对生产写库。

权威日期：`china_date.py` 的 `jdyChinaDate`（T16:00Z = 中国次日）。

## 主集

闸「0 行超差」只对**主集**：`jdy_targets_v3.csv` 里 `source=dashboard` 的仪表盘户，排除下列留档/例外（verify_today / verify_asof 内建同清单）：

| 排除 | 码 |
|---|---|
| 鲸耀 | `8038` |
| 锦州森源（公式有、synie 无档） | `538` |
| v2_carry synie 补档 | `8044` `8046` `8047` `8052` `8053` `8059` `8062` `8065` `8081` `8084` `8086` |

不要用全库 1122 FULL OUTER 直接判绿。USD 户 200/12/155/159 在仪表盘内，**留在主集**。
`verify_today` / `verify_asof` 只比对目标表里出现的户（`t.party_code IS NOT NULL`），live 多出来的非仪表盘 80xx（8006/8030/8037 等）不进闸。

## W4 承兑 1122 对齐

W4 把「不过账」历史 exit 全量补过账后，客户 ENDORSE 会误借 1122，且 `bills.json` 客户收入有一批在 synie 记成供应商接收（贷 2202）。冻结夜在 `backfill --kind bill` 之后跑：

```bash
python3 scripts/jdy-replay/build_w4_align_plan.py -o .scratch/replay/w4_align_plan.json
# 默认 dry-run
bun scripts/jdy-replay/w4_align_customer_bills.ts --plan .scratch/replay/w4_align_plan.json
bun scripts/jdy-replay/w4_align_customer_bills.ts --plan .scratch/replay/w4_align_plan.json --apply
```

做的事：非 K16 客户 ENDORSE 改结算 3104 再补过；1:1 供应商接收改挂客户 1122；`receive_untarget` 撤销误贷；同票拆段 / 主集 1123 回款 / 未落地客户支出走有日期的改挂凭证。禁止 `replayBill`。

彩排收口一次性脚本（同样 `--apply` 才写）：

```bash
bun scripts/jdy-replay/w4j_journals.ts --apply   # YHDZ/科目错挂
bun scripts/jdy-replay/w4m_mixed.ts --apply      # 混合户 13 行
bun scripts/jdy-replay/w4_1121_reclass.ts --apply # 剩余 YHDZ 1121→3104
```

接收过账日按简道云收入日改（任意时点）：`.scratch/replay/w4_fix_receive_dates.sql`（127 笔）。

## formula_asof.py

与 `.scratch/align/build_v3_final.py` 同一五项（发票 7313 / 期初 raw / 流水 66328 / 承兑 raw 净额 / 其他收付款 2557），日期用 `jdyChinaDate` 截到 T。源：`data/jdy-source/raw/`。

流水：按 `rule_clean` 方向取位（收入 B / 支出 C）+ `日期|账户|金额|对手` 去重，不读 scratch。若本机有 `.scratch/jdy-migration/clean/bank_tx_dedup.json`，启动时对照断言（客户 lookup 行 _id / 金额必须一致）。

CSV 只输出 `京泰` / `东方`（认 JT/DF）；空公司或其它字符串丢掉。

```bash
# 仓库根；本机无 data/jdy-source 时加 --source-dir
python3 scripts/jdy-replay/formula_asof.py --as-of 2023-12-31 -o /tmp/formula_asof.csv
# 列：company, party_code, amount（京泰/东方）
```

历史闸：2023-12-31、2024-12-31、2025-12-31。今天对仪表盘用较晚的 T（或 `jdy_targets_v3.csv` 展开进 `verify_today.sql`，先去掉例外户）。

## verify_*.sql

均 `psql -v ON_ERROR_STOP=1`。

`verify_today` / `verify_asof`：**先 `\i` 建表 → `\copy` → 再 `\i` 比对**。空表会 WARNING 并跳过比对（避免第一次把全库当超差）。

| 脚本 | 何时 | 怎么跑 | 绿 |
|---|---|---|---|
| `verify_today.sql` | W6 后今天 | `\i` → `\copy replay_targets` → `\i` | 主集 1122 `code='1122'` vs 目标，`\|diff\|>0.01` 0 行 |
| `verify_role_vs_code.sql` | 任一 asOf | `-v as_of=YYYY-MM-DD` | receivable 轧差 − 1122 = 0 |
| `verify_identity.sql` | **W6 前** | `-v window_start='2026-08-18 16:00:00+08'` | 0004–0007 1122 == 窗口内发票 + 新接收 + 客户退回 + 0001N；对不上不删找平 |
| `verify_asof.sql` | W8 截日 | `formula_asof.py --as-of T`，`\i` → `\copy replay_formula_asof` → `\i`，`-v as_of=T` | `posting_date<=T` 1122 vs 公式，**主集** 0 超差 |
| `verify_1124.sql` | W5 后 | 第 2 段要 W5 前表 `replay_1124_non_jdy_snap` | JDY 备注头 = remain+remarks；非 JDY 有 GL = 0；非 JDY vs 快照 |
| `verify_1121.sql` | W4/W8 | 白名单填 2217.64 那张 `voucher_no` | 科目 vs `acc_bill_holding` 按公司。**不对 AR/AP 报表** |
| `verify_no_plug.sql` | W5+W6 后 | 直接 `-f`；W6 删前同一会话先 `\i` 一次（或写入 `replay_plug_journal_ids`） | `A(J)-20200101-0004`..`0008` 三表 + 头/行审计 = 0。行审计按 `changes.journal_id`，不按凭证号 |

`window_start` 必须带时区。`acc_gl_entry.inserted_at` 是 UTC 墙钟（无 tz）；脚本用 `inserted_at AT TIME ZONE 'UTC'` 再和 timestamptz 比。中国冻结夜 16:00 = `2026-08-18 16:00:00+08`（不要传无偏移的 `16:00:00`，那会被当成 UTC 墙钟，当晚新过账会漏）。

`verify_identity.sql` 里 `known_gaps` 默认空。W6 把未导票 / 538 / 补记等逐项写进 VALUES，主集 gap 合计必须 0。
