/**
 * Resource Catalog 迁移基线报告。
 *
 * 用法（仓库根或 server/）：
 *   bun server/scripts/resource-catalog-baseline.ts
 *
 * 写出（gitignored）：
 *   server/.baseline/resource-catalog/report.json
 *   server/.baseline/resource-catalog/report.md
 *   server/.baseline/resource-catalog/currency-meta.superadmin.json
 *
 * 可扩展统计均为实测，禁止硬置零。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Actor } from '../src/platform/authz/core/index.ts'
import { createSealedResourceRegistry } from '../src/platform/meta/register-all.ts'
import { CURRENCY_RESOURCE_NAME } from '../src/modules/base/meta.ts'
import {
  FRONTEND_DEAD_TYPOS,
  RESOURCE_CLASSIFICATION,
  type PresentationClass,
} from '../src/platform/meta/resource-classification.ts'
import { decodeResourceDocument } from '@synie/shared'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const outDir = join(repoRoot, 'server/.baseline/resource-catalog')

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
  return extractObjectKeys(source, /const RESOURCE_DEFAULTS_REMOVED/)
}

function walkFiles(dir: string, accept: (path: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...walkFiles(path, accept))
    else if (accept(path)) files.push(path)
  }
  return files
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
          'audit',
          'delete',
          'void',
          'export',
          'print',
        ].includes(a.permissionAction ?? a.key),
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
    join(repoRoot, 'web/app/components/synie-record-drawer/extension-drawer-props.tsx'),
    'utf8',
  )
  const remoteSource = readFileSync(
    join(repoRoot, 'web/app/components/synie-remote-select/remote-query.ts'),
    'utf8',
  )

  const clientKeys = extractObjectKeys(clientSource, /const transports[^=]*=\s*\{/)
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
    const catalog = decodeResourceDocument(registry.buildDocument(r.name, superAdmin))
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

  // —— 实测：Adapter 命令 / legacy 字段事实 / write stubs ——
  // 语义 CommandAdapter：registry 显式 SEMANTIC_COMMAND_ADAPTERS + commands.ts 内 defineCommand
  const registryTs = clientSource
  const semanticAdapterResources = [
    ...registryTs.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*\w+CommandAdapter/gm),
  ].map((m) => m[1]!)
  // 每个 semantic 资源的 command 数从 catalog 取
  let adapterCommands = 0
  const adapterResourcesMeasured: string[] = []
  for (const name of semanticAdapterResources) {
    if (!serverNames.has(name)) continue
    const catalog = decodeResourceDocument(registry.buildDocument(name, superAdmin))
    adapterCommands += catalog.commands.length
    adapterResourcesMeasured.push(name)
  }
  // 禁止开放命令桥：扫描全部资源实现中的 Proxy 与 legacy action transport。
  const webResourcesDir = join(repoRoot, 'web/app/lib/resources')
  const resourceSourceFiles = walkFiles(
    webResourcesDir,
    (path) => /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path),
  )
  const proxyActionSites: string[] = []
  for (const path of resourceSourceFiles) {
    const src = readFileSync(path, 'utf8')
    const proxyCount = src.match(/\bnew\s+Proxy\s*\(/g)?.length ?? 0
    const actionCount = src.match(/\baction\s*\(/g)?.length ?? 0
    if (proxyCount || actionCount) {
      proxyActionSites.push(
        `${path.slice(repoRoot.length + 1)}:proxy=${proxyCount},action=${actionCount}`,
      )
    }
  }

  // legacyUsages：basic 分类资源在 extension-drawer-props **本资源对象块**内仍含字段事实
  const basicNames = new Set(
    serverResources
      .map((r) => r.name)
      .filter((n) => classificationByName[n]?.presentation === 'basic'),
  )
  const drawerFieldFactResources: string[] = []
  function extractResourceBlock(source: string, name: string): string | null {
    const needle = `${name}:`
    let searchFrom = 0
    while (searchFrom < source.length) {
      const idx = source.indexOf(needle, searchFrom)
      if (idx < 0) return null
      // 确保是对象 key（前为空白/换行，后为可选空白 + `{`）
      const before = idx === 0 ? '\n' : source[idx - 1]!
      if (!/[\s,{]/.test(before)) {
        searchFrom = idx + needle.length
        continue
      }
      let i = idx + needle.length
      while (i < source.length && /\s/.test(source[i]!)) i++
      if (source[i] !== '{') {
        searchFrom = idx + needle.length
        continue
      }
      // 花括号配对取本块
      let depth = 0
      const start = i
      for (; i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') {
          depth--
          if (depth === 0) return source.slice(start, i + 1)
        }
      }
      return null
    }
    return null
  }
  for (const name of basicNames) {
    const block = extractResourceBlock(drawerSource, name)
    if (!block) continue
    // 本块内有 fields 且含 required/edit/placeholder 才算字段事实残留
    if (
      /fields\s*:/.test(block) &&
      /\brequired\s*:|\bedit\s*:|\bplaceholder\s*:/.test(block)
    ) {
      drawerFieldFactResources.push(name)
    }
  }
  // 页面手写 fields 中 required/edit/placeholder，且涉及 basic 分类资源、未走 Catalog Basic Form
  const routesRoot = join(repoRoot, 'web/app/routes')
  const pageFieldFactCandidates: string[] = []
  function walkTsx(dir: string) {
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent)
      if (statSync(p).isDirectory()) walkTsx(p)
      else if (ent.endsWith('.tsx')) {
        const src = readFileSync(p, 'utf8')
        if (!/fields\s*=\s*\{|fields\s*:\s*\{/.test(src)) continue
        if (!/\brequired\s*:|\bedit\s*:|\bplaceholder\s*:/.test(src)) continue
        // 已走 Catalog Basic Form 的页面不算 legacy
        if (/basicFormDrawerProps|useCatalogBasicForm/.test(src)) continue
        // 仅统计引用了 basic 分类资源的页面（extension 的 PE 字段事实不计入 basic 迁移缺口）
        let touchesBasic = false
        for (const name of basicNames) {
          if (src.includes(`'${name}'`) || src.includes(`"${name}"`) || src.includes(`\`${name}\``)) {
            touchesBasic = true
            break
          }
        }
        if (!touchesBasic) continue
        pageFieldFactCandidates.push(p.slice(repoRoot.length + 1))
      }
    }
  }
  walkTsx(routesRoot)

  // writeStubs：全部资源传输/绑定层仍伪造写方法并抛“不支持”。
  let writeStubs = 0
  const writeStubPatterns: string[] = []
  for (const path of resourceSourceFiles) {
    const src = readFileSync(path, 'utf8')
    const found = [
      ...src.matchAll(
        /(?:async\s+)?(?:create|update|delete)\s*\([^)]*\)\s*\{\s*throw\s+new\s+Error/g,
      ),
      ...src.matchAll(
        /(?:create|update|delete)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*throw\s+new\s+Error/g,
      ),
    ]
    if (found.length) {
      writeStubs += found.length
      writeStubPatterns.push(`${path.slice(repoRoot.length + 1)}:${found.length}`)
    }
  }

  // 全量扫描 useCatalogBasicForm 的资源实参（支持直接字面量与文件内 const）。
  const basicFormConsumerFiles: string[] = []
  const basicFormConsumerResources = new Set<string>()
  function walkBasicConsumers(dir: string) {
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent)
      if (statSync(p).isDirectory()) walkBasicConsumers(p)
      else if (
        (ent.endsWith('.tsx') || ent.endsWith('.ts')) &&
        !ent.includes('.test.')
      ) {
        const src = readFileSync(p, 'utf8')
        if (/basicFormDrawerProps|useCatalogBasicForm/.test(src)) {
          basicFormConsumerFiles.push(p.slice(repoRoot.length + 1))
          const constants = new Map<string, string>()
          for (const match of src.matchAll(
            /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g,
          )) {
            constants.set(match[1]!, match[2]!)
          }
          for (const match of src.matchAll(
            /\buseCatalogBasicForm\s*\(\s*(?:['"`]([A-Za-z][A-Za-z0-9_]*)['"`]|([A-Za-z_$][\w$]*))/g,
          )) {
            const resource = match[1] ?? constants.get(match[2]!)
            if (resource) basicFormConsumerResources.add(resource)
          }
        }
      }
    }
  }
  walkBasicConsumers(routesRoot)
  const unconsumedBasicFormResources = [...basicNames]
    .filter((name) => !basicFormConsumerResources.has(name))
    .sort()
  const legacyPageFieldFacts = pageFieldFactCandidates.filter((relativePath) => {
    const src = readFileSync(join(repoRoot, relativePath), 'utf8')
    return unconsumedBasicFormResources.some(
      (name) =>
        src.includes(`'${name}'`) ||
        src.includes(`"${name}"`) ||
        src.includes(`\`${name}\``),
    )
  })
  const legacyUsages =
    drawerFieldFactResources.length +
    new Set([...unconsumedBasicFormResources, ...legacyPageFieldFacts]).size

  let basicCatalogFormResources = 0
  for (const r of serverResources) {
    if (classificationByName[r.name]?.presentation !== 'basic') continue
    const catalog = decodeResourceDocument(registry.buildDocument(r.name, superAdmin))
    if (catalog.form.kind === 'basic') basicCatalogFormResources++
  }

  const extensible = {
    declaredCommands,
    adapterCommands,
    adapterResources: adapterResourcesMeasured,
    proxyActionHooks: proxyActionSites.length,
    proxyActionSites,
    basicWritableFields,
    legacyUsages,
    legacyDrawerFieldFacts: drawerFieldFactResources,
    legacyPageFieldFacts,
    writeStubs,
    writeStubPatterns,
    basicCatalogFormResources,
    basicFormConsumerFiles,
    basicFormConsumerResources: [...basicFormConsumerResources].sort(),
    unconsumedBasicFormResources,
    normalizedResources: sealStats.normalized,
    formKindCounts,
    presentationCounts,
    notes:
      '实测 gaps：adapterCommands=SEMANTIC_COMMAND_ADAPTERS 覆盖的 catalog 命令数；' +
      'proxyActionHooks=资源实现中的 new Proxy/action transport；' +
      'legacyUsages=basic 资源 drawer/页面仍手写 required|edit|placeholder；' +
      'writeStubs=伪造写方法并抛「不支持」的代码点；' +
      'unconsumedBasicFormResources=未由 useCatalogBasicForm 消费的 basic 资源',
  }

  const classifications = serverResources.map((r) => {
    const c = classificationByName[r.name]!
    return {
      name: r.name,
      presentation: c.presentation,
      interactive: c.interactive,
      note: c.note ?? null,
      hasTransport: clientSet.has(r.name),
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
      transportCount: clientKeys.length,
      drawerKeyCount: drawerKeys.length,
      remoteDefaultCount: remoteDefaultKeys.length,
      missingClientCount: missingClients.length,
      extraClientCount: extraClients.length,
      missingDrawerCount: missingDrawers.length,
      extraDrawerCount: extraDrawers.length,
      normalizedResources: sealStats.normalized,
      legacyNormalizerCalls: 0,
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
  md.push(`| 前端 ResourceTransport binding | ${report.summary.transportCount} |`)
  md.push(`| Presentation Extension registry 键 | ${report.summary.drawerKeyCount} |`)
  md.push(`| Remote 默认配置 | ${report.summary.remoteDefaultCount} |`)
  md.push(`| 缺 Transport | ${report.summary.missingClientCount} |`)
  md.push(`| 多余 Transport | ${report.summary.extraClientCount} |`)
  md.push(`| 缺 PE 配置 | ${report.summary.missingDrawerCount} |`)
  md.push(`| 多余 PE 配置 | ${report.summary.extraDrawerCount} |`)
  md.push(`| 已规范化资源 | ${report.summary.normalizedResources} |`)
  md.push(`| legacy normalizer 调用 | ${report.summary.legacyNormalizerCalls} |`)
  md.push(`| 未分类 | ${report.summary.unclassifiedCount} |`)
  md.push(`| 未解释缺 Transport | ${report.summary.unexplainedMissingClientCount} |`)
  md.push(`| 未解释缺 PE 配置 | ${report.summary.unexplainedMissingDrawerCount} |`)
  md.push(`| 拼写漂移 | ${report.summary.knownSpellingDriftCount} |`)
  md.push('')
  md.push('## 缺口与漂移')
  md.push('')
  md.push('### 服务端有、前端 Transport 无')
  md.push('')
  md.push(missingClients.length ? missingClients.map((n) => `- \`${n}\``).join('\n') : '_无_')
  md.push('')
  md.push('### 未解释缺 Transport（应为 0）')
  md.push('')
  md.push(
    unexplainedMissingClients.length
      ? unexplainedMissingClients.map((n) => `- \`${n}\``).join('\n')
      : '_无_',
  )
  md.push('')
  md.push('### 前端 Transport 有、服务端无')
  md.push('')
  md.push(extraClients.length ? extraClients.map((n) => `- \`${n}\``).join('\n') : '_无_')
  md.push('')
  md.push('### 服务端有、PE 配置无（basic/none/模块共置 PE 属正常）')
  md.push('')
  md.push(
    missingDrawers.length
      ? missingDrawers.map((n) => `- \`${n}\``).join('\n')
      : '_无_',
  )
  md.push('')
  md.push('### 未解释缺 PE 配置（应为 0）')
  md.push('')
  md.push(
    unexplainedMissingDrawers.length
      ? unexplainedMissingDrawers.map((n) => `- \`${n}\``).join('\n')
      : '_无_',
  )
  md.push('')
  md.push('### PE 配置有、服务端无')
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
  md.push('| 资源 | 呈现 | 交互 | Transport | PE 配置 | 备注 |')
  md.push('|------|------|------|--------|--------|------|')
  for (const c of classifications) {
    md.push(
      `| \`${c.name}\` | ${c.presentation} | ${c.interactive ? 'yes' : ''} | ${c.hasTransport ? 'yes' : ''} | ${c.hasDrawer ? 'yes' : ''} | ${c.note ?? ''} |`,
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
        normalized: sealStats.normalized,
        legacyNormalizerCalls: 0,
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
