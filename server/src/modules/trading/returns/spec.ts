/**
 * 退货 Meta 声明与 side 规格（销售退货 / 采购退货对称配置；委外退货后续票进同目录）。
 * 机制镜像 trading/fulfillment 双侧：无装箱子树，条目来源是履约条目（发货/入库）而非订单条目；
 * 源单行锚点可空 = 手工行（手填物料/单位/数量/含税单价/税率）。
 */
import type { TradingSide } from '../common.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'

/** 退货三类：销售/采购为金额单；委外为纯数量单（无金额/科目/币种/对账） */
export type ReturnKind = TradingSide | 'outsourced'

export interface ReturnSideSpec {
  side: ReturnKind
  /** 订单投影侧（委外退货挂委外采购订单条目，投影走 purchase 侧） */
  projectionSide: TradingSide
  /** 委外退货=true：reverseFulfillment/postFulfillment 传 requireOutsourced */
  requireOutsourced: boolean
  /** 金额单=true：科目/原币/GL/对账投影；委外纯数量单=false */
  monetary: boolean
  label: string
  /** 聚合草稿校验文案前缀（「销售退货草稿参数不合法」）；与 label 解耦，改单据名不会静默破文案 */
  draftLabel: string
  itemLabel: string
  prefix: string
  headTable: string
  itemTable: string
  headResource: string
  itemResource: string
  voucherType: string
  /** 源单（履约）表与列 */
  sourceHeadTable: string
  sourceItemTable: string
  sourceParentCol: string
  sourceItemResource: string
  /** 条目上源单锚点 fk 的 apiName（deliveryItemId / receiptItemId / outsourcedReceiptItemId） */
  sourceItemApi: string
  /** 源单锚点物理列 */
  sourceItemCol: string
  orderItemTable: string
  /** 文案用词：源单/源条目 */
  sourceLabel: string
  sourceItemLabel: string
  allowedParty: ReadonlySet<string>
  /** 强制角色科目所在侧与销售/采购退货的 GL 方向（仅 monetary） */
  requiredRoleSide: 'debit' | 'credit'
  requiredRole: string
  /** 审核库存方向：销售退货回库 in / 采购与委外退货出仓 out */
  stockDirection: 'in' | 'out'
  numberCol: string
  dateCol: string
  parentCol: string
  numberApi: string
  dateApi: string
  parentApi: string
  statusApi: string
}

