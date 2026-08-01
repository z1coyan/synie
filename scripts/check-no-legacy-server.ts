import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dir, '..')
const scanRoots = [
  'scripts',
  '.github',
  'web',
  'convex',
  'packages',
  'infra',
] as const
const directFiles = [
  'package.json',
  'bun.lock',
  'turbo.json',
  'compose.yaml',
  '.env.example',
  'README.md',
  'CONTEXT.md',
] as const
const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.sh',
  '.conf',
  '.template',
])
const excludedPrefixes = [
  'advisor-plans/',
  'docs/',
  '.scratch/',
  'convex/migration/',
  'node_modules/',
  'web/node_modules/',
  'web/dist/',
  'web/test-results/',
] as const
const excludedFiles = new Set([
  'scripts/check-no-legacy-server.ts',
  'scripts/check-convex-cutover-readiness.ts',
])

const forbiddenPatterns = [
  ['server workspace', /@synie\/server|workspace:server/],
  ['Hono transport', /hono\/client|(?:from\s+|import\s*\()\s*['"]hono(?:\/[^'"]*)?['"]/],
  ['Kysely tooling', /kysely-codegen|kysely-postgres-js/],
  ['legacy API port', /SYNIE_API_PORT|GO_API_PORT/],
  ['legacy browser token', /synie:token/],
  ['business REST path', /\/api\/v1(?:\/|\b)/],
  ['legacy server source', /server\/src|server\/Dockerfile/],
  ['backend mode switch', /VITE_SYNIE_BACKEND/],
  ['legacy business database', /\bDATABASE_URL\b/],
  ['legacy JWT secret', /\bAUTH_SECRET\b|\bAUTH_TOKEN_TTL\b/],
] as const

function repoPath(path: string): string {
  return relative(root, path).split(sep).join('/')
}

function shouldScan(path: string): boolean {
  const relativePath = repoPath(path)
  if (excludedFiles.has(relativePath)) return false
  if (excludedPrefixes.some((prefix) => relativePath.startsWith(prefix))) return false
  const name = relativePath.split('/').at(-1) ?? ''
  return name === 'Dockerfile' || name.startsWith('Dockerfile.') || textExtensions.has(extname(name))
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return shouldScan(path) ? [path] : []
  const files: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    const relativePath = repoPath(child)
    if (excludedPrefixes.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) {
      continue
    }
    if (entry.isDirectory()) files.push(...filesUnder(child))
    else if (entry.isFile() && shouldScan(child)) files.push(child)
  }
  return files
}

if (existsSync(join(root, 'server'))) {
  throw new Error('server/ 目录仍存在')
}

const files = [
  ...directFiles.map((path) => join(root, path)).filter(existsSync),
  ...scanRoots.flatMap((path) => filesUnder(join(root, path))),
]
const violations: string[] = []
for (const path of [...new Set(files)].sort()) {
  const source = readFileSync(path, 'utf8')
  for (const [label, pattern] of forbiddenPatterns) {
    const match = source.match(pattern)
    if (!match || match.index === undefined) continue
    const line = source.slice(0, match.index).split('\n').length
    violations.push(`${repoPath(path)}:${line} [${label}] ${match[0]}`)
  }
}

const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  workspaces?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
if (rootPackage.workspaces?.some((workspace) => workspace === 'server' || workspace.startsWith('server/'))) {
  violations.push('package.json [server workspace] workspaces 仍包含 server')
}
for (const packagePath of ['package.json', 'web/package.json', 'packages/shared/package.json']) {
  const value = JSON.parse(readFileSync(join(root, packagePath), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  for (const name of Object.keys({ ...value.dependencies, ...value.devDependencies })) {
    if (name === '@synie/server' || name === 'hono' || name.startsWith('kysely')) {
      violations.push(`${packagePath} [legacy dependency] ${name}`)
    }
  }
}

if (violations.length > 0) {
  console.error(`旧后端残留检查失败（${violations.length}）：`)
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`旧后端残留检查通过：${files.length} 个活动文件，server/=0，REST fallback=0`)
console.log('bun.lock 中 Better Auth 的间接 Kysely adapter 依赖可保留；仓库无直接 Kysely 依赖或工具。')
