import { v } from 'convex/values'
import { permissionedQuery } from '../lib/auth'
import generatedDocuments from './generatedDocuments.json'

type GeneratedDocument = {
  name: string
  label: string
  permissionPrefix: string
  capabilities: string[]
}

/** Permission matrix is a build-time projection of the sealed Catalog. */
const groups = Object.values(generatedDocuments as Record<string, GeneratedDocument>)
  .filter((document) => document.permissionPrefix && document.capabilities.length > 0)
  .map((document) => ({
    prefix: document.permissionPrefix,
    label: document.label,
    // `read` is the baseline resource capability. Generated documents only
    // declare additional writer/command capabilities, so it must be projected
    // explicitly into the role permission sheet.
    actions: [...new Set(['read', ...document.capabilities])].sort(),
  }))
  .sort((left, right) => left.prefix.localeCompare(right.prefix))

export const get = permissionedQuery('sys.role_permission:read')({
  args: {},
  returns: v.any(),
  handler: async () => ({ groups }),
})
