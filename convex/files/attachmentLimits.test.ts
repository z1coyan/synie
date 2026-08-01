import { describe, expect, test } from 'bun:test'
import {
  assertOwnerAttachmentCapacity,
  assertOwnerCategoryCapacity,
  MAX_ATTACHMENTS_PER_OWNER,
  MAX_ATTACHMENT_CATEGORY_CODEPOINTS,
  MAX_DRAWING_ATTACHMENTS_PER_OWNER,
  normalizeAttachmentCategory,
} from './attachmentLimits'

describe('附件宿主容量边界', () => {
  test('允许恰好 200 个，拒绝第 201 个或非法计数', () => {
    expect(() => assertOwnerAttachmentCapacity(MAX_ATTACHMENTS_PER_OWNER - 1)).not.toThrow()
    expect(() => assertOwnerAttachmentCapacity(MAX_ATTACHMENTS_PER_OWNER)).toThrow('最多挂接 200 个附件')
    expect(() => assertOwnerAttachmentCapacity(200, 2, 2)).not.toThrow()
    expect(() => assertOwnerAttachmentCapacity(200, 2, 1)).toThrow('最多挂接 200 个附件')
    expect(() => assertOwnerAttachmentCapacity(-1)).toThrow('最多挂接 200 个附件')
  })

  test('图纸槽位独立限制 20 张，并允许等量替换', () => {
    const drawings = Array.from({ length: MAX_DRAWING_ATTACHMENTS_PER_OWNER }, () => ({
      category: 'drawing',
    }))
    expect(() => assertOwnerCategoryCapacity(drawings, 'drawing', 20, 20)).not.toThrow()
    expect(() => assertOwnerCategoryCapacity(drawings, 'drawing')).toThrow('图纸槽位最多挂接 20 个附件')
    expect(() => assertOwnerCategoryCapacity(drawings, 'default', 100)).not.toThrow()
  })

  test('分类使用 NFKC/去空格规范化，且最多 32 个 Unicode 字符', () => {
    expect(normalizeAttachmentCategory()).toBe('default')
    expect(normalizeAttachmentCategory('   ')).toBe('default')
    expect(normalizeAttachmentCategory(' ｄｒａｗｉｎｇ ')).toBe('drawing')
    expect(normalizeAttachmentCategory('📄'.repeat(MAX_ATTACHMENT_CATEGORY_CODEPOINTS))).toHaveLength(64)
    expect(() => normalizeAttachmentCategory('📄'.repeat(MAX_ATTACHMENT_CATEGORY_CODEPOINTS + 1)))
      .toThrow('附件分类最多 32 个字符')
  })
})
