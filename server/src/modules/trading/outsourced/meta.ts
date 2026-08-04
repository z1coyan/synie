import type { ResourceMeta } from '~/platform/meta/types.ts'
import type { GridColumnRef } from '@synie/shared'

function f(
  name: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name, apiName, dbColumn: name, type, label, ...opts }
}

export function outsourcedIssueMeta(): ResourceMeta {
  return {
    name: 'purOutsourcedIssues',
    classification: { presentation: 'extension', interactive: true },
    permissionPrefix: 'purchase.outsourced_issue',
    numbering: true,
    permissionLabel: '委外发料单',
    table: 'pur_outsourced_issue',
    printHead: true,
    fields: [
      f('id', 'id', 'uuid', 'id', {"sortable": true, "readonly": true}),
      f('issue_no', 'issueNo', 'string', '发料单号', {"sortable": true, "filterable": true}),
      f('issue_date', 'issueDate', 'date', '发料日期(库存分录业务日)', {"sortable": true, "filterable": true}),
      f('party_type', 'partyType', 'enum', '对手类型(供应商/内部公司,须与所引委外订单一致)', {"sortable": true, "filterable": true, "enumOptions": [{"label": "供应商", "value": "SUPPLIER"}, {"label": "客户", "value": "CUSTOMER"}, {"label": "内部公司", "value": "COMPANY"}, {"label": "员工", "value": "EMPLOYEE"}]}),
      f('party_id', 'partyId', 'fk', '对手', {"filterable": true, "ref": {"resource": null, "relation": null, "labelField": null, "discriminator": "partyType", "discriminatorType": "enum", "variants": [{"label": "内部公司", "labelField": "name", "resource": "basCompanies", "value": "COMPANY"}, {"label": "供应商", "labelField": "name", "resource": "purSuppliers", "value": "SUPPLIER"}]}}),
      f('remarks', 'remarks', 'string', '备注(对内;可带入库存分录)', {"sortable": true, "filterable": true}),
      f('status', 'status', 'enum', '状态', {"sortable": true, "filterable": true, "enumOptions": [{"label": "草稿", "value": "DRAFT"}, {"label": "已审核", "value": "AUDITED"}, {"label": "已作废", "value": "VOIDED"}]}),
      f('audited_at', 'auditedAt', 'datetime', '审核时间', {"sortable": true, "filterable": true}),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {"sortable": true, "filterable": true}),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {"sortable": true, "filterable": true}),
      f('company_id', 'companyId', 'fk', '公司', {"filterable": true, "ref": {"resource": "basCompanies", "relation": "company", "labelField": "name"}}),
      f('from_warehouse_id', 'fromWarehouseId', 'fk', '默认调出仓(可空,仅新建行预填)', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "fromWarehouse", "labelField": "name"}}),
      f('outsourced_warehouse_id', 'outsourcedWarehouseId', 'fk', '默认外协仓(可空,仅新建行预填)', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "outsourcedWarehouse", "labelField": "name"}}),
      f('created_by_id', 'createdById', 'fk', '录入人', {"filterable": true, "ref": {"resource": "sysUsers", "relation": "createdBy", "labelField": "name"}}),
      f('audited_by_id', 'auditedById', 'fk', '审核人', {"filterable": true, "ref": {"resource": "sysUsers", "relation": "auditedBy", "labelField": "name"}}),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      { key: 'audit', label: '审核', scope: 'row' },
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
    ],
    audit: { enabled: true },

  }
}

