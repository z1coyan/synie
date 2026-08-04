/**
 * 封路特征化测试（工单 04）：`modules/**` 禁止 import 旧授权原语。
 *
 * 新体系下模块零鉴权代码——路由挂 `guard(resource, action)`，服务收 Permit，
 * 列表/单记录/写入三个执行点由平台拥有。豁免清单是**扫荡进度表**：
 * 09-12 每迁一个模块就从这里删一行，清零即全库无旧原语（工单 15 断言为空）。
 */
import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'

/** 旧授权原语（platform/authz/actor.ts 与 db/list.ts 的过渡层导出） */
const FORBIDDEN = [
  'requirePermission',
  'hasPermission',
  'companyScopeWhere',
  'canAccessCompany',
  'requireCompanyAccess',
  'companyFilter',
] as const

/**
 * 扫荡期豁免（按模块逐批清零）。新增文件一律不得进入本清单——
 * 新代码走 Permit，加不进来说明设计对了。
 */
const EXEMPT = new Set<string>([
  'modules/accounting/entry-service.ts',
  'modules/accounting/journal-service.ts',
  'modules/base/account-service.ts',
  'modules/base/company-service.ts',
  'modules/base/currency-service.ts',
  'modules/base/market/service.ts',
  'modules/base/unit-service.ts',
  'modules/finance/banking-accounts.ts',
  'modules/finance/banking-import.ts',
  'modules/finance/banking-recon.ts',
  'modules/finance/bill-service.ts',
  'modules/finance/common.ts',
  'modules/finance/expense-service.ts',
  'modules/finance/invoice-service.ts',
  'modules/hr/attendance-service.ts',
  'modules/hr/payroll-service.ts',
  'modules/iam/service.ts',
  'modules/inventory/category-service.ts',
  'modules/inventory/helpers.ts',
  'modules/inventory/material-service.ts',
  'modules/inventory/material-unit-service.ts',
  'modules/inventory/stock-count-service.ts',
  'modules/inventory/stock-doc-service.ts',
  'modules/inventory/stock-entry-service.ts',
  'modules/inventory/stock-transfer-service.ts',
  'modules/inventory/warehouse-service.ts',
  'modules/manufacturing/demand-service.ts',
  'modules/manufacturing/helpers.ts',
  'modules/manufacturing/master-service.ts',
  'modules/manufacturing/mold-design-service.ts',
  'modules/manufacturing/output-service.ts',
  'modules/manufacturing/work-order-docbuilder.ts',
  'modules/manufacturing/work-order-service.ts',
  'modules/party/address-service.ts',
  'modules/party/party-service.ts',
  'modules/sales/company-account-default.ts',
  'modules/scm/orderflow/routes.ts',
  'modules/scm/orderflow/service.ts',
  'modules/trading/common.ts',
  'modules/trading/fulfillment/service.ts',
  'modules/trading/order/docbuilder.ts',
  'modules/trading/order/outsourced-config.ts',
  'modules/trading/order/service.ts',
  'modules/trading/outsourced/service.ts',
  'modules/trading/quotation/service.ts',
  'modules/trading/reconciliation/service.ts',
])

async function moduleFiles(): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Glob('modules/**/*.ts').scan({ cwd: 'src' })) {
    if (!file.endsWith('.test.ts')) files.push(file)
  }
  return files.sort()
}

describe('封路：modules 不得使用旧授权原语', () => {
  const pattern = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`)

  test('非豁免模块文件零命中', async () => {
    const offenders: string[] = []
    for (const file of await moduleFiles()) {
      if (EXEMPT.has(file)) continue
      const text = await Bun.file(`src/${file}`).text()
      if (pattern.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test('豁免清单无僵尸项（迁完必须同步删行）', async () => {
    const files = new Set(await moduleFiles())
    const stale: string[] = []
    for (const file of EXEMPT) {
      if (!files.has(file)) {
        stale.push(`${file}（文件已不存在）`)
        continue
      }
      const text = await Bun.file(`src/${file}`).text()
      if (!pattern.test(text)) stale.push(`${file}（已无旧原语，可移出豁免）`)
    }
    expect(stale).toEqual([])
  })

  test('豁免规模只减不增（扫荡进度快照）', () => {
    expect(EXEMPT.size).toBeLessThanOrEqual(46)
  })
})
