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
    table,
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
  return headMeta(
    'mfgOperations',
    'mfg.operation',
    '工序',
    'mfg_operation',
    '工序编号',
    '工序名称',
  )
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
  meta.printHead = true
  meta.printLoops = [{ name: 'items', resource: 'mfgProcessTemplateItems' }]
  return meta
}

export function processTemplateItemResourceMeta(): ResourceMeta {
  return {
    name: 'mfgProcessTemplateItems',
    permissionPrefix: 'mfg.route_template',
    permissionLabel: '工艺模板',
    table: 'mfg_process_template_item',
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
    permissionPrefix: 'mfg.bom',
    permissionLabel: 'BOM',
    table: 'mfg_bom',
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
    permissionPrefix: 'mfg.bom',
    permissionLabel: 'BOM',
    table: 'mfg_bom_component',
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
    permissionPrefix: 'mfg.bom',
    permissionLabel: 'BOM',
    table: 'mfg_bom_route',
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
    permissionPrefix: 'mfg.bom',
    permissionLabel: 'BOM',
    table: 'mfg_bom_byproduct',
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
    permissionPrefix: 'mfg.demand',
    permissionLabel: '履约需求单',
    table: 'mfg_demand',
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
    permissionPrefix: 'mfg.demand',
    permissionLabel: '履约需求单',
    table: 'mfg_demand_item',
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
    permissionPrefix: 'mfg.work_order',
    permissionLabel: '生产工单',
    table: 'mfg_work_order',
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
    audit: { enabled: true },

  }
}

/** 工单配料快照：打印循环区字段目录（只读投影） */
export function workOrderComponentResourceMeta(): ResourceMeta {
  return {
    name: 'mfgWorkOrderComponents',
    permissionPrefix: 'mfg.work_order',
    permissionLabel: '生产工单',
    table: 'mfg_work_order_component',
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
    permissionPrefix: 'mfg.work_order',
    permissionLabel: '生产工单',
    table: 'mfg_work_order_route',
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
    permissionPrefix: 'mfg.work_order',
    permissionLabel: '生产工单',
    table: 'mfg_work_order_byproduct',
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
    permissionPrefix: 'mfg.output',
    permissionLabel: '生产入库单',
    table: 'mfg_output',
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
    permissionPrefix: 'mfg.output',
    permissionLabel: '生产入库单',
    table: 'mfg_output_item',
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
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
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
  ]
}
