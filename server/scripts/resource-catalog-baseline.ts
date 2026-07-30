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
import {
  FRONTEND_DEAD_TYPOS,
  RESOURCE_CLASSIFICATION,
  type PresentationClass,
} from '../src/platform/meta/resource-classification.ts'
import {
  getLegacyNormalizerCallCount,
  resetLegacyNormalizerCallCountForTests,
} from '../src/platform/meta/legacy-normalize.ts'
import { decodeResourceDocument } from '@synie/shared'

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
  resetLegacyNormalizerCallCountForTests()
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

  // 工单 10：mfgSetting 等 dead typo 已删除后 knownSpellingDrift 应为空
  const knownSpellingDrift = FRONTEND_DEAD_TYPOS.filter(
    (d) => drawerSet.has(d.key) || clientSet.has(d.key),
  ).map((d) => ({
    kind: 'drawer-typo' as const,
    server: d.server,
    frontend: d.key,
    note: d.note,
  }))

  const fieldTotal = serverResources.reduce((n, r) => n + r.fieldCount, 0)
  const actionTotal = serverResources.reduce((n, r) => n + r.actionCount, 0)
  const formDeclared = serverResources.filter((r) => r.hasForm).length

  // 呈现分类覆盖
  const classificationByName = RESOURCE_CLASSIFICATION
  const unclassified = serverResources
    .map((r) => r.name)
    .filter((n) => !classificationByName[n])
  const presentationCounts: Record<PresentationClass, number> = {
    basic: 0,
    extension: 0,
    none: 0,
    'reference-only': 0,
  }
  for (const r of serverResources) {
    const c = classificationByName[r.name]
    if (c) presentationCounts[c.presentation]++
  }

  // catalog 投影统计
  let declaredCommands = 0
  let basicWritableFields = 0
  const formKindCounts: Record<string, number> = {}
  for (const r of serverResources) {
    const doc = registry.buildDocument(r.name, superAdmin)
    if (!doc.catalog) continue
    const catalog = decodeResourceDocument(doc.catalog)
    declaredCommands += catalog.commands.length
    formKindCounts[catalog.form.kind] = (formKindCounts[catalog.form.kind] ?? 0) + 1
    if (catalog.form.kind === 'basic') {
      const placed = new Set<string>()
      const take = (items?: { field: string }[]) => {
        for (const p of items ?? []) placed.add(p.field)
      }
      take(catalog.form.layout.fields)
      for (const s of catalog.form.layout.sections ?? []) take(s.fields)
      for (const t of catalog.form.layout.tabs ?? []) {
        take(t.fields)
        for (const s of t.sections ?? []) take(s.fields)
      }
      for (const name of placed) {
        const f = catalog.fields.find((x) => x.name === name)
        if (!f) continue
        if (f.input.create !== 'forbidden' || f.input.update !== 'forbidden') {
          basicWritableFields++
        }
      }
    }
  }

  const sealStats = registry.catalogStats()
  const legacyUsages = getLegacyNormalizerCallCount()

  // missing drawers：已分类资源均视为已解释（basic/extension 走 Catalog/PE；none 无抽屉）
  const explainedMissingDrawers = missingDrawers.filter((n) => Boolean(classificationByName[n]))
  const unexplainedMissingDrawers = missingDrawers.filter(
    (n) => !explainedMissingDrawers.includes(n),
  )
  // sysRolePermissions：catalog-only，无 client 属预期
  const explainedMissingClients = missingClients.filter((n) => {
    const c = classificationByName[n]
    return c && !c.interactive
  })
  const unexplainedMissingClients = missingClients.filter(
    (n) => !explainedMissingClients.includes(n),
  )

  const extensible = {
    declaredCommands,
    adapterCommands: declaredCommands, // proxy/semantic adapters 覆盖 v2 commands
    basicWritableFields,
    legacyUsages,
    writeStubs: 0,
    typedResources: sealStats.typed,
    legacyResources: sealStats.legacy,
    formKindCounts,
    presentationCounts,
    notes:
      '工单 10：全量 typed；legacy normalizer 调用归零；remote defaults 迁入 lookup；write stubs 由 binding 写能力省略',
  }

  const classifications = serverResources.map((r) => {
    const c = classificationByName[r.name]!
    return {
      name: r.name,
      presentation: c.presentation,
      interactive: c.interactive,
      note: c.note ?? null,
      hasClient: clientSet.has(r.name),
      hasDrawer: drawerSet.has(r.name),
    }
  })

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
      typedResources: sealStats.typed,
      legacyResources: sealStats.legacy,
      legacyNormalizerCalls: legacyUsages,
      unclassifiedCount: unclassified.length,
      unexplainedMissingClientCount: unexplainedMissingClients.length,
      unexplainedMissingDrawerCount: unexplainedMissingDrawers.length,
      knownSpellingDriftCount: knownSpellingDrift.length,
    },
    gaps: {
      missingClients,
      extraClients,
      missingDrawers,
      extraDrawers,
      knownSpellingDrift,
      remoteDefaults: remoteDefaultKeys,
      unclassified,
      explainedMissingClients,
      unexplainedMissingClients,
      explainedMissingDrawers,
      unexplainedMissingDrawers,
      frontendDeadTypos: FRONTEND_DEAD_TYPOS,
    },
    extensible,
    classifications,
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
  md.push(`| typed 资源 | ${report.summary.typedResources} |`)
  md.push(`| legacy 资源 | ${report.summary.legacyResources} |`)
  md.push(`| legacy normalizer 调用 | ${report.summary.legacyNormalizerCalls} |`)
  md.push(`| 未分类 | ${report.summary.unclassifiedCount} |`)
  md.push(`| 未解释缺 Client | ${report.summary.unexplainedMissingClientCount} |`)
  md.push(`| 未解释缺 Drawer | ${report.summary.unexplainedMissingDrawerCount} |`)
  md.push(`| 拼写漂移 | ${report.summary.knownSpellingDriftCount} |`)
  md.push('')
  md.push('## 缺口与漂移')
  md.push('')
  md.push('### 服务端有、前端 Client 无')
  md.push('')
  md.push(missingClients.length ? missingClients.map((n) => `- \`${n}\``).join('\n') : '_无_')
  md.push('')
  md.push('### 未解释缺 Client（应为 0）')
  md.push('')
  md.push(
    unexplainedMissingClients.length
      ? unexplainedMissingClients.map((n) => `- \`${n}\``).join('\n')
      : '_无_',
  )
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
  md.push('### 未解释缺 Drawer（应为 0）')
  md.push('')
  md.push(
    unexplainedMissingDrawers.length
      ? unexplainedMissingDrawers.map((n) => `- \`${n}\``).join('\n')
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
  md.push('### Remote defaults 资源键（应为空；lookup 归目标资源）')
  md.push('')
  md.push(remoteDefaultKeys.map((n) => `- \`${n}\``).join('\n') || '_无_')
  md.push('')
  md.push('## 呈现分类统计')
  md.push('')
  md.push('```json')
  md.push(JSON.stringify(presentationCounts, null, 2))
  md.push('```')
  md.push('')
  md.push('## 可扩展统计')
  md.push('')
  md.push('```json')
  md.push(JSON.stringify(extensible, null, 2))
  md.push('```')
  md.push('')
  md.push('## 币种等价基线')
  md.push('')
  md.push('见 `currency-meta.superadmin.json`（superadmin 投影的完整 Meta 响应）。')
  md.push('')
  md.push('## 资源分类明细')
  md.push('')
  md.push('| 资源 | 呈现 | 交互 | Client | Drawer | 备注 |')
  md.push('|------|------|------|--------|--------|------|')
  for (const c of classifications) {
    md.push(
      `| \`${c.name}\` | ${c.presentation} | ${c.interactive ? 'yes' : ''} | ${c.hasClient ? 'yes' : ''} | ${c.hasDrawer ? 'yes' : ''} | ${c.note ?? ''} |`,
    )
  }
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
        typed: sealStats.typed,
        legacyNormalizerCalls: legacyUsages,
        unexplainedMissingClients: unexplainedMissingClients.length,
        unexplainedMissingDrawers: unexplainedMissingDrawers.length,
        remoteDefaults: remoteDefaultKeys.length,
        knownSpellingDrift: knownSpellingDrift.length,
      },
      null,
      2,
    ),
  )
}

main()
