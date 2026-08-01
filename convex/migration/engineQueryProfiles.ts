/** Sealed Plan 004 read shapes; index names are checked by schema/codegen deployment. */
export const engineQueryProfiles = {
  inventoryCurrent: {
    table: 'inventoryCurrentBalances',
    index: 'by_key',
    equality: ['generation', 'companyId', 'warehouseId', 'materialId'],
  },
  inventoryAsOfMonths: {
    table: 'inventoryMonthlyDeltas',
    index: 'by_key_month',
    equality: ['generation', 'companyId', 'warehouseId', 'materialId'],
    range: 'postingMonth',
    maxDocuments: 2_400,
  },
  inventoryAsOfCurrentMonth: {
    table: 'inventoryDailyDeltas',
    index: 'by_key_date',
    equality: ['generation', 'companyId', 'warehouseId', 'materialId'],
    range: 'postingDate',
    maxDocuments: 31,
  },
  glAccountAsOfMonths: {
    table: 'glAccountMonthly',
    index: 'by_key_month',
    equality: ['generation', 'companyId', 'accountId'],
    range: 'postingMonth',
    maxDocuments: 2_400,
  },
  glAccountAsOfCurrentMonth: {
    table: 'glAccountDaily',
    index: 'by_key_date',
    equality: ['generation', 'companyId', 'accountId'],
    range: 'postingDate',
    maxDocuments: 31,
  },
  stockFactsByVoucher: {
    table: 'stockEntries', index: 'by_voucher', equality: ['voucherType', 'voucherId'], maxDocuments: 5_000,
  },
  glFactsByVoucher: {
    table: 'glEntries', index: 'by_voucher', equality: ['voucherType', 'voucherId'], maxDocuments: 5_000,
  },
} as const
