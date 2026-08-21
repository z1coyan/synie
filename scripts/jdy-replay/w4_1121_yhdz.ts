/**
 * YHDZ 1121 贴现/兑付双计：解除对账 → journals.cancel → 对账改挂承兑交易。
 * 缺省 dry-run；--apply 才写。
 *
 * bun scripts/jdy-replay/w4_1121_yhdz.ts
 * bun scripts/jdy-replay/w4_1121_yhdz.ts --apply
 * bun scripts/jdy-replay/w4_1121_yhdz.ts --apply --allow-prod
 */
import { main } from './w4-1121-yhdz-cli.ts'

await main(process.argv.slice(2))
