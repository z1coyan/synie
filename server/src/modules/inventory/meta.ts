/**
 * 库存域 ResourceMeta（对齐 server-go inventory 各域 meta.go）。
 */
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

const crud = [
  { key: 'read', label: '查看', scope: 'both' as const },
  { key: 'create', label: '新增', scope: 'both' as const },
  { key: 'update', label: '编辑', scope: 'row' as const },
  { key: 'delete', label: '删除', scope: 'row' as const, isDanger: true },
]

/** 标准派生资源的动作词表：CRUD + 批量（批量端点由 platform/standard 派生） */
const standardCrud = [
  ...crud,
  { key: 'batch_update', label: '批量编辑', scope: 'bulk' as const },
  { key: 'batch_delete', label: '批量删除', scope: 'bulk' as const, isDanger: true },
]

const directionOptions = [
  { value: 'IN', label: '入库' },
  { value: 'OUT', label: '出库' },
]

const stockDocStatus = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'VOIDED', label: '已作废' },
]

const transferStatus = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'SHIPPED', label: '已发货' },
  { value: 'RECEIVED', label: '已收货' },
]

const countStatus = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'CANCELLED', label: '已作废' },
]

const partyTypeOptions = [
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'CUSTOMER', label: '客户' },
  { value: 'COMPANY', label: '内部公司' },
  { value: 'EMPLOYEE', label: '员工' },
]

export const materialTypeOptions = [
  { value: 'STOCK', label: '库存' },
  { value: 'VIRTUAL', label: '虚拟' },
  { value: 'ASSET', label: '资产' },
]

export function materialCategoryResourceMeta(): ResourceMeta {
  return {
    name: 'invMaterialCategories',
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'base.material_category',
    permissionLabel: '物料分类',
    table: 'inv_material_category',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '分类编号', {
        required: true,
        maxLength: 32,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '分类名称', {
        required: true,
        maxLength: 128,
        filterable: true,
        sortable: true,
      }),
      field('is_leaf', 'isLeaf', 'boolean', '叶子分类', { filterable: true, sortable: true }),
      field('active', 'active', 'boolean', '启用', { filterable: true, sortable: true }),
      field('has_children', 'hasChildren', 'boolean', '含下级分类', {
        calculated: true,
        printOnly: true,
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
      field('parent_id', 'parentId', 'fk', '上级分类', {
        nullable: true,
        filterable: true,
        ref: {
          resource: 'invMaterialCategories',
          relation: 'parent',
          labelField: 'name',
        },
      }),
    ],
    actions: standardCrud,
    form: {
      kind: 'basic',
      exclude: ['id', 'active', 'insertedAt', 'updatedAt', 'hasChildren'],
      fields: {
        code: { placeholder: '如 01、0101', span: 6 },
        name: { placeholder: '如 原材料', span: 6 },
        isLeaf: { initial: true, span: 6 },
        // 候选限定非叶子（叶子不能挂子分类；后端另有校验）
        parentId: {
          filterState: { isLeaf: { kind: 'bool', eq: false } },
        },
      },
    },
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'code'],
      subtitleFields: ['code'],
    },
    print: true,
    printLoops: [{ name: 'children', resource: 'invMaterialCategories' }],
    audit: { enabled: true },

  }
}

