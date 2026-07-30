/**
 * Catalog Basic Form 页面接线：document + drawer props + binding。
 * basic 资源页面应经本 hook 取表单事实，禁止再手写 required/edit/placeholder。
 */
import { resourceBindingFor, resourceClientFor } from '../registry'
import { basicFormDrawerProps, type BasicFormDrawerProps } from './basic-form'
import { useResourceDocument } from './use-resource-document'

export function useCatalogBasicForm(resource: string, fallbackLabel?: string) {
  const binding = resourceBindingFor(resource)
  const client = resourceClientFor(resource)
  const documentQuery = useResourceDocument(resource)
  const formProps: BasicFormDrawerProps = documentQuery.data
    ? basicFormDrawerProps(documentQuery.data)
    : {
        label: fallbackLabel ?? resource,
        exclude: [],
        fields: {},
      }

  return {
    binding,
    client,
    documentQuery,
    formProps,
    /** document 已加载且 form.kind=basic */
    ready: Boolean(documentQuery.data && documentQuery.data.form.kind === 'basic'),
  }
}
