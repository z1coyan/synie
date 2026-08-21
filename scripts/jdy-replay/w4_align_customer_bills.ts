/**
 * W4 承兑 1122 对齐。读 build_w4_align_plan.py 的 JSON。
 * 缺省 dry-run；--apply 才写。
 *
 * bun scripts/jdy-replay/w4_align_customer_bills.ts --plan .scratch/replay/w4_align_plan.json
 */
import { main } from './w4-align-cli.ts'

await main(process.argv.slice(2))