export function outsourcedIssueItemMeta(): ResourceMeta {
  return {
    name: 'purOutsourcedIssueItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'purchase.outsourced_issue',
    permissionLabel: '委外发料单',
    table: 'pur_outsourced_issue_item',
    fields: [
      f('id', 'id', 'uuid', 'id', {"sortable": true, "readonly": true}),
      f('idx', 'idx', 'integer', '行号', {"sortable": true, "filterable": true}),
      f('qty', 'qty', 'decimal', '录入数量', {"sortable": true, "filterable": true}),
      f('base_qty', 'baseQty', 'decimal', '折算数量(材料默认单位,6 位)', {"sortable": true, "filterable": true}),
      f('material_code', 'materialCode', 'string', '物料编号', {"sortable": true, "filterable": true}),
      f('material_name', 'materialName', 'string', '物料名称', {"sortable": true, "filterable": true}),
      f('material_spec', 'materialSpec', 'string', '规格', {"sortable": true, "filterable": true}),
      f('unit_name', 'unitName', 'string', '单位名称', {"sortable": true, "filterable": true}),
      f('order_no', 'orderNo', 'string', '订单号', {"sortable": true, "filterable": true}),
      f('remarks', 'remarks', 'string', '行备注', {"sortable": true, "filterable": true}),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {"sortable": true, "filterable": true}),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {"sortable": true, "filterable": true}),
      f('issue_id', 'issueId', 'fk', '委外发料单', {"filterable": true, "ref": {"resource": "purOutsourcedIssues", "relation": "issue", "labelField": "issueNo"}}),
      f('company_id', 'companyId', 'fk', '公司', {"filterable": true, "ref": {"resource": "basCompanies", "relation": "company", "labelField": "name"}}),
      f('order_item_material_id', 'orderItemMaterialId', 'fk', '发料清单行', {"filterable": true, "ref": {"resource": "purOrderItemMaterials", "relation": "orderItemMaterial", "labelField": "remarks"}}),
      f('material_id', 'materialId', 'fk', '材料(以发料清单行为准)', {"filterable": true, "ref": {"resource": "invMaterials", "relation": "material", "labelField": "name"}}),
      f('unit_id', 'unitId', 'fk', '单位(以发料清单行为准)', {"filterable": true, "ref": {"resource": "basUnits", "relation": "unit", "labelField": "name"}}),
      f('from_warehouse_id', 'fromWarehouseId', 'fk', '调出仓(本公司启用叶子仓)', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "fromWarehouse", "labelField": "name"}}),
      f('outsourced_warehouse_id', 'outsourcedWarehouseId', 'fk', '外协仓(限绑定当前对手)', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "outsourcedWarehouse", "labelField": "name"}}),
      f('issue_no', 'issueNo', 'string', '发料单号', {"sortable": true, "filterable": true}),
      f('issue_date', 'issueDate', 'date', '发料日期', {"sortable": true, "filterable": true}),
      f('issue_status', 'issueStatus', 'enum', '发料单状态', {"sortable": true, "filterable": true, "enumOptions": [{"label": "草稿", "value": "DRAFT"}, {"label": "已审核", "value": "AUDITED"}, {"label": "已作废", "value": "VOIDED"}]}),
      f('party_type', 'partyType', 'enum', '对手类型(供应商/内部公司)', {"sortable": true, "filterable": true, "enumOptions": [{"label": "供应商", "value": "SUPPLIER"}, {"label": "客户", "value": "CUSTOMER"}, {"label": "内部公司", "value": "COMPANY"}, {"label": "员工", "value": "EMPLOYEE"}]}),
      f('party_id', 'partyId', 'fk', '对手', {"filterable": true, "ref": {"resource": null, "relation": null, "labelField": null, "discriminator": "partyType", "discriminatorType": "enum", "variants": [{"label": "内部公司", "labelField": "name", "resource": "basCompanies", "value": "COMPANY"}, {"label": "供应商", "labelField": "name", "resource": "purSuppliers", "value": "SUPPLIER"}]}}),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    // exclude 保留历史审计面：发料单头快照列不进审计 diff
    audit: {
      enabled: true,
      exclude: ['issue_no', 'issue_date', 'issue_status', 'party_type', 'party_id'],
    },

  }
}

