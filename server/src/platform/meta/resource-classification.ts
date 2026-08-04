/**
 * Resource Catalog 呈现分类规范化（工单 10）。
 * 分类事实由各资源 meta 自带（ResourceMeta.classification，注册期强制）；
 * 本层只保留规范化逻辑：register 时按分类补齐 form.kind，不改变领域校验与写路径。
 */
import type { FormMeta } from '@synie/shared'
import type { ResourceMeta } from './types.ts'

export type { PresentationClass, ResourceClassification } from './types.ts'

/**
 * 按分类补齐 form.kind；不覆盖模块已显式声明的 form.kind / lookup。
 */
export function applyResourceClassification(meta: ResourceMeta): ResourceMeta {
  const c = meta.classification
  if (!c) {
    throw new Error(
      `Meta 资源「${meta.name}」缺少 classification（presentation/interactive 必须有意识声明）`,
    )
  }
  let form = meta.form
  const desiredKind =
    c.presentation === 'basic'
      ? 'basic'
      : c.presentation === 'extension'
        ? 'extension'
        : 'none'

  if (!form) {
    if (desiredKind !== 'none') {
      form = { kind: desiredKind }
    }
  } else if (!form.kind) {
    form = { ...form, kind: desiredKind as FormMeta['kind'] }
  } else if (
    (c.presentation === 'extension' || c.presentation === 'none') &&
    form.kind === 'basic'
  ) {
    // 分类优先：扩展/无表单不得保持 basic
    form = { ...form, kind: desiredKind as FormMeta['kind'] }
  } else if (c.presentation === 'basic' && form.kind === 'none') {
    // basic 分类一律投影 basic 布局（由 toForm 从可写字段生成 placements）
    form = { ...form, kind: 'basic' }
  }

  return {
    ...meta,
    ...(form ? { form } : {}),
  }
}
