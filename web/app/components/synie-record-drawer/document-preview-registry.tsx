/**
 * 单据只读速览薄装配（Fk 全局入口）。
 * 侧效：import 本模块即登记各业务 Presentation module 暴露的 preview。
 */
import {
  listPresentationResources,
  presentationFor,
} from '~/lib/resources/presentation/registry'
import { registerDocumentPreview } from './document-preview'

for (const resource of listPresentationResources()) {
  const preview = presentationFor(resource).documentPreview
  if (preview) registerDocumentPreview(resource, preview)
}