export function returnSpec(side: ReturnKind): ReturnSideSpec {
  if (side === 'sales') {
    return {
      side: 'sales',
      projectionSide: 'sales',
      requireOutsourced: false,
      monetary: true,
      label: '销售退货单',
      draftLabel: '销售退货',
      itemLabel: '销售退货条目',
      prefix: 'sales.return',
      headTable: 'sal_return',
      itemTable: 'sal_return_item',
      headResource: 'salReturns',
      itemResource: 'salReturnItems',
      voucherType: 'sales.return',
      sourceHeadTable: 'sal_delivery',
      sourceItemTable: 'sal_delivery_item',
      sourceParentCol: 'delivery_id',
      sourceItemResource: 'salDeliveryItems',
      sourceItemApi: 'deliveryItemId',
      sourceItemCol: 'delivery_item_id',
      orderItemTable: 'sal_order_item',
      sourceLabel: '发货单',
      sourceItemLabel: '发货条目',
      allowedParty: new Set(['customer', 'company']),
      requiredRoleSide: 'credit',
      requiredRole: 'unbilled_receivable',
      stockDirection: 'in',
      numberCol: 'return_no',
      dateCol: 'return_date',
      parentCol: 'return_id',
      numberApi: 'returnNo',
      dateApi: 'returnDate',
      parentApi: 'returnId',
      statusApi: 'returnStatus',
    }
  }
  if (side === 'purchase') {
    return {
      side: 'purchase',
      projectionSide: 'purchase',
      requireOutsourced: false,
      monetary: true,
      label: '采购退货单',
      draftLabel: '采购退货',
      itemLabel: '采购退货条目',
      prefix: 'purchase.return',
      headTable: 'pur_return',
      itemTable: 'pur_return_item',
      headResource: 'purReturns',
      itemResource: 'purReturnItems',
      voucherType: 'purchase.return',
      sourceHeadTable: 'pur_receipt',
      sourceItemTable: 'pur_receipt_item',
      sourceParentCol: 'receipt_id',
      sourceItemResource: 'purReceiptItems',
      sourceItemApi: 'receiptItemId',
      sourceItemCol: 'receipt_item_id',
      orderItemTable: 'pur_order_item',
      sourceLabel: '入库单',
      sourceItemLabel: '入库条目',
      allowedParty: new Set(['supplier', 'company']),
      requiredRoleSide: 'debit',
      requiredRole: 'unbilled_payable',
      stockDirection: 'out',
      numberCol: 'return_no',
      dateCol: 'return_date',
      parentCol: 'return_id',
      numberApi: 'returnNo',
      dateApi: 'returnDate',
      parentApi: 'returnId',
      statusApi: 'returnStatus',
    }
  }
  // 委外退货：纯数量单（无金额/科目/币种/对账；不回补外协仓材料、不退副产物）
  return {
    side: 'outsourced',
    projectionSide: 'purchase',
    requireOutsourced: true,
    monetary: false,
    label: '委外退货单',
    draftLabel: '委外退货',
    itemLabel: '委外退货条目',
    prefix: 'purchase.outsourced_return',
    headTable: 'pur_outsourced_return',
    itemTable: 'pur_outsourced_return_item',
    headResource: 'purOutsourcedReturns',
    itemResource: 'purOutsourcedReturnItems',
    voucherType: 'purchase.outsourced_return',
    sourceHeadTable: 'pur_outsourced_receipt',
    sourceItemTable: 'pur_outsourced_receipt_item',
    sourceParentCol: 'receipt_id',
    sourceItemResource: 'purOutsourcedReceiptItems',
    sourceItemApi: 'outsourcedReceiptItemId',
    sourceItemCol: 'outsourced_receipt_item_id',
    orderItemTable: 'pur_order_item',
    sourceLabel: '委外入库单',
    sourceItemLabel: '委外入库条目',
    allowedParty: new Set(['supplier', 'company']),
    requiredRoleSide: 'debit',
    requiredRole: '',
    stockDirection: 'out',
    numberCol: 'return_no',
    dateCol: 'return_date',
    parentCol: 'return_id',
    numberApi: 'returnNo',
    dateApi: 'returnDate',
    parentApi: 'returnId',
    statusApi: 'returnStatus',
  }
}

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

function f(
  name: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name, apiName, dbColumn: name, type, label, ...opts }
}

