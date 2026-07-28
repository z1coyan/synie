import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  glEntryClient,
  glJournalClient,
  glJournalLineClient,
} from '~/lib/resources/accounting'
import { resolveSource } from '~/components/synie-remote-select/remote-query'

const read = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8')
const journals = read('journals.tsx')
const entries = read('entries.tsx')
const arAp = read('ar-ap.tsx')
const accounting = read('../../../lib/resources/accounting.ts')
const recordDrawer = read('../../../components/synie-record-drawer/SynieRecordDrawer.tsx')
const bankReconcile = read('-reconcile-drawer.tsx')

describe('PR-2.12 财务页面 REST 迁移契约', () => {
  test('三个消费面不再包含 GraphQL 请求或 operation', () => {
    for (const source of [journals, entries, arAp]) {
      expect(source).not.toContain('gqlFetch')
      expect(source).not.toContain('createAccGlJournal')
      expect(source).not.toContain('accArApReport')
    }
  })

  test('Grid、Drawer 与凭证行表显式使用 accounting REST client', () => {
    expect(journals.match(/client=\{glJournalClient\}/g)).toHaveLength(2)
    expect(journals).toContain('client={glJournalLineClient}')
    expect(entries.match(/client=\{glEntryClient\}/g)).toHaveLength(2)
    expect(arAp).toContain('fetchARAPReport(companyId!, asOf)')

    expect(glEntryClient.id).toBe('rest:accGlEntries')
    expect(glJournalClient.id).toBe('rest:accGlJournals')
    expect(glJournalLineClient.id).toBe('rest:accGlJournalLines')
  })

  test('accounting client 覆盖只读分录、头行 CRUD、审核、取消与报表路径', () => {
    for (const path of [
      "api.accounting['gl-entries'].query",
      "api.accounting['gl-entries'][':id']",
      "api.accounting['gl-journals'].query",
      "api.accounting['gl-journals'][':id']",
      "api.accounting['gl-journals'][':id'].audit",
      "api.accounting['gl-journals'][':id'].cancel",
      "api.accounting['gl-journal-lines'].query",
      "api.accounting['gl-journal-lines'][':id']",
      "api.accounting['ar-ap-report']",
    ]) {
      expect(accounting).toContain(path)
    }
    expect(accounting).toContain("body[field] = value == null || value === '' ? '0' : String(value)")
  })

  test('凭证草稿动作按状态收口，行录入支持四类往来对手 REST 候选', () => {
    expect(journals).toContain("audit: (row) => row.status === 'DRAFT'")
    expect(journals).toContain("cancel: (row) => row.status === 'AUDITED'")
    expect(journals).toContain("delete: (row) => row.status === 'DRAFT'")
    for (const marker of [
      'SUPPLIER',
      'CUSTOMER',
      'COMPANY',
      'EMPLOYEE',
      'supplierClient',
      'customerClient',
      'companyClient',
      'employeeClient',
    ]) {
      expect(journals).toContain(marker)
    }
  })

  test('AR/AP 公司候选与自动单公司选择均使用公司 REST client', () => {
    expect(arAp).toContain('companyClient.query')
    expect(arAp).toContain('client={companyClient}')
    expect(arAp).not.toContain('basCompanies(limit:')
  })

  test('共享引用、保存并审核与银行凭证候选不回退到 Journal GraphQL', () => {
    expect(resolveSource({ resource: 'accGlEntries' })?.client?.id).toBe(
      'rest:accGlEntries',
    )
    expect(resolveSource({ resource: 'accGlJournals' })?.client?.id).toBe(
      'rest:accGlJournals',
    )
    expect(resolveSource({ resource: 'accGlJournalLines' })?.client?.id).toBe(
      'rest:accGlJournalLines',
    )
    expect(recordDrawer).toContain('if (!client?.action)')
    expect(recordDrawer).toContain('await client.action(auditAction.key, [auditId])')
    expect(bankReconcile).toContain("useGridMeta('accGlJournals', true, glJournalClient)")
    expect(bankReconcile).toMatch(
      /resource="accGlJournals"\s+client=\{glJournalClient\}/,
    )
  })
})
