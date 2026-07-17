import { formatAmount } from '~/lib/amount'
import { SynieAttachmentPanel } from '../synie-attachment-panel/SynieAttachmentPanel'
import { SynieImageAttachment } from '../synie-attachment-panel/SynieImageAttachment'
import type { SynieRecordDrawerProps } from './SynieRecordDrawer'

/**
 * 资源级抽屉配置:每个资源一份可全局引用的 SynieRecordDrawer 定制。
 * fk 速览(FkPreviewProvider)按 resource 取用;页面用 {...drawerConfig('资源名')}
 * 引用同一份,页面级差异(onSubmit、动态 fields)在 JSX 上继续覆盖。
 */
export type ResourceDrawerConfig = Pick<
  SynieRecordDrawerProps,
  'exclude' | 'fields' | 'contentClassName' | 'extraContent'
> & { label: string }

const registry: Record<string, ResourceDrawerConfig> = {
  sysUsers: { label: '用户' },
  sysRoles: {
    label: '角色',
    // 启用是状态不是表单字段(规范):新建默认启用,启停走列表行动作
    exclude: ['enabled'],
    fields: {
      code: { required: true, edit: 'createOnly', placeholder: '如 purchaser' },
      name: { required: true, placeholder: '如 采购管理员' },
    },
  },
  basCompanies: { label: '公司' },
  basCurrencies: { label: '货币' },
  basUnits: { label: '单位' },
  basAccounts: { label: '科目' },
  salCustomers: { label: '客户' },
  purSuppliers: { label: '供应商' },
  hrAttendancePunches: { label: '打卡记录' },
  hrAttendanceImports: { label: '考勤导入' },
  hrEmployees: {
    label: '员工',
    contentClassName: 'w-full lg:w-[640px]',
    fields: {
      // 编号必填但可留空自动取号(后端 AutoNumber),前端不标必填
      code: { order: 0, cols: 6, placeholder: '留空自动编号' },
      name: { order: 1, cols: 6, required: true },
      attendanceNo: { order: 2, cols: 6 },
      phone: { order: 3, cols: 6 },
      idNumber: { order: 4 },
      householdRegistration: { order: 5 },
      currentAddress: { order: 6 },
      dailyWage: { order: 7, cols: 6, render: (v) => formatAmount(v) },
      monthlyAllowance: { order: 8, cols: 6, render: (v) => formatAmount(v) },
    },
    // 身份证正/背面照片:附件槽位(owner+category),create 态无宿主 id,槽位自身显示提示
    extraContent: (mode, row) => (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SynieImageAttachment
          ownerType="hr_employee"
          ownerId={row?.id as string | undefined}
          category="id_front"
          label="身份证正面"
          readonly={mode === 'view'}
        />
        <SynieImageAttachment
          ownerType="hr_employee"
          ownerId={row?.id as string | undefined}
          category="id_back"
          label="身份证背面"
          readonly={mode === 'view'}
        />
      </div>
    ),
  },
  invMaterials: {
    label: '物料',
    contentClassName: 'w-full lg:w-[640px]',
    // 启用是状态不是表单字段(规范):新建默认启用,启停走列表行动作
    exclude: ['active'],
    fields: {
      // 编号必填但可留空自动取号(后端 AutoNumber:分类编号-4 位序号),前端不标必填
      code: { order: 0, cols: 6, placeholder: '留空自动编号(分类号-序号)' },
      name: { order: 1, cols: 6, required: true },
      // 物料只能挂启用的叶子分类(后端另有叶子校验兜底)
      categoryId: { order: 2, cols: 6, required: true, remote: { filter: '{isLeaf: {eq: true}, active: {eq: true}}' } },
      defaultUnitId: { order: 3, cols: 6, required: true },
      spec: { order: 4, cols: 6, placeholder: '如 M8×30' },
      customerPartNo: { order: 5, cols: 6 },
    },
  },
  invMaterialUnits: { label: '单位转换' },
  hrPayrolls: {
    label: '工资单',
    fields: {
      dailyWage: { render: (v) => formatAmount(v) },
      baseAmount: { render: (v) => formatAmount(v) },
      allowance: { render: (v) => formatAmount(v) },
      bonus: { render: (v) => formatAmount(v) },
      fine: { render: (v) => formatAmount(v) },
      loanDeduction: { render: (v) => formatAmount(v) },
      payable: { render: (v) => formatAmount(v) },
      paidTotal: { render: (v) => formatAmount(v) },
    },
  },
  hrPayrollPayments: {
    label: '发放记录',
    fields: { amount: { render: (v) => formatAmount(v) } },
  },
  hrEmployeeLoans: {
    label: '员工借款',
    fields: { amount: { render: (v) => formatAmount(v) } },
  },
  sysAuditLogs: { label: '操作日志' },
  sysNumberingRules: { label: '编号规则' },
  sysNumberingCounters: { label: '计数器' },
  accGlJournals: { label: '凭证' },
  accGlJournalLines: { label: '分录行' },
  accGlEntries: { label: '分录' },
  accBankAccounts: { label: '银行账户' },
  accBankTransactions: { label: '银行流水' },
  accBankImportTemplates: { label: '流水导入模板' },
  accBankImports: { label: '流水导入' },
  accBankImportItems: { label: '导入行' },
  accVatInvoices: { label: '增值税发票' },
  // 票据台账页已并入持有承兑(票面修正走持有段行操作),这里是票据档案的唯一全量呈现:
  // 任何 billId fk 速览(含已处置票的历史交易行)都能看到完整票面+影像附件
  accBills: {
    label: '承兑票据',
    contentClassName: 'w-full lg:w-[760px]',
    // 票据包金额不展示:承兑均来源于接收,原包金额业务上不关心(后端已改可空)
    exclude: ['faceAmount'],
    fields: {
      // 票号是票据身份,建档即定,不可改(后端 update 动作本就不收 bill_no)
      billNo: { order: -1, edit: 'readOnly' },
      billKind: { order: 0, cols: 6 },
      transferable: { order: 1, cols: 6 },
      issueDate: { order: 2, cols: 6 },
      acceptanceDate: { order: 3, cols: 6 },
      // 半宽字段共 5 个,到期日独占整行,保证下方出票人四件套两列对齐
      dueDate: { order: 4 },
      // 出票人/收款人/承兑人四件套(名称/账号/开户行/开户行联行号),两列排
      drawerName: { order: 6, cols: 6, label: '出票人名称' },
      drawerAccount: { order: 7, cols: 6, label: '出票人账号' },
      drawerBankName: { order: 8, cols: 6, label: '出票人开户行' },
      drawerBankNo: { order: 9, cols: 6, label: '出票人开户行联行号' },
      payeeName: { order: 10, cols: 6, label: '收款人名称' },
      payeeAccount: { order: 11, cols: 6, label: '收款人账号' },
      payeeBankName: { order: 12, cols: 6, label: '收款人开户行' },
      payeeBankNo: { order: 13, cols: 6, label: '收款人开户行联行号' },
      acceptorName: { order: 14, cols: 6, label: '承兑人名称' },
      acceptorAccount: { order: 15, cols: 6, label: '承兑人账号' },
      acceptorBankName: { order: 16, cols: 6, label: '承兑人开户行' },
      acceptorBankNo: { order: 17, cols: 6, label: '承兑人开户行联行号' },
      remarks: { order: 18 },
    },
    // 票面影像:create 态无宿主 id,面板自身显示提示,无需在此分支
    extraContent: (mode, row) => (
      <SynieAttachmentPanel
        ownerType="acc_bill"
        ownerId={row?.id as string | undefined}
        category="original"
        readonly={mode === 'view'}
      />
    ),
  },
  accBillTransactions: { label: '承兑交易' },
  accBillHoldings: { label: '持有承兑' },
  accBankReconciliations: { label: '对账记录' },
  // 文件速览:存储配置/对象键是实现细节,不进详情
  sysFiles: { label: '文件', exclude: ['storage', 'key'] },
  sysStorages: { label: '存储接入' },
}

/** 取资源抽屉配置;extra 覆盖时 fields 按字段名深合一层,其余浅覆盖 */
export function drawerConfig(resource: string, extra?: Partial<ResourceDrawerConfig>): ResourceDrawerConfig {
  const base = registry[resource] ?? { label: resource }
  if (!extra) return base
  return { ...base, ...extra, fields: { ...base.fields, ...extra.fields } }
}
