/**
 * 资源事实清单（Resource Manifest）——由 server/scripts/generate-resource-manifest.ts
 * 从 sealed Registry 派生（ADR 2026-08-07-resource-manifest）。禁止手改：
 * 改 server meta 后重跑 bun run -F @synie/server gen:manifest；漂移测试对拍兜底。
 */
import type { ResourceManifest } from '../resource-manifest.ts'

export const RESOURCE_MANIFEST: ResourceManifest = {
  "accBankAccounts": {
    "label": "银行账户",
    "lookup": {
      "labelField": "alias",
      "searchFields": [
        "alias",
        "bankName",
        "branchName",
        "holderName",
        "accountNo",
        "note"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accBankImportItems": {
    "label": "银行流水",
    "lookup": {
      "labelField": "counterpartyName",
      "searchFields": [
        "counterpartyName",
        "counterpartyAccount",
        "summary",
        "note",
        "error"
      ]
    },
    "wire": {
      "decimal": [
        "income",
        "expense",
        "balance"
      ],
      "date": [
        "occurredAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accBankImports": {
    "label": "银行流水",
    "lookup": {
      "labelField": "error",
      "searchFields": [
        "error"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "importedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accBankImportTemplates": {
    "label": "流水导入模板",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "datetimeCol",
        "dateCol",
        "timeCol",
        "incomeCol",
        "expenseCol",
        "amountCol",
        "balanceCol",
        "counterpartyNameCol",
        "counterpartyAccountCol",
        "summaryCol",
        "noteCol"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accBankReconciliations": {
    "label": "银行流水",
    "lookup": {
      "labelField": "id",
      "searchFields": [
        "id"
      ]
    },
    "wire": {
      "decimal": [
        "amount"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accBankTransactions": {
    "label": "银行流水",
    "lookup": {
      "labelField": "counterpartyName",
      "searchFields": [
        "counterpartyName",
        "counterpartyAccount",
        "summary",
        "note"
      ]
    },
    "wire": {
      "decimal": [
        "income",
        "expense",
        "balance",
        "reconciledAmount",
        "unreconciledAmount"
      ],
      "date": [
        "occurredAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accBillHoldings": {
    "label": "持有承兑",
    "lookup": {
      "labelField": "billNo",
      "searchFields": [
        "billNo"
      ]
    },
    "wire": {
      "decimal": [
        "amount"
      ],
      "date": [
        "dueDate",
        "acquiredOn",
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "accBills": {
    "label": "承兑票据",
    "lookup": {
      "labelField": "billNo",
      "searchFields": [
        "billNo",
        "drawerName",
        "drawerAccount",
        "drawerBankName",
        "drawerBankNo",
        "payeeName",
        "payeeAccount",
        "payeeBankName",
        "payeeBankNo",
        "acceptorName",
        "acceptorAccount",
        "acceptorBankName",
        "acceptorBankNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "faceAmount"
      ],
      "date": [
        "issueDate",
        "dueDate",
        "acceptanceDate",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accBillTransactions": {
    "label": "承兑交易",
    "lookup": {
      "labelField": "docNo",
      "searchFields": [
        "docNo",
        "discountOrg",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "amount",
        "discountRate",
        "interest",
        "netAmount"
      ],
      "date": [
        "occurredOn",
        "postingDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accExpenseReportItems": {
    "label": "费用报销单",
    "lookup": {
      "labelField": "summary",
      "searchFields": [
        "summary",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "amount"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accExpenseReports": {
    "label": "费用报销单",
    "lookup": {
      "labelField": "docNo",
      "searchFields": [
        "docNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "expenseDate",
        "postingDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accGlEntries": {
    "label": "总账分录",
    "lookup": {
      "labelField": "voucherType",
      "searchFields": [
        "voucherType",
        "voucherNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "debit",
        "credit"
      ],
      "date": [
        "postingDate",
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "accGlJournalLines": {
    "label": "会计凭证",
    "lookup": {
      "labelField": "remarks",
      "searchFields": [
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "debit",
        "credit"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": [
        "debit",
        "credit"
      ]
    }
  },
  "accGlJournals": {
    "label": "会计凭证",
    "lookup": {
      "labelField": "voucherNo",
      "searchFields": [
        "voucherNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "debitTotal",
        "creditTotal"
      ],
      "date": [
        "date",
        "postingDate",
        "submittedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accSettings": {
    "label": "财务设置",
    "lookup": {
      "labelField": "ocrAccessKeyId",
      "searchFields": [
        "ocrAccessKeyId"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "accVatInvoices": {
    "label": "增值税发票",
    "lookup": {
      "labelField": "docNo",
      "searchFields": [
        "docNo",
        "invoiceCode",
        "invoiceNo",
        "sellerName",
        "sellerTaxNo",
        "buyerName",
        "buyerTaxNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "netTotal",
        "taxTotal",
        "grossTotal"
      ],
      "date": [
        "invoiceDate",
        "postingDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "basAccounts": {
    "label": "会计科目",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "basCompanies": {
    "label": "公司",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name",
        "shortName"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [],
      "decimalZero": []
    }
  },
  "basCurrencies": {
    "label": "货币",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "isoCode"
      ],
      "subtitleFields": [
        "isoCode"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "basMarketInstruments": {
    "label": "行情品种",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name",
        "externalLastCode",
        "externalProductGroup",
        "note"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "basMarketPricePoints": {
    "label": "行情价点",
    "lookup": {
      "labelField": "note",
      "searchFields": [
        "note"
      ]
    },
    "wire": {
      "decimal": [
        "price"
      ],
      "date": [
        "observedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "basPartyAddresses": {
    "label": "地址",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "contactName",
        "contactPhone",
        "province",
        "city",
        "district",
        "address"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "basUnits": {
    "label": "单位",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "symbol"
      ],
      "subtitleFields": [
        "symbol"
      ]
    },
    "wire": {
      "decimal": [
        "ratio"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "hrAttendanceCorrections": {
    "label": "补卡单",
    "lookup": {
      "labelField": "times",
      "searchFields": [
        "note"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "date",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "hrAttendanceDays": {
    "label": "日考勤",
    "lookup": {
      "labelField": "morningIn",
      "searchFields": [
        "morningIn"
      ]
    },
    "wire": {
      "decimal": [
        "normalHours",
        "overtimeHours",
        "bonusWorkday"
      ],
      "date": [
        "date",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "hrAttendanceImports": {
    "label": "打卡记录",
    "lookup": {
      "labelField": "error",
      "searchFields": [
        "error",
        "unmatchedDetail"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "importedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "hrAttendancePunches": {
    "label": "打卡记录",
    "lookup": {
      "labelField": "attendanceNo",
      "searchFields": [
        "attendanceNo"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "punchedAt",
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "hrEmployeeLoans": {
    "label": "员工借款",
    "lookup": {
      "labelField": "occurredOn",
      "searchFields": [
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "amount"
      ],
      "date": [
        "occurredOn",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "hrEmployees": {
    "label": "员工",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "code",
        "attendanceNo"
      ],
      "subtitleFields": [
        "code",
        "attendanceNo"
      ]
    },
    "wire": {
      "decimal": [
        "dailyWage",
        "monthlyAllowance"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "hrPayrollPayments": {
    "label": "工资发放",
    "lookup": {
      "labelField": "month",
      "searchFields": [
        "month",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "amount"
      ],
      "date": [
        "paidOn",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "hrPayrolls": {
    "label": "工资单",
    "lookup": {
      "labelField": "month",
      "searchFields": [
        "month",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "workdays",
        "overtimeHours",
        "dailyWage",
        "baseAmount",
        "allowance",
        "bonus",
        "fine",
        "loanDeduction",
        "payable",
        "paidTotal"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invMaterialCategories": {
    "label": "物料分类",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "code"
      ],
      "subtitleFields": [
        "code"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invMaterials": {
    "label": "物料",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "code",
        "spec"
      ],
      "subtitleFields": [
        "code",
        "spec"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invMaterialUnits": {
    "label": "物料",
    "lookup": {
      "labelField": "id",
      "searchFields": [
        "id"
      ]
    },
    "wire": {
      "decimal": [
        "factor"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invStockCountItems": {
    "label": "库存盘点单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName",
        "remark"
      ]
    },
    "wire": {
      "decimal": [
        "countedQuantity",
        "convertedCounted",
        "bookQuantity"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invStockCounts": {
    "label": "库存盘点单",
    "lookup": {
      "labelField": "docNo",
      "searchFields": [
        "docNo",
        "summary",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "postingDate",
        "auditedAt",
        "snapshotTakenAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invStockDocItems": {
    "label": "手工出入库单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName",
        "remark"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invStockDocs": {
    "label": "手工出入库单",
    "lookup": {
      "labelField": "docNo",
      "searchFields": [
        "docNo",
        "summary",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "docDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invStockEntries": {
    "label": "库存分录",
    "lookup": {
      "labelField": "voucherType",
      "searchFields": [
        "voucherType",
        "voucherNo",
        "remarks",
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo"
      ]
    },
    "wire": {
      "decimal": [
        "quantity"
      ],
      "date": [
        "postingDate",
        "cancelledAt",
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "invStockTransferItems": {
    "label": "手工调拨单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName",
        "remark"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "receivedQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invStockTransfers": {
    "label": "手工调拨单",
    "lookup": {
      "labelField": "docNo",
      "searchFields": [
        "docNo",
        "summary",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "docDate",
        "shippedAt",
        "receivedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "invWarehouses": {
    "label": "仓库",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgBomByproducts": {
    "label": "BOM行",
    "lookup": {
      "labelField": "note",
      "searchFields": [
        "note",
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo"
      ]
    },
    "wire": {
      "decimal": [
        "quantity"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgBomComponents": {
    "label": "BOM行",
    "lookup": {
      "labelField": "note",
      "searchFields": [
        "note",
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo"
      ]
    },
    "wire": {
      "decimal": [
        "quantity",
        "lossRate"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgBomRoutes": {
    "label": "工艺路线行",
    "lookup": {
      "labelField": "requirement",
      "searchFields": [
        "requirement"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgBoms": {
    "label": "BOM",
    "lookup": {
      "labelField": "code",
      "searchFields": [
        "code",
        "planName",
        "note",
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgDemandItems": {
    "label": "需求行",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "orderedQty",
        "receivedQty",
        "arrangedQty",
        "completedQty",
        "remainingOrderableQty",
        "remainingArrangeableQty"
      ],
      "date": [
        "needDate",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgDemands": {
    "label": "履约需求单",
    "lookup": {
      "labelField": "demandNo",
      "searchFields": [
        "demandNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "demandDate",
        "needDate",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgMoldDesigns": {
    "label": "模具设计",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgOperations": {
    "label": "工序",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name",
        "note"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgOutputItems": {
    "label": "生产入库行",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName",
        "remarks",
        "outputNo"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "outputDate"
      ],
      "decimalZero": []
    }
  },
  "mfgOutputs": {
    "label": "生产入库单",
    "lookup": {
      "labelField": "outputNo",
      "searchFields": [
        "outputNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "outputDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgProcessTemplateItems": {
    "label": "工艺模板行",
    "lookup": {
      "labelField": "requirement",
      "searchFields": [
        "requirement"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgProcessTemplates": {
    "label": "工艺模板",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name",
        "note"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgSettings": {
    "label": "生产设置",
    "lookup": {
      "labelField": "id",
      "searchFields": [
        "id"
      ]
    },
    "wire": {
      "decimal": [
        "outputOverreceiveRatio"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "mfgWorkOrderByproducts": {
    "label": "生产工单",
    "lookup": {
      "labelField": "note",
      "searchFields": [
        "note"
      ]
    },
    "wire": {
      "decimal": [
        "quantity"
      ],
      "date": [],
      "decimalZero": []
    }
  },
  "mfgWorkOrderComponents": {
    "label": "生产工单",
    "lookup": {
      "labelField": "note",
      "searchFields": [
        "note"
      ]
    },
    "wire": {
      "decimal": [
        "quantity",
        "lossRate"
      ],
      "date": [],
      "decimalZero": []
    }
  },
  "mfgWorkOrderRoutes": {
    "label": "生产工单",
    "lookup": {
      "labelField": "requirement",
      "searchFields": [
        "requirement"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [],
      "decimalZero": []
    }
  },
  "mfgWorkOrders": {
    "label": "生产工单",
    "lookup": {
      "labelField": "workOrderNo",
      "searchFields": [
        "workOrderNo",
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "receivedBaseQty",
        "remainingBaseQty"
      ],
      "date": [
        "needDate",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purOrderItemByproducts": {
    "label": "采购订单",
    "lookup": {
      "labelField": "remarks",
      "searchFields": [
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "quantity"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purOrderItemMaterials": {
    "label": "采购订单",
    "lookup": {
      "labelField": "remarks",
      "searchFields": [
        "remarks",
        "orderNo"
      ]
    },
    "wire": {
      "decimal": [
        "quantity",
        "issuedQty",
        "remainingIssueQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purOrderItems": {
    "label": "采购订单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName",
        "remarks",
        "currencyCode"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "receivedQty",
        "price",
        "amount",
        "basePrice",
        "baseAmount",
        "taxRate",
        "remainingBaseQty"
      ],
      "date": [
        "demandDate",
        "insertedAt",
        "updatedAt",
        "orderDate"
      ],
      "decimalZero": []
    }
  },
  "purOrders": {
    "label": "采购订单",
    "lookup": {
      "labelField": "orderNo",
      "searchFields": [
        "orderNo",
        "terms",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "exchangeRate",
        "grossTotal",
        "baseGrossTotal"
      ],
      "date": [
        "orderDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purOutsourcedIssueItems": {
    "label": "委外发料行",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName",
        "orderNo",
        "remarks",
        "issueNo"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "issueDate"
      ],
      "decimalZero": []
    }
  },
  "purOutsourcedIssues": {
    "label": "委外发料单",
    "lookup": {
      "labelField": "issueNo",
      "searchFields": [
        "issueNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "issueDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purOutsourcedReceiptItemByproducts": {
    "label": "委外入库副产物行",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName",
        "orderNo",
        "remarks",
        "receiptNo"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purOutsourcedReceiptItemMaterials": {
    "label": "委外入库材料行",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "unitName",
        "orderNo",
        "remarks",
        "receiptNo"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purOutsourcedReceiptItems": {
    "label": "委外入库成品行",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName",
        "orderNo",
        "orderUnitName",
        "orderCurrencyCode",
        "remarks",
        "receiptNo"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "orderQty",
        "orderBaseQty",
        "orderPrice",
        "orderAmount",
        "orderBasePrice",
        "orderBaseAmount",
        "orderTaxRate",
        "reconciledQty",
        "remainingReconcilableQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "receiptDate"
      ],
      "decimalZero": []
    }
  },
  "purOutsourcedReceipts": {
    "label": "委外入库单",
    "lookup": {
      "labelField": "receiptNo",
      "searchFields": [
        "receiptNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "receiptDate",
        "postingDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purQuotationItems": {
    "label": "采购报价单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName",
        "remarks",
        "currencyCode"
      ]
    },
    "wire": {
      "decimal": [
        "price",
        "taxRate"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "quotationDate",
        "validUntil"
      ],
      "decimalZero": []
    }
  },
  "purQuotations": {
    "label": "采购报价单",
    "lookup": {
      "labelField": "quotationNo",
      "searchFields": [
        "quotationNo",
        "terms",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "quotationDate",
        "validUntil",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purQuotationTiers": {
    "label": "采购报价单",
    "lookup": {
      "labelField": "id",
      "searchFields": [
        "id"
      ]
    },
    "wire": {
      "decimal": [
        "minQty",
        "price"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purReceiptItems": {
    "label": "采购入库单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName",
        "orderNo",
        "orderUnitName",
        "orderCurrencyCode",
        "remarks",
        "receiptNo"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "orderQty",
        "orderBaseQty",
        "orderPrice",
        "orderAmount",
        "orderBasePrice",
        "orderBaseAmount",
        "orderTaxRate",
        "reconciledQty",
        "remainingReconcilableQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "receiptDate"
      ],
      "decimalZero": []
    }
  },
  "purReceipts": {
    "label": "采购入库单",
    "lookup": {
      "labelField": "receiptNo",
      "searchFields": [
        "receiptNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "receiptDate",
        "postingDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purReconciliationItems": {
    "label": "采购对账单",
    "lookup": {
      "labelField": "remarks",
      "searchFields": [
        "remarks",
        "reconciliationNo",
        "receiptNo",
        "materialName",
        "unitName",
        "orderCurrencyCode"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "amount",
        "baseAmount"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "receiptDate"
      ],
      "decimalZero": []
    }
  },
  "purReconciliations": {
    "label": "采购对账单",
    "lookup": {
      "labelField": "reconciliationNo",
      "searchFields": [
        "reconciliationNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "grossTotal",
        "baseGrossTotal"
      ],
      "date": [
        "postingDate",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "purSuppliers": {
    "label": "供应商",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name",
        "shortName"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salCompanyAccountDefaults": {
    "label": "公司默认过账科目",
    "lookup": {
      "labelField": "companyId",
      "searchFields": [
        "id"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salCustomers": {
    "label": "客户",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name",
        "shortName"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salDeliveries": {
    "label": "销售发货单",
    "lookup": {
      "labelField": "deliveryNo",
      "searchFields": [
        "deliveryNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "deliveryDate",
        "postingDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salDeliveryItems": {
    "label": "销售发货单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName",
        "orderNo",
        "orderUnitName",
        "orderCurrencyCode",
        "remarks",
        "deliveryNo"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "orderQty",
        "orderBaseQty",
        "orderPrice",
        "orderAmount",
        "orderBasePrice",
        "orderBaseAmount",
        "orderTaxRate",
        "reconciledQty",
        "remainingReconcilableQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "deliveryDate"
      ],
      "decimalZero": []
    }
  },
  "salDeliveryPackBoxes": {
    "label": "装箱箱",
    "lookup": {
      "labelField": "id",
      "searchFields": [
        "id"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salDeliveryPackLines": {
    "label": "装箱行",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salOrderItems": {
    "label": "销售订单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName",
        "remarks",
        "currencyCode"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "shippedQty",
        "price",
        "amount",
        "basePrice",
        "baseAmount",
        "taxRate",
        "remainingBaseQty"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "orderDate"
      ],
      "decimalZero": []
    }
  },
  "salOrders": {
    "label": "销售订单",
    "lookup": {
      "labelField": "orderNo",
      "searchFields": [
        "orderNo",
        "terms",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "exchangeRate",
        "grossTotal",
        "baseGrossTotal"
      ],
      "date": [
        "orderDate",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salQuotationItems": {
    "label": "销售报价单",
    "lookup": {
      "labelField": "materialCode",
      "searchFields": [
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName",
        "remarks",
        "currencyCode"
      ]
    },
    "wire": {
      "decimal": [
        "price",
        "taxRate"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "quotationDate",
        "validUntil"
      ],
      "decimalZero": []
    }
  },
  "salQuotations": {
    "label": "销售报价单",
    "lookup": {
      "labelField": "quotationNo",
      "searchFields": [
        "quotationNo",
        "terms",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "quotationDate",
        "validUntil",
        "auditedAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salQuotationTiers": {
    "label": "销售报价单",
    "lookup": {
      "labelField": "id",
      "searchFields": [
        "id"
      ]
    },
    "wire": {
      "decimal": [
        "minQty",
        "price"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salReconciliationItems": {
    "label": "销售对账单",
    "lookup": {
      "labelField": "remarks",
      "searchFields": [
        "remarks",
        "reconciliationNo",
        "deliveryNo",
        "materialName",
        "unitName",
        "orderCurrencyCode"
      ]
    },
    "wire": {
      "decimal": [
        "qty",
        "baseQty",
        "amount",
        "baseAmount"
      ],
      "date": [
        "insertedAt",
        "updatedAt",
        "deliveryDate"
      ],
      "decimalZero": []
    }
  },
  "salReconciliations": {
    "label": "销售对账单",
    "lookup": {
      "labelField": "reconciliationNo",
      "searchFields": [
        "reconciliationNo",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [
        "grossTotal",
        "baseGrossTotal"
      ],
      "date": [
        "postingDate",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "salSettings": {
    "label": "供应链设置",
    "lookup": {
      "labelField": "id",
      "searchFields": [
        "id"
      ]
    },
    "wire": {
      "decimal": [
        "deliveryOvershipRatio",
        "receiptOverreceiveRatio",
        "demandOverorderRatio"
      ],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "scmOrderFlowItems": {
    "label": "订单收发货历史",
    "lookup": {
      "labelField": "id",
      "searchFields": [
        "id",
        "voucherNo",
        "materialCode",
        "materialName",
        "materialSpec",
        "customerPartNo",
        "unitName"
      ]
    },
    "wire": {
      "decimal": [
        "qty"
      ],
      "date": [
        "voucherDate"
      ],
      "decimalZero": []
    }
  },
  "sysAttachments": {
    "label": "附件",
    "lookup": {
      "labelField": "category",
      "searchFields": [
        "ownerType",
        "category"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "sysAuditLogs": {
    "label": "审计日志",
    "lookup": {
      "labelField": "resource",
      "searchFields": [
        "resource",
        "recordLabel",
        "actionType",
        "actionName",
        "actorName"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "sysDepartments": {
    "label": "部门",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "code"
      ],
      "subtitleFields": [
        "code"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "sysFiles": {
    "label": "附件",
    "lookup": {
      "labelField": "storage",
      "searchFields": [
        "storage",
        "key",
        "filename",
        "contentType",
        "sha256"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "sysNumberingCounters": {
    "label": "编号规则",
    "lookup": {
      "labelField": "scopeKey",
      "searchFields": [
        "scopeKey"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "sysNumberingRules": {
    "label": "编号规则",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "resource",
        "name"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "sysPrintTemplates": {
    "label": "打印模板",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "resource",
        "remarks"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "sysRoleMenus": {
    "label": "角色菜单",
    "lookup": {
      "labelField": "menuCode",
      "searchFields": [
        "menuCode"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "sysRolePermissions": {
    "label": "角色权限",
    "lookup": {
      "labelField": "permission",
      "searchFields": [
        "permission"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt"
      ],
      "decimalZero": []
    }
  },
  "sysRoles": {
    "label": "角色",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "code",
        "name"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "sysSettings": {
    "label": "系统设置",
    "lookup": {
      "labelField": "marketFetchLastSummary",
      "searchFields": [
        "marketFetchLastSummary",
        "fileReconLastSummary"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "marketFetchLastRunAt",
        "fileReconLastRunAt",
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "sysStorages": {
    "label": "存储接入",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "name",
        "label",
        "root",
        "endpoint",
        "region",
        "bucket",
        "prefix",
        "accessKeyId"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  },
  "sysUsers": {
    "label": "用户",
    "lookup": {
      "labelField": "name",
      "searchFields": [
        "username",
        "name",
        "email",
        "preferredLanguage"
      ]
    },
    "wire": {
      "decimal": [],
      "date": [
        "insertedAt",
        "updatedAt"
      ],
      "decimalZero": []
    }
  }
}
