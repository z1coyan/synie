import type { ResourceMeta } from '~/platform/meta/types.ts'

function field(
  dbName: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name: dbName, apiName, dbColumn: dbName, type, label, ...opts }
}

function fk(
  dbName: string,
  apiName: string,
  label: string,
  resource: string,
  relation: string,
  labelField: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return field(dbName, apiName, 'fk', label, {
    filterable: true,
    ref: { resource, relation, labelField },
    ...opts,
  })
}

const demandStatusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'CONFIRMED', label: '已确认' },
  { value: 'CLOSED', label: '已关闭' },
  { value: 'VOIDED', label: '已作废' },
]

const fulfillmentOptions = [
  { value: 'MAKE', label: '自制' },
  { value: 'BUY', label: '外购' },
  { value: 'OUTSOURCE', label: '委外' },
  { value: 'STOCK', label: '库存' },
]

const demandItemStatusOptions = [
  { value: 'PENDING', label: '待安排' },
  { value: 'SCHEDULED', label: '已安排' },
  { value: 'COMPLETED', label: '已完成' },
]

const workOrderStatusOptions = [
  { value: 'IN_PROGRESS', label: '进行中' },
  { value: 'COMPLETED', label: '已完工' },
  { value: 'VOIDED', label: '已作废' },
]

const outputStatusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'VOIDED', label: '已作废' },
]

const bomStatusOptions = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'ACTIVE', label: '启用' },
  { value: 'INACTIVE', label: '停用' },
]

export const moldTypeOptions = [
  { value: 'STAMPING', label: '冲压' },
  { value: 'FORMING', label: '变形' },
  { value: 'POSITIONING', label: '定位' },
  { value: 'OTHER', label: '其他' },
]

const headCrud: ResourceMeta['actions'] = [
  { key: 'read', label: '查看', scope: 'both' },
  { key: 'create', label: '新增', scope: 'both' },
  { key: 'update', label: '编辑', scope: 'row' },
  { key: 'delete', label: '删除', scope: 'row', isDanger: true },
]

function headMeta(
  name: string,
  permission: string,
  label: string,
  table: string,
  codeLabel: string,
  nameLabel: string,
): ResourceMeta {
  return {
    name,
    permissionPrefix: permission,
    permissionLabel: label,
    // 工序/工艺模板均全局共享不分公司（无 company_id 列）
    authz: { kind: 'global' },
    table,
    numbering: true,
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', codeLabel, {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', nameLabel, { required: true, filterable: true, sortable: true }),
      field('note', 'note', 'string', '备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
    ],
    actions: headCrud,
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        code: { placeholder: '留空自动取号' },
        name: {},
      },
    },
    print: true,
    audit: { enabled: true },
  }
}

function routeFields(): ResourceMeta['fields'] {
  return [
    field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
    field('seq', 'seq', 'integer', '工序顺序', { required: true, filterable: true, sortable: true }),
    field('requirement', 'requirement', 'string', '工艺要求', { filterable: true, sortable: true }),
    field('is_outsourced', 'isOutsourced', 'boolean', '外协标记', {
      required: true,
      filterable: true,
      sortable: true,
    }),
    field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
    field('updated_at', 'updatedAt', 'datetime', '更新时间', {
      readonly: true,
      filterable: true,
      sortable: true,
    }),
  ]
}

export function operationResourceMeta(): ResourceMeta {
  const meta = headMeta(
    'mfgOperations',
    'mfg.operation',
    '工序',
    'mfg_operation',
    '工序编号',
    '工序名称',
  )
  meta.classification = { presentation: 'basic', interactive: true }
  return meta
}

export function processTemplateResourceMeta(): ResourceMeta {
  const meta = headMeta(
    'mfgProcessTemplates',
    'mfg.route_template',
    '工艺模板',
    'mfg_process_template',
    '模板编号',
    '模板名称',
  )
  meta.classification = { presentation: 'extension', interactive: true }
  meta.printHead = true
  meta.printLoops = [{ name: 'items', resource: 'mfgProcessTemplateItems' }]
  return meta
}

