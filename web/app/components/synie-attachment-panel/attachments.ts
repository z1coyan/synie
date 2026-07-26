import { queryAttachments } from '~/lib/resources/files'

export interface AttachmentRow {
  id: string
  category: string
  insertedAt: string
  file: { id: string; filename: string; contentType: string | null; size: number }
}

export const attachmentListKey = (ownerType: string, ownerId?: string | null, category?: string) => [
  'sysAttachments',
  ownerType,
  ownerId ?? '',
  category ?? '',
]

export async function fetchAttachmentList(
  ownerType: string,
  ownerId: string,
  category?: string
): Promise<AttachmentRow[]> {
  const result = await queryAttachments({
    limit: 200,
    offset: 0,
    ownerType,
    ownerId,
    category,
  })
  return result.results
    .filter((attachment) => attachment.file)
    .map((attachment) => ({
      id: attachment.id,
      category: attachment.category,
      insertedAt: attachment.insertedAt,
      file: {
        id: attachment.file!.id,
        filename: attachment.file!.filename,
        contentType: attachment.file!.contentType ?? null,
        size: attachment.file!.size,
      },
    }))
    .sort((a, b) => a.insertedAt.localeCompare(b.insertedAt))
}
