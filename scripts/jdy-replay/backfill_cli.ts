/**
 * W2/W3/W4/W5 唯一 TS 执行入口。
 *
 * bun scripts/jdy-replay/backfill_cli.ts \
 *   --kind invoice|bill|delivery-remain \
 *   --ids-file <uuid 列表> \
 *   --dry-run
 *
 * 缺省 dry-run；--apply 才写库。
 */
import { main } from './backfill-cli.ts'

await main(process.argv.slice(2))