export function processTemplateItemResourceMeta(): ResourceMeta {
  return {
    name: 'mfgProcessTemplateItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'mfg.route_template',
    permissionLabel: '工艺模板',
    table: 'mfg_process_template_item',
    authz: { kind: 'via', parent: 'mfgProcessTemplates', fk: 'template_id' },
    fields: [
      ...routeFields(),
      fk('template_id', 'templateId', '工艺模板', 'mfgProcessTemplates', 'template', 'name', {
        required: true,
        createOnly: true,
      }),
      fk('operation_id', 'operationId', '工序', 'mfgOperations', 'operation', 'name', {
        required: true,
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        templateId: { required: true },
        operationId: { required: true },
        seq: { required: true },
      },
    },
    audit: { enabled: true },

  }
}

export function bomResourceMeta(): ResourceMeta {
  return {
    name: 'mfgBoms',
    classification: { presentation: 'extension', interactive: true },
    permissionPrefix: 'mfg.bom',
    numbering: true,
    permissionLabel: 'BOM',
    table: 'mfg_bom',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '编号', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('plan_name', 'planName', 'string', '方案名称', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        filterable: true,
        sortable: true,
        readonly: true,
        enumOptions: bomStatusOptions,
      }),
      field('note', 'note', 'string', '备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      fk('material_id', 'materialId', '物料', 'invMaterials', 'material', 'name', {
        required: true,
        createOnly: true,
      }),
    ],
    actions: [
      ...headCrud,
      { key: 'activate', label: '启用', scope: 'row', permissionAction: 'update' },
      { key: 'deactivate', label: '停用', scope: 'row', permissionAction: 'update' },
    ],
    form: {
      exclude: ['id', 'status', 'insertedAt', 'updatedAt'],
      fields: {
        code: { placeholder: '留空自动取号' },
        materialId: { required: true },
      },
    },
    print: true,
    printHead: true,
    printLoops: [
      { name: 'byproducts', resource: 'mfgBomByproducts' },
      { name: 'components', resource: 'mfgBomComponents' },
      { name: 'routes', resource: 'mfgBomRoutes' },
    ],
    audit: { enabled: true },

  }
}

export function bomComponentResourceMeta(): ResourceMeta {
  return {
    name: 'mfgBomComponents',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'mfg.bom',
    permissionLabel: 'BOM',
    table: 'mfg_bom_component',
    authz: { kind: 'via', parent: 'mfgBoms', fk: 'bom_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('quantity', 'quantity', 'decimal', '单位净用量(每 1 默认单位母物料)', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('loss_rate', 'lossRate', 'decimal', '损耗率(空即无损耗)', {
        filterable: true,
        sortable: true,
      }),
      field('note', 'note', 'string', '备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      fk('bom_id', 'bomId', 'BOM', 'mfgBoms', 'bom', 'code', { required: true, createOnly: true }),
      fk('material_id', 'materialId', '子物料', 'invMaterials', 'material', 'name', {
        required: true,
      }),
      fk('unit_id', 'unitId', '单位', 'basUnits', 'unit', 'name', { required: true }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        bomId: { required: true },
        materialId: { required: true },
        unitId: { required: true },
        quantity: { required: true },
      },
    },
    audit: { enabled: true },

  }
}

