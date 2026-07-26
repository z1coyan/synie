import { accountClient } from './accounts'
import { glEntryClient, glJournalClient, glJournalLineClient } from './accounting'
import { companyClient } from './companies'
import { customerClient } from './customers'
import { currencyClient } from './currencies'
import { employeeClient } from './employees'
import { fileClient, storageClient } from './files'
import { roleClient, userClient } from './iam'
import {
  materialCategoryClient,
  materialClient,
  materialUnitClient,
  stockCountClient,
  stockCountItemClient,
  stockDocClient,
  stockDocItemClient,
  stockEntryClient,
  stockTransferClient,
  stockTransferItemClient,
  warehouseClient,
} from './inventory'
import { marketInstrumentClient, marketPricePointClient } from './market'
import { numberingCounterClient, numberingRuleClient } from './numbering'
import {
  purchaseOrderClient,
  purchaseOrderItemByproductClient,
  purchaseOrderItemClient,
  purchaseOrderItemMaterialClient,
  salesOrderClient,
  salesOrderItemClient,
} from './orders'
import { printTemplateClient } from './printing'
import {
  purchaseQuotationClient,
  purchaseQuotationItemClient,
  purchaseQuotationTierClient,
  salesQuotationClient,
  salesQuotationItemClient,
  salesQuotationTierClient,
} from './quotations'
import { supplierClient } from './suppliers'
import {
  accountingSettingClient,
  manufacturingSettingClient,
  salesSettingClient,
  systemSettingClient,
} from './settings'
import { unitClient } from './units'
import type { ResourceClient } from './types'

const clients: Record<string, ResourceClient> = {
  accGlEntries: glEntryClient,
  accGlJournals: glJournalClient,
  accGlJournalLines: glJournalLineClient,
  basAccounts: accountClient,
  basCompanies: companyClient,
  basCurrencies: currencyClient,
  basMarketInstruments: marketInstrumentClient,
  basMarketPricePoints: marketPricePointClient,
  basUnits: unitClient,
  invMaterialCategories: materialCategoryClient,
  invMaterials: materialClient,
  invMaterialUnits: materialUnitClient,
  invWarehouses: warehouseClient,
  invStockEntries: stockEntryClient,
  invStockDocs: stockDocClient,
  invStockDocItems: stockDocItemClient,
  invStockTransfers: stockTransferClient,
  invStockTransferItems: stockTransferItemClient,
  invStockCounts: stockCountClient,
  invStockCountItems: stockCountItemClient,
  hrEmployees: employeeClient,
  purSuppliers: supplierClient,
  purOrders: purchaseOrderClient,
  purOrderItems: purchaseOrderItemClient,
  purOrderItemMaterials: purchaseOrderItemMaterialClient,
  purOrderItemByproducts: purchaseOrderItemByproductClient,
  purQuotations: purchaseQuotationClient,
  purQuotationItems: purchaseQuotationItemClient,
  purQuotationTiers: purchaseQuotationTierClient,
  salCustomers: customerClient,
  salOrders: salesOrderClient,
  salOrderItems: salesOrderItemClient,
  salQuotations: salesQuotationClient,
  salQuotationItems: salesQuotationItemClient,
  salQuotationTiers: salesQuotationTierClient,
  sysFiles: fileClient,
  sysNumberingCounters: numberingCounterClient,
  sysNumberingRules: numberingRuleClient,
  sysPrintTemplates: printTemplateClient,
  accSettings: accountingSettingClient,
  mfgSettings: manufacturingSettingClient,
  salSettings: salesSettingClient,
  sysSettings: systemSettingClient,
  sysRoles: roleClient,
  sysStorages: storageClient,
  sysUsers: userClient,
}

export function resourceClientFor(resource: string): ResourceClient | undefined {
  return clients[resource]
}
