/**
 * 制造主数据领域：present / 校验 / 行充实（W5 聚合迁移配套）。
 * 服务装配见 master-service.ts。
 */
import { decimal, isDecimalString, toDecimalString } from '@synie/shared'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { runeLen } from '~/platform/posting/text.ts'
import { ensureMaterial, ensureUnitAllowed, trimOptional } from './helpers.ts'
import type {
  Bom,
  BomByproduct,
  BomComponent,
  BomRoute,
  BomStatus,
  Operation,
  ProcessTemplate,
  TemplateItem,
} from './types.ts'

export const OPERATION_RESOURCE = 'mfgOperations'
export const TEMPLATE_RESOURCE = 'mfgProcessTemplates'
export const TEMPLATE_ITEM_RESOURCE = 'mfgProcessTemplateItems'
export const BOM_RESOURCE = 'mfgBoms'
export const BOM_COMPONENT_RESOURCE = 'mfgBomComponents'
export const BOM_ROUTE_RESOURCE = 'mfgBomRoutes'
export const BOM_BYPRODUCT_RESOURCE = 'mfgBomByproducts'

export const MFG_DUP = { code: '23505' as const, message: '制造数据已存在' }
export const MFG_REF = { code: '23503' as const, message: '制造数据已被业务引用,不可删除' }

export function presentHead(row: Record<string, unknown>): Operation {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    note: row.note == null ? null : String(row.note),
    insertedAt: row.insertedAt as Date,
    updatedAt: row.updatedAt as Date,
  }
}

export function presentTemplate(row: Record<string, unknown>): ProcessTemplate {
  return presentHead(row)
}

export function presentBom(row: Record<string, unknown>): Bom {
  return {
    id: String(row.id),
    code: String(row.code),
    planName: row.planName == null ? null : String(row.planName),
    note: row.note == null ? null : String(row.note),
    materialId: String(row.materialId),
    status: String(row.status).toLowerCase() as BomStatus,
    insertedAt: row.insertedAt as Date,
    updatedAt: row.updatedAt as Date,
  }
}

export function presentRouteItem(row: Record<string, unknown>): TemplateItem {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    requirement: row.requirement == null ? null : String(row.requirement),
    isOutsourced: Boolean(row.isOutsourced),
    templateId: String(row.templateId),
    operationId: String(row.operationId),
    insertedAt: row.insertedAt as Date,
    updatedAt: row.updatedAt as Date,
  }
}

export function presentBomRoute(row: Record<string, unknown>): BomRoute {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    requirement: row.requirement == null ? null : String(row.requirement),
    isOutsourced: Boolean(row.isOutsourced),
    bomId: String(row.bomId),
    operationId: String(row.operationId),
    insertedAt: row.insertedAt as Date,
    updatedAt: row.updatedAt as Date,
  }
}

export function presentComponent(row: Record<string, unknown>): BomComponent {
  return {
    id: String(row.id),
    quantity: String(row.quantity),
    lossRate: row.lossRate == null ? null : String(row.lossRate),
    note: row.note == null ? null : String(row.note),
    bomId: String(row.bomId),
    materialId: String(row.materialId),
    unitId: String(row.unitId),
    insertedAt: row.insertedAt as Date,
    updatedAt: row.updatedAt as Date,
  }
}

export function presentByproduct(row: Record<string, unknown>): BomByproduct {
  return {
    id: String(row.id),
    quantity: String(row.quantity),
    note: row.note == null ? null : String(row.note),
    bomId: String(row.bomId),
    materialId: String(row.materialId),
    unitId: String(row.unitId),
    insertedAt: row.insertedAt as Date,
    updatedAt: row.updatedAt as Date,
  }
}

export function validateHeadNote(
  label: string,
  draft: Record<string, unknown>,
  action: 'create' | 'update',
): void {
  const fields: Record<string, string[]> = {}
  if (action === 'create' || draft.name !== undefined) {
    const n = String(draft.name ?? '').trim()
    if (!n || runeLen(n) > 64) fields.name = ['不能为空且最多 64 个字符']
    draft.name = n
  }
  if (draft.note !== undefined) {
    const nt = trimOptional(draft.note as string | null)
    if (nt && runeLen(nt) > 255) fields.note = ['最多 255 个字符']
    draft.note = nt
  } else if (action === 'create') {
    draft.note = null
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation(`${label}参数不合法`, fields)
  }
}

export function validateBomHead(draft: Record<string, unknown>, action: 'create' | 'update'): void {
  const fields: Record<string, string[]> = {}
  if (action === 'create' && !draft.materialId) fields.materialId = ['必填']
  if (draft.planName !== undefined) {
    const p = trimOptional(draft.planName as string | null)
    if (p && runeLen(p) > 64) fields.planName = ['最多 64 个字符']
    draft.planName = p
  } else if (action === 'create') {
    draft.planName = null
  }
  if (draft.note !== undefined) {
    const n = trimOptional(draft.note as string | null)
    if (n && runeLen(n) > 255) fields.note = ['最多 255 个字符']
    draft.note = n
  } else if (action === 'create') {
    draft.note = null
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('BOM参数不合法', fields)
  }
}

