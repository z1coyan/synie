/**
 * 销售退货 Meta 声明（源单行；手工行为 #57 预留列与可空快照）。
 * 机制镜像 trading/fulfillment 销售侧：无装箱子树，条目来源是发货条目而非订单条目。
 * 采购/委外退货后续票进同目录（pur_return / pur_outsourced_return）。
 */
import type { ResourceMeta } from '~/platform/meta/types.ts'

export const RETURN_HEAD_RESOURCE = 'salReturns'
export const RETURN_ITEM_RESOURCE = 'salReturnItems'
export const RETURN_HEAD_TABLE = 'sal_return'
export const RETURN_ITEM_TABLE = 'sal_return_item'
export const RETURN_VOUCHER_TYPE = 'sales.return'
export const RETURN_PERMISSION_PREFIX = 'sales.return'
export const RETURN_HEAD_LABEL = '销售退货单'
export const RETURN_ITEM_LABEL = '销售退货条目'
/** 贷方科目强制角色（方向为销售发货反转：借选定科目/贷未开票应收） */
export const RETURN_REQUIRED_ROLE = 'unbilled_receivable'

const PARTY = [
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'CUSTOMER', label: '客户' },
  { value: 'COMPANY', label: '内部公司' },
  { value: 'EMPLOYEE', label: '员工' },
]
const STATUS = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'AUDITED', label: '已审核' },
  { value: 'VOIDED', label: '已作废' },
]
const PARTY_VARIANTS = [
  { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
  { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
]

function f(
  name: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name, apiName, dbColumn: name, type, label, ...opts }
}

export function returnHeadMeta(): ResourceMeta {
  return {
    name: RETURN_HEAD_RESOURCE,
    // 整单抽屉为 Presentation Extension（镜像 salDeliveries）
    classification: { presentation: 'extension', interactive: true },
    permissionPrefix: RETURN_PERMISSION_PREFIX,
    numbering: true,
    permissionLabel: RETURN_HEAD_LABEL,
    table: RETURN_HEAD_TABLE,
    authz: { kind: 'company' },
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('return_no', 'returnNo', 'string', '退货单号', {
        readonly: true, filterable: true, sortable: true,
      }),
      f('return_date', 'returnDate', 'date', '退货日期(库存分录业务日)', {
        required: true, filterable: true, sortable: true,
      }),
      f('posting_date', 'postingDate', 'date', '过账日期(总账;有金额审核时必填)', {
        filterable: true, sortable: true,
      }),
      f('party_type', 'partyType', 'enum', '对手类型(客户/内部公司)', {
        required: true, enumOptions: PARTY, filterable: true, sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        required: true, filterable: true,
        ref: { resource: null, relation: null, labelField: null, discriminator: 'partyType', discriminatorType: 'enum', variants: PARTY_VARIANTS },
      }),
      // 原币与汇率：本票源单行按订单快照币种校验一致；为 #57 手工行预留全单换算口径
      f('currency_id', 'currencyId', 'fk', '原币(源单行须与订单快照币种一致)', {
        filterable: true,
        ref: { resource: 'basCurrencies', relation: 'currency', labelField: 'name' },
      }),
      f('exchange_rate', 'exchangeRate', 'decimal', '汇率(默认 1)', {
        filterable: true, sortable: true,
      }),
      f('remarks', 'remarks', 'string', '备注(对内;可带入库存分录)', { filterable: true, sortable: true }),
      f('status', 'status', 'enum', '状态', {
        readonly: true, enumOptions: STATUS, filterable: true, sortable: true,
      }),
      f('audited_at', 'auditedAt', 'datetime', '审核时间', { readonly: true, filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f('company_id', 'companyId', 'fk', '公司', {
        required: true, createOnly: true, filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f('warehouse_id', 'warehouseId', 'fk', '默认仓库(可空,仅新建行预填)', {
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'warehouse', labelField: 'name' },
      }),
      f('debit_account_id', 'debitAccountId', 'fk', '借方科目(自选;草稿必填)', {
        required: true, filterable: true,
        ref: { resource: 'basAccounts', relation: 'debitAccount', labelField: 'name' },
      }),
      f('credit_account_id', 'creditAccountId', 'fk', '贷方科目(未开票应收;草稿必填)', {
        required: true, filterable: true,
        ref: { resource: 'basAccounts', relation: 'creditAccount', labelField: 'name' },
      }),
      f('created_by_id', 'createdById', 'fk', '录入人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      f('audited_by_id', 'auditedById', 'fk', '审核人', {
        readonly: true, filterable: true,
        ref: { resource: 'sysUsers', relation: 'auditedBy', labelField: 'name' },
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      { key: 'audit', label: '审核', scope: 'row' },
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
    ],
    form: { kind: 'extension' },
    // 前缀组打印头锚点（本票无打印动作；打印目录派生需唯一头）
    printHead: true,
    audit: { enabled: true },
  }
}

export function returnItemMeta(): ResourceMeta {
  return {
    name: RETURN_ITEM_RESOURCE,
    classification: { presentation: 'none', interactive: false },
    /** 行图纸快照只读展示宿主：保存时从物料复制挂接，删行/删单清理（ownerType=表名） */
    attachments: {},
    permissionPrefix: RETURN_PERMISSION_PREFIX,
    permissionLabel: RETURN_HEAD_LABEL,
    table: RETURN_ITEM_TABLE,
    authz: { kind: 'via', parent: RETURN_HEAD_RESOURCE, fk: 'return_id' },
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
      f('qty', 'qty', 'decimal', '录入数量', { required: true, filterable: true, sortable: true }),
      f('base_qty', 'baseQty', 'decimal', '折算数量(物料默认单位,6 位)', { readonly: true, filterable: true, sortable: true }),
      // 快照列：源单行随发货条目带入；为手工行（#57）预留可空
      f('material_code', 'materialCode', 'string', '物料编号', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('material_name', 'materialName', 'string', '物料名称', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('material_spec', 'materialSpec', 'string', '规格', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('unit_name', 'unitName', 'string', '单位名称', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_no', 'orderNo', 'string', '订单号', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_qty', 'orderQty', 'decimal', '订购数量(订单行单位)', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_base_qty', 'orderBaseQty', 'decimal', '订购数量(默认单位)', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_unit_name', 'orderUnitName', 'string', '订单行单位名称', { readonly: true, nullable: true, filterable: true, sortable: true }),
      // 含税单价/税率：源单行随发货快照带入(保存时覆盖)；手工行手填(wire 可写)
      f('order_price', 'orderPrice', 'decimal', '原币含税单价(手工行手填)', { nullable: true, filterable: true, sortable: true }),
      f('order_amount', 'orderAmount', 'decimal', '原币含税金额', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_base_price', 'orderBasePrice', 'decimal', '本币含税单价', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_base_amount', 'orderBaseAmount', 'decimal', '本币含税金额', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_tax_rate', 'orderTaxRate', 'decimal', '税率(手工行手填)', { nullable: true, filterable: true, sortable: true }),
      f('order_currency_code', 'orderCurrencyCode', 'string', '订单原币代码', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('reconciled_qty', 'reconciledQty', 'decimal', '已对账数量(默认单位;由销售对账单生效/回退同步)', {
        readonly: true, filterable: true, sortable: true,
      }),
      f('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f('return_id', 'returnId', 'fk', '销售退货单', {
        required: true, createOnly: true, filterable: true,
        ref: { resource: RETURN_HEAD_RESOURCE, relation: 'return', labelField: 'returnNo' },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        readonly: true, filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f('delivery_item_id', 'deliveryItemId', 'fk', '发货条目(源单行锚点;手工行留空)', {
        nullable: true, filterable: true,
        ref: { resource: 'salDeliveryItems', relation: 'deliveryItem', labelField: 'materialCode' },
      }),
      f('order_item_id', 'orderItemId', 'fk', '订单条目(随发货条目带入)', {
        readonly: true, nullable: true, filterable: true,
        ref: { resource: 'salOrderItems', relation: 'orderItem', labelField: 'materialCode' },
      }),
      // 物料：手工行手填(wire 可写)；源单行随发货条目带入(保存时覆盖)
      f('material_id', 'materialId', 'fk', '物料(手工行必填)', {
        nullable: true, filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      f('unit_id', 'unitId', 'fk', '单位', {
        filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
      f('warehouse_id', 'warehouseId', 'fk', '退货入仓', {
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'warehouse', labelField: 'name' },
      }),
      f('return_no', 'returnNo', 'string', '退货单号', {
        readonly: true, calculated: true, filterable: true, sortable: true,
      }),
      f('return_date', 'returnDate', 'date', '退货日期', {
        readonly: true, calculated: true, filterable: true, sortable: true,
      }),
      f('return_status', 'returnStatus', 'enum', '退货单状态', {
        readonly: true, calculated: true, enumOptions: STATUS, filterable: true, sortable: true,
      }),
      f('party_type', 'partyType', 'enum', '对手类型(客户/内部公司)', {
        readonly: true, calculated: true, enumOptions: PARTY, filterable: true, sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        readonly: true, filterable: true, printRawId: true,
        ref: { resource: null, relation: null, labelField: null, discriminator: 'partyType', discriminatorType: 'enum', variants: PARTY_VARIANTS },
      }),
      f('remaining_reconcilable_qty', 'remainingReconcilableQty', 'decimal', '剩余可对账量(默认单位)', {
        readonly: true, calculated: true, filterable: true, sortable: true,
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    // exclude 保留历史审计面：头冗余对手不进审计 diff
    audit: { enabled: true, exclude: ['party_id'] },
  }
}
