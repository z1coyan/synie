/**
 * 生产与测试共用的资源注册组合入口。
 * 顺序固定：平台横切 → 基础/IAM/业务域 → 打印（字段目录依赖已注册资源）。
 * 新增业务资源时只应扩展本入口或其调用的模块 register* 函数，禁止在 index.ts
 * 与 test/helpers.ts 再维护第二份列表。
 */
import { registerAccountingResources } from '~/modules/accounting/index.ts'
import { registerBaseResources } from '~/modules/base/index.ts'
import { registerMarketResources } from '~/modules/base/market/index.ts'
import { registerFinanceResources } from '~/modules/finance/index.ts'
import { registerHrResources } from '~/modules/hr/index.ts'
import { registerIamResources } from '~/modules/iam/index.ts'
import { registerInventoryResources } from '~/modules/inventory/index.ts'
import { registerManufacturingResources } from '~/modules/manufacturing/index.ts'
import { registerPartyResources } from '~/modules/party/index.ts'
import { registerSalesCompanyAccountDefault } from '~/modules/sales/index.ts'
import { registerScmResources } from '~/modules/scm/index.ts'
import { registerTradingResources } from '~/modules/trading/index.ts'
import { registerAuditResources } from '~/platform/audit/index.ts'
import { registerFileResources } from '~/platform/files/index.ts'
import { registerNumberingResources } from '~/platform/numbering/index.ts'
import { registerPrintingResources } from '~/platform/printing/index.ts'
import { registerSettingResources } from '~/platform/settings/index.ts'
import { createRegistry, type Registry } from './registry.ts'

/** 将全部产品资源注册进给定 Registry（幂等要求：registry 必须为空） */
export function registerAllResources(registry: Registry): void {
  registerSettingResources(registry)
  registerNumberingResources(registry)
  registerFileResources(registry)
  registerAuditResources(registry)
  registerBaseResources(registry)
  registerMarketResources(registry)
  registerIamResources(registry)
  registerPartyResources(registry)
  registerHrResources(registry)
  registerSalesCompanyAccountDefault(registry)
  registerInventoryResources(registry)
  registerAccountingResources(registry)
  registerTradingResources(registry)
  registerFinanceResources(registry)
  registerScmResources(registry)
  registerManufacturingResources(registry)
  // 打印模板 Meta 在业务域之后（字段目录自 Registry fail-closed 派生）
  registerPrintingResources(registry)
}

/** 创建已注册全部资源的 Registry（测试与报告脚本首选入口） */
export function createSealedResourceRegistry(): Registry {
  const registry = createRegistry()
  registerAllResources(registry)
  return registry
}