export function outsourcedReceiptMeta(): ResourceMeta {
  return {
    name: 'purOutsourcedReceipts',
    classification: { presentation: 'extension', interactive: true },
    permissionPrefix: 'purchase.outsourced_receipt',
    numbering: true,
    permissionLabel: '委外入库单',
    table: 'pur_outsourced_receipt',
    printHead: true,
    fields: [
      f('id', 'id', 'uuid', 'id', {"sortable": true, "readonly": true}),
      f('receipt_no', 'receiptNo', 'string', '入库单号', {"sortable": true, "filterable": true}),
      f('receipt_date', 'receiptDate', 'date', '入库日期(库存分录业务日)', {"sortable": true, "filterable": true}),
      f('posting_date', 'postingDate', 'date', '过账日期(总账;有金额审核时必填)', {"sortable": true, "filterable": true}),
      f('party_type', 'partyType', 'enum', '对手类型(供应商/内部公司,须与所引委外订单一致)', {"sortable": true, "filterable": true, "enumOptions": [{"label": "供应商", "value": "SUPPLIER"}, {"label": "客户", "value": "CUSTOMER"}, {"label": "内部公司", "value": "COMPANY"}, {"label": "员工", "value": "EMPLOYEE"}]}),
      f('party_id', 'partyId', 'fk', '对手', {"filterable": true, "ref": {"resource": null, "relation": null, "labelField": null, "discriminator": "partyType", "discriminatorType": "enum", "variants": [{"label": "内部公司", "labelField": "name", "resource": "basCompanies", "value": "COMPANY"}, {"label": "供应商", "labelField": "name", "resource": "purSuppliers", "value": "SUPPLIER"}]}}),
      f('remarks', 'remarks', 'string', '备注(对内;可带入库存分录)', {"sortable": true, "filterable": true}),
      f('status', 'status', 'enum', '状态', {"sortable": true, "filterable": true, "enumOptions": [{"label": "草稿", "value": "DRAFT"}, {"label": "已审核", "value": "AUDITED"}, {"label": "已作废", "value": "VOIDED"}]}),
      f('audited_at', 'auditedAt', 'datetime', '审核时间', {"sortable": true, "filterable": true}),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {"sortable": true, "filterable": true}),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {"sortable": true, "filterable": true}),
      f('company_id', 'companyId', 'fk', '公司', {"filterable": true, "ref": {"resource": "basCompanies", "relation": "company", "labelField": "name"}}),
      f('warehouse_id', 'warehouseId', 'fk', '默认入仓(可空,成品行/副产物行新建与带出预填)', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "warehouse", "labelField": "name"}}),
      f('outsourced_warehouse_id', 'outsourcedWarehouseId', 'fk', '默认外协仓(可空,材料扣减行带出预填;限绑定当前对手)', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "outsourcedWarehouse", "labelField": "name"}}),
      f('debit_account_id', 'debitAccountId', 'fk', '借方科目(自选:存货/费用等;草稿必填)', {"filterable": true, "ref": {"resource": "basAccounts", "relation": "debitAccount", "labelField": "name"}}),
      f('credit_account_id', 'creditAccountId', 'fk', '贷方科目(未开票应付;草稿必填)', {"filterable": true, "ref": {"resource": "basAccounts", "relation": "creditAccount", "labelField": "name"}}),
      f('created_by_id', 'createdById', 'fk', '录入人', {"filterable": true, "ref": {"resource": "sysUsers", "relation": "createdBy", "labelField": "name"}}),
      f('audited_by_id', 'auditedById', 'fk', '审核人', {"filterable": true, "ref": {"resource": "sysUsers", "relation": "auditedBy", "labelField": "name"}}),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      { key: 'audit', label: '审核', scope: 'row' },
      { key: 'void', label: '作废', scope: 'row', isDanger: true },
    ],
    audit: { enabled: true },

  }
}

