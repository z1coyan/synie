/**
 * 日记账/YHDZ 1122 改挂。缺省 dry-run；--apply 才写。
 *
 * bun scripts/jdy-replay/w4j_journals.ts
 * bun scripts/jdy-replay/w4j_journals.ts --apply
 */
import { main } from '../../server/src/modules/finance/w4j-journals-cli.ts'

await main(process.argv.slice(2))
