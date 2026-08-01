import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { findAggregateClientWriteViolations } from '../../scripts/lib/aggregate-client-write-guard'

const aggregateResources = new Set([
  'invStockDocs',
  'invStockDocItems',
  'accExpenseReports',
  'accExpenseReportItems',
])

const declarations = {
  path: 'web/app/lib/resources/example.ts',
  source: `
    export const stockDocClient = unboundResourceClient('invStockDocs')
    export const stockDocItemClient = unboundResourceClient('invStockDocItems')
    export const expenseReportClient = unboundResourceClient('accExpenseReports')
    export const currencyClient = unboundResourceClient('basCurrencies')
  `,
}

describe('Convex cutover 聚合 client 写入门禁', () => {
  test('从 unbound 声明追踪具名、import alias、namespace 与简单本地 alias', () => {
    const violations = findAggregateClientWriteViolations([
      declarations,
      {
        path: 'web/app/routes/direct.tsx',
        source: `
          import { stockDocClient as documentWriter, stockDocItemClient, currencyClient } from '~/lib/resources/example'
          await documentWriter.create({})
          await stockDocItemClient['update']('item-1', {})
          await documentWriter.query({ limit: 10 })
          await currencyClient.create({})
          const localWriter = documentWriter
          await localWriter.delete('doc-1')
        `,
      },
      {
        path: 'web/app/routes/namespace.tsx',
        source: `
          import * as resources from '~/lib/resources/example'
          await resources.expenseReportClient.update('report-1', {})
        `,
      },
    ], aggregateResources)

    expect(violations.map(({ resource, operation }) => ({ resource, operation }))).toEqual([
      { resource: 'invStockDocs', operation: 'create' },
      { resource: 'invStockDocItems', operation: 'update' },
      { resource: 'invStockDocs', operation: 'delete' },
      { resource: 'accExpenseReports', operation: 'update' },
    ])
  })

  test('聚合 client 装入通用 client 属性时 fail-closed，避免 helper alias 绕过', () => {
    const violations = findAggregateClientWriteViolations([
      declarations,
      {
        path: 'web/app/routes/escaped.tsx',
        source: `
          import { stockDocItemClient } from '~/lib/resources/example'
          saveRows({ client: stockDocItemClient })
        `,
      },
    ], aggregateResources)

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      resource: 'invStockDocItems',
      client: 'stockDocItemClient',
      operation: 'alias',
    })
  })

  test('旧库存 cfg.docClient/itemClient 写法即使无法解析 alias 也会失败', () => {
    const violations = findAggregateClientWriteViolations([{
      path: 'web/app/routes/legacy-stock.tsx',
      source: `
        await cfg.docClient.create(values)
        await cfg['itemClient'].delete('item-1')
        await cfg.reader.get('doc-1')
      `,
    }], aggregateResources)

    expect(violations.map(({ client, operation }) => ({ client, operation }))).toEqual([
      { client: 'docClient', operation: 'create' },
      { client: 'itemClient', operation: 'delete' },
    ])
  })

  test('真实 readiness 脚本扫描当前生产 Web 后为零', async () => {
    const root = resolve(import.meta.dir, '../..')
    const child = Bun.spawn([
      process.execPath,
      'scripts/check-convex-cutover-readiness.ts',
    ], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('aggregateClientWrites=0')
    expect(stdout).toContain('restBindings=0')
    expect(stderr).toBe('')
  })
})
