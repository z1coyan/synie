/**
 * 销售/采购对账单 Meta 与 side 规格（对称配置）。
 */
import type { TradingSide } from '../common.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'

export type ReconciliationKind = 'regular' | 'gift_sample'
export type ReconciliationStatus = 'draft' | 'confirmed' | 'closed' | 'voided'

export interface ReconciliationSideSpec {
  side: TradingSide
  prefix: string
  table: string
  itemTable: string
  label: string
  party: string
  todoType: string
  voucher: string
  headResource: string
  itemResource: string
  destroyHead: string
  destroyItem: string
  confirmMutation: string
  unconfirmMutation: string
  auditMutation: string
  voidMutation: string
}

export function reconciliationSpec(side: TradingSide): ReconciliationSideSpec {
  if (side === 'sales') {
    return {
      side: 'sales',
      prefix: 'sales.reconciliation',
      table: 'sal_reconciliation',
      itemTable: 'sal_reconciliation_item',
      label: '销售对账单',
      party: 'customer',
      todoType: 'issue_invoice',
      voucher: 'sales.reconciliation',
      headResource: 'salReconciliations',
      itemResource: 'salReconciliationItems',
      destroyHead: 'destroySalReconciliation',
      destroyItem: 'destroySalReconciliationItem',
      confirmMutation: 'confirmSalReconciliation',
      unconfirmMutation: 'unconfirmSalReconciliation',
      auditMutation: 'auditSalReconciliation',
      voidMutation: 'voidSalReconciliation',
    }
  }
  return {
    side: 'purchase',
    prefix: 'purchase.reconciliation',
    table: 'pur_reconciliation',
    itemTable: 'pur_reconciliation_item',
    label: '采购对账单',
    party: 'supplier',
    todoType: 'receive_invoice',
    voucher: 'purchase.reconciliation',
    headResource: 'purReconciliations',
    itemResource: 'purReconciliationItems',
    destroyHead: 'destroyPurReconciliation',
    destroyItem: 'destroyPurReconciliationItem',
    confirmMutation: 'confirmPurReconciliation',
    unconfirmMutation: 'unconfirmPurReconciliation',
    auditMutation: 'auditPurReconciliation',
    voidMutation: 'voidPurReconciliation',
  }
}

const PARTY = [
  { value: 'SUPPLIER', label: '供应商' },
  { value: 'CUSTOMER', label: '客户' },
  { value: 'COMPANY', label: '内部公司' },
  { value: 'EMPLOYEE', label: '员工' },
]

const KINDS = [
  { value: 'REGULAR', label: '常规' },
  { value: 'GIFT_SAMPLE', label: '赠送/样品' },
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

export function reconciliationHeadMeta(side: TradingSide): ResourceMeta {
  const spec = reconciliationSpec(side)
  const sales = side === 'sales'
  const confirmedLabel = sales ? '客户已确认' : '供应商已确认'
  const statusOptions = [
    { value: 'DRAFT', label: '草稿' },
    { value: 'CONFIRMED', label: confirmedLabel },
    { value: 'CLOSED', label: '已结单' },
    { value: 'VOIDED', label: '已作废' },
  ]
  const partyVariants = sales
    ? [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'CUSTOMER', resource: 'salCustomers', labelField: 'name', label: '客户' },
      ]
    : [
        { value: 'COMPANY', resource: 'basCompanies', labelField: 'name', label: '内部公司' },
        { value: 'SUPPLIER', resource: 'purSuppliers', labelField: 'name', label: '供应商' },
      ]
  const debitLabel = sales
    ? '借方科目(常规单=发货贷方口径;赠送/样品单=费用损失类;草稿必填)'
    : '借方科目(未开票应付;草稿必填)'
  const creditLabel = sales
    ? '贷方科目(未开票应收;草稿必填)'
    : '贷方科目(常规单=入库借方口径;赠送/样品单=收益类;草稿必填)'
  const confirmLabel = sales ? '客户确认' : '供应商确认'
  return {
    name: spec.headResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.table,
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('reconciliation_no', 'reconciliationNo', 'string', '对账单号', {
        filterable: true,
        sortable: true,
      }),
      f('reconciliation_type', 'reconciliationType', 'enum', '对账类型(常规/赠送样品;保存后锁死)', {
        enumOptions: KINDS,
        filterable: true,
        sortable: true,
      }),
      f('party_type', 'partyType', 'enum', sales ? '对手类型' : '对手类型(供应商/内部公司)', {
        enumOptions: PARTY,
        filterable: true,
        sortable: true,
      }),
      f('party_id', 'partyId', 'fk', '对手', {
        required: true,
        filterable: true,
        ref: {
          resource: null,
          relation: null,
          labelField: null,
          discriminator: 'partyType',
          discriminatorType: 'enum',
          variants: partyVariants,
        },
      }),
      f(
        'posting_date',
        'postingDate',
        'date',
        '过账日期(赠送/样品单结单总账;有金额结单时必填,默认结单当日)',
        { filterable: true, sortable: true },
      ),
      f('remarks', 'remarks', 'string', '备注', { filterable: true, sortable: true }),
      f('status', 'status', 'enum', '状态', {
        enumOptions: statusOptions,
        filterable: true,
        sortable: true,
      }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
      }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {
        filterable: true,
        sortable: true,
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      f('debit_account_id', 'debitAccountId', 'fk', debitLabel, {
        filterable: true,
        ref: { resource: 'basAccounts', relation: 'debitAccount', labelField: 'name' },
      }),
      f('credit_account_id', 'creditAccountId', 'fk', creditLabel, {
        filterable: true,
        ref: { resource: 'basAccounts', relation: 'creditAccount', labelField: 'name' },
      }),
      f('created_by_id', 'createdById', 'fk', '录入人', {
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'createdBy', labelField: 'name' },
      }),
      f(
        'gross_total',
        'grossTotal',
        'decimal',
        '原币含税合计(行原币金额合计;单内同币种)',
        { readonly: true, calculated: true },
      ),
      f(
        'base_gross_total',
        'baseGrossTotal',
        'decimal',
        '本币含税合计(行本币金额合计;发票价税合计须与之相等)',
        { readonly: true, calculated: true },
      ),
    ],
    printHead: true,
    printLoops: [{ name: 'items', resource: spec.itemResource }],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      { key: 'confirm', label: confirmLabel, scope: 'row'},
      {
        key: 'unconfirm',
        label: '撤回确认',
        scope: 'row',
        isDanger: true,
      },
      { key: 'audit', label: '结单', scope: 'row'},
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
    ],
    audit: { enabled: true },
  }
}

