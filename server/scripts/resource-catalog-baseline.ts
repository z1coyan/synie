/**
 * Resource Catalog 迁移基线报告。
 *
 * 用法（仓库根或 server/）：
 *   bun server/scripts/resource-catalog-baseline.ts
 *
 * 写出：
 *   .scratch/resource-catalog/baseline/report.json
 *   .scratch/resource-catalog/baseline/report.md
 *   .scratch/resource-catalog/baseline/currency-meta.superadmin.json
 *
 * 可扩展字段（declaredCommands / adapterCommands / basicWritableFields /
 * legacyUsages / writeStubs）在后续工单填充，本脚本先占位为零。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Actor } from '../src/platform/authz/actor.ts'
import { createSealedResourceRegistry } from '../src/platform/meta/register-all.ts'
import { CURRENCY_RESOURCE_NAME } from '../src/modules/base/meta.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const outDir = join(repoRoot, '.scratch/resource-catalog/baseline')

const superAdmin: Actor = {
  userId: 'baseline',
  username: 'baseline',
  name: null,
  superAdmin: true,
  allCompanies: true,
  permissions: new Set(),
  companyIds: [],
}

/**
 * 只取对象字面量**顶层**键（进入对象时 depth=1），避免把 fields 内字段名算成资源键。
 * 行首键在本行处理 `{` 之前判定，以兼容 `name: {` 多行对象写法。
 */
