/**
 * 单据装配 seam：业务记录 → PrintDoc。
 * 本期接入 sales.order；新资源 = 注册 DocBuilder，不改 Renderer/PdfConverter。
 */
import type { Actor } from '../authz/actor.ts'
import type { BuiltDoc } from './types.ts'

export interface DocBuilder {
  /** 资源中文名（批量文件名用） */
  label(): string
  buildDocs(actor: Actor, ids: string[]): Promise<BuiltDoc[]>
}

export type DocBuilderMap = Map<string, DocBuilder>