export function reconciliationItemMeta(side: TradingSide): ResourceMeta {
  const spec = reconciliationSpec(side)
  const sales = side === 'sales'
  const confirmedLabel = sales ? '客户已确认' : '供应商已确认'
  const statusOptions = [
    { value: 'DRAFT', label: '草稿' },
    { value: 'CONFIRMED', label: confirmedLabel },
    { value: 'CLOSED', label: '已结单' },
    { value: 'VOIDED', label: '已作废' },
  ]
  const sourceFields: ResourceMeta['fields'] = sales
    ? [
        f('delivery_item_id', 'deliveryItemId', 'fk', '发货条目', {
          filterable: true,
          ref: { resource: 'salDeliveryItems', relation: 'deliveryItem', labelField: 'materialCode' },
        }),
      ]
    : [
        f(
          'receipt_item_id',
          'receiptItemId',
          'fk',
          '入库条目(采购入库;与委外入库条目恰挂其一)',
          {
            filterable: true,
            ref: {
              resource: 'purReceiptItems',
              relation: 'receiptItem',
              labelField: 'materialCode',
            },
          },
        ),
        f(
          'outsourced_receipt_item_id',
          'outsourcedReceiptItemId',
          'fk',
          '委外入库条目(与采购入库条目恰挂其一)',
          {
            filterable: true,
            ref: {
              resource: 'purOutsourcedReceiptItems',
              relation: 'outsourcedReceiptItem',
              labelField: 'materialCode',
            },
          },
        ),
      ]
  const sourceNo = sales
    ? f('delivery_no', 'deliveryNo', 'string', '发货单号', {
        filterable: true,
        sortable: true,
      })
    : f('receipt_no', 'receiptNo', 'string', '入库单号', {
        filterable: true,
        sortable: true,
      })
  const sourceDate = sales
    ? f('delivery_date', 'deliveryDate', 'date', '发货日期', {
        filterable: true,
        sortable: true,
      })
    : f('receipt_date', 'receiptDate', 'date', '入库日期', {
        filterable: true,
        sortable: true,
      })
  return {
    name: spec.itemResource,
    permissionPrefix: spec.prefix,
    permissionLabel: spec.label,
    table: spec.itemTable,
    fields: [
      f('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      f('idx', 'idx', 'integer', '行号', { filterable: true, sortable: true }),
      f(
        'qty',
        'qty',
        'decimal',
        sales ? '对账数量(发货条目行单位)' : '对账数量(入库条目行单位)',
        { filterable: true, sortable: true },
      ),
      f('base_qty', 'baseQty', 'decimal', '折算数量(物料默认单位,6 位;与已对账数量同口径)', {
        filterable: true,
        sortable: true,
      }),
      f('amount', 'amount', 'decimal', '原币含税金额(数量×快照原币含税单价,2 位)', {
        filterable: true,
        sortable: true,
      }),
      f('base_amount', 'baseAmount', 'decimal', '本币含税金额(原币金额×源订单汇率,2 位)', {
        filterable: true,
        sortable: true,
      }),
      f('remarks', 'remarks', 'string', '行备注', { filterable: true, sortable: true }),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        filterable: true,
        sortable: true,
      }),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {
        filterable: true,
        sortable: true,
      }),
      f('reconciliation_id', 'reconciliationId', 'fk', sales ? '销售对账单' : '采购对账单', {
        filterable: true,
        ref: {
          resource: spec.headResource,
          relation: 'reconciliation',
          labelField: 'reconciliationNo',
        },
      }),
      f('company_id', 'companyId', 'fk', '公司', {
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      ...sourceFields,
      f('reconciliation_no', 'reconciliationNo', 'string', '对账单号', {
        filterable: true,
        sortable: true,
      }),
      f('reconciliation_status', 'reconciliationStatus', 'enum', '对账单状态', {
        enumOptions: statusOptions,
        filterable: true,
        sortable: true,
      }),
      sourceNo,
      sourceDate,
      f(
        'material_name',
        'materialName',
        'string',
        sales ? '物料名称(发货条目快照)' : '物料名称(入库条目快照)',
        { filterable: true, sortable: true },
      ),
      f(
        'unit_name',
        'unitName',
        'string',
        sales ? '单位名称(发货条目快照)' : '单位名称(入库条目快照)',
        { filterable: true, sortable: true },
      ),
      f('order_currency_code', 'orderCurrencyCode', 'string', '订单原币代码', {
        filterable: true,
        sortable: true,
      }),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    audit: { enabled: true },
  }
}