function extractObjectKeys(source: string, objectStartPattern: RegExp): string[] {
  const match = source.match(objectStartPattern)
  if (!match || match.index === undefined) return []
  const from = match.index + match[0].length
  const keys: string[] = []
  let depth = 1
  let i = from
  let lineStart = from
  let lineKeyCaptured = false
  while (i < source.length && depth > 0) {
    const ch = source[i]
    if (ch === '\n') {
      lineStart = i + 1
      lineKeyCaptured = false
      i++
      continue
    }
    if (!lineKeyCaptured && depth === 1) {
      const line = source.slice(lineStart, i + 1)
      const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:/)
      if (m) {
        keys.push(m[1]!)
        lineKeyCaptured = true
      }
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  return [...new Set(keys)].sort()
}

function extractRemoteDefaultKeys(source: string): string[] {
  return extractObjectKeys(source, /const RESOURCE_DEFAULTS[^=]*=\s*\{/)
}

function main() {
  const registry = createSealedResourceRegistry()
  const resources = registry.list().slice().sort((a, b) => a.name.localeCompare(b.name))

  const serverResources = resources.map((r) => {
    const formFieldCount = r.form
      ? (r.form.exclude?.length ?? 0) + Object.keys(r.form.fields ?? {}).length
      : 0
    const nonStandardActions = r.actions.filter(
      (a) =>
        ![
          'read',
          'create',
          'update',
          'delete',
          'print',
          'import',
          'export',
          'batch_delete',
          'batch_update',
          'batch_print',
        ].includes(a.key),
    )
    return {
      name: r.name,
      permissionPrefix: r.permissionPrefix,
      permissionLabel: r.permissionLabel,
      fieldCount: r.fields.length,
      actionCount: r.actions.length,
      actionKeys: r.actions.map((a) => a.key),
      hasForm: Boolean(r.form),
      formFieldHints: formFieldCount,
      formHasSections: Boolean(r.form?.sections?.length),
      formHasTabs: Boolean(r.form?.tabs?.length),
      extendedActionKeys: nonStandardActions.map((a) => a.key),
      permissionActionMismatches: r.actions
        .filter((a) => a.permissionAction && a.permissionAction !== a.key)
        .map((a) => ({ key: a.key, permissionAction: a.permissionAction })),
    }
  })

  const clientSource = readFileSync(
    join(repoRoot, 'web/app/lib/resources/registry.ts'),
    'utf8',
  )
  const drawerSource = readFileSync(
    join(repoRoot, 'web/app/components/synie-record-drawer/registry.tsx'),
    'utf8',
  )
  const remoteSource = readFileSync(
    join(repoRoot, 'web/app/components/synie-remote-select/remote-query.ts'),
    'utf8',
  )

  const clientKeys = extractObjectKeys(clientSource, /const clients[^=]*=\s*\{/)
  const drawerKeys = extractObjectKeys(drawerSource, /const registry[^=]*=\s*\{/)
  const remoteDefaultKeys = extractRemoteDefaultKeys(remoteSource)

  const serverNames = new Set(serverResources.map((r) => r.name))
  const clientSet = new Set(clientKeys)
  const drawerSet = new Set(drawerKeys)

  const missingClients = [...serverNames].filter((n) => !clientSet.has(n)).sort()
  const extraClients = clientKeys.filter((n) => !serverNames.has(n)).sort()
  const missingDrawers = [...serverNames].filter((n) => !drawerSet.has(n)).sort()
  const extraDrawers = drawerKeys.filter((n) => !serverNames.has(n)).sort()

  const knownSpellingDrift = [
    {
      kind: 'drawer-typo',
      server: 'mfgSettings',
      frontend: 'mfgSetting',
      note: 'drawer registry 使用历史拼写 mfgSetting；服务端与 ResourceClient 为 mfgSettings',
    },
  ].filter(
    (d) =>
      (d.server && serverNames.has(d.server)) ||
      (d.frontend && (drawerSet.has(d.frontend) || clientSet.has(d.frontend))),
  )

  const fieldTotal = serverResources.reduce((n, r) => n + r.fieldCount, 0)
  const actionTotal = serverResources.reduce((n, r) => n + r.actionCount, 0)
  const formDeclared = serverResources.filter((r) => r.hasForm).length

  // 可扩展统计：后续工单填充；保持字段稳定以便 diff
  const extensible = {
    declaredCommands: 0,
    adapterCommands: 0,
    basicWritableFields: 0,
    legacyUsages: 0,
    writeStubs: 0,
    notes:
      'declaredCommands/adapterCommands/basicWritableFields/legacyUsages/writeStubs 在工单 05+ 填入真实计数',
  }

  const currencyDoc = registry.buildDocument(CURRENCY_RESOURCE_NAME, superAdmin)

  const report = {
    generatedAt: new Date().toISOString(),
    commitHint: 'run at implement time; re-run after each resource-catalog ticket',
    summary: {
      serverResourceCount: serverResources.length,
      fieldTotal,
      actionTotal,
      formDeclared,
      clientCount: clientKeys.length,
      drawerKeyCount: drawerKeys.length,
      remoteDefaultCount: remoteDefaultKeys.length,
      missingClientCount: missingClients.length,
      extraClientCount: extraClients.length,
      missingDrawerCount: missingDrawers.length,
      extraDrawerCount: extraDrawers.length,
    },
    gaps: {
      missingClients,
      extraClients,
      missingDrawers,
      extraDrawers,
      knownSpellingDrift,
      remoteDefaults: remoteDefaultKeys,
    },
    extensible,
    resources: serverResources,
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(
    join(outDir, 'currency-meta.superadmin.json'),
    JSON.stringify(currencyDoc, null, 2) + '\n',
  )

  const md: string[] = []
  md.push('# Resource Catalog 迁移基线报告')
  md.push('')
  md.push(`生成时间：${report.generatedAt}`)
  md.push('')
  md.push('## 摘要')
  md.push('')
  md.push(`| 指标 | 数量 |`)
  md.push(`|------|------|`)
  md.push(`| 服务端资源 | ${report.summary.serverResourceCount} |`)
  md.push(`| 字段总数 | ${report.summary.fieldTotal} |`)
  md.push(`| 动作总数 | ${report.summary.actionTotal} |`)
  md.push(`| 声明 Form 的资源 | ${report.summary.formDeclared} |`)
  md.push(`| 前端 ResourceClient | ${report.summary.clientCount} |`)
  md.push(`| 抽屉 registry 键 | ${report.summary.drawerKeyCount} |`)
  md.push(`| Remote 默认配置 | ${report.summary.remoteDefaultCount} |`)
  md.push(`| 缺 Client | ${report.summary.missingClientCount} |`)
  md.push(`| 多余 Client | ${report.summary.extraClientCount} |`)
  md.push(`| 缺 Drawer | ${report.summary.missingDrawerCount} |`)
  md.push(`| 多余 Drawer | ${report.summary.extraDrawerCount} |`)
  md.push('')
  md.push('## 缺口与漂移')
  md.push('')
  md.push('### 服务端有、前端 Client 无')
  md.push('')
  md.push(missingClients.length ? missingClients.map((n) => `- \`${n}\``).join('\n') : '_无_')
  md.push('')
  md.push('### 前端 Client 有、服务端无')
  md.push('')
  md.push(extraClients.length ? extraClients.map((n) => `- \`${n}\``).join('\n') : '_无_')
  md.push('')
  md.push('### 服务端有、Drawer 无（含仅列表/只读投影属正常）')
  md.push('')
  md.push(
    missingDrawers.length
      ? missingDrawers.map((n) => `- \`${n}\``).join('\n')
      : '_无_',
  )
  md.push('')
  md.push('### Drawer 有、服务端无')
  md.push('')
  md.push(extraDrawers.length ? extraDrawers.map((n) => `- \`${n}\``).join('\n') : '_无_')
  md.push('')
  md.push('### 已知拼写漂移')
  md.push('')
  for (const d of knownSpellingDrift) {
    md.push(`- **${d.kind}**: server=\`${d.server}\` frontend=\`${d.frontend}\` — ${d.note}`)
  }
  if (knownSpellingDrift.length === 0) md.push('_无_')
  md.push('')
  md.push('### Remote defaults 资源键')
  md.push('')
  md.push(remoteDefaultKeys.map((n) => `- \`${n}\``).join('\n') || '_无_')
  md.push('')
  md.push('## 可扩展统计（后续工单）')
  md.push('')
  md.push('```json')
  md.push(JSON.stringify(extensible, null, 2))
  md.push('```')
  md.push('')
  md.push('## 币种等价基线')
  md.push('')
  md.push('见 `currency-meta.superadmin.json`（superadmin 投影的完整 Meta 响应）。')
  md.push('')
  md.push('## 资源明细（名称 / 字段 / 动作 / Form）')
  md.push('')
  md.push('| 资源 | 前缀 | 字段 | 动作 | Form |')
  md.push('|------|------|------|------|------|')
  for (const r of serverResources) {
    md.push(
      `| \`${r.name}\` | \`${r.permissionPrefix}\` | ${r.fieldCount} | ${r.actionCount} | ${r.hasForm ? 'yes' : ''} |`,
    )
  }
  md.push('')

  writeFileSync(join(outDir, 'report.md'), md.join('\n'))
  console.log(
    JSON.stringify(
      {
        outDir,
        serverResourceCount: report.summary.serverResourceCount,
        fieldTotal: report.summary.fieldTotal,
        missingClients: missingClients.length,
        extraDrawers: extraDrawers.length,
        knownSpellingDrift: knownSpellingDrift.length,
      },
      null,
      2,
    ),
  )
}

main()
