/**
 * 简道云挂票误建供应商改挂费用报销。缺省 dry-run；生产加 --allow-prod。
 * bun scripts/jdy-replay/expense_reclass.ts
 * bun scripts/jdy-replay/expense_reclass.ts --apply --allow-prod
 */
import { main } from './expense-reclass-cli.ts'

await main(process.argv.slice(2))