export function returnHeadMeta(side: ReturnKind): ResourceMeta {
  const spec = returnSpec(side)
  const sales = side === 'sales'
  const monetary = spec.monetary
  const variants = sales
    ? [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
      ]
    : [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
      ]
  return {
    name: spec.headResource,
    // 整单抽屉为 Presentation Extension（镜像履约单据）
    classification: { presentation: 'extension', interactive: true },
    permissionPrefix: spec.prefix,
    numbering: true,
    permissionLabel: spec.label,
    table: spec.headTable,
    authz: { kind: 'company' },
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('return_no', 'returnNo', 'string', '退货单号', {
        readonly: true, filterable: true, sortable: true,
      }),
      f('return_date', 'returnDate', 'date', '退货日期(库存分录业务日)', {
        required: true, filterable: true, sortable: true,
      }),
      // 过账日期/原币汇率/表底科目仅金额单（委外纯数量单不过总账）
      ...(monetary
        ? [
            f('posting_date', 'postingDate', 'date', '过账日期(总账;有金额审核时必填)', {
              filterable: true, sortable: true,
            }),
          ]
        : []),
      f('party_type', 'partyType', 'enum', sales ? '对手类型(客户/内部公司)' : '对手类型(供应商/内部公司)', {
        required: true, enumOptions: PARTY, filterable: true, sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        required: true, filterable: true,
        ref: { resource: null, relation: null, labelField: null, discriminator: 'partyType', discriminatorType: 'enum', variants },
      }),
      // 原币与汇率：源单行按订单快照币种校验一致；手工行按本头汇率折本币
      ...(monetary
        ? [
            f('currency_id', 'currencyId', 'fk', '原币(源单行须与订单快照币种一致)', {
              filterable: true,
              ref: { resource: 'basCurrencies', relation: 'currency', labelField: 'name' },
            }),
            f('exchange_rate', 'exchangeRate', 'decimal', '汇率(默认 1)', {
              filterable: true, sortable: true,
            }),
          ]
        : []),
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
      ...(monetary
        ? [
            f('debit_account_id', 'debitAccountId', 'fk', sales ? '借方科目(自选;草稿必填)' : '借方科目(未开票应付;草稿必填)', {
              required: true, filterable: true,
              ref: { resource: 'basAccounts', relation: 'debitAccount', labelField: 'name' },
            }),
            f('credit_account_id', 'creditAccountId', 'fk', sales ? '贷方科目(未开票应收;草稿必填)' : '贷方科目(自选;草稿必填)', {
              required: true, filterable: true,
              ref: { resource: 'basAccounts', relation: 'creditAccount', labelField: 'name' },
            }),
          ]
        : []),
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
      // 补货需求生成：仅销售退货（采购/委外退货不放——缺口重现后供应商/协作方重送即可）
      ...(sales
        ? [{ key: 'generate_replenishment', label: '生成补货需求单', scope: 'row' as const }]
        : []),
    ],
    form: { kind: 'extension' },
    // 前缀组打印头锚点（本票无打印动作；打印目录派生需唯一头）
    printHead: true,
    audit: { enabled: true },
  }
}