export function bomRouteResourceMeta(): ResourceMeta {
  return {
    name: 'mfgBomRoutes',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'mfg.bom',
    permissionLabel: 'BOM',
    table: 'mfg_bom_route',
    authz: { kind: 'via', parent: 'mfgBoms', fk: 'bom_id' },
    fields: [
      ...routeFields(),
      fk('bom_id', 'bomId', 'BOM', 'mfgBoms', 'bom', 'code', { required: true, createOnly: true }),
      fk('operation_id', 'operationId', '工序', 'mfgOperations', 'operation', 'name', {
        required: true,
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        bomId: { required: true },
        operationId: { required: true },
        seq: { required: true },
      },
    },
    audit: { enabled: true },

  }
}

export function bomByproductResourceMeta(): ResourceMeta {
  return {
    name: 'mfgBomByproducts',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'mfg.bom',
    permissionLabel: 'BOM',
    table: 'mfg_bom_byproduct',
    authz: { kind: 'via', parent: 'mfgBoms', fk: 'bom_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('quantity', 'quantity', 'decimal', '单位产出量(每 1 默认单位母物料)', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('note', 'note', 'string', '备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      fk('bom_id', 'bomId', 'BOM', 'mfgBoms', 'bom', 'code', { required: true, createOnly: true }),
      fk('material_id', 'materialId', '副产品物料', 'invMaterials', 'material', 'name', {
        required: true,
      }),
      fk('unit_id', 'unitId', '单位', 'basUnits', 'unit', 'name', { required: true }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        bomId: { required: true },
        materialId: { required: true },
        unitId: { required: true },
        quantity: { required: true },
      },
    },
    audit: { enabled: true },

  }
}

export function demandResourceMeta(): ResourceMeta {
  return {
    name: 'mfgDemands',
    classification: { presentation: 'extension', interactive: true },
    numbering: true,
    permissionPrefix: 'mfg.demand',
    permissionLabel: '履约需求单',
    table: 'mfg_demand',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('demand_no', 'demandNo', 'string', '需求单号', { filterable: true, sortable: true }),
      field('demand_date', 'demandDate', 'date', '业务日期', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '备注', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        filterable: true,
        sortable: true,
        enumOptions: demandStatusOptions,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      fk('company_id', 'companyId', '公司', 'basCompanies', 'company', 'name'),
      fk('created_by_id', 'createdById', '录入人', 'sysUsers', 'createdBy', 'name'),
    ],
    actions: [
      ...headCrud,
      {
        key: 'audit',
        label: '审核',
        scope: 'row',
        permissionAction: 'confirm',
        confirmKind: 'audit_doc',
      },
      { key: 'close', label: '关闭', scope: 'row' },
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
    ],
    printHead: true,
    printLoops: [{ name: 'items', resource: 'mfgDemandItems' }],
    audit: { enabled: true },

  }
}

export function demandItemResourceMeta(): ResourceMeta {
  return {
    name: 'mfgDemandItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'mfg.demand',
    permissionLabel: '履约需求单',
    table: 'mfg_demand_item',
    authz: { kind: 'via', parent: 'mfgDemands', fk: 'demand_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('idx', 'idx', 'integer', '行号', { filterable: true, sortable: true }),
      field('qty', 'qty', 'decimal', '数量', { filterable: true, sortable: true }),
      field('base_qty', 'baseQty', 'decimal', '折算默认单位数量', {
        filterable: true,
        sortable: true,
      }),
      field('ordered_qty', 'orderedQty', 'decimal', '已下单数量(采购分量,系统维护)', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('received_qty', 'receivedQty', 'decimal', '已收数量(采购分量,系统维护)', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('arranged_qty', 'arrangedQty', 'decimal', '已安排数量(物料默认单位,系统维护)', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('completed_qty', 'completedQty', 'decimal', '已完成数量(物料默认单位,系统维护)', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('need_date', 'needDate', 'date', '需求日', { filterable: true, sortable: true }),
      field('fulfillment_method', 'fulfillmentMethod', 'enum', '履约方式(已废弃)', {
        filterable: true,
        sortable: true,
        readonly: true,
        enumOptions: fulfillmentOptions,
      }),
      field('status', 'status', 'enum', '行状态', {
        filterable: true,
        sortable: true,
        enumOptions: demandItemStatusOptions,
      }),
      field('material_code', 'materialCode', 'string', '物料编号快照', {
        filterable: true,
        sortable: true,
      }),
      field('material_name', 'materialName', 'string', '物料名称快照', {
        filterable: true,
        sortable: true,
      }),
      field('material_spec', 'materialSpec', 'string', '物料规格快照', {
        filterable: true,
        sortable: true,
      }),
      field('unit_name', 'unitName', 'string', '单位名称快照', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      fk('demand_id', 'demandId', '履约需求单', 'mfgDemands', 'demand', 'demandNo'),
      fk('company_id', 'companyId', '公司', 'basCompanies', 'company', 'name'),
      fk('material_id', 'materialId', '物料', 'invMaterials', 'material', 'name'),
      fk('unit_id', 'unitId', '单位', 'basUnits', 'unit', 'name'),
      fk(
        'sales_order_item_id',
        'salesOrderItemId',
        '来源销售订单条目(可空)',
        'salOrderItems',
        'salesOrderItem',
        'materialCode',
      ),
      field('ordered', 'ordered', 'boolean', '已安排(有占量且未完成)', {
        calculated: true,
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('remaining_orderable_qty', 'remainingOrderableQty', 'decimal', '剩余可安排数量(物料默认单位)', {
        calculated: true,
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field(
        'remaining_arrangeable_qty',
        'remainingArrangeableQty',
        'decimal',
        '剩余可安排数量(物料默认单位)',
        {
          calculated: true,
          readonly: true,
          filterable: true,
          sortable: true,
        },
      ),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    printLoops: [{ name: 'work_orders', resource: 'mfgWorkOrders' }],
    audit: { enabled: true },

  }
}

export function workOrderResourceMeta(): ResourceMeta {
  return {
    name: 'mfgWorkOrders',
    classification: { presentation: 'extension', interactive: true },
    /** 工单图纸只读展示宿主：附件固化 company_id */
    attachments: {},
    numbering: true,
    permissionPrefix: 'mfg.work_order',
    permissionLabel: '生产工单',
    table: 'mfg_work_order',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('work_order_no', 'workOrderNo', 'string', '工单号', {
        filterable: true,
        sortable: true,
      }),
      field('qty', 'qty', 'decimal', '工单数量(与需求行同单位)', {
        filterable: true,
        sortable: true,
      }),
      field('base_qty', 'baseQty', 'decimal', '工单数量(默认单位)', {
        filterable: true,
        sortable: true,
      }),
      field('received_base_qty', 'receivedBaseQty', 'decimal', '累计已入(默认单位)', {
        filterable: true,
        sortable: true,
      }),
      field('need_date', 'needDate', 'date', '需求日/交期', { filterable: true, sortable: true }),
      field('material_code', 'materialCode', 'string', '物料编号快照', {
        filterable: true,
        sortable: true,
      }),
      field('material_name', 'materialName', 'string', '物料名称快照', {
        filterable: true,
        sortable: true,
      }),
      field('material_spec', 'materialSpec', 'string', '物料规格快照', {
        filterable: true,
        sortable: true,
      }),
      field('unit_name', 'unitName', 'string', '单位名称快照', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        filterable: true,
        sortable: true,
        enumOptions: workOrderStatusOptions,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      fk('company_id', 'companyId', '公司', 'basCompanies', 'company', 'name'),
      fk('demand_id', 'demandId', '来源需求单', 'mfgDemands', 'demand', 'demandNo'),
      fk('demand_item_id', 'demandItemId', '来源需求行', 'mfgDemandItems', 'demandItem', 'materialCode'),
      fk('material_id', 'materialId', '物料', 'invMaterials', 'material', 'name'),
      fk('unit_id', 'unitId', '单位', 'basUnits', 'unit', 'name'),
      fk('bom_id', 'bomId', 'BOM(来源留痕)', 'mfgBoms', 'bom', 'code'),
      fk('created_by_id', 'createdById', '生成人', 'sysUsers', 'createdBy', 'name'),
      field('remaining_base_qty', 'remainingBaseQty', 'decimal', '未完成数量(默认单位)', {
        calculated: true,
        filterable: true,
        sortable: true,
      }),
    ],
    actions: [
      ...headCrud,
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
      { key: 'print', label: '打印', scope: 'row' },
      { key: 'export', label: '导出', scope: 'both' },
      { key: 'batch_print', label: '批量打印', scope: 'bulk' },
    ],
    print: true,
    printHead: true,
    // 工单快照子表仅服务打印字段目录（无独立 CRUD 页）
    printLoops: [
      { name: 'components', resource: 'mfgWorkOrderComponents' },
      { name: 'routes', resource: 'mfgWorkOrderRoutes' },
      { name: 'byproducts', resource: 'mfgWorkOrderByproducts' },
    ],
    // exclude 保留历史审计面：BOM 引用不进审计 diff
    audit: { enabled: true, exclude: ['bom_id'] },

  }
}

/** 工单配料快照：打印循环区字段目录（只读投影） */
export function workOrderComponentResourceMeta(): ResourceMeta {
  return {
    name: 'mfgWorkOrderComponents',
    classification: { presentation: 'none', interactive: false, note: '工单 BOM 配料快照；打印循环区' },
    permissionPrefix: 'mfg.work_order',
    permissionLabel: '生产工单',
    table: 'mfg_work_order_component',
    authz: { kind: 'via', parent: 'mfgWorkOrders', fk: 'work_order_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true }),
      field('quantity', 'quantity', 'decimal', '净用量', { filterable: true }),
      field('loss_rate', 'lossRate', 'decimal', '损耗率'),
      field('note', 'note', 'string', '备注'),
      field('idx', 'idx', 'integer', '行序', { filterable: true, sortable: true }),
      fk('work_order_id', 'workOrderId', '生产工单', 'mfgWorkOrders', 'workOrder', 'workOrderNo', {
        required: true,
        createOnly: true,
      }),
      fk('material_id', 'materialId', '物料', 'invMaterials', 'material', 'name', { required: true }),
      fk('unit_id', 'unitId', '单位', 'basUnits', 'unit', 'name', { required: true }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  }
}

/** 工单工艺路线快照：打印循环区 */
export function workOrderRouteResourceMeta(): ResourceMeta {
  return {
    name: 'mfgWorkOrderRoutes',
    classification: { presentation: 'none', interactive: false, note: '工单工艺路线快照；打印循环区' },
    permissionPrefix: 'mfg.work_order',
    permissionLabel: '生产工单',
    table: 'mfg_work_order_route',
    authz: { kind: 'via', parent: 'mfgWorkOrders', fk: 'work_order_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true }),
      field('seq', 'seq', 'integer', '工序顺序', { required: true, filterable: true, sortable: true }),
      field('requirement', 'requirement', 'string', '工艺要求'),
      field('is_outsourced', 'isOutsourced', 'boolean', '外协标记', { required: true }),
      fk('work_order_id', 'workOrderId', '生产工单', 'mfgWorkOrders', 'workOrder', 'workOrderNo', {
        required: true,
        createOnly: true,
      }),
      fk('operation_id', 'operationId', '工序', 'mfgOperations', 'operation', 'name', { required: true }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  }
}

/** 工单副产品快照：打印循环区 */
export function workOrderByproductResourceMeta(): ResourceMeta {
  return {
    name: 'mfgWorkOrderByproducts',
    classification: { presentation: 'none', interactive: false, note: '工单副产品快照；打印循环区' },
    permissionPrefix: 'mfg.work_order',
    permissionLabel: '生产工单',
    table: 'mfg_work_order_byproduct',
    authz: { kind: 'via', parent: 'mfgWorkOrders', fk: 'work_order_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true }),
      field('quantity', 'quantity', 'decimal', '产出量', { filterable: true }),
      field('note', 'note', 'string', '备注'),
      field('idx', 'idx', 'integer', '行序', { filterable: true, sortable: true }),
      fk('work_order_id', 'workOrderId', '生产工单', 'mfgWorkOrders', 'workOrder', 'workOrderNo', {
        required: true,
        createOnly: true,
      }),
      fk('material_id', 'materialId', '物料', 'invMaterials', 'material', 'name', { required: true }),
      fk('unit_id', 'unitId', '单位', 'basUnits', 'unit', 'name', { required: true }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
  }
}

export function outputResourceMeta(): ResourceMeta {
  return {
    name: 'mfgOutputs',
    classification: { presentation: 'extension', interactive: true },
    numbering: true,
    permissionPrefix: 'mfg.output',
    permissionLabel: '生产入库单',
    table: 'mfg_output',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('output_no', 'outputNo', 'string', '入库单号', { filterable: true, sortable: true }),
      field('output_date', 'outputDate', 'date', '入库日期(库存分录业务日)', {
        filterable: true,
        sortable: true,
      }),
      field('remarks', 'remarks', 'string', '备注', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        filterable: true,
        sortable: true,
        enumOptions: outputStatusOptions,
      }),
      field('audited_at', 'auditedAt', 'datetime', '审核时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      fk('company_id', 'companyId', '公司', 'basCompanies', 'company', 'name'),
      fk('warehouse_id', 'warehouseId', '默认仓库(可空,仅新建行预填)', 'invWarehouses', 'warehouse', 'name'),
      fk('created_by_id', 'createdById', '录入人', 'sysUsers', 'createdBy', 'name'),
      fk('audited_by_id', 'auditedById', '审核人', 'sysUsers', 'auditedBy', 'name'),
    ],
    actions: [
      ...headCrud,
      { key: 'audit', label: '审核', scope: 'row' },
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
    ],
    printHead: true,
    printLoops: [{ name: 'items', resource: 'mfgOutputItems' }],
    audit: { enabled: true },

  }
}

export function outputItemResourceMeta(): ResourceMeta {
  return {
    name: 'mfgOutputItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'mfg.output',
    permissionLabel: '生产入库单',
    table: 'mfg_output_item',
    authz: { kind: 'via', parent: 'mfgOutputs', fk: 'output_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('idx', 'idx', 'integer', '行号', { filterable: true, sortable: true }),
      field('qty', 'qty', 'decimal', '数量', { filterable: true, sortable: true }),
      field('base_qty', 'baseQty', 'decimal', '折算默认单位数量', {
        filterable: true,
        sortable: true,
      }),
      field('material_code', 'materialCode', 'string', '物料编号快照', {
        filterable: true,
        sortable: true,
      }),
      field('material_name', 'materialName', 'string', '物料名称快照', {
        filterable: true,
        sortable: true,
      }),
      field('material_spec', 'materialSpec', 'string', '物料规格快照', {
        filterable: true,
        sortable: true,
      }),
      field('unit_name', 'unitName', 'string', '单位名称快照', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      fk('output_id', 'outputId', '生产入库单', 'mfgOutputs', 'output', 'outputNo'),
      fk('company_id', 'companyId', '公司', 'basCompanies', 'company', 'name'),
      fk('work_order_id', 'workOrderId', '生产工单', 'mfgWorkOrders', 'workOrder', 'workOrderNo'),
      fk('material_id', 'materialId', '物料', 'invMaterials', 'material', 'name'),
      fk('unit_id', 'unitId', '单位', 'basUnits', 'unit', 'name'),
      fk('warehouse_id', 'warehouseId', '入库仓库', 'invWarehouses', 'warehouse', 'name'),
      // 母单投影：list 子查询 join mfg_output 暴露同名列，供条目 tab 筛/排/展示（同履约条目先例）
      field('output_no', 'outputNo', 'string', '入库单号', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
      field('output_date', 'outputDate', 'date', '入库日期', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
      field('output_status', 'outputStatus', 'enum', '入库状态', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
        enumOptions: outputStatusOptions,
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },

  }
}

export function moldDesignResourceMeta(): ResourceMeta {
  return {
    name: 'mfgMoldDesigns',
    // 附件（图纸）挂物料宿主 inv_material 而非模具自身；编号走 base.material 规则——均不在此声明
    classification: {
      presentation: 'extension',
      interactive: true,
      note: '建模具同事务自动建资产物料;自定义抽屉(名称/规格/类型/单位+图纸附件)',
    },
    permissionPrefix: 'mfg.mold_design',
    permissionLabel: '模具设计',
    table: 'mfg_mold_design',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      // material_code/name/spec/unit_name 为 join 物料的计算列（source 子查询暴露同名别名）
      field('material_code', 'materialCode', 'string', '模具编号', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
      field('material_name', 'materialName', 'string', '模具名称', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
      field('material_spec', 'materialSpec', 'string', '模具规格', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
      field('mold_type', 'moldType', 'enum', '模具类型', {
        required: true,
        filterable: true,
        sortable: true,
        enumOptions: moldTypeOptions,
      }),
      field('unit_name', 'unitName', 'string', '单位', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
      field('material_id', 'materialId', 'fk', '物料', {
        readonly: true,
        filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
    ],
    actions: headCrud,
    print: true,
    audit: { enabled: true },
  }
}

export function allManufacturingResourceMetas(): ResourceMeta[] {
  return [
    operationResourceMeta(),
    processTemplateResourceMeta(),
    processTemplateItemResourceMeta(),
    bomResourceMeta(),
    bomComponentResourceMeta(),
    bomRouteResourceMeta(),
    bomByproductResourceMeta(),
    demandResourceMeta(),
    demandItemResourceMeta(),
    workOrderResourceMeta(),
    workOrderComponentResourceMeta(),
    workOrderRouteResourceMeta(),
    workOrderByproductResourceMeta(),
    outputResourceMeta(),
    outputItemResourceMeta(),
    moldDesignResourceMeta(),
  ]
}
