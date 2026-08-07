/**
 * 从 sealed Registry 生成资源事实清单 → packages/shared/src/generated/resource-manifest.ts。
 * 用法：bun run -F @synie/server gen:manifest（改 server meta 后必跑；manifest.test.ts 漂移对拍）。
 */
import { buildResourceManifest, serializeResourceManifest } from '../src/platform/meta/manifest.ts'
import { createSealedResourceRegistry } from '../src/platform/meta/register-all.ts'

const out = new URL('../../packages/shared/src/generated/resource-manifest.ts', import.meta.url)

const registry = createSealedResourceRegistry()
const manifest = buildResourceManifest(registry)
await Bun.write(out, serializeResourceManifest(manifest))
console.log(`resource-manifest: ${Object.keys(manifest).length} 资源 → ${out.pathname}`)
