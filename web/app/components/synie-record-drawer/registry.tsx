import { Label, ListBox, Select, TextArea, TextField } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import { currencyClient } from '~/lib/resources/currencies'
import { marketInstrumentClient } from '~/lib/resources/market'
import { unitClient } from '~/lib/resources/units'
import { SynieAttachmentPanel } from '../synie-attachment-panel/SynieAttachmentPanel'
import { RemoteSelect } from '../synie-remote-select/RemoteSelect'
import type { SynieRecordDrawerProps } from './SynieRecordDrawer'

/**
 * 资源级抽屉配置:每个资源一份可全局引用的 SynieRecordDrawer 定制。
 * fk 速览(FkPreviewProvider)按 resource 取用;页面用 {...drawerConfig('资源名')}
 * 引用同一份,页面级差异(onSubmit、动态 fields)在 JSX 上继续覆盖。
 */
export type ResourceDrawerConfig = Pick<
  SynieRecordDrawerProps,
  'exclude' | 'fields' | 'contentClassName' | 'extraContent' | 'tabs'
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
      // 内置标记仅迁移种子可写(create 不收),表单/详情不展示(同 sysStorages 先例)
      builtin: { visible: () => false },
    },
  },
  // 字段/exclude/placeholder/filterState 由 Resource Catalog Basic Form 投影（页面经 basicFormDrawerProps）
  basCompanies: { label: '公司' },
  basCurrencies: { label: '货币' },
  basUnits: { label: '单位' },
  purSuppliers: { label: '供应商' },
  // 字段/effects 由 basAccounts Presentation Extension 拥有（页面经 createAccountPresentation）
  basAccounts: { label: '科目' },
  basMarketInstruments: {
    label: '行情品种',
    fields: {
      code: { required: true, edit: 'createOnly', placeholder: '如 SHFE_CU' },
      name: { required: true, placeholder: '如 沪铜' },
      sourceType: { required: true },
      defaultPriceKind: { required: true },
      currencyId: {
        required: true,
        edit: 'createOnly',
        remote: {
          client: currencyClient,
          filterState: { active: { kind: 'bool', eq: true } },
        },
      },
      unitId: { required: true, edit: 'createOnly', remote: { client: unitClient } },
      fetchEnabled: {},
      externalLastCode: { placeholder: '主连如 CU0' },
      externalProductGroup: { placeholder: '上期所组如 cu' },
    },
  },
  basMarketPricePoints: {
    label: '行情价点',
    // 价点不可改:无编辑态表单;币种/单位由品种继承
    exclude: ['currencyId', 'unitId', 'isVoided', 'insertedAt', 'updatedAt'],
    fields: {
      instrumentId: {
        required: true,
        edit: 'createOnly',
        remote: { client: marketInstrumentClient },
      },
      observedAt: { required: true, edit: 'createOnly' },
      price: { required: true, edit: 'createOnly' },
      priceKind: { edit: 'createOnly' },
      source: { edit: 'createOnly' },
      note: { edit: 'createOnly' },
    },
  },
  salCustomers: { label: '客户' },
  salOrders: {
    label: '销售订单',
    // 条目表 8 列,默认 480px 太挤,订单抽屉加宽(移动端仍全宽)
    contentClassName: 'w-full lg:w-[880px]',
    // 状态翻转走行内动作(audit/close/void);审核时间/审核人/录入人是系统字段;
    // 双币含税总额是行聚合,只在表格展示;创建/更新时间表格已隐藏
    exclude: [
      'status',
      'auditedAt',
      'auditedById',
      'createdById',
      'grossTotal',
      'baseGrossTotal',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      // 公司提到最前;建后不可改(update 动作不收 company_id)
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      // 编号可留空自动取号(后端 AutoNumber:sales.order 编号规则),前端不标必填
      orderNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      orderDate: { order: 1, cols: 6, required: true },
      // 订单对手限客户/内部公司(供应商留给采购单);meta 枚举是全量三值,自定义下拉只放两类
      partyType: {
        order: 2,
        cols: 6,
        required: true,
        label: '对手类型',
        // 切换对手类型时清掉已选对手,避免客户 id 挂在公司数据源下
        effects: () => ({ partyId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="CUSTOMER" id="CUSTOMER" textValue="客户">
                  客户
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手',
        // 未选对手类型时不出现;选定后数据源跟随类型(多态 fk,同凭证分录行先例)
        visible: (values) => values.partyType === 'CUSTOMER' || values.partyType === 'COMPANY',
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'salCustomers'}
              label="对手"
              placeholder={isCompany ? '选择内部公司…' : '选择客户…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      // 币种(原币)一单一币;仅启用币种可选;汇率原币→本币,本币单强制 1(动态默认/显隐在订单页按公司本币叠加)
      currencyId: {
        order: 4,
        cols: 6,
        required: true,
        label: '币种',
        remote: { filterState: { active: { kind: 'bool', eq: true } } },
      },
      exchangeRate: { order: 5, cols: 6, label: '汇率', placeholder: '如 7.25' },
      remarks: { order: 6, label: '订单备注' },
      // 交易条款是对客户的自由多行文本,置表单底部
      terms: {
        order: 7,
        label: '交易条款',
        input: ({ value, onChange, isDisabled }) => (
          <TextField value={value == null ? '' : String(value)} onChange={onChange} isDisabled={isDisabled}>
            <Label>交易条款</Label>
            <TextArea rows={4} placeholder="对客户展示的交易条款,如交付、付款、验收约定" />
          </TextField>
        ),
      },
    },
  },
  salOrderItems: { label: '订单条目' },
  salQuotations: {
    label: '销售报价单',
    // 条目表含梯度概要列,默认 480px 太挤,报价抽屉加宽(移动端仍全宽)
    contentClassName: 'w-full lg:w-[880px]',
    // 状态翻转走行内动作(audit/void);审核时间/审核人/录入人是系统字段;创建/更新时间表格已隐藏
    exclude: ['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      // 公司提到最前;建后不可改(update 动作不收 company_id)
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      // 编号可留空自动取号(后端 AutoNumber:sales.quotation 编号规则),前端不标必填
      quotationNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      quotationDate: { order: 1, cols: 6, required: true },
      // 截止当日仍有效;过期是派生展示态,不落库
      validUntil: { order: 2, cols: 6, required: true, label: '报价截止' },
      // 报价对手限客户/内部公司(同销售订单);meta 枚举是全量三值,自定义下拉只放两类
      partyType: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手类型',
        // 切换对手类型时清掉已选对手,避免客户 id 挂在公司数据源下
        effects: () => ({ partyId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="CUSTOMER" id="CUSTOMER" textValue="客户">
                  客户
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 4,
        cols: 6,
        required: true,
        label: '对手',
        // 未选对手类型时不出现;选定后数据源跟随类型(多态 fk,同销售订单先例)
        visible: (values) => values.partyType === 'CUSTOMER' || values.partyType === 'COMPANY',
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'salCustomers'}
              label="对手"
              placeholder={isCompany ? '选择内部公司…' : '选择客户…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      // 一单一币,默认单据公司本币;仅启用币种可选;报价单无金额,不挂汇率不做双币
      currencyId: {
        order: 5,
        cols: 6,
        required: true,
        label: '币种',
        remote: { filterState: { active: { kind: 'bool', eq: true } } },
      },
      remarks: { order: 6, label: '报价备注' },
      // 报价条款是对客户的自由多行文本,置表单底部
      terms: {
        order: 7,
        label: '报价条款',
        input: ({ value, onChange, isDisabled }) => (
          <TextField value={value == null ? '' : String(value)} onChange={onChange} isDisabled={isDisabled}>
            <Label>报价条款</Label>
            <TextArea rows={4} placeholder="对客户展示的报价条款,如付款、交付、有效条件约定" />
          </TextField>
        ),
      },
    },
  },
  salQuotationItems: { label: '报价条目' },
  salQuotationTiers: { label: '价格档' },
  purQuotations: {
    label: '采购报价单',
    // 条目表含梯度概要列,默认 480px 太挤,报价抽屉加宽(移动端仍全宽)
    contentClassName: 'w-full lg:w-[880px]',
    // 状态翻转走行内动作(audit/void);审核时间/审核人/录入人是系统字段;创建/更新时间表格已隐藏
    exclude: ['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      // 公司提到最前;建后不可改(update 动作不收 company_id)
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      // 编号可留空自动取号(后端 AutoNumber:purchase.quotation 编号规则),前端不标必填
      quotationNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      quotationDate: { order: 1, cols: 6, required: true },
      // 截止当日仍有效;过期是派生展示态,不落库
      validUntil: { order: 2, cols: 6, required: true, label: '报价截止' },
      // 报价对手限供应商/内部公司(同采购订单);meta 枚举是全量三值,自定义下拉只放两类
      partyType: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手类型',
        // 切换对手类型时清掉已选对手,避免供应商 id 挂在公司数据源下
        effects: () => ({ partyId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="SUPPLIER" id="SUPPLIER" textValue="供应商">
                  供应商
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 4,
        cols: 6,
        required: true,
        label: '对手',
        // 未选对手类型时不出现;选定后数据源跟随类型(多态 fk,同销售报价先例)
        visible: (values) => values.partyType === 'SUPPLIER' || values.partyType === 'COMPANY',
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'purSuppliers'}
              label="对手"
              placeholder={isCompany ? '选择内部公司…' : '选择供应商…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      // 一单一币,默认单据公司本币;仅启用币种可选;报价单无金额,不挂汇率不做双币
      currencyId: {
        order: 5,
        cols: 6,
        required: true,
        label: '币种',
        remote: { filterState: { active: { kind: 'bool', eq: true } } },
      },
      remarks: { order: 6, label: '报价备注' },
      // 报价条款是对供应商的自由多行文本,置表单底部
      terms: {
        order: 7,
        label: '报价条款',
        input: ({ value, onChange, isDisabled }) => (
          <TextField value={value == null ? '' : String(value)} onChange={onChange} isDisabled={isDisabled}>
            <Label>报价条款</Label>
            <TextArea rows={4} placeholder="对供应商展示的报价条款,如付款、交付、有效条件约定" />
          </TextField>
        ),
      },
    },
  },
  purQuotationItems: { label: '采购报价条目' },
  purQuotationTiers: { label: '采购报价价格档' },
  purOrders: {
    label: '采购订单',
    // 条目表 8 列,默认 480px 太挤,订单抽屉加宽(移动端仍全宽)
    contentClassName: 'w-full lg:w-[880px]',
    // 状态翻转走行内动作(audit/close/void);审核时间/审核人/录入人是系统字段;
    // 双币含税总额是行聚合,只在表格展示;创建/更新时间表格已隐藏
    exclude: [
      'status',
      'auditedAt',
      'auditedById',
      'createdById',
      'grossTotal',
      'baseGrossTotal',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      // 公司提到最前;建后不可改(update 动作不收 company_id)
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      // 编号可留空自动取号(后端 AutoNumber:purchase.order 编号规则),前端不标必填
      orderNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      orderDate: { order: 1, cols: 6, required: true },
      // 订单对手限供应商/内部公司;meta 枚举是全量三值,自定义下拉只放两类
      partyType: {
        order: 2,
        cols: 6,
        required: true,
        label: '对手类型',
        // 切换对手类型时清掉已选对手,避免供应商 id 挂在公司数据源下
        effects: () => ({ partyId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="SUPPLIER" id="SUPPLIER" textValue="供应商">
                  供应商
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手',
        // 未选对手类型时不出现;选定后数据源跟随类型(多态 fk,同销售订单先例)
        visible: (values) => values.partyType === 'SUPPLIER' || values.partyType === 'COMPANY',
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'purSuppliers'}
              label="对手"
              placeholder={isCompany ? '选择内部公司…' : '选择供应商…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      // 币种(原币)一单一币;仅启用币种可选;汇率原币→本币,本币单强制 1(动态默认/显隐在订单页按公司本币叠加)
      currencyId: {
        order: 4,
        cols: 6,
        required: true,
        label: '币种',
        remote: { filterState: { active: { kind: 'bool', eq: true } } },
      },
      exchangeRate: { order: 5, cols: 6, label: '汇率', placeholder: '如 7.25' },
      remarks: { order: 6, label: '订单备注' },
      // 交易条款是对供应商的自由多行文本,置表单底部
      terms: {
        order: 7,
        label: '交易条款',
        input: ({ value, onChange, isDisabled }) => (
          <TextField value={value == null ? '' : String(value)} onChange={onChange} isDisabled={isDisabled}>
            <Label>交易条款</Label>
            <TextArea rows={4} placeholder="对供应商展示的交易条款,如交付、付款、验收约定" />
          </TextField>
        ),
      },
    },
  },
  purOrderItems: { label: '采购订单条目' },
  purReceipts: {
    label: '采购入库单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: ['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      receiptNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      receiptDate: { order: 1, cols: 6, required: true },
      postingDate: { order: 2, cols: 6, label: '过账日期' },
      partyType: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手类型',
        effects: () => ({ partyId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="SUPPLIER" id="SUPPLIER" textValue="供应商">
                  供应商
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 4,
        cols: 6,
        required: true,
        label: '对手',
        visible: (values) => values.partyType === 'SUPPLIER' || values.partyType === 'COMPANY',
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'purSuppliers'}
              label="对手"
              placeholder={isCompany ? '选择内部公司…' : '选择供应商…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      warehouseId: { order: 5, cols: 6, label: '默认仓库(可空)' },
      remarks: { order: 6, label: '备注' },
      // 借贷科目在条目表下方渲染(见入库抽屉 extraContent);hidden=不占主栅格但仍必填/提交
      debitAccountId: { order: 100, cols: 6, required: true, label: '借方科目', hidden: true },
      creditAccountId: {
        order: 101,
        cols: 6,
        required: true,
        label: '贷方科目(未开票应付)',
        hidden: true,
      },
    },
  },
  purReceiptItems: { label: '入库条目' },
  purOutsourcedReceipts: {
    label: '委外入库单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: ['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      receiptNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      receiptDate: { order: 1, cols: 6, required: true, label: '入库日期' },
      postingDate: { order: 2, cols: 6, label: '过账日期' },
      partyType: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手类型',
        effects: () => ({ partyId: null, outsourcedWarehouseId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="SUPPLIER" id="SUPPLIER" textValue="供应商">
                  供应商
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 4,
        cols: 6,
        required: true,
        label: '对手(协作方)',
        visible: (values) => values.partyType === 'SUPPLIER' || values.partyType === 'COMPANY',
        effects: () => ({ outsourcedWarehouseId: null }),
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'purSuppliers'}
              label="对手(协作方)"
              placeholder={isCompany ? '选择内部公司…' : '选择供应商…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      // 两仓均为可空头仓:默认入仓=成品行/副产物行新建与带出预填;默认外协仓=材料扣减行带出预填;
      // 选择器需读对手/公司上下文,定制输入在委外入库抽屉里覆盖
      warehouseId: { order: 5, cols: 6, label: '默认入仓(可空)' },
      outsourcedWarehouseId: { order: 6, cols: 6, label: '默认外协仓(可空)' },
      remarks: { order: 7, label: '备注' },
      // 借贷科目在条目表下方渲染(见委外入库抽屉 extraContent);hidden=不占主栅格但仍必填/提交
      debitAccountId: { order: 100, cols: 6, required: true, label: '借方科目', hidden: true },
      creditAccountId: {
        order: 101,
        cols: 6,
        required: true,
        label: '贷方科目(未开票应付)',
        hidden: true,
      },
    },
  },
  purOutsourcedReceiptItems: { label: '委外入库条目' },
  purOutsourcedReceiptItemMaterials: { label: '委外入库材料扣减行' },
  purOutsourcedReceiptItemByproducts: { label: '委外入库副产物行' },
  purOutsourcedIssues: {
    label: '委外发料单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: ['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      issueNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      issueDate: { order: 1, cols: 6, required: true, label: '发料日期' },
      partyType: {
        order: 2,
        cols: 6,
        required: true,
        label: '对手类型',
        effects: () => ({ partyId: null, outsourcedWarehouseId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="SUPPLIER" id="SUPPLIER" textValue="供应商">
                  供应商
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手(协作方)',
        visible: (values) => values.partyType === 'SUPPLIER' || values.partyType === 'COMPANY',
        effects: () => ({ outsourcedWarehouseId: null }),
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'purSuppliers'}
              label="对手(协作方)"
              placeholder={isCompany ? '选择内部公司…' : '选择供应商…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      // 两仓均为可空头仓(仅新建行预填);选择器需读对手上下文,定制输入在发料抽屉里覆盖
      fromWarehouseId: { order: 4, cols: 6, label: '默认调出仓(可空)' },
      outsourcedWarehouseId: { order: 5, cols: 6, label: '默认外协仓(可空)' },
      remarks: { order: 6, label: '备注' },
    },
  },
  purOutsourcedIssueItems: { label: '委外发料条目' },
  purReconciliations: {
    label: '采购对账单',
    contentClassName: 'w-full lg:w-[960px]',
    // 状态翻转走行内动作(confirm/unconfirm/audit/void);双币含税合计是行聚合,只在表格/条目表底部展示;
    // 录入人/创建/更新时间是系统字段
    exclude: [
      'status',
      'createdById',
      'grossTotal',
      'baseGrossTotal',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      // 公司提到最前;建后不可换(update 动作不收 company_id)
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      // 编号可留空自动取号(后端 AutoNumber:purchase.reconciliation 编号规则),前端不标必填
      reconciliationNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      // 对账类型手选必填、保存后锁死(换类型删单/作废重开,后端 ReconciliationTypeLocked 同口径)
      reconciliationType: {
        order: 1,
        cols: 6,
        required: true,
        edit: 'createOnly',
        label: '对账类型',
      },
      // 对手限供应商/内部公司(与采购入库同);meta 枚举是全量三值,自定义下拉只放两类
      partyType: {
        order: 2,
        cols: 6,
        required: true,
        label: '对手类型',
        effects: () => ({ partyId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="SUPPLIER" id="SUPPLIER" textValue="供应商">
                  供应商
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手',
        visible: (values) => values.partyType === 'SUPPLIER' || values.partyType === 'COMPANY',
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'purSuppliers'}
              label="对手"
              placeholder={isCompany ? '选择内部公司…' : '选择供应商…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      // 过账日期仅赠送/样品单结单过账用(有金额必填,未填默认结单当日);常规单不展示
      postingDate: {
        order: 4,
        cols: 6,
        label: '过账日期',
        visible: (values) => values.reconciliationType === 'GIFT_SAMPLE',
      },
      remarks: { order: 6, label: '备注' },
      // 借贷科目在条目表下方渲染(见对账抽屉 extraContent);hidden=不占主栅格但仍必填/提交
      debitAccountId: {
        order: 100,
        cols: 6,
        required: true,
        label: '借方科目(未开票应付)',
        hidden: true,
      },
      creditAccountId: { order: 101, cols: 6, required: true, label: '贷方科目', hidden: true },
    },
  },
  purReconciliationItems: { label: '对账条目' },
  hrAttendancePunches: { label: '打卡记录' },
  hrAttendanceImports: { label: '考勤导入' },
  // 字段/身份证影像由 hrEmployees Presentation Extension 拥有
  hrEmployees: { label: '员工' },
  mfgOperations: {
    label: '工序',
    fields: {
      // 编号可留空自动取号(后端 AutoNumber:mfg.operation),创建后不可改(update 不收 code)
      code: { order: 0, cols: 6, edit: 'createOnly', placeholder: '留空自动编号' },
      name: { order: 1, cols: 6, required: true, placeholder: '如 冲网' },
      note: { order: 2 },
    },
  },
  mfgProcessTemplates: {
    label: '工艺模板',
    // 工艺步骤 4 列,默认 480px 太挤,模板抽屉加宽(同物料先例;移动端仍全宽)
    contentClassName: 'w-full lg:w-[760px]',
    // 两 tab:基本信息(字段)、工艺步骤(页面 tabExtraContent)
    tabs: [
      { key: 'basic', label: '基本信息' },
      { key: 'items', label: '工艺步骤' },
    ],
    fields: {
      // 编号可留空自动取号(后端 AutoNumber:mfg.route_template),创建后不可改
      code: { order: 0, cols: 6, edit: 'createOnly', placeholder: '留空自动编号' },
      name: { order: 1, cols: 6, required: true, placeholder: '如 冲网标准工艺' },
      note: { order: 2 },
      // view 态时间戳收编出业务分组并垫底(同物料先例)
      insertedAt: { order: 98, section: '' },
      updatedAt: { order: 99 },
    },
  },
  mfgProcessTemplateItems: { label: '工艺步骤' },
  mfgBoms: {
    label: 'BOM',
    // 配料 5 列,默认 480px 太挤,BOM 抽屉加宽(同订单先例;移动端仍全宽)
    contentClassName: 'w-full lg:w-[880px]',
    // 四 tab:基本信息(字段)、配料/工艺路线/副产品(页面 tabExtraContent)
    tabs: [
      { key: 'basic', label: '基本信息' },
      { key: 'components', label: '配料' },
      { key: 'routes', label: '工艺路线' },
      { key: 'byproducts', label: '副产品' },
    ],
    fields: {
      // 编号留空自动取号(后端 AutoNumber:mfg.bom),创建后不可改(update 不收 code)
      code: { order: 0, cols: 6, edit: 'createOnly', placeholder: '留空自动编号' },
      // 方案名称可空:同物料多张 BOM 的区分辅助(列表/选择器)
      planName: { order: 1, cols: 6, placeholder: '如 自用 / 委外' },
      // BOM 建后不可换物料(update 不收 material_id,换物料=删旧建新);物料量大走弹窗选择
      materialId: { order: 2, required: true, edit: 'createOnly', picker: 'dialog' },
      note: { order: 3 },
      // view 态时间戳收编出业务分组并垫底(同物料先例)
      insertedAt: { order: 98, section: '' },
      updatedAt: { order: 99 },
    },
  },
  mfgBomComponents: { label: '配料' },
  mfgBomRoutes: { label: '工艺路线' },
  mfgBomByproducts: { label: '副产品' },
  mfgDemands: {
    label: '履约需求单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: ['status', 'createdById', 'insertedAt', 'updatedAt'],
    tabs: [
      { key: 'basic', label: '基本信息' },
      { key: 'items', label: '需求行' },
    ],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      demandNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      demandDate: { order: 1, cols: 6, required: true },
      remarks: { order: 2 },
    },
  },
  mfgDemandItems: { label: '需求行' },
  mfgWorkOrders: {
    label: '生产工单',
    exclude: ['status', 'createdById', 'insertedAt', 'updatedAt', 'qty', 'baseQty', 'receivedBaseQty'],
    fields: {
      workOrderNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      demandItemId: { order: 1, required: true, edit: 'createOnly', label: '来源需求行' },
      materialId: { order: 2, edit: 'readOnly' },
      needDate: { order: 3, edit: 'readOnly' },
      materialCode: { order: 4, edit: 'readOnly' },
      materialName: { order: 5, edit: 'readOnly' },
      unitName: { order: 6, edit: 'readOnly' },
    },
  },
  mfgOutputs: {
    label: '生产入库单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: ['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    tabs: [
      { key: 'basic', label: '基本信息' },
      { key: 'items', label: '入库行' },
    ],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      outputNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      outputDate: { order: 1, cols: 6, required: true },
      warehouseId: { order: 2, label: '默认仓库' },
      remarks: { order: 3 },
    },
  },
  mfgOutputItems: { label: '入库行' },
  // mfgSetting 历史拼写已删除；服务端/client 为 mfgSettings，设置页专用表单不经 drawer
  mfgSettings: { label: '生产设置' },
  // 字段/tabs/effects 由 invMaterials Presentation Extension 拥有
  invMaterials: { label: '物料' },
  invMaterialUnits: { label: '单位转换' },
  invWarehouses: { label: '仓库' },
  invStockDocs: {
    label: '手工出入库单',
    // 行表格 6 列,默认 480px 太挤,单据抽屉加宽(同销售订单先例;移动端仍全宽)
    contentClassName: 'w-full lg:w-[880px]',
    // 状态翻转走行内动作(audit/void);审核时间/审核人/录入人是系统字段;创建/更新时间表格已隐藏
    exclude: ['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      // 公司提到最前;建后不可换(update 动作不收 company_id)
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      // 方向新建必选默认「入库」,编辑态锁死(后端 StockDocDirectionLocked 同口径)
      direction: { required: true, order: 0, cols: 6, defaultValue: 'IN', edit: 'createOnly' },
      // 编号可留空自动取号(后端 AutoNumber:inv.stock_doc 编号规则),前端不标必填
      docNo: { order: 1, cols: 6, placeholder: '留空自动编号' },
      docDate: { order: 2, cols: 6, required: true },
      // 仓候选限本公司启用叶子仓(与后端 WarehouseUsable 同口径,页面层按公司叠 filter)
      warehouseId: { order: 3, required: true, label: '仓库' },
      summary: { order: 4, label: '摘要', placeholder: '货从哪来/到哪去(带入库存分录)' },
      remarks: { order: 5, label: '备注' },
    },
  },
  invStockDocItems: { label: '出入库行' },
  salDeliveries: {
    label: '销售发货单',
    contentClassName: 'w-full lg:w-[960px]',
    exclude: ['status', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      deliveryNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      deliveryDate: { order: 1, cols: 6, required: true },
      postingDate: { order: 2, cols: 6, label: '过账日期' },
      partyType: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手类型',
        effects: () => ({ partyId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="CUSTOMER" id="CUSTOMER" textValue="客户">
                  客户
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 4,
        cols: 6,
        required: true,
        label: '对手',
        visible: (values) => values.partyType === 'CUSTOMER' || values.partyType === 'COMPANY',
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'salCustomers'}
              label="对手"
              placeholder={isCompany ? '选择内部公司…' : '选择客户…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      warehouseId: { order: 5, cols: 6, label: '默认仓库(可空)' },
      remarks: { order: 6, label: '备注' },
      // 借贷科目在条目表下方渲染(见发货抽屉 extraContent);hidden=不占主栅格但仍必填/提交
      debitAccountId: {
        order: 100,
        cols: 6,
        required: true,
        label: '借方科目(未开票应收)',
        hidden: true,
      },
      creditAccountId: { order: 101, cols: 6, required: true, label: '贷方科目', hidden: true },
    },
  },
  salDeliveryItems: { label: '发货条目' },
  salReconciliations: {
    label: '销售对账单',
    contentClassName: 'w-full lg:w-[960px]',
    // 状态翻转走行内动作(confirm/unconfirm/audit/void);双币含税合计是行聚合,只在表格/条目表底部展示;
    // 录入人/创建/更新时间是系统字段
    exclude: [
      'status',
      'createdById',
      'grossTotal',
      'baseGrossTotal',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      // 公司提到最前;建后不可换(update 动作不收 company_id)
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      // 编号可留空自动取号(后端 AutoNumber:sales.reconciliation 编号规则),前端不标必填
      reconciliationNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      // 对账类型手选必填、保存后锁死(换类型删单/作废重开,后端 ReconciliationTypeLocked 同口径)
      reconciliationType: {
        order: 1,
        cols: 6,
        required: true,
        edit: 'createOnly',
        label: '对账类型',
      },
      // 对手限客户/内部公司(与销售发货同);meta 枚举是全量三值,自定义下拉只放两类
      partyType: {
        order: 2,
        cols: 6,
        required: true,
        label: '对手类型',
        effects: () => ({ partyId: null }),
        input: ({ value, onChange, isDisabled }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>对手类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="CUSTOMER" id="CUSTOMER" textValue="客户">
                  客户
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="COMPANY" id="COMPANY" textValue="内部公司">
                  内部公司
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      partyId: {
        order: 3,
        cols: 6,
        required: true,
        label: '对手',
        visible: (values) => values.partyType === 'CUSTOMER' || values.partyType === 'COMPANY',
        input: ({ value, onChange, isDisabled, values }) => {
          const isCompany = values.partyType === 'COMPANY'
          return (
            <RemoteSelect
              resource={isCompany ? 'basCompanies' : 'salCustomers'}
              label="对手"
              placeholder={isCompany ? '选择内部公司…' : '选择客户…'}
              value={value == null ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled}
            />
          )
        },
      },
      // 过账日期仅赠送/样品单结单过账用(有金额必填,未填默认结单当日);常规单不展示
      postingDate: {
        order: 4,
        cols: 6,
        label: '过账日期',
        visible: (values) => values.reconciliationType === 'GIFT_SAMPLE',
      },
      remarks: { order: 6, label: '备注' },
      // 借贷科目在条目表下方渲染(见对账抽屉 extraContent);hidden=不占主栅格但仍必填/提交
      debitAccountId: { order: 100, cols: 6, required: true, label: '借方科目', hidden: true },
      creditAccountId: {
        order: 101,
        cols: 6,
        required: true,
        label: '贷方科目(未开票应收)',
        hidden: true,
      },
    },
  },
  salReconciliationItems: { label: '对账条目' },
  invStockTransfers: {
    label: '手工调拨单',
    contentClassName: 'w-full lg:w-[880px]',
    // 状态流转走行内动作(ship/receive);各时间点/操作人是系统字段;创建/更新时间表格已隐藏
    exclude: [
      'status',
      'shippedAt',
      'shippedById',
      'receivedAt',
      'receivedById',
      'createdById',
      'insertedAt',
      'updatedAt',
    ],
    fields: {
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      docNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      docDate: { order: 1, cols: 6, required: true },
      // 三仓候选均限本公司启用叶子仓(后端 WarehouseUsable 同口径,页面层按公司叠 filter);
      // 在途仓由页面层按公司种子仓("{code} - 在途")默认预填
      fromWarehouseId: { order: 2, cols: 6, required: true, label: '调出仓库' },
      toWarehouseId: { order: 3, cols: 6, required: true, label: '调入仓库' },
      transitWarehouseId: { order: 4, cols: 6, required: true, label: '在途仓库' },
      summary: { order: 5, label: '摘要' },
      remarks: { order: 6, label: '备注' },
    },
  },
  invStockTransferItems: { label: '手工调拨行' },
  invStockCounts: {
    label: '库存盘点单',
    // 行表格 6 列(含差异计算列),默认 480px 太挤,单据抽屉加宽(同手工出入库单先例;移动端仍全宽)
    contentClassName: 'w-full lg:w-[880px]',
    // 状态翻转走行内动作(approve/cancel);账面快照时间/审核时间/审核人/录入人是系统字段;创建/更新时间表格已隐藏
    exclude: ['status', 'snapshotTakenAt', 'auditedAt', 'auditedById', 'createdById', 'insertedAt', 'updatedAt'],
    fields: {
      // 公司提到最前;建后不可换(update 动作不收 company_id)
      companyId: { required: true, order: -1, cols: 6, edit: 'createOnly' },
      // 编号可留空自动取号(后端 AutoNumber:inv.stock_count 编号规则),前端不标必填
      docNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
      postingDate: { order: 1, cols: 6, required: true },
      // 仓候选限本公司启用叶子仓(与后端 WarehouseUsable 同口径,页面层按公司叠 filter)
      warehouseId: { order: 2, required: true, label: '仓库' },
      summary: { order: 3, label: '摘要' },
      remarks: { order: 4, label: '备注' },
    },
  },
  invStockCountItems: { label: '盘点行' },
  invStockEntries: { label: '库存分录' },
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
  accExpenseReports: { label: '报销单' },
  accExpenseReportItems: { label: '报销行' },
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
  sysPrintTemplates: { label: '打印模板' },
}

/** 取资源抽屉配置;extra 覆盖时 fields 按字段名深合一层,其余浅覆盖 */
export function drawerConfig(resource: string, extra?: Partial<ResourceDrawerConfig>): ResourceDrawerConfig {
  const base = registry[resource] ?? { label: resource }
  if (!extra) return base
  return { ...base, ...extra, fields: { ...base.fields, ...extra.fields } }
}
