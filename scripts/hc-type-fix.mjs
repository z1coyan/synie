#!/usr/bin/env bun
/**
 * 1) apiData(...) on list/query results → apiData<{count:number; results: Row[]}>(...)
 * 2) json: input as SomeType → json: input as never  (ResourceClient boundary)
 * 3) json: body where body is Record → as never when needed
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../web/app/lib/resources')

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

for (const file of walk(ROOT)) {
  let s = readFileSync(file, 'utf8')
  const orig = s

  // Cast create/update Record bodies to never for hc zod input
  s = s.replace(/json:\s*input\s+as\s+[A-Za-z0-9_]+/g, 'json: input as never')
  s = s.replace(/json:\s*body\s+as\s+[A-Za-z0-9_]+/g, 'json: body as never')
  s = s.replace(/json:\s*input\s+as\s+unknown\s+as\s+[A-Za-z0-9_]+/g, 'json: input as never')
  s = s.replace(/json:\s*input\s+as\s+unknown\s+as\s+never/g, 'json: input as never')

  // Bare `json: input` in create/update when input is Record
  // (keep as-is if already typed by inference elsewhere)

  // apiData( query posts → typed list
  // Pattern: const result = await apiData(\n      api....query.$post
  s = s.replace(
    /const result = await apiData\(\s*\n(\s*)(api\.[^\n]+query\.\$post)/g,
    'const result = await apiData<{ count: number; results: Row[] }>(\n$1$2',
  )
  s = s.replace(
    /const x = await apiData\(\s*\n?(\s*)(api\.[^\n]+query\.\$post)/g,
    'const x = await apiData<{ count: number; results: Row[] }>(\n$1$2',
  )
  // single-line
  s = s.replace(
    /const result = await apiData\((api\.[^)]+query\.\$post)/g,
    'const result = await apiData<{ count: number; results: Row[] }>($1',
  )
  s = s.replace(
    /const x=await apiData\((api\.[^)]+query\.\$post)/g,
    'const x=await apiData<{ count: number; results: Row[] }>($1',
  )

  // gridMeta(await apiData( meta → typed
  s = s.replace(
    /gridMeta\(\s*\n?\s*await apiData\(\s*\n?\s*(api\.meta\.resources)/g,
    'gridMeta(\n      await apiData<import("@synie/shared").ResourceMetaDocument>(\n        $1',
  )
  s = s.replace(
    /gridMeta\(await apiData\((api\.meta\.resources)/g,
    'gridMeta(await apiData<import("@synie/shared").ResourceMetaDocument>($1',
  )

  if (s !== orig) {
    writeFileSync(file, s)
    console.log('typed', file)
  }
}
console.log('done')
