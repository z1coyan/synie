import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/entries')({
  component: EntriesPage,
})

function EntriesPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [viewRow, setViewRow] = useState<Row | null>(null)

  const companies = useQuery({
    queryKey: ['entriesCompanies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { count: number; results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { count results { id name } } }`
      ).then((d) => d.basCompanies),
  })

  useEffect(() => {
    if (companyId == null && companies.data?.count === 1) {
      const only = companies.data.results[0]
      setCompanyId(only.id)
      setCompanyRow(only)
    }
  }, [companies.data, companyId])

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">总账分录</h1>
      <p className="mt-2 text-sm text-ink-500">按公司查询总账分录明细,来源单据审核后自动生成,只读不可编辑。</p>

      <div className="mt-6 max-w-xs">
        <RemoteSelect
          resource="basCompanies"
          label="公司"
          placeholder="选择公司…"
          value={companyId}
          initialRows={companyRow ? [companyRow] : (companies.data?.results ?? [])}
          onChange={(id, row) => {
            setCompanyId(id)
            setCompanyRow(row)
          }}
        />
      </div>

      <div className="mt-6">
        {companyId == null ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>请先选择公司</EmptyState.Title>
              <EmptyState.Description>总账分录按公司维护,选择公司后查看明细。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={companyId}
            resource="accGlEntries"
            fixedFilter={{ companyId: { eq: companyId } }}
            onView={(row) => setViewRow(row)}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="accGlEntries"
        label="分录"
        mode="view"
        isOpen={viewRow !== null}
        onOpenChange={(open) => !open && setViewRow(null)}
        row={viewRow}
      />
    </>
  )
}
