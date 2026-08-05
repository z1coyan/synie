// bun run check 链的一环（工单 14）：web/app 下不得再出现
// 1) capabilities={[...]} 数组字面量覆盖——via 子行能力由服务端文档投影取宿主真值；
//    （保留机制仅 RemoteDialogSelect 的条件空数组，非数组字面量，不在此列）
// 2) 权限码字面量（前缀.资源:动作 形态）——门控一律消费资源文档投影
//    （useResourceCapabilities / GridMeta capabilities），不再硬编码。
// 排除：测试与自检脚本、permission-labels（权限前缀中文标签表）、menu（菜单码非权限码）。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const APP_ROOT = join(import.meta.dir, '..')

const CODE_LITERAL = /['"][a-z][a-z0-9_]*\.[a-z][a-z0-9_]*:[a-z_]+['"]/
const CAPS_OVERRIDE = /capabilities=\{\[/

function excluded(path: string): boolean {
  if (path.includes('.test.')) return true
  if (path.endsWith('-checks.ts')) return true
  if (path.includes('permission-labels')) return true
  if (/[/.]menu/.test(path)) return true
  return false
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      yield* walk(full)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full
    }
  }
}

const violations: string[] = []
for (const file of walk(APP_ROOT)) {
  if (excluded(file)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (CAPS_OVERRIDE.test(line)) {
      violations.push(`${file}:${i + 1} capabilities 数组字面量覆盖: ${line.trim()}`)
    } else if (CODE_LITERAL.test(line)) {
      violations.push(`${file}:${i + 1} 硬编码权限码: ${line.trim()}`)
    }
  })
}

if (violations.length > 0) {
  console.error(`FAIL authz-guard：发现 ${violations.length} 处硬编码权限残留`)
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log('authz-guard-checks ok')
