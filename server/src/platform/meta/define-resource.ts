/**
 * Typed ResourceDefinition 创作辅助：在编译期收紧本资源 form.exclude / form.fields
 * 的字段键。expand 期存量仍走 legacy ResourceMeta；新资源优先本入口。
 */
import type { FormMeta } from '@synie/shared'
import type { FieldMeta, ResourceMeta } from './types.ts'

type FieldNameOf<F extends readonly FieldMeta[]> = F[number]['apiName']

/**
 * 以字段字面量元组收窄 form.exclude / form.fields 键。
 * 运行时仍返回 ResourceMeta（catalogSource=typed）。
 */
export function defineResourceMeta<const F extends readonly FieldMeta[]>(
  def: Omit<ResourceMeta, 'fields' | 'form' | 'catalogSource'> & {
    fields: F
    form?: {
      exclude?: FieldNameOf<F>[]
      fields?: { [K in FieldNameOf<F>]?: Record<string, unknown> }
      sections?: FormMeta['sections']
      tabs?: FormMeta['tabs']
    }
  },
): ResourceMeta {
  return {
    ...def,
    fields: [...def.fields],
    form: def.form as FormMeta | undefined,
    catalogSource: 'typed',
  }
}
