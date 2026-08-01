import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceTransport } from './types'
import {
  getProductFile,
  listProductFiles,
  queryAttachmentsForFile,
  queryFileAttachments,
  removeFileAttachment,
  removeProductFile,
} from '~/lib/files'

export const fileClient = {
  id: 'convex:sysFiles',
  async query(input) {
    return await listProductFiles({ numItems: input.numItems ?? 100, cursor: input.cursor ?? null }) as { count: number; results: Row[] }
  },
  async get(id) { return await getProductFile(id) as Row },
  async delete(id) { await removeProductFile(id) },
} satisfies ResourceTransport

export async function queryAttachments(input: Record<string, unknown>) {
  if (typeof input.fileId === 'string' && input.fileId) return queryAttachmentsForFile(input.fileId)
  return queryFileAttachments({
    ownerType: String(input.ownerType),
    ownerId: String(input.ownerId),
    ...(typeof input.category === 'string' && input.category ? { category: input.category } : {}),
  })
}

export async function deleteAttachment(id: string): Promise<void> {
  await removeFileAttachment(id)
}
