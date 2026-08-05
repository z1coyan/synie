import { sql } from 'kysely'
import type { Actor } from '~/platform/authz/actor.ts'
import { permitFor } from './permit.ts'
import {
  accountByCode,
  leafCategory,
  type Accounts,
  type CompanyInfo,
  type MasterData,
  type SeedCtx,
  unitBySymbol,
  warehouseBySuffix,
} from './helpers.ts'
import type { SampleDataDeps } from './types.ts'

interface MaterialSpec {
  key: string
  name: string
  spec: string
  category: string
  customer?: string
  customerPartNo?: string
}

export async function seedPrerequisites(
  deps: SampleDataDeps,
  actor: Actor,
  company: CompanyInfo,
): Promise<SeedCtx> {
  const unbilledAR = await ensureAccount(
    deps,
    actor,
    company.id,
    '1124',
    '未开票应收',
    'debit',
    'UNBILLED_RECEIVABLE',
    '1',
  )
  const unbilledAP = await ensureAccount(
    deps,
    actor,
    company.id,
    '2204',
    '未开票应付',
    'credit',
    'UNBILLED_PAYABLE',
    '2',
  )
  const accounts: Accounts = {
    unbilledAR,
    unbilledAP,
    revenue: await accountByCode(deps.db, company.id, '5001'),
    inventory: await accountByCode(deps.db, company.id, '1405'),
    bank: await accountByCode(deps.db, company.id, '1002'),
    capital: await accountByCode(deps.db, company.id, '3001'),
    expense: await accountByCode(deps.db, company.id, '560299'),
    receivable: await accountByCode(deps.db, company.id, '1122'),
    payable: await accountByCode(deps.db, company.id, '2202'),
    tax: await accountByCode(deps.db, company.id, '2221'),
  }
  await ensureCompanyAccountDefault(deps, actor, company.id, accounts)

  const root = await warehouseBySuffix(deps.db, company.id, '所有仓库')
  const defaultWh = await warehouseBySuffix(deps.db, company.id, '默认仓库')
  const transit = await warehouseBySuffix(deps.db, company.id, '在途')
  const finished = await ensureFinishedWarehouse(deps, actor, company, root)

  return {
    company,
    accounts,
    warehouses: { default: defaultWh, transit, finished, root },
  }
}

async function ensureAccount(
  deps: SampleDataDeps,
  actor: Actor,
  companyId: string,
  code: string,
  name: string,
  direction: string,
  role: string,
  rootCode: string,
): Promise<string> {
  const existing = await sql<{ id: string }>`
    SELECT id FROM bas_account WHERE company_id = ${companyId}::uuid AND code = ${code}
  `.execute(deps.db)
  if (existing.rows[0]) return existing.rows[0].id
  const rootId = await accountByCode(deps.db, companyId, rootCode)
  const created = await deps.accounts.create(permitFor(deps, actor, 'basAccounts', 'create'), {
    code,
    name,
    direction,
    role,
    parentId: rootId,
    companyId,
  })
  return created.id
}

async function ensureCompanyAccountDefault(
  deps: SampleDataDeps,
  actor: Actor,
  companyId: string,
  accs: Accounts,
): Promise<void> {
  const existing = await deps.companyAccountDefaults.getByCompany(
    permitFor(deps, actor, 'salCompanyAccountDefaults', 'read'),
    companyId,
  )
  if (existing.id) return
  await deps.companyAccountDefaults.create(
    permitFor(deps, actor, 'salCompanyAccountDefaults', 'update'),
    {
    companyId,
    deliveryDebitAccountId: accs.unbilledAR,
    deliveryCreditAccountId: accs.revenue,
    receiptDebitAccountId: accs.inventory,
    receiptCreditAccountId: accs.unbilledAP,
  },
  )
}

async function ensureFinishedWarehouse(
  deps: SampleDataDeps,
  actor: Actor,
  company: CompanyInfo,
  rootId: string,
): Promise<string> {
  const name = `${company.code} - 成品仓`
  const existing = await sql<{ id: string }>`
    SELECT id FROM inv_warehouse
    WHERE company_id = ${company.id}::uuid AND name = ${name}
  `.execute(deps.db)
  if (existing.rows[0]) return existing.rows[0].id
  const created = await deps.warehouses.create(
    permitFor(deps, actor, 'invWarehouses', 'create'),
    {
      name,
      isLeaf: true,
      companyId: company.id,
      parentId: rootId,
    },
  )
  return created.id
}

