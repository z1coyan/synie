#!/usr/bin/env bun
/**
 * openapi-fetch apiClient.METHOD('/path', opts) → hono/client api.path.$method(opts)
 * Also strips components['schemas'] casts that only alias FilterState/ListQuery/etc.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const WEB = join(ROOT, 'web')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'schema.d.ts') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function pathToAccess(path) {
  const segs = path.replace(/^\//, '').split('/').filter(Boolean)
  let out = 'api'
  for (const seg of segs) {
    if (seg.startsWith('{') && seg.endsWith('}')) {
      out += `[':${seg.slice(1, -1)}']`
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) {
      out += `.${seg}`
    } else {
      out += `['${seg}']`
    }
  }
  return out
}

const METHOD_MAP = {
  GET: '$get',
  POST: '$post',
  PATCH: '$patch',
  PUT: '$put',
  DELETE: '$delete',
}

/** Find matching closing brace/paren from openIdx pointing at '{' or '(' */
function matchDelim(src, openIdx) {
  const open = src[openIdx]
  const close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : null
  if (!close) throw new Error(`not a delim at ${openIdx}`)
  let depth = 0
  let inStr = null
  let escape = false
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`unbalanced ${open} at ${openIdx}`)
}

/** Transform openapi-fetch options object body to hc args */
function transformOptions(optsSrc) {
  let s = optsSrc.trim()
  if (!s.startsWith('{')) return s

  // parseAs: 'blob' — drop; caller handles blob separately
  s = s.replace(/,?\s*parseAs:\s*['"]blob['"]/g, '')

  // params: { path: { ... } }  →  param: { ... }
  s = s.replace(/params:\s*\{\s*path:\s*(\{[\s\S]*?\})\s*,?\s*\}/g, 'param: $1')
  // remaining params: { query: { ... } } → query: { ... }
  s = s.replace(/params:\s*\{\s*query:\s*(\{[\s\S]*?\})\s*,?\s*\}/g, 'query: $1')
  // body: → json:
  s = s.replace(/\bbody:/g, 'json:')

  // cleanup double commas / trailing
  s = s.replace(/,\s*,/g, ',')
  s = s.replace(/\{\s*,/g, '{')
  s = s.replace(/,\s*\}/g, '}')

  return s
}

function transformApiCalls(src) {
  const re = /apiClient\.(GET|POST|PATCH|PUT|DELETE)\(\s*(['"])(\/[^'"]+)\2/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(src)) !== null) {
    const method = m[1]
    const path = m[3]
    const start = m.index
    out += src.slice(last, start)

    let i = m.index + m[0].length
    // skip whitespace
    while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') i++

    let opts = null
    let end
    if (src[i] === ',') {
      i++
      while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') i++
      if (src[i] !== '{') {
        // unexpected — keep original
        out += m[0]
        last = m.index + m[0].length
        continue
      }
      const close = matchDelim(src, i)
      opts = src.slice(i, close + 1)
      i = close + 1
      while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') i++
      if (src[i] !== ')') {
        out += m[0]
        last = m.index + m[0].length
        continue
      }
      end = i + 1
    } else if (src[i] === ')') {
      end = i + 1
    } else {
      out += m[0]
      last = m.index + m[0].length
      continue
    }

    const access = pathToAccess(path)
    const meth = METHOD_MAP[method]
    if (opts) {
      const transformed = transformOptions(opts)
      // if only empty {} after transform, omit
      if (transformed.replace(/\s/g, '') === '{}') {
        out += `${access}.${meth}()`
      } else {
        out += `${access}.${meth}(${transformed})`
      }
    } else {
      out += `${access}.${meth}()`
    }
    last = end
    re.lastIndex = end
  }
  out += src.slice(last)
  return out
}

function transformImports(src, file) {
  let s = src

  // drop schema imports
  s = s.replace(
    /^import\s+type\s+\{\s*components\s*\}\s+from\s+['"][^'"]*api\/schema['"]\s*;?\s*\n/gm,
    '',
  )
  s = s.replace(
    /^import\s+type\s+\{\s*components,\s*paths\s*\}\s+from\s+['"][^'"]*api\/schema['"]\s*;?\s*\n/gm,
    '',
  )
  s = s.replace(
    /^import\s+type\s+\{\s*paths\s*\}\s+from\s+['"][^'"]*api\/schema['"]\s*;?\s*\n/gm,
    '',
  )

  // apiClient, apiData imports → add api
  s = s.replace(
    /import\s+\{\s*([^}]*apiClient[^}]*)\s*\}\s+from\s+(['"][^'"]*api\/client['"])/g,
    (full, names, from) => {
      const parts = names.split(',').map((x) => x.trim()).filter(Boolean)
      const set = new Set(parts)
      set.add('api')
      // keep apiClient only if still referenced after transform — leave it; cleanup later
      return `import { ${[...set].join(', ')} } from ${from}`
    },
  )

  // components['schemas']['FilterState'] → FilterState (ensure import)
  const hadFilterSchema = /components\['schemas'\]\['FilterState'\]/.test(s)
  s = s.replace(/components\['schemas'\]\['FilterState'\]/g, 'FilterState')
  s = s.replace(/components\["schemas"\]\["FilterState"\]/g, 'FilterState')

  // ListQuery
  s = s.replace(/components\['schemas'\]\['ListQuery'\]/g, 'ListQuery')
  s = s.replace(/components\["schemas"\]\["ListQuery"\]/g, 'ListQuery')

  // ResourceMetaDocument already handled in meta.ts

  // Generic: components['schemas']['Foo'] → keep as type alias Raw or Record
  // Convert type Foo = components['schemas']['Bar'] to type Foo = Record<string, unknown> for create/update
  // Better: type Foo = Record<string, unknown> for *Create/*Update, and keep named exports as interfaces

  // Replace remaining components['schemas']['X'] with a typed unknown record marker
  s = s.replace(/components\['schemas'\]\['([^']+)'\]/g, "/* schema:$1 */ Record<string, unknown>")
  s = s.replace(/components\["schemas"\]\["([^"]+)"\]/g, "/* schema:$1 */ Record<string, unknown>")

  // Fix broken type exports like: export type Foo = /* schema:Bar */ Record<string, unknown>
  // That's fine.

  // Ensure FilterState / ListQuery imports when used
  if (/\bFilterState\b/.test(s) && !/import\s+type\s+\{[^}]*\bFilterState\b/.test(s) && !/import\s+\{[^}]*\bFilterState\b/.test(s)) {
    // prefer shared or data-grid
    if (s.includes("from '@synie/shared'") || s.includes('from "@synie/shared"')) {
      s = s.replace(
        /import\s+type\s+\{([^}]+)\}\s+from\s+['"]@synie\/shared['"]/,
        (full, names) => {
          if (names.includes('FilterState')) return full
          return `import type { ${names.trim().replace(/,$/, '')}, FilterState } from '@synie/shared'`
        },
      )
      if (!/FilterState/.test(s.match(/from ['"]@synie\/shared['"]/)?.[0] ?? '') && !/import type \{[^}]*FilterState/.test(s)) {
        s = `import type { FilterState } from '@synie/shared'\n` + s
      }
    } else if (/synie-data-grid\/types/.test(s)) {
      s = s.replace(
        /import\s+type\s+\{([^}]+)\}\s+from\s+['"][^'"]*synie-data-grid\/types['"]/,
        (full, names) => {
          if (names.includes('FilterState')) return full
          return full.replace(names, names.trim().replace(/,$/, '') + ', FilterState')
        },
      )
      if (!/\bFilterState\b/.test(s.split('\n').find((l) => l.includes('synie-data-grid/types')) ?? '')) {
        // add to existing import or new
        if (!/FilterState/.test(s.match(/from ['"][~./]*components\/synie-data-grid\/types['"]/) ? 'yes' : '')) {
          s = `import type { FilterState } from '~/components/synie-data-grid/types'\n` + s
        }
      }
    } else {
      s = `import type { FilterState } from '~/components/synie-data-grid/types'\n` + s
    }
  }

  if (/\bListQuery\b/.test(s) && !/import[^;]*\bListQuery\b/.test(s)) {
    s = `import type { ListQuery } from '@synie/shared'\n` + s
  }

  // Remove unused apiClient import if no longer referenced
  if (!/\bapiClient\b/.test(s.replace(/import\s*\{[^}]*apiClient[^}]*\}[^;]*;?/, ''))) {
    s = s.replace(/import\s*\{([^}]*)\}\s*from\s*(['"][^'"]*api\/client['"])/, (full, names, from) => {
      const parts = names
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x && x !== 'apiClient')
      if (parts.length === 0) return ''
      return `import { ${parts.join(', ')} } from ${from}`
    })
  }

  // ensure api is imported if used
  if (/\bapi\./.test(s) || /\bapi\[/.test(s)) {
    if (!/import\s*\{[^}]*\bapi\b[^}]*\}\s*from\s*['"][^'"]*api\/client['"]/.test(s)) {
      if (/from\s*['"][^'"]*api\/client['"]/.test(s)) {
        s = s.replace(
          /import\s*\{([^}]*)\}\s*from\s*(['"][^'"]*api\/client['"])/,
          (full, names, from) => {
            if (names.split(',').some((x) => x.trim() === 'api')) return full
            return `import { ${names.trim().replace(/,$/, '')}, api } from ${from}`
          },
        )
      } else {
        s = `import { api, apiData } from '../api/client'\n` + s
      }
    }
  }

  return s
}

function processFile(file) {
  const orig = readFileSync(file, 'utf8')
  if (!orig.includes('apiClient') && !orig.includes("api/schema") && !orig.includes("components['schemas']")) {
    return false
  }
  // skip the new client itself and schema
  if (file.endsWith('/api/client.ts') || file.endsWith('/api/session.ts') || file.endsWith('schema.d.ts')) {
    return false
  }

  let s = orig
  s = transformApiCalls(s)
  s = transformImports(s, file)

  if (s !== orig) {
    writeFileSync(file, s)
    console.log('updated', file.replace(ROOT + '/', ''))
    return true
  }
  return false
}

const files = walk(join(WEB, 'app'))
let n = 0
for (const f of files) {
  if (processFile(f)) n++
}
console.log(`done: ${n} files`)