export function outsourcedReceiptItemMeta(): ResourceMeta {
  return {
    name: 'purOutsourcedReceiptItems',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'purchase.outsourced_receipt',
    permissionLabel: '委外入库单',
    table: 'pur_outsourced_receipt_item',
    fields: [
      f('id', 'id', 'uuid', 'id', {"sortable": true, "readonly": true}),
      f('idx', 'idx', 'integer', '行号', {"sortable": true, "filterable": true}),
      f('qty', 'qty', 'decimal', '录入数量', {"sortable": true, "filterable": true}),
      f('base_qty', 'baseQty', 'decimal', '折算数量(物料默认单位,6 位)', {"sortable": true, "filterable": true}),
      f('material_code', 'materialCode', 'string', '物料编号', {"sortable": true, "filterable": true}),
      f('material_name', 'materialName', 'string', '物料名称', {"sortable": true, "filterable": true}),
      f('material_spec', 'materialSpec', 'string', '规格', {"sortable": true, "filterable": true}),
      f('customer_part_no', 'customerPartNo', 'string', '客户料号', {"sortable": true, "filterable": true}),
      f('unit_name', 'unitName', 'string', '单位名称', {"sortable": true, "filterable": true}),
      f('order_no', 'orderNo', 'string', '订单号', {"sortable": true, "filterable": true}),
      f('order_qty', 'orderQty', 'decimal', '订购数量(订单行单位)', {"sortable": true, "filterable": true}),
      f('order_base_qty', 'orderBaseQty', 'decimal', '订购数量(默认单位)', {"sortable": true, "filterable": true}),
      f('order_unit_name', 'orderUnitName', 'string', '订单行单位名称', {"sortable": true, "filterable": true}),
      f('order_price', 'orderPrice', 'decimal', '原币含税单价(加工费)', {"sortable": true, "filterable": true}),
      f('order_amount', 'orderAmount', 'decimal', '原币含税金额', {"sortable": true, "filterable": true}),
      f('order_base_price', 'orderBasePrice', 'decimal', '本币含税单价(加工费)', {"sortable": true, "filterable": true}),
      f('order_base_amount', 'orderBaseAmount', 'decimal', '本币含税金额', {"sortable": true, "filterable": true}),
      f('order_tax_rate', 'orderTaxRate', 'decimal', '税率', {"sortable": true, "filterable": true}),
      f('order_currency_code', 'orderCurrencyCode', 'string', '订单原币代码', {"sortable": true, "filterable": true}),
      f('reconciled_qty', 'reconciledQty', 'decimal', '已对账数量(默认单位;由采购对账单生效/回退同步)', {"sortable": true, "filterable": true}),
      f('remarks', 'remarks', 'string', '行备注', {"sortable": true, "filterable": true}),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {"sortable": true, "filterable": true}),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {"sortable": true, "filterable": true}),
      f('receipt_id', 'receiptId', 'fk', '委外入库单', {"filterable": true, "ref": {"resource": "purOutsourcedReceipts", "relation": "receipt", "labelField": "receiptNo"}}),
      f('company_id', 'companyId', 'fk', '公司', {"filterable": true, "ref": {"resource": "basCompanies", "relation": "company", "labelField": "name"}}),
      f('order_item_id', 'orderItemId', 'fk', '委外订单条目', {"filterable": true, "ref": {"resource": "purOrderItems", "relation": "orderItem", "labelField": "materialCode"}}),
      f('material_id', 'materialId', 'fk', '物料(成品,须与订单条目一致)', {"filterable": true, "ref": {"resource": "invMaterials", "relation": "material", "labelField": "name"}}),
      f('unit_id', 'unitId', 'fk', '单位', {"filterable": true, "ref": {"resource": "basUnits", "relation": "unit", "labelField": "name"}}),
      f('warehouse_id', 'warehouseId', 'fk', '入库仓库', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "warehouse", "labelField": "name"}}),
      f('receipt_no', 'receiptNo', 'string', '入库单号', {"sortable": true, "filterable": true}),
      f('receipt_date', 'receiptDate', 'date', '入库日期', {"sortable": true, "filterable": true}),
      f('receipt_status', 'receiptStatus', 'enum', '入库单状态', {"sortable": true, "filterable": true, "enumOptions": [{"label": "草稿", "value": "DRAFT"}, {"label": "已审核", "value": "AUDITED"}, {"label": "已作废", "value": "VOIDED"}]}),
      f('party_type', 'partyType', 'enum', '对手类型(供应商/内部公司)', {"sortable": true, "filterable": true, "enumOptions": [{"label": "供应商", "value": "SUPPLIER"}, {"label": "客户", "value": "CUSTOMER"}, {"label": "内部公司", "value": "COMPANY"}, {"label": "员工", "value": "EMPLOYEE"}]}),
      f('party_id', 'partyId', 'fk', '对手', {"filterable": true, "ref": {"resource": null, "relation": null, "labelField": null, "discriminator": "partyType", "discriminatorType": "enum", "variants": [{"label": "内部公司", "labelField": "name", "resource": "basCompanies", "value": "COMPANY"}, {"label": "供应商", "labelField": "name", "resource": "purSuppliers", "value": "SUPPLIER"}]}}),
      f('remaining_reconcilable_qty', 'remainingReconcilableQty', 'decimal', '剩余可对账量(默认单位)', {"sortable": true, "filterable": true}),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    // exclude 保留历史审计面：入库单头快照列与对账派生量不进审计 diff
    audit: {
      enabled: true,
      exclude: [
        'receipt_no',
        'receipt_date',
        'receipt_status',
        'party_type',
        'party_id',
        'remaining_reconcilable_qty',
      ],
    },

  }
}

