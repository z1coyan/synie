import { Decimal, roundBaseQty, scaledInt64ToDecimal } from '@synie/shared'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel } from '../../_generated/dataModel'
import { synieError, validationError } from '../../lib/errors'

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
type Wire = Record<string, unknown>

function quantityDecimal(value: unknown, field: string, allowZero: boolean): string {
  if (typeof value !== 'string') throw validationError('参数不合法', { [field]: ['必须是十进制字符串'] })
  let parsed: Decimal
  try { parsed = new Decimal(value) } catch { throw validationError('参数不合法', { [field]: ['必须是十进制字符串'] }) }
  if (!parsed.isFinite() || (allowZero ? parsed.lt(0) : parsed.lte(0))) {
    throw validationError('参数不合法', { [field]: [allowZero ? '不能小于零' : '必须大于零'] })
  }
  return value
}

export async function materialUnitSnapshot(
  ctx: Ctx,
  materialValue: unknown,
  unitValue: unknown,
  quantity?: { field: string; value: unknown; allowZero?: boolean },
): Promise<Wire> {
  if (typeof materialValue !== 'string' || typeof unitValue !== 'string') {
    throw synieError('validation', '物料和单位不能为空')
  }
  const materialId = ctx.db.normalizeId('materials', materialValue)
  const unitId = ctx.db.normalizeId('units', unitValue)
  const [material, unit] = await Promise.all([
    materialId ? ctx.db.get(materialId) : null,
    unitId ? ctx.db.get(unitId) : null,
  ])
  if (!material?.active) throw synieError('validation', '物料不存在或已停用')
  if (!unit) throw synieError('validation', '单位不存在')
  let factor = '1'
  if (material.defaultUnitId !== unit._id) {
    const conversion = await ctx.db.query('materialUnits').withIndex('by_material_unit', (q) =>
      q.eq('materialId', material._id).eq('unitId', unit._id),
    ).unique()
    if (!conversion) throw synieError('validation', '物料没有该单位换算关系')
    factor = scaledInt64ToDecimal(conversion.factorScaled, 6)
  }
  const snapshot: Wire = {
    materialId: material._id,
    unitId: unit._id,
    materialCode: material.code,
    materialName: material.name,
    materialSpec: material.spec,
    customerPartNo: material.customerPartNo,
    unitName: unit.name,
  }
  if (quantity) {
    const value = quantityDecimal(quantity.value, quantity.field, quantity.allowZero === true)
    snapshot.baseQty = roundBaseQty(new Decimal(value).mul(factor))
  }
  return snapshot
}

export async function currencySnapshot(ctx: Ctx, currencyValue: unknown): Promise<Wire> {
  if (currencyValue === null || currencyValue === undefined || currencyValue === '') return { currencyCode: null }
  if (typeof currencyValue !== 'string') throw synieError('validation', '币种不能为空')
  const id = ctx.db.normalizeId('currencies', currencyValue)
  const currency = id ? await ctx.db.get(id) : null
  if (!currency?.active) throw synieError('validation', '币种不存在或已停用')
  return { currencyId: currency._id, currencyCode: currency.isoCode }
}
