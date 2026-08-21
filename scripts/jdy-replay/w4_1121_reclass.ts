/**
 * 剩余 YHDZ 1121（无对应贴现/兑付银行分录）改挂 3104，不动银行借方、不动 1122。
 * 白名单 A(J)-20260514-0030 2217.64 不改。
 * bun scripts/jdy-replay/w4_1121_reclass.ts [--apply]
 */
import { main } from './w4-1121-reclass-cli.ts'
await main(process.argv.slice(2))
