import { Hono } from 'hono'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { AppEnv } from '../http/context.ts'
import type { Registry } from './registry.ts'

// 路径与响应包装对齐 server-go：{"resources": [...]} / 文档本体 / {"groups": [...]}
export function metaRoutes(registry: Registry, auth: AuthService) {
  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .get('/resources', (c) => c.json({ resources: registry.summaries(c.get('actor')) }))
    .get('/resources/:name', (c) => c.json(registry.buildDocument(c.req.param('name'), c.get('actor'))))
    .get('/permission-catalog', (c) => c.json({ groups: registry.permissionCatalog() }))
}
