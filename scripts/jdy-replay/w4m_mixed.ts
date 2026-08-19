/**
 * 混合户 1122 改挂日记账。缺省 dry-run；--apply 才过账。
 *
 * bun scripts/jdy-replay/w4m_mixed.ts
 * bun scripts/jdy-replay/w4m_mixed.ts --apply
 */
import { main } from '../../server/src/modules/finance/w4m-mixed-cli.ts'

await main(process.argv.slice(2))
