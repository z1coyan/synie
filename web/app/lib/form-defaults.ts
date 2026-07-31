/**
 * 新建表单通用默认值：授权公司、业务日。
 *
 * 公司：列筛恰好 1 家 → 授权公司列表第一家（按 code 升序）→ 空。
 * 业务日：见 BUSINESS_DATE_FIELDS；过账日/到期日/交期等不在此列。
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { companyClient } from '~/lib/resources/companies'

/** 本地日历日 YYYY-MM-DD（不用 toISOString：UTC 串在 UTC+8 凌晨会差一天） */
export function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 业务日字段名：新建默认今天。
 * 不含 postingDate（过账日常审核时再填）、validUntil/dueDate/needDate（面向未来）。
 */
export const BUSINESS_DATE_FIELDS = new Set([
  'orderDate',
  'quotationDate',
  'receiptDate',
  'deliveryDate',
  'issueDate',
  'docDate',
  'demandDate',
  'expenseDate',
  'outputDate',
  'invoiceDate',
  'date',
])

export function isBusinessDateField(name: string): boolean {
  return BUSINESS_DATE_FIELDS.has(name)
}

/** 新建公司默认：列筛恰好 1 家 → 授权列表第一家 → 空 */
export function defaultCompanyId(
  filters: FilterState | undefined,
  companies: Row[],
): string | null {
  const f = filters?.companyId
  if (f?.kind === 'fk' && f.values.length === 1) return f.values[0]
  if (companies.length >= 1) return companies[0].id
  return null
}

const COMPANIES_QUERY_KEY = ['form-defaults', 'authorized-companies'] as const

/** 授权公司列表（按 code 升序）；多页共用同一 queryKey 避免重复请求 */
export function useAuthorizedCompanies(enabled = true) {
  return useQuery({
    queryKey: COMPANIES_QUERY_KEY,
    enabled,
    staleTime: 60_000,
    queryFn: () =>
      companyClient
        .query({
          limit: 50,
          offset: 0,
          sort: { column: 'code', direction: 'ascending' },
        })
        .then((result) => result.results),
  })
}

/**
 * create 态公司默认值回填：表单 defaultValue 只在挂载时读一次，
 * 公司列表异步到达后由本组件补丁写入。
 */
export function CompanyDefaultSync({
  mode,
  values,
  patchValues,
  defaultId,
}: {
  mode: DrawerMode
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
  defaultId: string | null
}) {
  useEffect(() => {
    if (mode !== 'create' || defaultId == null) return
    if (values.companyId != null && values.companyId !== '') return
    patchValues({ companyId: defaultId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, defaultId, values.companyId])
  return null
}
