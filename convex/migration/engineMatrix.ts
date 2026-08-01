/**
 * Plan 004 historical coverage contract. The deleted source coordinate and title
 * keep the frozen denominator auditable; the fourth column is the live replacement
 * evidence and must never point back into the retired workspace.
 */
export const legacyEngineTestMap = [
  ['server/src/engines/inventory/inventory.test.ts', '空分录拒绝', 'ported', 'convex/engines/inventory/model.test.ts'],
  ['server/src/engines/inventory/inventory.test.ts', '凭证缺参拒绝', 'ported', 'convex/engines/inventory/model.test.ts'],
  ['server/src/engines/inventory/inventory.test.ts', '数量为零拒绝（触库前）', 'ported', 'convex/engines/inventory/model.test.ts'],
  ['server/src/engines/inventory/inventory.postgres.test.ts', 'seed fixture', 'not-applicable', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/inventory/inventory.postgres.test.ts', 'post 入仓 → 同单再过账二仓（多阶段）→ balance → cancel 幂等', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/inventory/inventory.postgres.test.ts', '负库存拒绝（出库超出余额）', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/inventory/inventory.postgres.test.ts', '作废致负拒绝（后有出库占用余额）', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/inventory/inventory.postgres.test.ts', 'allow_negative 仓豁免负库存', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/inventory/inventory.postgres.test.ts', '非叶子仓 / 他司仓 / 物料不存在拒绝', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/inventory/inventory.postgres.test.ts', '并发出库按（仓×物料）锁串行：仅一笔成功', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/inventory/inventory.postgres.test.ts', '数量十进制精度（6 位档）过账与余额', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.test.ts', '合法两行借贷配平通过', 'ported', 'convex/engines/gl/model.test.ts'],
  ['server/src/engines/gl/gl.test.ts', '不足两行拒绝', 'ported', 'convex/engines/gl/model.test.ts'],
  ['server/src/engines/gl/gl.test.ts', '双边为零拒绝', 'ported', 'convex/engines/gl/model.test.ts'],
  ['server/src/engines/gl/gl.test.ts', '同一行借贷均非零拒绝', 'ported', 'convex/engines/gl/model.test.ts'],
  ['server/src/engines/gl/gl.test.ts', '借贷不平拒绝（容差 0）', 'ported', 'convex/engines/gl/model.test.ts'],
  ['server/src/engines/gl/gl.test.ts', '对手类型与 ID 必须成对', 'ported', 'convex/engines/gl/model.test.ts'],
  ['server/src/engines/gl/gl.test.ts', '普通过账拒绝负数；红冲允许负数', 'ported', 'convex/engines/gl/model.test.ts'],
  ['server/src/engines/gl/gl.test.ts', '十进制字符串精确配平（无 number 精度漂移）', 'ported', 'convex/engines/gl/model.test.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', 'seed fixture', 'not-applicable', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', 'post → reverse 归零 → 重复红冲 conflict → cancel 幂等', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', '配平拒绝', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', '往来科目缺对手拒绝', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', '汇总科目 / 停用科目 / 他司科目拒绝', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', '科目不存在拒绝', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', '红冲行豁免往来对手；普通行不豁免', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', 'cancel 在无分录时仍成功（幂等）', 'ported', 'scripts/verify-convex-engines.ts'],
  ['server/src/engines/gl/gl.postgres.test.ts', 'reverse 无分录 conflict', 'ported', 'scripts/verify-convex-engines.ts'],
] as const

export const engineOperationMatrix = {
  number: {
    readSet: 'one enabled rule + one (rule, scope) counter',
    writes: 'counter=1; caller head=1; audit=1',
    idempotency: 'caller operation key; failed mutation consumes no number',
    errors: ['编号规则不存在', '编号字段缺失', '编号超出范围'],
    budget: 'reads=2+catalog lookups; writes=2+audit',
  },
  audit: {
    readSet: 'none',
    writes: 'one size-bounded audit document',
    idempotency: 'owned by enclosing business mutation',
    errors: ['审计内容不可序列化'],
    budget: 'writes=1; bytes<=64KiB',
  },
  inventoryPost: {
    readSet: 'voucher validation refs + one stable current balance per distinct warehouse/material',
    writes: 'facts=L; current=K; daily=K; monthly=K; optional head=1; audit=1',
    idempotency: 'multi-stage append preserved; caller operation key prevents transport replay',
    errors: ['库存过账参数不合法', '库存过账校验失败', '库存不足'],
    budget: 'reads<=2L+K; writes=L+3K+2',
  },
  inventoryCancel: {
    readSet: 'voucher facts + current balance per distinct key',
    writes: 'facts=L; current=K; daily=K; monthly=K; optional head=1; audit=1',
    idempotency: 'no live facts => successful no-op',
    errors: ['作废后库存不足'],
    budget: 'reads<=L+K; writes=L+3K+2',
  },
  glPost: {
    readSet: 'one account and optional currency per line',
    writes: 'facts=L; account daily/monthly<=2L; party daily/monthly<=2L; optional head=1; audit=1',
    idempotency: 'caller operation key; existing live normal voucher conflicts',
    errors: ['总账过账校验失败', '借贷不平'],
    budget: 'reads<=2L; writes<=5L+2',
  },
  glReverse: {
    readSet: 'all live non-reversal voucher facts',
    writes: 'reverse facts=L; original links=L; projections<=4L; audit=1',
    idempotency: 'second reverse conflicts',
    errors: ['总账分录不存在', '凭证已经红冲'],
    budget: 'reads<=L; writes<=6L+1',
  },
  glCancel: {
    readSet: 'all live voucher facts',
    writes: 'facts=L; projections<=4L; audit=1',
    idempotency: 'no live facts => successful no-op',
    errors: [],
    budget: 'reads<=L; writes<=5L+1',
  },
} as const