export function parseQty(raw: unknown): string {
  const s = String(raw ?? '')
  if (!isDecimalString(s) || !decimal(s).gt(0)) {
    throw ApiError.validation('BOM行参数不合法', { quantity: ['必须大于 0'] })
  }
  return toDecimalString(decimal(s))
}

export function parseLossRate(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (!isDecimalString(String(raw))) {
    throw ApiError.validation('BOM行参数不合法', { lossRate: ['必须为有效十进制数字'] })
  }
  const v = decimal(String(raw))
  if (v.isNegative()) {
    throw ApiError.validation('BOM行参数不合法', { lossRate: ['不能为负'] })
  }
  return toDecimalString(v)
}

export function validateBomLine(
  bomMaterial: string,
  material: string,
  quantity: string,
  lossRate: string | null,
): void {
  const fields: Record<string, string[]> = {}
  if (!material) fields.materialId = ['必填']
  else if (material === bomMaterial) fields.materialId = ['行物料不能是 BOM 物料自身']
  if (!decimal(quantity).gt(0)) fields.quantity = ['必须大于 0']
  if (lossRate != null && decimal(lossRate).isNegative()) fields.lossRate = ['不能为负']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('BOM行参数不合法', fields)
  }
}

export function normalizeRouteDraft(
  draft: Record<string, unknown>,
  action: 'create' | 'update',
): void {
  const fields: Record<string, string[]> = {}
  if (action === 'create' || draft.operationId !== undefined) {
    if (!draft.operationId) fields.operationId = ['必填']
  }
  if (draft.requirement !== undefined) {
    const requirement = trimOptional(draft.requirement as string | null)
    if (requirement && runeLen(requirement) > 512) fields.requirement = ['最多 512 个字符']
    draft.requirement = requirement
  } else if (action === 'create') {
    draft.requirement = null
  }
  if (draft.isOutsourced === undefined || draft.isOutsourced === null) {
    if (action === 'create') draft.isOutsourced = false
  } else {
    draft.isOutsourced = Boolean(draft.isOutsourced)
  }
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('工艺路线行参数不合法', fields)
  }
}

export async function bomLineBeforeWrite(
  trx: DbHandle,
  ctx: {
    action: 'create' | 'update'
    draft: Record<string, unknown>
    parent: Record<string, unknown>
    withLoss: boolean
  },
): Promise<void> {
  const materialId = String(ctx.draft.materialId ?? '')
  const quantity = parseQty(ctx.draft.quantity)
  const lossRate = ctx.withLoss ? parseLossRate(ctx.draft.lossRate) : null
  if (ctx.withLoss) ctx.draft.lossRate = lossRate
  ctx.draft.quantity = quantity
  if (ctx.draft.note !== undefined) {
    ctx.draft.note = trimOptional(ctx.draft.note as string | null)
  } else if (ctx.action === 'create') {
    ctx.draft.note = null
  }
  validateBomLine(String(ctx.parent.materialId), materialId, quantity, lossRate)
  await ensureMaterial(trx, materialId, ['STOCK'], 'BOM行')
  await ensureUnitAllowed(trx, materialId, String(ctx.draft.unitId))
}

export function headCreatePayload(input: {
  code?: string | null
  name: string
  note?: string | null
}): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: input.name, note: input.note ?? null }
  if (input.code != null && String(input.code).trim() !== '') payload.code = input.code
  return payload
}

export function headUpdatePatch(input: {
  name?: string
  note?: string | null
  notePresent?: boolean
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.notePresent) patch.note = input.note ?? null
  return patch
}

export function routeItemCreatePayload(input: {
  templateId?: string
  bomId?: string
  operationId: string
  seq: number
  requirement?: string | null
  isOutsourced?: boolean
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    operationId: input.operationId,
    seq: input.seq,
    requirement: input.requirement ?? null,
    isOutsourced: input.isOutsourced ?? false,
  }
  if (input.templateId !== undefined) payload.templateId = input.templateId
  if (input.bomId !== undefined) payload.bomId = input.bomId
  return payload
}

export function routeItemUpdatePatch(input: {
  operationId?: string
  seq?: number
  requirement?: string | null
  requirementPresent?: boolean
  isOutsourced?: boolean
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (input.operationId !== undefined) patch.operationId = input.operationId
  if (input.seq !== undefined) patch.seq = input.seq
  if (input.requirementPresent) patch.requirement = input.requirement ?? null
  if (input.isOutsourced !== undefined) patch.isOutsourced = input.isOutsourced
  return patch
}