export async function seedMaster(
  deps: SampleDataDeps,
  actor: Actor,
  company: CompanyInfo,
): Promise<MasterData> {
  const customers: MasterData['customers'] = {}
  for (const row of [
    { code: 'C01', name: '宁波海纳电气有限公司', short: '海纳电气' },
    { code: 'C02', name: '温州联成机电有限公司', short: '联成机电' },
    { code: 'C03', name: '杭州远景新能源有限公司', short: '远景新能源' },
    { code: 'C04', name: '上海昊阳自动化设备有限公司', short: '昊阳自动化' },
    { code: 'C05', name: '苏州凯迪电子科技有限公司', short: '凯迪电子' },
    { code: 'C06', name: '广州南控电气有限公司', short: '南控电气' },
  ] as const) {
    const created = await deps.customers.create(permitFor(deps, actor, 'salCustomers', 'create'), {
      code: row.code,
      name: row.name,
      shortName: row.short,
    })
    customers[row.code] = created
  }

  const suppliers: MasterData['suppliers'] = {}
  for (const row of [
    { code: 'S01', name: '铜陵精铜材料有限公司', short: '精铜材料' },
    { code: 'S02', name: '义乌宏达标准件厂', short: '宏达标准件' },
    { code: 'S03', name: '上海申绝缘科技有限公司', short: '申绝缘' },
    { code: 'S04', name: '无锡恒力钣金有限公司', short: '恒力钣金' },
    { code: 'S05', name: '余姚创新塑业有限公司', short: '创新塑业' },
    { code: 'S06', name: '温州顺达包装有限公司', short: '顺达包装' },
  ] as const) {
    const created = await deps.suppliers.create(permitFor(deps, actor, 'purSuppliers', 'create'), {
      code: row.code,
      name: row.name,
      shortName: row.short,
    })
    suppliers[row.code] = created
  }

  const pcs = await unitBySymbol(deps.db, 'pcs')
  const materials: MasterData['materials'] = {}
  for (const spec of materialSpecs()) {
    const catId = await leafCategory(deps.db, spec.category)
    const created = await deps.materials.create(permitFor(deps, actor, 'invMaterials', 'create'), {
      name: spec.name,
      spec: spec.spec,
      categoryId: catId,
      defaultUnitId: pcs,
      isCustomerMaterial: Boolean(spec.customer),
      customerId: spec.customer ? customers[spec.customer]!.id : null,
      customerPartNo: spec.customerPartNo ?? null,
    })
    materials[spec.key] = { id: created.id, defaultUnitId: created.defaultUnitId }
  }

  const pack = await unitBySymbol(deps.db, '包')
  await deps.materialUnits.create(permitFor(deps, actor, 'invMaterialUnits', 'update'), {
    materialId: materials.carton!.id,
    unitId: pack,
    factor: '0.05',
  })

  const employees: MasterData['employees'] = {}
  for (const row of [
    { name: '张伟强', phone: '13857610001', wage: '260', allowance: '300' },
    { name: '李秀英', phone: '13857610002', wage: '220', allowance: '300' },
    { name: '王建军', phone: '13857610003', wage: '240', allowance: '500' },
    { name: '陈晓梅', phone: '13857610004', wage: '200', allowance: '200' },
  ] as const) {
    const created = await deps.employees.create(permitFor(deps, actor, 'hrEmployees', 'create'), {
      name: row.name,
      phone: row.phone,
      dailyWage: row.wage,
      monthlyAllowance: row.allowance,
    })
    employees[row.name] = { id: created.id, name: created.name }
  }

  return { company, customers, suppliers, materials, employees }
}

function materialSpecs(): MaterialSpec[] {
  return [
    {
      key: 'box_shell',
      name: '配电箱壳体',
      spec: 'HN-BX-100 定制',
      category: 'F(P)',
      customer: 'C01',
      customerPartNo: 'HN-BX-100',
    },
    {
      key: 'busbar',
      name: '汇流铜排组件',
      spec: 'HN-BB-08 8 路',
      category: 'F(P)',
      customer: 'C01',
      customerPartNo: 'HN-BB-08',
    },
    {
      key: 'mount_plate',
      name: '断路器安装板',
      spec: 'LC-MB-63',
      category: 'F(P)',
      customer: 'C02',
      customerPartNo: 'LC-MB-63',
    },
    {
      key: 'terminal_assy',
      name: '端子排组件',
      spec: 'YJ-TB-12',
      category: 'F(P)',
      customer: 'C03',
      customerPartNo: 'YJ-TB-12',
    },
    { key: 'terminal_block', name: '接线端子座', spec: 'UK-2.5B 灰', category: 'F(G)' },
    { key: 'copper_terminal', name: '铜接线端子', spec: 'OT-6', category: 'F(G)' },
    { key: 'rail', name: '导轨', spec: 'C45 35×7.5×1000', category: 'F(G)' },
    { key: 'copper_bar', name: '紫铜排', spec: 'T2 3×30×1000', category: 'F(S)' },
    { key: 'copper_rod', name: '紫铜棒', spec: 'T2 φ20', category: 'F(S)' },
    { key: 'steel_sheet', name: '冷轧钢板', spec: 'DC01 1.5×1250×2500', category: 'F(S)' },
    { key: 'stamped_part', name: '冲压安装支架', spec: 'ST-40', category: 'F(S)' },
    { key: 'abs_pellet', name: 'ABS 粒料', spec: 'PA-757 白', category: 'F(S)' },
    { key: 'scrap_copper', name: '废铜边角料', spec: '混合', category: 'F(S)' },
    { key: 'screw', name: '十字盘头螺丝', spec: 'M4×12 镀锌', category: 'M(C)' },
    { key: 'insul_sleeve', name: '绝缘护套', spec: 'φ6 黑 100m/卷', category: 'M(C)' },
    { key: 'stretch_film', name: '缠绕膜', spec: '50cm×300m', category: 'M(C)' },
    { key: 'carton', name: '五层纸箱', spec: '40×30×30', category: 'P(C)' },
  ]
}
