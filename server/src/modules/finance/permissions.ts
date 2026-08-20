/**
 * 银行流水权限常量：ResourceDefinition 与 service 鉴权共用，禁止字符串漂移。
 * reconcile 为语义 command key（v1 曾伪装为 export，见工单 11 收缩）。
 */
export const ACC_BANK_TRANSACTION = {
  prefix: 'acc.bank_transaction',
  read: 'acc.bank_transaction:read',
  create: 'acc.bank_transaction:create',
  update: 'acc.bank_transaction:update',
  delete: 'acc.bank_transaction:delete',
  import: 'acc.bank_transaction:create',
  reconcile: 'acc.bank_transaction:update',
} as const

export type AccBankTransactionPermission =
  (typeof ACC_BANK_TRANSACTION)[keyof typeof ACC_BANK_TRANSACTION]
