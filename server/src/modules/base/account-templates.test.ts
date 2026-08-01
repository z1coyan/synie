import { describe, expect, test } from 'bun:test'
import { accountResourceMeta } from './meta.ts'
import templateData from './templates.json'

type TemplateEntry = {
  code: string
  name: string
  direction: string
  is_group: boolean
  parent: string | null
  role: string | null
}

const templates = templateData as Record<string, TemplateEntry[]>

/**
 * 现有业务表单会按这些角色筛选或自动带出科目；每套默认模板必须各有且仅有
 * 一个叶子科目，否则新建公司完成建账后仍无法直接录入对应单据。
 */
const FORM_REQUIRED_ROLES = {
  unbilled_receivable: '销售发货、销售对账与公司默认过账科目',
  unbilled_payable: '采购入库、委外入库、采购对账与公司默认过账科目',
  other_payable: '费用报销发票',
  travel: '费用报销与费用报销发票（差旅费）',
  office: '费用报销与费用报销发票（办公费）',
  entertainment: '费用报销与费用报销发票（业务招待费）',
  transport: '费用报销与费用报销发票（交通费）',
  other_expense: '费用报销与费用报销发票（其他费用）',
} as const

/** 应收应付报表及发票往来核算依赖的其余标准角色。 */
const REPORT_REQUIRED_ROLES = {
  receivable: '应收账款',
  advance_received: '预收账款',
  payable: '应付账款',
  advance_paid: '预付账款',
} as const

const REQUIRED_ROLES = { ...FORM_REQUIRED_ROLES, ...REPORT_REQUIRED_ROLES }

const ROLE_DIRECTIONS = {
  unbilled_receivable: 'debit',
  receivable: 'debit',
  advance_received: 'credit',
  unbilled_payable: 'credit',
  payable: 'credit',
  other_payable: 'credit',
  advance_paid: 'debit',
  travel: 'debit',
  office: 'debit',
  entertainment: 'debit',
  transport: 'debit',
  other_expense: 'debit',
} as const satisfies Record<keyof typeof REQUIRED_ROLES, 'debit' | 'credit'>

describe('默认科目表模板', () => {
  test('覆盖清单与后端当前开放的科目角色一致', () => {
    const roleField = accountResourceMeta().fields.find((field) => field.apiName === 'role')
    const catalogRoles = roleField?.enumOptions?.map((option) => option.value.toLowerCase()).sort()
    expect(catalogRoles).toEqual(Object.keys(REQUIRED_ROLES).sort())
  })

  test('三套模板各自完整且唯一覆盖当前表单与报表需要的科目角色', () => {
    expect(Object.keys(templates).sort()).toEqual(['cas', 'intl', 'small'])

    const problems: string[] = []
    for (const [template, entries] of Object.entries(templates)) {
      const seen = new Map<string, TemplateEntry>()
      for (const entry of entries) {
        if (seen.has(entry.code)) problems.push(`${template}: 科目编码 ${entry.code} 重复`)
        if (entry.role && entry.role !== entry.role.toLowerCase()) {
          problems.push(`${template}: 科目 ${entry.code} 的角色不是数据库小写格式`)
        }
        if (entry.parent) {
          const parent = seen.get(entry.parent)
          if (!parent) problems.push(`${template}: 科目 ${entry.code} 的父科目不存在或排在其后`)
          else if (!parent.is_group) problems.push(`${template}: 科目 ${entry.code} 的父科目 ${entry.parent} 不是汇总科目`)
        }
        seen.set(entry.code, entry)
      }

      for (const [role, requiredBy] of Object.entries(REQUIRED_ROLES)) {
        const matches = entries.filter((entry) => entry.role?.toLowerCase() === role)
        if (matches.length !== 1) {
          problems.push(`${template}: ${role} (${requiredBy}) 实际 ${matches.length} 个`)
          continue
        }
        if (matches[0]!.is_group) {
          problems.push(`${template}: ${role} (${requiredBy}) 挂在汇总科目 ${matches[0]!.code}`)
        }
        if (matches[0]!.direction !== ROLE_DIRECTIONS[role as keyof typeof REQUIRED_ROLES]) {
          problems.push(`${template}: ${role} (${requiredBy}) 余额方向错误`)
        }
      }
    }

    expect(problems).toEqual([])
  })
})
