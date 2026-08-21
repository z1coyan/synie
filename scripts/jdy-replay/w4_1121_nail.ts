/**
 * 钉 1121 持有。缺省 dry-run；--apply 才写。生产加 --allow-prod。
 * bun scripts/jdy-replay/w4_1121_nail.ts
 * bun scripts/jdy-replay/w4_1121_nail.ts --apply --allow-prod
 */
import { main } from './w4-1121-nail-cli.ts'

await main(process.argv.slice(2))
