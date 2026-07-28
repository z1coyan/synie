import type { Actor } from '~/platform/authz/actor.ts'
import type { MasterData } from './helpers.ts'
import type { MfgResult, SampleDataDeps } from './types.ts'

export async function seedMfg(
  deps: SampleDataDeps,
  actor: Actor,
  md: MasterData,
): Promise<MfgResult> {
  const opsByName: Record<string, string> = {}
  const opIDs: string[] = []
  for (const name of ['下料', '冲压', '折弯', '喷涂', '装配']) {
    const op = await deps.manufacturingMaster.createOperation(actor, { name })
    opsByName[name] = op.id
    opIDs.push(op.id)
  }

  const t1 = await deps.manufacturingMaster.createTemplate(actor, { name: '钣金件标准工艺' })
  for (const row of [
    { op: '下料', seq: 10, req: '按图下料,去毛刺', isOutsourced: false },
    { op: '冲压', seq: 20, req: '冲孔/落料一次成型', isOutsourced: false },
    { op: '折弯', seq: 30, req: '按图折弯,角度±1°', isOutsourced: false },
    { op: '喷涂', seq: 40, req: '外协喷涂,RAL7035', isOutsourced: true },
  ] as const) {
    await deps.manufacturingMaster.createTemplateItem(actor, {
      templateId: t1.id,
      operationId: opsByName[row.op]!,
      seq: row.seq,
      requirement: row.req,
      isOutsourced: row.isOutsourced,
    })
  }

  const t2 = await deps.manufacturingMaster.createTemplate(actor, { name: '铜排组件工艺' })
  for (const row of [
    { op: '下料', seq: 10, req: '铜排定尺下料' },
    { op: '冲压', seq: 20, req: '冲安装孔,去毛刺' },
    { op: '装配', seq: 30, req: '端子压接,扭力按规范' },
  ] as const) {
    await deps.manufacturingMaster.createTemplateItem(actor, {
      templateId: t2.id,
      operationId: opsByName[row.op]!,
      seq: row.seq,
      requirement: row.req,
    })
  }

  const bom1 = await deps.manufacturingMaster.createBom(actor, {
    materialId: md.materials.box_shell!.id,
    note: '示例 BOM',
  })
  for (const row of [
    { key: 'steel_sheet', qty: '2.5', loss: null as string | null, note: '箱体展开料' },
    { key: 'screw', qty: '12', loss: '0.02', note: '装配紧固' },
    { key: 'insul_sleeve', qty: '0.5', loss: null, note: null },
  ]) {
    await createBOMComponent(deps, actor, bom1.id, md, row.key, row.qty, row.loss, row.note)
  }
  await deps.manufacturingMaster.applyRouteTemplate(actor, bom1.id, t1.id)

  const bom2 = await deps.manufacturingMaster.createBom(actor, {
    materialId: md.materials.busbar!.id,
    note: '示例 BOM',
  })
  for (const row of [
    { key: 'copper_bar', qty: '1.2', loss: '0.03' as string | null },
    { key: 'terminal_block', qty: '8', loss: null },
    { key: 'insul_sleeve', qty: '0.3', loss: null },
  ]) {
    await createBOMComponent(deps, actor, bom2.id, md, row.key, row.qty, row.loss, null)
  }
  for (const row of [
    { op: '下料', seq: 10, req: '铜排定尺下料' },
    { op: '装配', seq: 20, req: '端子压接' },
  ] as const) {
    await deps.manufacturingMaster.createRoute(actor, {
      bomId: bom2.id,
      operationId: opsByName[row.op]!,
      seq: row.seq,
      requirement: row.req,
    })
  }
  const scrap = md.materials.scrap_copper!
  await deps.manufacturingMaster.createByproduct(actor, {
    bomId: bom2.id,
    quantity: '0.05',
    note: '下料边角料',
    materialId: scrap.id,
    unitId: scrap.defaultUnitId,
  })

  return {
    operations: opIDs,
    processTemplates: [t1.id, t2.id],
    boms: [bom1.id, bom2.id],
    opsByName,
  }
}

export async function createBOMComponent(
  deps: SampleDataDeps,
  actor: Actor,
  bomId: string,
  md: MasterData,
  key: string,
  qty: string,
  loss: string | null,
  note: string | null,
): Promise<void> {
  const mat = md.materials[key]
  if (!mat) throw new Error(`示例物料缺失: ${key}`)
  await deps.manufacturingMaster.createComponent(actor, {
    bomId,
    materialId: mat.id,
    unitId: mat.defaultUnitId,
    quantity: qty,
    lossRate: loss,
    note,
  })
}