export function materialResourceMeta(): ResourceMeta {
  return {
    name: 'invMaterials',
    classification: { presentation: 'extension', interactive: true, note: '单位转换 tab + 客户料 effects + 图纸附件' },
    /** 图纸等附件宿主：物料全局共享，不固化公司 */
    attachments: {},
    numbering: true,
    permissionPrefix: 'base.material',
    permissionLabel: '物料',
    table: 'inv_material',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      // createOnly 而非 readonly：自动编号由内核在 create 写入（显式传入则跳过取号），编辑态不可改
      field('code', 'code', 'string', '物料编号', {
        createOnly: true,
        maxLength: 64,
        filterable: true,
        sortable: true,
      }),
      // 列内存大写（00013 迁移的 CHECK 白名单），wire 同为大写 token
      field('material_type', 'materialType', 'enum', '物料类型', {
        filterable: true,
        sortable: true,
        enumOptions: materialTypeOptions,
        enumStorage: 'upper',
      }),
      field('name', 'name', 'string', '物料名称', {
        required: true,
        maxLength: 128,
        filterable: true,
        sortable: true,
      }),
      field('spec', 'spec', 'string', '物料规格', {
        nullable: true,
        maxLength: 128,
        filterable: true,
        sortable: true,
      }),
      field('customer_part_no', 'customerPartNo', 'string', '客户方产品编号(仅客户物料可填)', {
        nullable: true,
        maxLength: 64,
        filterable: true,
        sortable: true,
      }),
      field('is_customer_material', 'isCustomerMaterial', 'boolean', '是否客户物料', {
        filterable: true,
        sortable: true,
      }),
      field('active', 'active', 'boolean', '启用', { filterable: true, sortable: true }),
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
      field('category_id', 'categoryId', 'fk', '物料分类', {
        required: true,
        filterable: true,
        ref: { resource: 'invMaterialCategories', relation: 'category', labelField: 'name' },
      }),
      field('default_unit_id', 'defaultUnitId', 'fk', '默认单位', {
        required: true,
        filterable: true,
        ref: { resource: 'basUnits', relation: 'defaultUnit', labelField: 'name' },
      }),
      field('customer_id', 'customerId', 'fk', '所属客户(仅客户物料)', {
        nullable: true,
        filterable: true,
        ref: { resource: 'salCustomers', relation: 'customer', labelField: 'name' },
      }),
    ],
    actions: standardCrud,
    // 单位转换 tab + 客户料 effects + 图纸附件 → Presentation Extension
    form: {
      kind: 'extension',
      exclude: ['active'],
      fields: {
        code: { edit: 'readOnly', placeholder: '保存后自动编号(分类号[客户号]-序号)' },
        materialType: { required: true, defaultValue: 'STOCK' },
        name: { required: true },
        categoryId: {
          required: true,
          filterState: {
            isLeaf: { kind: 'bool', eq: true },
            active: { kind: 'bool', eq: true },
          },
        },
        defaultUnitId: { required: true },
        isCustomerMaterial: { defaultValue: false },
      },
    },
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'code', 'spec'],
      subtitleFields: ['code', 'spec'],
    },
    print: true,
    printHead: true,
    printLoops: [{ name: 'units', resource: 'invMaterialUnits' }],
    audit: { enabled: true },

  }
}