export function outsourcedReceiptItemMaterialMeta(): ResourceMeta {
  return {
    name: 'purOutsourcedReceiptItemMaterials',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'purchase.outsourced_receipt',
    permissionLabel: '委外入库单',
    table: 'pur_outsourced_receipt_item_material',
    fields: [
      f('id', 'id', 'uuid', 'id', {"sortable": true, "readonly": true}),
      f('idx', 'idx', 'integer', '行号', {"sortable": true, "filterable": true}),
      f('qty', 'qty', 'decimal', '扣减数量', {"sortable": true, "filterable": true}),
      f('base_qty', 'baseQty', 'decimal', '折算数量(材料默认单位,6 位)', {"sortable": true, "filterable": true}),
      f('material_code', 'materialCode', 'string', '物料编号', {"sortable": true, "filterable": true}),
      f('material_name', 'materialName', 'string', '物料名称', {"sortable": true, "filterable": true}),
      f('material_spec', 'materialSpec', 'string', '规格', {"sortable": true, "filterable": true}),
      f('unit_name', 'unitName', 'string', '单位名称', {"sortable": true, "filterable": true}),
      f('order_no', 'orderNo', 'string', '订单号', {"sortable": true, "filterable": true}),
      f('remarks', 'remarks', 'string', '行备注', {"sortable": true, "filterable": true}),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {"sortable": true, "filterable": true}),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {"sortable": true, "filterable": true}),
      f('receipt_item_id', 'receiptItemId', 'fk', '入库条目', {"filterable": true, "ref": {"resource": "purOutsourcedReceiptItems", "relation": "receiptItem", "labelField": "materialCode"}}),
      f('company_id', 'companyId', 'fk', '公司', {"filterable": true, "ref": {"resource": "basCompanies", "relation": "company", "labelField": "name"}}),
      f('order_item_material_id', 'orderItemMaterialId', 'fk', '发料清单行', {"filterable": true, "ref": {"resource": "purOrderItemMaterials", "relation": "orderItemMaterial", "labelField": "remarks"}}),
      f('material_id', 'materialId', 'fk', '材料(以发料清单行为准)', {"filterable": true, "ref": {"resource": "invMaterials", "relation": "material", "labelField": "name"}}),
      f('unit_id', 'unitId', 'fk', '单位(以发料清单行为准)', {"filterable": true, "ref": {"resource": "basUnits", "relation": "unit", "labelField": "name"}}),
      f('outsourced_warehouse_id', 'outsourcedWarehouseId', 'fk', '外协仓(可空,审核前必填;限绑定母单对手)', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "outsourcedWarehouse", "labelField": "name"}}),
      f('receipt_no', 'receiptNo', 'string', '入库单号', {"sortable": true, "filterable": true}),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    // exclude 保留历史审计面：头快照列不进审计 diff
    audit: { enabled: true, exclude: ['receipt_no'] },

  }
}