export function returnItemMeta(side: ReturnKind): ResourceMeta {
  const spec = returnSpec(side)
  const sales = side === 'sales'
  const monetary = spec.monetary
  const variants = sales
    ? [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
      ]
    : [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
      ]
  return {
    name: spec.itemResource,
    classification: { presentation: 'none', interactive: false },
    /** 行图纸快照只读展示宿主：保存时从物料复制挂接，删行/删单清理（ownerType=表名） */
    attachments: {},
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.itemTable,
    authz: { kind: 'via', parent: spec.headResource, fk: 'return_id' },
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('idx', 'idx', 'integer', '行号', { required: true, filterable: true, sortable: true }),
      f('qty', 'qty', 'decimal', '录入数量', { required: true, filterable: true, sortable: true }),
      f('base_qty', 'baseQty', 'decimal', '折算数量(物料默认单位,6 位)', { readonly: true, filterable: true, sortable: true }),
      // 快照列：源单行随履约条目带入；手工行随物料/手填带入
      f('material_code', 'materialCode', 'string', '物料编号', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('material_name', 'materialName', 'string', '物料名称', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('material_spec', 'materialSpec', 'string', '规格', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('unit_name', 'unitName', 'string', '单位名称', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_no', 'orderNo', 'string', '订单号', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_qty', 'orderQty', 'decimal', '订购数量(订单行单位)', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_base_qty', 'orderBaseQty', 'decimal', '订购数量(默认单位)', { readonly: true, nullable: true, filterable: true, sortable: true }),
      f('order_unit_name', 'orderUnitName', 'string', '订单行单位名称', { readonly: true, nullable: true, filterable: true, sortable: true }),
      // 价税快照/原币/已对账列仅金额单（委外纯数量单无金额、不进对账）
      ...(monetary
        ? [
            // 含税单价/税率：源单行随履约快照带入(保存时覆盖)；手工行手填(wire 可写)
            f('order_price', 'orderPrice', 'decimal', '原币含税单价(手工行手填)', { nullable: true, filterable: true, sortable: true }),
            f('order_amount', 'orderAmount', 'decimal', '原币含税金额', { readonly: true, nullable: true, filterable: true, sortable: true }),
            f('order_base_price', 'orderBasePrice', 'decimal', '本币含税单价', { readonly: true, nullable: true, filterable: true, sortable: true }),
            f('order_base_amount', 'orderBaseAmount', 'decimal', '本币含税金额', { readonly: true, nullable: true, filterable: true, sortable: true }),
            f('order_tax_rate', 'orderTaxRate', 'decimal', '税率(手工行手填)', { nullable: true, filterable: true, sortable: true }),
            f('order_currency_code', 'orderCurrencyCode', 'string', '订单原币代码', { readonly: true, nullable: true, filterable: true, sortable: true }),
            f('reconciled_qty', 'reconciledQty', 'decimal', sales ? '已对账数量(默认单位;由销售对账单生效/回退同步)' : '已对账数量(默认单位;由采购对账单生效/回退同步)', {
              readonly: true, filterable: true, sortable: true,
            }),
          ]
        : []),
      f('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', { readonly: true, filterable: true, sortable: true }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', { readonly: true, filterable: true, sortable: true }),
      f('return_id', 'returnId', 'fk', spec.label, {
        required: true, createOnly: true, filterable: true,
        ref: { resource: spec.headResource, relation: 'return', labelField: 'returnNo' },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        readonly: true, filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f(
        spec.sourceItemCol,
        spec.sourceItemApi,
        'fk',
        `${spec.sourceItemLabel}(源单行锚点;手工行留空)`,
        {
          nullable: true, filterable: true,
          ref: { resource: spec.sourceItemResource, relation: 'sourceItem', labelField: 'materialCode' },
        },
      ),
      f('order_item_id', 'orderItemId', 'fk', '订单条目(随来源条目带入)', {
        readonly: true, nullable: true, filterable: true,
        ref: { resource: sales ? 'salOrderItems' : 'purOrderItems', relation: 'orderItem', labelField: 'materialCode' },
      }),
      // 物料：手工行手填(wire 可写)；源单行随来源条目带入(保存时覆盖)
      f('material_id', 'materialId', 'fk', '物料(手工行必填)', {
        nullable: true, filterable: true,
        ref: { resource: 'invMaterials', relation: 'material', labelField: 'name' },
      }),
      f('unit_id', 'unitId', 'fk', '单位', {
        filterable: true,
        ref: { resource: 'basUnits', relation: 'unit', labelField: 'name' },
      }),
      f('warehouse_id', 'warehouseId', 'fk', sales ? '退货入仓' : '退货出仓', {
        filterable: true,
        ref: { resource: 'invWarehouses', relation: 'warehouse', labelField: 'name' },
      }),
      // 剩余可对账仅金额单（委外不进对账池）
      f('return_no', 'returnNo', 'string', '退货单号', {
        readonly: true, calculated: true, filterable: true, sortable: true,
      }),
      f('return_date', 'returnDate', 'date', '退货日期', {
        readonly: true, calculated: true, filterable: true, sortable: true,
      }),
      f('return_status', 'returnStatus', 'enum', '退货单状态', {
        readonly: true, calculated: true, enumOptions: STATUS, filterable: true, sortable: true,
      }),
      f('party_type', 'partyType', 'enum', sales ? '对手类型(客户/内部公司)' : '对手类型(供应商/内部公司)', {
        readonly: true, calculated: true, enumOptions: PARTY, filterable: true, sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        readonly: true, filterable: true, printRawId: true,
        ref: { resource: null, relation: null, labelField: null, discriminator: 'partyType', discriminatorType: 'enum', variants },
      }),
      ...(monetary
        ? [
            f('remaining_reconcilable_qty', 'remainingReconcilableQty', 'decimal', '剩余可对账量(默认单位)', {
              readonly: true, calculated: true, filterable: true, sortable: true,
            }),
          ]
        : []),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    // exclude 保留历史审计面：头冗余对手不进审计 diff
    audit: { enabled: true, exclude: ['party_id'] },
  }
}
