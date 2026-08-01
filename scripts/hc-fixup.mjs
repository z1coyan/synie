#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WEB_APP = join(import.meta.dir, '../web/app')

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

for (const file of walk(WEB_APP)) {
  let s = readFileSync(file, 'utf8')
  const orig = s

  // shorthand body in hc calls: { body } → { json: body }
  s = s.replace(/\$post\(\{\s*body\s*\}\)/g, '$post({ json: body })')
  s = s.replace(/\$patch\(\{\s*body\s*\}\)/g, '$patch({ json: body })')
  s = s.replace(/\$put\(\{\s*body\s*\}\)/g, '$put({ json: body })')
  // { body, other } → { json: body, other }
  s = s.replace(/\$post\(\{\s*body\s*,/g, '$post({ json: body,')
  s = s.replace(/\$patch\(\{\s*body\s*,/g, '$patch({ json: body,')

  // AccountTemplate broken index
  s = s.replace(
    /type AccountTemplate = Record<string, unknown>\['template'\]/g,
    'type AccountTemplate = "CAS" | "SMALL" | "INTL"',
  )
  s = s.replace(
    /Record<string, unknown>\['preferredLanguage'\]/g,
    '"zh-CN" | "en-US"',
  )
  s = s.replace(
    /Record<string, unknown>\['template'\]/g,
    '"CAS" | "SMALL" | "INTL"',
  )

  // Ensure ListQuery import when used as type
  if (/\bListQuery\b/.test(s) && !/import\s+type\s+\{[^}]*\bListQuery\b/.test(s) && !/import\s+\{[^}]*\bListQuery\b/.test(s)) {
    s = `import type { ListQuery } from '@synie/shared'\n` + s
  }

  // MarketSeriesPriceKind used as value with .toUpperCase - must be string
  s = s.replace(
    /export type MarketSeriesPriceKind = Record<string, unknown>/g,
    'export type MarketSeriesPriceKind = string',
  )
  s = s.replace(
    /type MarketPriceKind = Record<string, unknown>/g,
    'type MarketPriceKind = string',
  )

  if (s !== orig) {
    writeFileSync(file, s)
    console.log('fixed', file)
  }
}
console.log('hc-fixup done')
