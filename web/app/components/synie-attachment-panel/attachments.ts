import { gqlFetch } from '~/lib/graphql'

/**
 * 附件列表查询三件套:面板/单图槽位/表格图片列共用同一 queryKey,
 * 上传删除后的失效互相可见(面板动、表格列跟着刷)。
 */
export interface AttachmentRow {
  id: string
  category: string
  insertedAt: string
  file: { id: string; filename: string; contentType: string | null; size: number | null }
}

export const attachmentListKey = (ownerType: string, ownerId?: string | null, category?: string) => [
  'sysAttachments',
  ownerType,
  ownerId ?? '',
  category ?? '',
]

/** owner_type/category 是开发期常量,ownerId 是库里 uuid,内插安全(与 DataGrid 同做法);按上传时间升序 */
export async function fetchAttachmentList(
  ownerType: string,
  ownerId: string,
  category?: string
): Promise<AttachmentRow[]> {
  const categoryFilter = category ? `, category: { eq: "${category}" }` : ''
  const query = `query {
    sysAttachments(limit: 200, filter: { ownerType: { eq: "${ownerType}" }, ownerId: { eq: "${ownerId}" }${categoryFilter} }) {
      results { id category insertedAt file { id filename contentType size } }
    }
  }`
  const d = await gqlFetch<{ sysAttachments: { results: AttachmentRow[] } }>(query)
  return [...d.sysAttachments.results].sort((a, b) => a.insertedAt.localeCompare(b.insertedAt))
}
