#!/usr/bin/env bun
/**
 * Rewrite contract tests that grepped openapi-fetch path strings to hc chain fragments.
 * '/sales/orders/{id}/audit' → "api.sales.orders[':id'].audit"
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (n.includes('contract') && n.endsWith('.ts')) out.push(p)
  }
  return out
}

function pathToHcFragment(path) {
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

const ROOT = join(import.meta.dir, '../web/app')
for (const file of walk(ROOT)) {
  let s = readFileSync(file, 'utf8')
  const orig = s

  // quoted path strings like '/sales/orders/{id}/audit' or "'/sales/..."
  s = s.replace(/(['"`])(\/[a-z0-9{}/_-]+)\1/gi, (full, q, path) => {
    if (!path.includes('/')) return full
    // keep non-API paths
    if (path.startsWith('/_app') || path.startsWith('/login')) return full
    const frag = pathToHcFragment(path)
    return `${q}${frag}${q}`
  })

  // setup.ts uses raw fetch paths still - keep /setup/* for setup facade test
  if (file.includes('setup-rest-contract')) {
    // setup uses fetch `/api/v1/setup${path}` with paths like '/status'
    // restore setup expectations to match setup.ts
    s = orig // leave setup contract; handle manually
  }

  if (s !== orig && !file.includes('setup-rest-contract')) {
    writeFileSync(file, s)
    console.log('updated', file)
  }
}
console.log('done')
