import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

function closureRecordTable() {
  return defineTable({
    resource: v.string(),
    companyId: v.union(v.string(), v.null()),
    parentId: v.union(v.string(), v.null()),
    status: v.union(v.string(), v.null()),
    sortKey: v.string(),
    searchText: v.string(),
    /** Decimal facts are stored as scaled int64; `data` only contains non-decimal wire fields. */
    decimalValues: v.optional(v.any()),
    /** Domain-private aggregate metadata (for example a stock-count revision witness). */
    internalState: v.optional(v.any()),
    data: v.any(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_resource_sort', ['resource', 'sortKey'])
    .index('by_resource_company_sort', ['resource', 'companyId', 'sortKey'])
    .index('by_resource_company_status_sort', ['resource', 'companyId', 'status', 'sortKey'])
    .index('by_resource_parent_sort', ['resource', 'parentId', 'sortKey'])
    .index('by_resource_status_sort', ['resource', 'status', 'sortKey'])
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['resource', 'companyId', 'status'],
    })
}

export default defineSchema({
  /** Closure-owned record stores; business writes still enter explicit domain policies/commands. */
  masterRecords: closureRecordTable(),
  accountingDocuments: closureRecordTable(),
  inventoryDocuments: closureRecordTable(),
  tradingDocuments: closureRecordTable(),
  financeDocuments: closureRecordTable(),
  manufacturingDocuments: closureRecordTable(),
  hrDocuments: closureRecordTable(),
  marketTodoRecords: closureRecordTable(),

  /** Indexed market decisions; closure records remain the Catalog-facing source. */
  marketInstrumentIndex: defineTable({
    recordId: v.string(),
    code: v.string(),
    active: v.boolean(),
    fetchEnabled: v.boolean(),
    defaultPriceKind: v.union(
      v.literal('SETTLEMENT'),
      v.literal('AVERAGE'),
      v.literal('LAST'),
    ),
    currencyId: v.string(),
    unitId: v.string(),
  })
    .index('by_record', ['recordId'])
    .index('by_active_code', ['active', 'code'])
    .index('by_fetch_code', ['fetchEnabled', 'code']),

  marketPriceIndex: defineTable({
    recordId: v.string(),
    instrumentId: v.string(),
    observedAt: v.number(),
    priceKind: v.union(
      v.literal('SETTLEMENT'),
      v.literal('AVERAGE'),
      v.literal('LAST'),
    ),
    source: v.union(v.literal('MANUAL'), v.literal('FETCH')),
    active: v.boolean(),
  })
    .index('by_record', ['recordId'])
    .index('by_instrument', ['instrumentId', 'recordId'])
    .index('by_active_unique', ['active', 'instrumentId', 'observedAt', 'priceKind', 'source'])
    .index('by_instrument_kind_active_time', ['instrumentId', 'priceKind', 'active', 'observedAt']),

  /** Todo is a cross-domain projection, not a public generic Catalog resource. */
  todos: defineTable({
    type: v.union(v.literal('ISSUE_INVOICE'), v.literal('RECEIVE_INVOICE')),
    sourceType: v.union(v.literal('sales.reconciliation'), v.literal('purchase.reconciliation')),
    sourceId: v.string(),
    sourceNo: v.string(),
    partyType: v.string(),
    partyId: v.string(),
    amountScaled: v.int64(),
    status: v.union(v.literal('ACTIVE'), v.literal('CLOSED')),
    closedReason: v.union(v.literal('UNCONFIRM'), v.literal('INVOICE_AUDIT'), v.null()),
    sourceChangedAt: v.number(),
    closedAt: v.union(v.number(), v.null()),
    companyId: v.string(),
    createdById: v.union(v.id('appUsers'), v.null()),
    orderKey: v.string(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_source_status', ['sourceType', 'sourceId', 'status'])
    .index('by_status_order', ['status', 'orderKey'])
    .index('by_company_status_order', ['companyId', 'status', 'orderKey']),

  todoStates: defineTable({
    todoId: v.id('todos'),
    userId: v.id('appUsers'),
    readAt: v.union(v.number(), v.null()),
    dismissedAt: v.union(v.number(), v.null()),
    resetBasisAt: v.union(v.number(), v.null()),
    updatedAt: v.number(),
  })
    .index('by_todo_user', ['todoId', 'userId'])
    .index('by_user', ['userId']),

  /** Immutable product-file metadata; bytes live in the private product S3 bucket. */
  files: defineTable({
    objectKey: v.string(),
    filename: v.string(),
    contentType: v.union(v.string(), v.null()),
    size: v.number(),
    sha256: v.string(),
    uploadedById: v.id('appUsers'),
    status: v.union(v.literal('ready'), v.literal('deleting')),
    insertedAt: v.number(),
  })
    .index('by_time', ['insertedAt'])
    .index('by_uploader_time', ['uploadedById', 'insertedAt'])
    .index('by_object_key', ['objectKey']),

  attachments: defineTable({
    fileId: v.id('files'),
    ownerType: v.string(),
    ownerId: v.string(),
    category: v.string(),
    companyId: v.union(v.string(), v.null()),
    insertedAt: v.number(),
  })
    .index('by_owner', ['ownerType', 'ownerId', 'insertedAt'])
    .index('by_owner_category', ['ownerType', 'ownerId', 'category', 'insertedAt'])
    .index('by_file', ['fileId', 'insertedAt']),

  uploadIntents: defineTable({
    objectKey: v.string(),
    /** Final immutable key. Optional only for intents created before the prefix split. */
    finalObjectKey: v.optional(v.string()),
    filename: v.string(),
    contentType: v.string(),
    size: v.number(),
    sha256: v.string(),
    uploadedById: v.id('appUsers'),
    ownerType: v.union(v.string(), v.null()),
    ownerId: v.union(v.string(), v.null()),
    category: v.string(),
    companyId: v.union(v.string(), v.null()),
    status: v.union(v.literal('pending'), v.literal('finalized'), v.literal('failed')),
    fileId: v.optional(v.id('files')),
    failureCode: v.optional(v.string()),
    expiresAt: v.number(),
    insertedAt: v.number(),
  })
    .index('by_uploader_status', ['uploadedById', 'status', 'insertedAt'])
    .index('by_status_expiry', ['status', 'expiresAt']),

  fileDeleteJobs: defineTable({
    fileId: v.id('files'),
    objectKey: v.string(),
    requestedById: v.id('appUsers'),
    status: v.union(v.literal('pending'), v.literal('failed')),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    nextAttemptAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index('by_file', ['fileId'])
    .index('by_status_next', ['status', 'nextAttemptAt']),

  s3ReconciliationRuns: defineTable({
    status: v.union(v.literal('running'), v.literal('succeeded'), v.literal('failed')),
    metadataCount: v.number(),
    objectCount: v.number(),
    missingObjectKeys: v.array(v.string()),
    orphanObjectKeys: v.array(v.string()),
    checksumMismatchFileIds: v.array(v.string()),
    truncated: v.boolean(),
    error: v.union(v.string(), v.null()),
    startedAt: v.number(),
    completedAt: v.union(v.number(), v.null()),
  }).index('by_started', ['startedAt']),

  /** Printing metadata only; template and generated bytes remain in private product S3. */
  printTemplates: defineTable({
    name: v.string(),
    resource: v.union(v.literal('sales.order'), v.literal('mfg.work_order')),
    isDefault: v.boolean(),
    remarks: v.union(v.string(), v.null()),
    fileId: v.id('files'),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_updated', ['updatedAt'])
    .index('by_resource_default_name', ['resource', 'isDefault', 'name'])
    .searchIndex('search_name', { searchField: 'name', filterFields: ['resource', 'isDefault'] }),

  /** Short-lived xlsx/pdf object ownership; this is cleanup state, not business history. */
  printArtifacts: defineTable({
    ownerUserId: v.id('appUsers'),
    companyIds: v.array(v.string()),
    resource: v.union(v.literal('sales.order'), v.literal('mfg.work_order')),
    permission: v.string(),
    kind: v.union(v.literal('export_xlsx'), v.literal('print_input_xlsx'), v.literal('print_pdf')),
    requestKey: v.string(),
    objectKey: v.string(),
    filename: v.string(),
    contentType: v.string(),
    size: v.number(),
    sha256: v.string(),
    expiresAt: v.number(),
    insertedAt: v.number(),
  })
    .index('by_owner_request', ['ownerUserId', 'kind', 'requestKey'])
    .index('by_owner_time', ['ownerUserId', 'insertedAt'])
    .index('by_expiry', ['expiresAt'])
    .index('by_object_key', ['objectKey']),

  /** Crash-safe transient execution state; purged with its objects within 24 hours. */
  printJobs: defineTable({
    ownerUserId: v.id('appUsers'),
    companyIds: v.array(v.string()),
    resource: v.union(v.literal('sales.order'), v.literal('mfg.work_order')),
    permission: v.string(),
    templateId: v.id('printTemplates'),
    idempotencyKey: v.string(),
    status: v.union(
      v.literal('queued'), v.literal('running'), v.literal('succeeded'),
      v.literal('retryable'), v.literal('failed'), v.literal('expired'),
    ),
    attempts: v.number(),
    maxAttempts: v.number(),
    nextAttemptAt: v.number(),
    leaseToken: v.union(v.string(), v.null()),
    leaseExpiresAt: v.union(v.number(), v.null()),
    deadlineAt: v.union(v.number(), v.null()),
    inputArtifactId: v.id('printArtifacts'),
    outputArtifactId: v.union(v.id('printArtifacts'), v.null()),
    outputObjectKey: v.string(),
    filename: v.string(),
    errorCode: v.union(v.string(), v.null()),
    insertedAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index('by_owner_idempotency', ['ownerUserId', 'idempotencyKey'])
    .index('by_owner_time', ['ownerUserId', 'insertedAt'])
    .index('by_status_next', ['status', 'nextAttemptAt'])
    .index('by_running_lease', ['status', 'leaseExpiresAt'])
    .index('by_expiry', ['expiresAt']),

  /** Durable external-I/O jobs. Payload bytes never enter this table. */
  ioJobs: defineTable({
    kind: v.union(
      v.literal('bank_import_parse'), v.literal('bank_import_commit'),
      v.literal('attendance_import_parse'), v.literal('attendance_import_commit'),
      v.literal('market_refresh'), v.literal('file_cleanup'), v.literal('s3_reconcile'),
    ),
    idempotencyKey: v.string(),
    subjectId: v.union(v.string(), v.null()),
    fileId: v.union(v.id('files'), v.null()),
    companyId: v.union(v.string(), v.null()),
    createdById: v.union(v.id('appUsers'), v.null()),
    status: v.union(
      v.literal('queued'), v.literal('running'), v.literal('succeeded'),
      v.literal('failed'), v.literal('cancelled'), v.literal('dead_letter'),
    ),
    phase: v.string(),
    progressDone: v.number(),
    progressTotal: v.number(),
    leaseToken: v.union(v.string(), v.null()),
    leaseExpiresAt: v.union(v.number(), v.null()),
    attempts: v.number(),
    maxAttempts: v.number(),
    nextAttemptAt: v.number(),
    errorCode: v.union(v.string(), v.null()),
    errorMessage: v.union(v.string(), v.null()),
    parameters: v.any(),
    result: v.optional(v.any()),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_idempotency', ['kind', 'idempotencyKey'])
    .index('by_status_next', ['status', 'nextAttemptAt'])
    .index('by_subject', ['kind', 'subjectId'])
    .index('by_lease', ['status', 'leaseExpiresAt']),

  ioJobChunks: defineTable({
    jobId: v.id('ioJobs'),
    chunkNo: v.number(),
    hash: v.string(),
    rowCount: v.number(),
    insertedAt: v.number(),
  }).index('by_job_chunk', ['jobId', 'chunkNo']),

  bankImportRows: defineTable({
    jobId: v.id('ioJobs'),
    rowNo: v.number(),
    occurredAt: v.union(v.string(), v.null()),
    income: v.union(v.string(), v.null()),
    expense: v.union(v.string(), v.null()),
    balance: v.union(v.string(), v.null()),
    counterpartyName: v.union(v.string(), v.null()),
    counterpartyAccount: v.union(v.string(), v.null()),
    summary: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
    error: v.union(v.string(), v.null()),
    transactionId: v.union(v.string(), v.null()),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_job_row', ['jobId', 'rowNo'])
    .index('by_job_transaction', ['jobId', 'transactionId']),

  attendanceImportRows: defineTable({
    jobId: v.id('ioJobs'),
    rowNo: v.number(),
    attendanceNo: v.string(),
    punchedAt: v.string(),
    employeeId: v.union(v.id('employees'), v.null()),
    punchRecordId: v.union(v.string(), v.null()),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_job_row', ['jobId', 'rowNo'])
    .index('by_job_punch', ['jobId', 'punchRecordId']),

  /** Immutable punch facts; visibility is the parent import's single status flip. */
  attendancePunchFacts: defineTable({
    importId: v.string(),
    jobId: v.id('ioJobs'),
    attendanceNo: v.string(),
    punchedAt: v.number(),
    date: v.string(),
    employeeId: v.id('employees'),
    insertedAt: v.number(),
  })
    .index('by_import_time', ['importId', 'punchedAt'])
    .index('by_date', ['date', 'employeeId', 'punchedAt'])
    .index('by_employee_date', ['employeeId', 'date', 'punchedAt'])
    .index('by_employee_time', ['employeeId', 'punchedAt']),

  attendanceProjectionState: defineTable({
    key: v.literal('singleton'),
    activeGeneration: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  attendanceDayProjections: defineTable({
    generation: v.number(),
    employeeId: v.id('employees'),
    date: v.string(),
    morningIn: v.union(v.string(), v.null()),
    morningOut: v.union(v.string(), v.null()),
    afternoonIn: v.union(v.string(), v.null()),
    afternoonOut: v.union(v.string(), v.null()),
    normalHoursScaled: v.int64(),
    overtimeHoursScaled: v.int64(),
    bonusWorkdayScaled: v.int64(),
    status: v.union(v.literal('OK'), v.literal('MISSING')),
    searchText: v.string(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_generation_date', ['generation', 'date', 'employeeId'])
    .index('by_generation_employee_date', ['generation', 'employeeId', 'date'])
    .searchIndex('search_text', { searchField: 'searchText', filterFields: ['generation'] }),

  attendanceProjectionBuilds: defineTable({
    jobId: v.id('ioJobs'),
    sourceGeneration: v.number(),
    targetGeneration: v.number(),
    state: v.union(v.literal('building'), v.literal('verified'), v.literal('activated'), v.literal('failed')),
    copiedRows: v.number(),
    rebuiltPairs: v.number(),
    targetRows: v.number(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_job', ['jobId'])
    .index('by_state', ['state', 'insertedAt']),

  attendanceProjectionBuildPairs: defineTable({
    buildId: v.id('attendanceProjectionBuilds'),
    employeeId: v.id('employees'),
    date: v.string(),
    insertedAt: v.number(),
  }).index('by_build_pair', ['buildId', 'employeeId', 'date']),

  domainUniqueClaims: defineTable({
    resource: v.string(),
    scopeKey: v.string(),
    uniqueKey: v.string(),
    recordId: v.string(),
  })
    .index('by_claim', ['resource', 'scopeKey', 'uniqueKey'])
    .index('by_record', ['resource', 'recordId']),

  domainReferences: defineTable({
    sourceResource: v.string(),
    sourceRecordId: v.string(),
    field: v.string(),
    targetResource: v.string(),
    targetRecordId: v.string(),
  })
    .index('by_source', ['sourceResource', 'sourceRecordId'])
    .index('by_target', ['targetResource', 'targetRecordId']),

  /** Finite indexed list shapes for closure records with non-label ordering. */
  domainQueryRows: defineTable({
    resource: v.string(),
    profile: v.string(),
    recordId: v.string(),
    companyId: v.union(v.string(), v.null()),
    parentId: v.union(v.string(), v.null()),
    status: v.union(v.string(), v.null()),
    equalityField: v.string(),
    equalityValue: v.string(),
    sortValue: v.string(),
  })
    .index('by_record', ['resource', 'recordId'])
    .index('by_resource_profile_sort', ['resource', 'profile', 'sortValue', 'recordId'])
    .index('by_resource_profile_company_sort', ['resource', 'profile', 'companyId', 'sortValue', 'recordId'])
    .index('by_resource_profile_status_sort', ['resource', 'profile', 'status', 'sortValue', 'recordId'])
    .index('by_resource_profile_company_status_sort', ['resource', 'profile', 'companyId', 'status', 'sortValue', 'recordId'])
    .index('by_resource_profile_parent_sort', ['resource', 'profile', 'parentId', 'sortValue', 'recordId'])
    .index('by_resource_profile_equality_sort', ['resource', 'profile', 'equalityField', 'equalityValue', 'sortValue', 'recordId'])
    .index('by_resource_profile_equality_status_sort', ['resource', 'profile', 'equalityField', 'equalityValue', 'status', 'sortValue', 'recordId']),

  domainRevisions: defineTable({
    scope: v.string(),
    key: v.string(),
    revision: v.int64(),
    updatedAt: v.number(),
  }).index('by_scope_key', ['scope', 'key']),

  /** Internal manufacturing allocation facts; not a generic Catalog resource. */
  mfgDemandArrangements: defineTable({
    demandItemId: v.string(),
    companyId: v.string(),
    arrangementType: v.union(
      v.literal('MAKE'), v.literal('PURCHASE'), v.literal('OUTSOURCE'),
      v.literal('STOCK'), v.literal('CLOSE'),
    ),
    qtyScaled: v.int64(),
    baseQtyScaled: v.int64(),
    workOrderId: v.union(v.string(), v.null()),
    purchaseOrderItemId: v.union(v.string(), v.null()),
    remarks: v.union(v.string(), v.null()),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_demand_item', ['demandItemId', 'insertedAt'])
    .index('by_work_order', ['workOrderId'])
    .index('by_purchase_order_item', ['purchaseOrderItemId']),

  /** Bounded attendance range index used by recalc actions and 100k import chunks. */
  hrAttendanceIndex: defineTable({
    resource: v.union(
      v.literal('hrAttendancePunches'),
      v.literal('hrAttendanceCorrections'),
      v.literal('hrAttendanceDays'),
    ),
    recordId: v.string(),
    employeeId: v.string(),
    date: v.string(),
  })
    .index('by_resource_date', ['resource', 'date', 'employeeId'])
    .index('by_resource_employee_date', ['resource', 'employeeId', 'date'])
    .index('by_record', ['resource', 'recordId']),

  /** Payroll/payment/loan query facts; semantic HR mutations maintain this table. */
  hrPayrollIndex: defineTable({
    resource: v.union(
      v.literal('hrPayrolls'),
      v.literal('hrPayrollPayments'),
      v.literal('hrEmployeeLoans'),
    ),
    recordId: v.string(),
    employeeId: v.string(),
    month: v.union(v.string(), v.null()),
    payrollId: v.union(v.string(), v.null()),
    date: v.string(),
  })
    .index('by_record', ['resource', 'recordId'])
    .index('by_resource_date', ['resource', 'date', 'recordId'])
    .index('by_resource_month', ['resource', 'month', 'recordId'])
    .index('by_resource_month_employee', ['resource', 'month', 'employeeId'])
    .index('by_resource_payroll_date', ['resource', 'payrollId', 'date'])
    .index('by_resource_employee_date', ['resource', 'employeeId', 'date']),

  /** Bank transaction/reconciliation capacities; maintained only by finance banking mutations. */
  financeBankingIndex: defineTable({
    resource: v.union(v.literal('accBankTransactions'), v.literal('accBankReconciliations')),
    recordId: v.string(),
    companyId: v.string(),
    bankAccountId: v.string(),
    bankTransactionId: v.union(v.string(), v.null()),
    journalId: v.union(v.string(), v.null()),
    ledgerAccountId: v.union(v.string(), v.null()),
    income: v.union(v.boolean(), v.null()),
    amountScaled: v.int64(),
  })
    .index('by_record', ['resource', 'recordId'])
    .index('by_resource_bank_account', ['resource', 'bankAccountId', 'recordId'])
    .index('by_resource_transaction', ['resource', 'bankTransactionId', 'recordId'])
    .index('by_resource_journal', ['resource', 'journalId', 'recordId']),

  salesSettings: defineTable({
    key: v.literal('singleton'),
    sampleItemMaxQty: v.number(),
    deliveryOvershipRatioScaled: v.int64(),
    spotItemMaxQty: v.number(),
    receiptOverreceiveRatioScaled: v.int64(),
    demandOverorderRatioScaled: v.int64(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  manufacturingSettings: defineTable({
    key: v.literal('singleton'),
    outputOverreceiveRatioScaled: v.int64(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  accountingSettings: defineTable({
    key: v.literal('singleton'),
    insertedAt: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  systemSettings: defineTable({
    key: v.literal('singleton'),
    marketFetchScheduleEnabled: v.boolean(),
    marketFetchLastIntervalMinutes: v.number(),
    marketFetchSettlementEnabled: v.boolean(),
    marketFetchLastRunAt: v.union(v.number(), v.null()),
    marketFetchLastSummary: v.union(v.string(), v.null()),
    insertedAt: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  /** Persisted scheduler slots and tick lease; never kept in a container timer. */
  marketSchedulerState: defineTable({
    key: v.literal('singleton'),
    lastLastDate: v.union(v.string(), v.null()),
    lastLastSlot: v.union(v.number(), v.null()),
    lastSettlementDate: v.union(v.string(), v.null()),
    lastSettlementSlot: v.union(v.number(), v.null()),
    leaseToken: v.union(v.string(), v.null()),
    leaseExpiresAt: v.union(v.number(), v.null()),
    lastTickAt: v.union(v.number(), v.null()),
    updatedAt: v.number(),
  }).index('by_key', ['key']),
  setupState: defineTable({
    key: v.literal('singleton'),
    authInitializedAt: v.number(),
    firstAdminUserId: v.id('appUsers'),
  }).index('by_key', ['key']),

  appUsers: defineTable({
    authUserId: v.string(),
    usernameKey: v.string(),
    username: v.string(),
    name: v.union(v.string(), v.null()),
    enabled: v.boolean(),
    superAdmin: v.boolean(),
    allCompanies: v.boolean(),
    preferredLanguage: v.optional(v.union(v.literal('zh-CN'), v.literal('en-US'))),
    insertedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  })
    .index('by_auth_user', ['authUserId'])
    .index('by_username_key', ['usernameKey']),

  iamRoles: defineTable({
    code: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    builtin: v.boolean(),
    insertedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  }).index('by_code', ['code']),

  iamRolePermissions: defineTable({
    roleId: v.id('iamRoles'),
    permission: v.string(),
    insertedAt: v.optional(v.number()),
  })
    .index('by_role', ['roleId'])
    .index('by_role_permission', ['roleId', 'permission']),

  iamUserRoles: defineTable({
    userId: v.id('appUsers'),
    roleId: v.id('iamRoles'),
  })
    .index('by_user', ['userId'])
    .index('by_role', ['roleId'])
    .index('by_user_role', ['userId', 'roleId']),

  iamUserCompanies: defineTable({
    userId: v.id('appUsers'),
    companyId: v.string(),
  })
    .index('by_user', ['userId'])
    .index('by_user_company', ['userId', 'companyId']),

  authLoginAttempts: defineTable({
    key: v.string(),
    failures: v.number(),
    windowStartedAt: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  currencies: defineTable({
    name: v.string(),
    nameKey: v.string(),
    isoCode: v.string(),
    isoCodeKey: v.string(),
    symbol: v.union(v.string(), v.null()),
    active: v.boolean(),
    searchText: v.string(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_iso_code_key', ['isoCodeKey'])
    .index('by_name_key', ['nameKey'])
    .index('by_active_iso_code_key', ['active', 'isoCodeKey'])
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['active'],
    }),

  units: defineTable({
    unitType: v.union(
      v.literal('LENGTH'),
      v.literal('AREA'),
      v.literal('WEIGHT'),
      v.literal('QUANTITY'),
    ),
    isBase: v.boolean(),
    name: v.string(),
    nameKey: v.string(),
    symbol: v.string(),
    symbolKey: v.string(),
    ratioScaled: v.int64(),
    searchText: v.string(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_symbol_key', ['symbolKey'])
    .index('by_type_base', ['unitType', 'isBase'])
    .index('by_type_name_key', ['unitType', 'nameKey'])
    .index('by_name_key', ['nameKey'])
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: ['unitType', 'isBase'],
    }),

  warehouses: defineTable({
    name: v.string(),
    nameKey: v.string(),
    isLeaf: v.boolean(),
    active: v.boolean(),
    isOutsourced: v.boolean(),
    partyType: v.union(v.literal('SUPPLIER'), v.literal('COMPANY'), v.null()),
    partyId: v.union(v.string(), v.null()),
    allowNegative: v.boolean(),
    companyId: v.string(),
    parentId: v.union(v.id('warehouses'), v.null()),
    accountId: v.union(v.string(), v.null()),
    searchText: v.string(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_company_name_key', ['companyId', 'nameKey'])
    .index('by_company_parent_name_key', ['companyId', 'parentId', 'nameKey'])
    .index('by_party_name_key', ['partyType', 'partyId', 'nameKey'])
    .index('by_parent', ['parentId'])
    .searchIndex('search_text', {
      searchField: 'searchText',
      filterFields: [
        'companyId',
        'parentId',
        'active',
        'isLeaf',
        'isOutsourced',
        'partyType',
        'partyId',
      ],
    }),

  /**
   * Warehouse is a Plan 003 vertical slice but its company/account/party owners
   * migrate later. These rows are explicit isolation fixtures, not public Catalog
   * resources and never have a ResourceBinding writer.
   */
  pilotCompanies: defineTable({
    code: v.string(),
    codeKey: v.string(),
    name: v.string(),
    baseCurrencyId: v.union(v.id('currencies'), v.null()),
  })
    .index('by_code_key', ['codeKey'])
    .index('by_base_currency', ['baseCurrencyId']),

  pilotAccounts: defineTable({
    companyId: v.string(),
    code: v.string(),
    name: v.string(),
    isGroup: v.boolean(),
    /** Optional during the Plan 003 -> 004 rolling schema upgrade. */
    active: v.optional(v.boolean()),
    role: v.optional(v.union(v.string(), v.null())),
    currencyId: v.union(v.id('currencies'), v.null()),
  })
    .index('by_company_code', ['companyId', 'code'])
    .index('by_currency', ['currencyId']),

  pilotSuppliers: defineTable({
    name: v.string(),
    nameKey: v.string(),
    enabled: v.boolean(),
  }).index('by_name_key', ['nameKey']),

  companies: defineTable({
    code: v.string(),
    codeKey: v.string(),
    name: v.string(),
    shortName: v.string(),
    parentId: v.union(v.id('companies'), v.null()),
    baseCurrencyId: v.id('currencies'),
    searchText: v.string(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_code_key', ['codeKey'])
    .index('by_parent', ['parentId'])
    .searchIndex('search_text', { searchField: 'searchText' }),

  accounts: defineTable({
    code: v.string(),
    codeKey: v.string(),
    name: v.string(),
    direction: v.union(v.literal('DEBIT'), v.literal('CREDIT')),
    isGroup: v.boolean(),
    active: v.boolean(),
    role: v.union(v.string(), v.null()),
    parentId: v.union(v.id('accounts'), v.null()),
    companyId: v.id('companies'),
    currencyId: v.union(v.id('currencies'), v.null()),
    searchText: v.string(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_company_code_key', ['companyId', 'codeKey'])
    .index('by_company_parent_code_key', ['companyId', 'parentId', 'codeKey'])
    .index('by_parent', ['parentId'])
    .index('by_currency', ['currencyId'])
    .searchIndex('search_text', { searchField: 'searchText', filterFields: ['companyId', 'active', 'isGroup', 'role'] }),

  companyAccountDefaults: defineTable({
    companyId: v.id('companies'),
    deliveryDebitAccountId: v.union(v.id('accounts'), v.null()),
    deliveryCreditAccountId: v.union(v.id('accounts'), v.null()),
    receiptDebitAccountId: v.union(v.id('accounts'), v.null()),
    receiptCreditAccountId: v.union(v.id('accounts'), v.null()),
    insertedAt: v.number(),
    updatedAt: v.number(),
  }).index('by_company', ['companyId']),

  customers: defineTable({
    code: v.string(), codeKey: v.string(), name: v.string(), shortName: v.union(v.string(), v.null()),
    searchText: v.string(), insertedAt: v.number(), updatedAt: v.number(),
  }).index('by_code_key', ['codeKey']).searchIndex('search_text', { searchField: 'searchText' }),

  suppliers: defineTable({
    code: v.string(), codeKey: v.string(), name: v.string(), shortName: v.union(v.string(), v.null()),
    searchText: v.string(), insertedAt: v.number(), updatedAt: v.number(),
  }).index('by_code_key', ['codeKey']).searchIndex('search_text', { searchField: 'searchText' }),

  employees: defineTable({
    code: v.string(), codeKey: v.string(), name: v.string(), attendanceNo: v.union(v.string(), v.null()),
    idNumber: v.union(v.string(), v.null()), householdRegistration: v.union(v.string(), v.null()),
    phone: v.union(v.string(), v.null()), currentAddress: v.union(v.string(), v.null()),
    dailyWage: v.union(v.int64(), v.null()), monthlyAllowance: v.union(v.int64(), v.null()),
    insuranceTypes: v.array(v.string()), searchText: v.string(), insertedAt: v.number(), updatedAt: v.number(),
  })
    .index('by_code_key', ['codeKey'])
    .index('by_attendance_no', ['attendanceNo'])
    .searchIndex('search_text', { searchField: 'searchText' }),

  materialCategories: defineTable({
    code: v.string(), codeKey: v.string(), name: v.string(), isLeaf: v.boolean(), active: v.boolean(), parentId: v.union(v.id('materialCategories'), v.null()),
    searchText: v.string(), insertedAt: v.number(), updatedAt: v.number(),
  })
    .index('by_code_key', ['codeKey'])
    .index('by_parent_code_key', ['parentId', 'codeKey'])
    .searchIndex('search_text', { searchField: 'searchText' }),

  materials: defineTable({
    code: v.string(),
    codeKey: v.string(),
    name: v.string(),
    spec: v.union(v.string(), v.null()),
    customerPartNo: v.union(v.string(), v.null()),
    isCustomerMaterial: v.boolean(),
    active: v.boolean(),
    categoryId: v.id('materialCategories'),
    defaultUnitId: v.id('units'),
    customerId: v.union(v.id('customers'), v.null()),
    searchText: v.string(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_code_key', ['codeKey'])
    .index('by_category', ['categoryId'])
    .index('by_default_unit', ['defaultUnitId'])
    .index('by_customer', ['customerId'])
    .searchIndex('search_text', { searchField: 'searchText', filterFields: ['active', 'categoryId', 'customerId'] }),

  materialUnits: defineTable({
    materialId: v.id('materials'),
    unitId: v.id('units'),
    factorScaled: v.int64(),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_material_unit', ['materialId', 'unitId'])
    .index('by_unit', ['unitId']),

  /** Reference witnesses used until their owning resources migrate in Plan 005. */
  pilotResourceReferences: defineTable({
    targetResource: v.union(
      v.literal('basCurrencies'),
      v.literal('basUnits'),
      v.literal('invWarehouses'),
    ),
    targetId: v.string(),
    sourceLabel: v.string(),
  }).index('by_target', ['targetResource', 'targetId']),

  /** Replaced by the formal audit ledger in Plan 004; never exposed as Catalog data. */
  pilotAuditEntries: defineTable({
    resource: v.union(
      v.literal('basCurrencies'),
      v.literal('basUnits'),
      v.literal('invWarehouses'),
    ),
    recordId: v.string(),
    recordLabel: v.string(),
    actorUserId: v.id('appUsers'),
    companyId: v.union(v.string(), v.null()),
    action: v.union(v.literal('create'), v.literal('update'), v.literal('destroy')),
    changes: v.any(),
    occurredAt: v.number(),
  })
    .index('by_resource_record', ['resource', 'recordId'])
    .index('by_actor_time', ['actorUserId', 'occurredAt']),

  /** Plan 004 isolation fixture; the real material Catalog owner migrates in Plan 005. */
  engineMaterials: defineTable({
    companyId: v.string(),
    code: v.string(),
    name: v.string(),
    active: v.boolean(),
  }).index('by_company_code', ['companyId', 'code']),

  enginePostingHeads: defineTable({
    companyId: v.string(),
    voucherType: v.string(),
    voucherId: v.string(),
    voucherNo: v.string(),
    state: v.union(v.literal('draft'), v.literal('audited'), v.literal('cancelled')),
    auditedBy: v.union(v.id('appUsers'), v.null()),
    auditedAt: v.union(v.number(), v.null()),
  }).index('by_voucher', ['voucherType', 'voucherId']),

  numberingRules: defineTable({
    resource: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    perCompany: v.boolean(),
    segments: v.array(
      v.union(
        v.object({ kind: v.literal('text'), value: v.string() }),
        v.object({ kind: v.literal('field'), field: v.string(), format: v.optional(v.string()) }),
        v.object({ kind: v.literal('sequence'), padding: v.number() }),
      ),
    ),
    insertedAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_resource_enabled', ['resource', 'enabled'])
    .index('by_resource_name', ['resource', 'name']),

  numberingCounters: defineTable({
    ruleId: v.id('numberingRules'),
    scopeKey: v.string(),
    value: v.int64(),
    insertedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index('by_rule_scope', ['ruleId', 'scopeKey']),

  auditLogs: defineTable({
    resource: v.string(),
    recordId: v.string(),
    recordLabel: v.string(),
    actorUserId: v.id('appUsers'),
    actorUsername: v.string(),
    companyId: v.union(v.string(), v.null()),
    action: v.string(),
    changes: v.any(),
    truncated: v.boolean(),
    occurredAt: v.number(),
  })
    .index('by_resource_record', ['resource', 'recordId'])
    .index('by_time', ['occurredAt'])
    .index('by_company_time', ['companyId', 'occurredAt'])
    .index('by_actor_time', ['actorUserId', 'occurredAt']),

  projectionGenerations: defineTable({
    projection: v.union(v.literal('inventory'), v.literal('gl')),
    activeGeneration: v.number(),
    verifiedGeneration: v.number(),
    updatedAt: v.number(),
  }).index('by_projection', ['projection']),

  projectionRebuildSessions: defineTable({
    projection: v.union(v.literal('inventory'), v.literal('gl')),
    targetGeneration: v.number(),
    state: v.union(v.literal('building'), v.literal('verified'), v.literal('activated'), v.literal('failed')),
    completedChunks: v.number(),
    sourceRows: v.number(),
    liveRows: v.number(),
    startedAt: v.number(),
    completedAt: v.union(v.number(), v.null()),
  }).index('by_projection_state', ['projection', 'state']),

  projectionRebuildChunks: defineTable({
    sessionId: v.id('projectionRebuildSessions'),
    chunkKey: v.string(),
    sourceRows: v.number(),
    liveRows: v.number(),
    completedAt: v.number(),
  }).index('by_session_chunk', ['sessionId', 'chunkKey']),

  stockEntries: defineTable({
    voucherType: v.string(),
    voucherId: v.string(),
    voucherNo: v.string(),
    companyId: v.string(),
    warehouseId: v.id('warehouses'),
    materialId: v.id('materials'),
    postingDate: v.string(),
    signedBaseQty: v.int64(),
    sequence: v.number(),
    cancelled: v.boolean(),
    cancelledAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    factProjectionId: v.optional(v.id('inventoryDocuments')),
  })
    .index('by_voucher', ['voucherType', 'voucherId'])
    .index('by_material', ['materialId'])
    .index('by_warehouse', ['warehouseId'])
    .index('by_company_warehouse_material_date', [
      'companyId',
      'warehouseId',
      'materialId',
      'postingDate',
    ]),

  inventoryCurrentBalances: defineTable({
    generation: v.number(),
    companyId: v.string(),
    warehouseId: v.id('warehouses'),
    materialId: v.id('materials'),
    baseQty: v.int64(),
    updatedAt: v.number(),
  }).index('by_key', ['generation', 'companyId', 'warehouseId', 'materialId']),

  inventoryDailyDeltas: defineTable({
    generation: v.number(),
    companyId: v.string(),
    warehouseId: v.id('warehouses'),
    materialId: v.id('materials'),
    postingDate: v.string(),
    baseQty: v.int64(),
  }).index('by_key_date', [
    'generation',
    'companyId',
    'warehouseId',
    'materialId',
    'postingDate',
  ]),

  inventoryMonthlyDeltas: defineTable({
    generation: v.number(),
    companyId: v.string(),
    warehouseId: v.id('warehouses'),
    materialId: v.id('materials'),
    postingMonth: v.string(),
    baseQty: v.int64(),
  }).index('by_key_month', [
    'generation',
    'companyId',
    'warehouseId',
    'materialId',
    'postingMonth',
  ]),

  glEntries: defineTable({
    voucherType: v.string(),
    voucherId: v.string(),
    voucherNo: v.string(),
    companyId: v.string(),
    accountId: v.id('accounts'),
    currencyId: v.union(v.id('currencies'), v.null()),
    postingDate: v.string(),
    debit: v.int64(),
    credit: v.int64(),
    partyType: v.union(v.string(), v.null()),
    partyId: v.union(v.string(), v.null()),
    sequence: v.number(),
    reversal: v.boolean(),
    reversedById: v.union(v.id('glEntries'), v.null()),
    reversesId: v.union(v.id('glEntries'), v.null()),
    cancelled: v.boolean(),
    cancelledAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    factProjectionId: v.optional(v.id('accountingDocuments')),
  })
    .index('by_voucher', ['voucherType', 'voucherId'])
    .index('by_company_account_date', ['companyId', 'accountId', 'postingDate']),

  glAccountDaily: defineTable({
    generation: v.number(),
    companyId: v.string(),
    accountId: v.id('accounts'),
    postingDate: v.string(),
    debit: v.int64(),
    credit: v.int64(),
  }).index('by_key_date', ['generation', 'companyId', 'accountId', 'postingDate']),

  glAccountMonthly: defineTable({
    generation: v.number(),
    companyId: v.string(),
    accountId: v.id('accounts'),
    postingMonth: v.string(),
    debit: v.int64(),
    credit: v.int64(),
  }).index('by_key_month', ['generation', 'companyId', 'accountId', 'postingMonth']),

  glPartyDaily: defineTable({
    generation: v.number(),
    companyId: v.string(),
    accountId: v.id('accounts'),
    partyType: v.string(),
    partyId: v.string(),
    postingDate: v.string(),
    debit: v.int64(),
    credit: v.int64(),
  }).index('by_key_date', [
    'generation',
    'companyId',
    'accountId',
    'partyType',
    'partyId',
    'postingDate',
  ]).index('by_account_date', [
    'generation',
    'companyId',
    'accountId',
    'postingDate',
  ]),

  glPartyMonthly: defineTable({
    generation: v.number(),
    companyId: v.string(),
    accountId: v.id('accounts'),
    partyType: v.string(),
    partyId: v.string(),
    postingMonth: v.string(),
    debit: v.int64(),
    credit: v.int64(),
  }).index('by_key_month', [
    'generation',
    'companyId',
    'accountId',
    'partyType',
    'partyId',
    'postingMonth',
  ]).index('by_account_month', [
    'generation',
    'companyId',
    'accountId',
    'postingMonth',
  ]),

  infraRestoreSmoke: defineTable({
    // Plan 001 originally wrote the three legacy smoke fields below. Keep them
    // readable so an existing local deployment can accept the schema upgrade;
    // new restore probes always use marker + storageId + expectedSha256.
    key: v.optional(v.string()),
    revision: v.optional(v.number()),
    value: v.optional(v.string()),
    marker: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    expectedSha256: v.optional(v.string()),
    productFileId: v.optional(v.id('files')),
    productObjectKey: v.optional(v.string()),
    productExpectedSha256: v.optional(v.string()),
  }).index('by_marker', ['marker']),
})