export function materialUnitResourceMeta(): ResourceMeta {
  return {
    name: 'invMaterialUnits',
    classification: { presentation: 'none', interactive: false, note: '嵌于物料 PE 子表，无独立抽屉' },
    permissionPrefix: 'base.material',
    permissionLabel: '物料',
    table: 'inv_material_unit',
    authz: { kind: 'via', parent: 'invMaterials', fk: 'material_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('factor', 'factor', 'decimal', '换算系数(1 默认单位 = x 该单位)', {
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
      // 母物料创建后不可改（转换行随物料走，与既有 update wire 一致）
      field('material_id', 'materialId', 'fk', '物料', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      field('unit_id', 'unitId', 'fk', '单位', {
        required: true,
        filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        materialId: { required: true },
        unitId: { required: true },
        factor: { required: true, placeholder: '1 默认单位 = x 该单位' },
      },
    },
    print: true,
    audit: { enabled: true },

  }
}

export function warehouseResourceMeta(): ResourceMeta {
  return {
    name: 'invWarehouses',
    classification: { presentation: 'extension', interactive: true, note: '协作方多态外键，Basic Form fail-closed' },
    permissionPrefix: 'base.warehouse',
    permissionLabel: '仓库',
    table: 'inv_warehouse',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('name', 'name', 'string', '仓库名称', { required: true, filterable: true, sortable: true }),
      field('is_leaf', 'isLeaf', 'boolean', '叶子仓库', { filterable: true, sortable: true }),
      field('active', 'active', 'boolean', '启用', { filterable: true, sortable: true }),
      field(
        'is_outsourced',
        'isOutsourced',
        'boolean',
        '外协仓(货物存放在协作方处的我方仓,为是必挂协作方)',
        { filterable: true, sortable: true },
      ),
      field(
        'party_type',
        'partyType',
        'enum',
        '协作方类型(供应商/内部公司;外协仓必填,非外协仓必须为空)',
        { enumOptions: partyTypeOptions, filterable: true, sortable: true },
      ),
      field('party_id', 'partyId', 'fk', '协作方(多态引用,随 party_type 判别;一仓绑一方)', {
        filterable: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator: 'partyType',
          discriminatorType: 'enum',
          variants: [
            { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
            { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
          ],
        },
      }),
      field(
        'allow_negative',
        'allowNegative',
        'boolean',
        '允许负库存(库存分录审核/作废的负库存校验逐仓跳过)',
        { filterable: true, sortable: true },
      ),
      field('has_children', 'hasChildren', 'boolean', '含下级仓库', {
        calculated: true,
        printOnly: true,
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
      field('company_id', 'companyId', 'fk', '公司', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('parent_id', 'parentId', 'fk', '上级仓库', {
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'parent', labelField: 'name' },
      }),
      field('account_id', 'accountId', 'fk', '关联科目', {
        filterable: true,
        ref: { resource: 'basAccounts', relation: 'account', labelField: 'name' },
      }),
    ],
    actions: crud,
    form: {
      exclude: ['id', 'active', 'insertedAt', 'updatedAt'],
      fields: {
        name: { required: true },
        isLeaf: { defaultValue: true },
        isOutsourced: { defaultValue: false },
        allowNegative: { defaultValue: false },
        companyId: { required: true, edit: 'createOnly' },
      },
    },
    print: true,
    printLoops: [{ name: 'children', resource: 'invWarehouses' }],
    audit: { enabled: true },

  }
}

export function stockEntryResourceMeta(): ResourceMeta {
  return {
    name: 'invStockEntries',
    classification: { presentation: 'none', interactive: false, note: '只读库存分录' },
    permissionPrefix: 'inv.stock_entry',
    permissionLabel: '库存分录',
    table: 'inv_stock_entry',
    // 来源单据是多态的（voucher_type/voucher_id），静态 via 只能声明单 parent；
    // 分录自带 company_id，故按公司域声明。余额聚合端点共用本前缀的 read 码与公司边界。
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('seq', 'seq', 'integer', '序号', { readonly: true, filterable: true, sortable: true }),
      field(
        'quantity',
        'quantity',
        'decimal',
        '数量',
        { readonly: true, filterable: true, sortable: true },
      ),
      field('posting_date', 'postingDate', 'date', '业务日期', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('voucher_type', 'voucherType', 'string', '来源单据类型', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('voucher_id', 'voucherId', 'fk', '来源单据', {
        readonly: true,
        filterable: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator: 'voucherType',
          discriminatorType: 'string',
          variants: [
            { value: 'inv.stock_count', resource: 'invStockCounts', labelField: 'docNo', label: '库存盘点单' },
            { value: 'inv.stock_doc', resource: 'invStockDocs', labelField: 'docNo', label: '手工出入库单' },
            {
              value: 'inv.stock_transfer',
              resource: 'invStockTransfers',
              labelField: 'docNo',
              label: '手工调拨单',
            },
            { value: 'mfg.output', resource: 'mfgOutputs', labelField: 'outputNo', label: '生产入库单' },
            {
              value: 'purchase.outsourced_issue',
              resource: 'purOutsourcedIssues',
              labelField: 'issueNo',
              label: '委外发料单',
            },
            {
              value: 'purchase.outsourced_receipt',
              resource: 'purOutsourcedReceipts',
              labelField: 'receiptNo',
              label: '委外入库单',
            },
            { value: 'purchase.receipt', resource: 'purReceipts', labelField: 'receiptNo', label: '采购入库单' },
            {
              value: 'sales.delivery',
              resource: 'salDeliveries',
              labelField: 'deliveryNo',
              label: '销售发货单',
            },
          ],
        },
      }),
      field('voucher_no', 'voucherNo', 'string', '来源单据编号', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('is_cancelled', 'isCancelled', 'boolean', '已作废', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field(
        'cancelled_at',
        'cancelledAt',
        'datetime',
        '作废时间(盘点单审核的兜底校验据此判定「快照后该仓分录有作废」)',
        { readonly: true, filterable: true, sortable: true },
      ),
      field('remarks', 'remarks', 'string', '摘要', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('warehouse_id', 'warehouseId', 'fk', '仓库', {
        readonly: true,
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'warehouse', labelField: 'name' },
      }),
      field('material_id', 'materialId', 'fk', '物料', {
        readonly: true,
        filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      // 物料主数据投影(列表 SQL join inv_material,分录无快照概念):供物料富单元格与四字段搜索
      field('material_code', 'materialCode', 'string', '物料编号(物料主数据)', {
        readonly: true,
        calculated: true,
        filterable: true,
        sortable: true,
      }),
      field('material_name', 'materialName', 'string', '物料名称(物料主数据)', {
        readonly: true,
        calculated: true,
        filterable: true,
      }),
      field('material_spec', 'materialSpec', 'string', '规格(物料主数据)', {
        readonly: true,
        calculated: true,
        filterable: true,
      }),
      field('customer_part_no', 'customerPartNo', 'string', '客户方产品编号(物料主数据)', {
        readonly: true,
        calculated: true,
        filterable: true,
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: false },
  }
}

export function stockDocResourceMeta(): ResourceMeta {
  return {
    name: 'invStockDocs',
    classification: { presentation: 'extension', interactive: true },
    numbering: true,
    permissionPrefix: 'inv.stock_doc',
    permissionLabel: '手工出入库单',
    table: 'inv_stock_doc',
    // 手工库存单据不按人/部门收窄：不声明 owner/dept，supportedScopes 只出 all
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_no', 'docNo', 'string', '单据编号', { required: true, filterable: true, sortable: true }),
      field('direction', 'direction', 'enum', '出入库方向', {
        required: true,
        createOnly: true,
        enumOptions: directionOptions,
        filterable: true,
        sortable: true,
      }),
      field('doc_date', 'docDate', 'date', '业务日期', { required: true, filterable: true, sortable: true }),
      field('summary', 'summary', 'string', '摘要(带入库存分录)', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '备注(对内)', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        readonly: true,
        enumOptions: stockDocStatus,
        filterable: true,
        sortable: true,
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
      field('company_id', 'companyId', 'fk', '公司', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('warehouse_id', 'warehouseId', 'fk', '仓库(限本公司叶子仓)', {
        required: true,
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'warehouse', labelField: 'name' },
      }),
      field('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      field('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'auditedBy', labelField: 'name' },
      }),
    ],
    actions: [
      ...crud,
      { key: 'audit', label: '审核', scope: 'row' },
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
    ],
    form: {
      exclude: ['id', 'status', 'auditedAt', 'insertedAt', 'updatedAt', 'createdById', 'auditedById'],
      fields: {
        docNo: { placeholder: '留空自动编号' },
        direction: { required: true, edit: 'createOnly' },
        docDate: { required: true },
        companyId: { required: true, edit: 'createOnly' },
        warehouseId: { required: true },
      },
    },
    print: true,
    printHead: true,
    printLoops: [{ name: 'items', resource: 'invStockDocItems' }],
    audit: { enabled: true },

  }
}

export function stockDocItemResourceMeta(): ResourceMeta {
  return {
    name: 'invStockDocItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'inv.stock_doc',
    permissionLabel: '手工出入库单',
    table: 'inv_stock_doc_item',
    authz: { kind: 'via', parent: 'invStockDocs', fk: 'stock_doc_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
      field('qty', 'qty', 'decimal', '录入数量', { required: true, filterable: true, sortable: true }),
      field(
        'base_qty',
        'baseQty',
        'decimal',
        '折算数量(系统算:物料默认单位口径,6 位小数)',
        { readonly: true, filterable: true, sortable: true },
      ),
      field('material_code', 'materialCode', 'string', '物料编号', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('material_name', 'materialName', 'string', '物料名称', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('material_spec', 'materialSpec', 'string', '规格', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('unit_name', 'unitName', 'string', '单位名称', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('remark', 'remark', 'string', '行备注', { filterable: true, sortable: true }),
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
      field('stock_doc_id', 'stockDocId', 'fk', '手工出入库单', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'invStockDocs', relation: 'stockDoc', labelField: 'docNo' },
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('material_id', 'materialId', 'fk', '物料', {
        required: true,
        filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      field('unit_id', 'unitId', 'fk', '单位', {
        required: true,
        filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    form: {
      exclude: [
        'id',
        'baseQty',
        'materialCode',
        'materialName',
        'materialSpec',
        'unitName',
        'companyId',
        'insertedAt',
        'updatedAt',
      ],
    },
    print: true,
    audit: { enabled: true },

  }
}

export function stockTransferResourceMeta(): ResourceMeta {
  return {
    name: 'invStockTransfers',
    classification: { presentation: 'extension', interactive: true },
    numbering: true,
    permissionPrefix: 'inv.stock_transfer',
    permissionLabel: '手工调拨单',
    table: 'inv_stock_transfer',
    // 同手工出入库单：无 owner/dept 绑定，只有公司边界
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_no', 'docNo', 'string', '单据编号', { required: true, filterable: true, sortable: true }),
      field('doc_date', 'docDate', 'date', '业务日期', { required: true, filterable: true, sortable: true }),
      field('summary', 'summary', 'string', '摘要(带入库存分录)', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '备注(对内)', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        readonly: true,
        enumOptions: transferStatus,
        filterable: true,
        sortable: true,
      }),
      field('shipped_at', 'shippedAt', 'datetime', '发货时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('received_at', 'receivedAt', 'datetime', '收货时间', {
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
      field('company_id', 'companyId', 'fk', '公司', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('from_warehouse_id', 'fromWarehouseId', 'fk', '调出仓库(限本公司叶子仓)', {
        required: true,
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'fromWarehouse', labelField: 'name' },
      }),
      field('to_warehouse_id', 'toWarehouseId', 'fk', '调入仓库(限本公司叶子仓)', {
        required: true,
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'toWarehouse', labelField: 'name' },
      }),
      field('transit_warehouse_id', 'transitWarehouseId', 'fk', '在途仓库(限本公司叶子仓)', {
        required: true,
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'transitWarehouse', labelField: 'name' },
      }),
      field('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      field('shipped_by_id', 'shippedById', 'fk', '发货人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'shippedBy', labelField: 'name' },
      }),
      field('received_by_id', 'receivedById', 'fk', '收货人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'receivedBy', labelField: 'name' },
      }),
    ],
    actions: [
      ...crud,
      { key: 'ship', label: '发货', scope: 'row' },
      { key: 'receive', label: '收货', scope: 'row' },
    ],
    form: {
      exclude: [
        'id',
        'status',
        'shippedAt',
        'receivedAt',
        'insertedAt',
        'updatedAt',
        'createdById',
        'shippedById',
        'receivedById',
      ],
      fields: {
        docNo: { placeholder: '留空自动编号' },
        docDate: { required: true },
        companyId: { required: true, edit: 'createOnly' },
        fromWarehouseId: { required: true },
        toWarehouseId: { required: true },
        transitWarehouseId: { required: true },
      },
    },
    print: true,
    printHead: true,
    printLoops: [{ name: 'items', resource: 'invStockTransferItems' }],
    audit: { enabled: true },

  }
}

export function stockTransferItemResourceMeta(): ResourceMeta {
  return {
    name: 'invStockTransferItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'inv.stock_transfer',
    permissionLabel: '手工调拨单',
    table: 'inv_stock_transfer_item',
    authz: { kind: 'via', parent: 'invStockTransfers', fk: 'stock_transfer_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
      field('qty', 'qty', 'decimal', '录入数量', { required: true, filterable: true, sortable: true }),
      field(
        'base_qty',
        'baseQty',
        'decimal',
        '折算数量(系统算:物料默认单位口径,6 位小数)',
        { readonly: true, filterable: true, sortable: true },
      ),
      field('received_qty', 'receivedQty', 'decimal', '实收数量(收货回写,折算口径)', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('material_code', 'materialCode', 'string', '物料编号', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('material_name', 'materialName', 'string', '物料名称', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('material_spec', 'materialSpec', 'string', '规格', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('unit_name', 'unitName', 'string', '单位名称', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('remark', 'remark', 'string', '行备注', { filterable: true, sortable: true }),
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
      field('stock_transfer_id', 'stockTransferId', 'fk', '调拨单', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'invStockTransfers', relation: 'stockTransfer', labelField: 'docNo' },
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('material_id', 'materialId', 'fk', '物料', {
        required: true,
        filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      field('unit_id', 'unitId', 'fk', '单位', {
        required: true,
        filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    form: {
      exclude: [
        'id',
        'baseQty',
        'receivedQty',
        'materialCode',
        'materialName',
        'materialSpec',
        'unitName',
        'companyId',
        'insertedAt',
        'updatedAt',
      ],
    },
    print: true,
    audit: { enabled: true },

  }
}

export function stockCountResourceMeta(): ResourceMeta {
  return {
    name: 'invStockCounts',
    classification: { presentation: 'extension', interactive: true },
    numbering: true,
    permissionPrefix: 'inv.stock_count',
    permissionLabel: '库存盘点单',
    table: 'inv_stock_count',
    // 同手工出入库单：无 owner/dept 绑定，只有公司边界
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('doc_no', 'docNo', 'string', '单据编号', { required: true, filterable: true, sortable: true }),
      field('posting_date', 'postingDate', 'date', '业务日期', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('summary', 'summary', 'string', '摘要(带入库存分录)', { filterable: true, sortable: true }),
      field('remarks', 'remarks', 'string', '备注(对内)', { filterable: true, sortable: true }),
      field('status', 'status', 'enum', '状态', {
        readonly: true,
        enumOptions: countStatus,
        filterable: true,
        sortable: true,
      }),
      field('audited_at', 'auditedAt', 'datetime', '审核时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('snapshot_taken_at', 'snapshotTakenAt', 'datetime', '账面快照时间', {
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
      field('company_id', 'companyId', 'fk', '公司', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('warehouse_id', 'warehouseId', 'fk', '仓库(限本公司叶子仓)', {
        required: true,
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'warehouse', labelField: 'name' },
      }),
      field('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      field('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'auditedBy', labelField: 'name' },
      }),
    ],
    actions: [
      ...crud,
      { key: 'approve', label: '审核', scope: 'row' },
      { key: 'cancel', label: '作废', scope: 'row', isDanger: true },
    ],
    print: true,
    printHead: true,
    printLoops: [{ name: 'items', resource: 'invStockCountItems' }],
    audit: { enabled: true },

  }
}

export function stockCountItemResourceMeta(): ResourceMeta {
  return {
    name: 'invStockCountItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'inv.stock_count',
    permissionLabel: '库存盘点单',
    table: 'inv_stock_count_item',
    authz: { kind: 'via', parent: 'invStockCounts', fk: 'count_id' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('counted_quantity', 'countedQuantity', 'decimal', '实盘数量(录入单位口径,审核前可空)', {
        filterable: true,
        sortable: true,
      }),
      field(
        'converted_counted',
        'convertedCounted',
        'decimal',
        '折算实盘(系统算:物料默认单位口径,6 位小数)',
        { readonly: true, filterable: true, sortable: true },
      ),
      field(
        'book_quantity',
        'bookQuantity',
        'decimal',
        '账面数量快照(系统取数:物料默认单位口径,6 位小数)',
        { readonly: true, filterable: true, sortable: true },
      ),
      field('material_code', 'materialCode', 'string', '物料编号', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('material_name', 'materialName', 'string', '物料名称', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('material_spec', 'materialSpec', 'string', '规格', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('unit_name', 'unitName', 'string', '单位名称', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('remark', 'remark', 'string', '行备注', { filterable: true, sortable: true }),
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
      field('count_id', 'countId', 'fk', '库存盘点单', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'invStockCounts', relation: 'count', labelField: 'docNo' },
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        readonly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      field('material_id', 'materialId', 'fk', '物料', {
        required: true,
        filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      field('unit_id', 'unitId', 'fk', '单位', {
        required: true,
        filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    print: true,
    audit: { enabled: true },

  }
}

export function allInventoryResourceMetas(): ResourceMeta[] {
  return [
    materialCategoryResourceMeta(),
    materialResourceMeta(),
    materialUnitResourceMeta(),
    warehouseResourceMeta(),
    stockEntryResourceMeta(),
    stockDocResourceMeta(),
    stockDocItemResourceMeta(),
    stockTransferResourceMeta(),
    stockTransferItemResourceMeta(),
    stockCountResourceMeta(),
    stockCountItemResourceMeta(),
  ]
}