export function outsourcedReceiptItemByproductMeta(): ResourceMeta {
  return {
    name: 'purOutsourcedReceiptItemByproducts',
    classification: { presentation: 'none', interactive: false },
    permissionPrefix: 'purchase.outsourced_receipt',
    permissionLabel: '委外入库单',
    table: 'pur_outsourced_receipt_item_byproduct',
    fields: [
      f('id', 'id', 'uuid', 'id', {"sortable": true, "readonly": true}),
      f('idx', 'idx', 'integer', '行号', {"sortable": true, "filterable": true}),
      f('qty', 'qty', 'decimal', '入库数量', {"sortable": true, "filterable": true}),
      f('base_qty', 'baseQty', 'decimal', '折算数量(物料默认单位,6 位)', {"sortable": true, "filterable": true}),
      f('material_code', 'materialCode', 'string', '物料编号', {"sortable": true, "filterable": true}),
      f('material_name', 'materialName', 'string', '物料名称', {"sortable": true, "filterable": true}),
      f('material_spec', 'materialSpec', 'string', '规格', {"sortable": true, "filterable": true}),
      f('unit_name', 'unitName', 'string', '单位名称', {"sortable": true, "filterable": true}),
      f('order_no', 'orderNo', 'string', '订单号', {"sortable": true, "filterable": true}),
      f('remarks', 'remarks', 'string', '行备注', {"sortable": true, "filterable": true}),
      f('inserted_at', 'insertedAt', 'datetime', '创建时间', {"sortable": true, "filterable": true}),
      f('updated_at', 'updatedAt', 'datetime', '更新时间', {"sortable": true, "filterable": true}),
      f('receipt_item_id', 'receiptItemId', 'fk', '入库条目', {"filterable": true, "ref": {"resource": "purOutsourcedReceiptItems", "relation": "receiptItem", "labelField": "materialCode"}}),
      f('company_id', 'companyId', 'fk', '公司', {"filterable": true, "ref": {"resource": "basCompanies", "relation": "company", "labelField": "name"}}),
      f('order_item_byproduct_id', 'orderItemByproductId', 'fk', '副产物清单行', {"filterable": true, "ref": {"resource": "purOrderItemByproducts", "relation": "orderItemByproduct", "labelField": "remarks"}}),
      f('material_id', 'materialId', 'fk', '物料(以副产物清单行为准)', {"filterable": true, "ref": {"resource": "invMaterials", "relation": "material", "labelField": "name"}}),
      f('unit_id', 'unitId', 'fk', '单位(以副产物清单行为准)', {"filterable": true, "ref": {"resource": "basUnits", "relation": "unit", "labelField": "name"}}),
      f('warehouse_id', 'warehouseId', 'fk', '入仓(可空,审核前必填;本公司启用叶子仓)', {"filterable": true, "ref": {"resource": "invWarehouses", "relation": "warehouse", "labelField": "name"}}),
      f('receipt_no', 'receiptNo', 'string', '入库单号', {"sortable": true, "filterable": true}),
    ],
    actions: [{ key: 'read', label: '查看', scope: 'both' }],
    // exclude 保留历史审计面：头快照列不进审计 diff
    audit: { enabled: true, exclude: ['receipt_no'] },

  }
}
