/**
 * 单据装配 seam：业务记录 → PrintDoc。
 * 新资源 = 业务域 createXxxDocBuilder + 组合根 registerDocBuilder，不改 Renderer/PdfConverter。
 *
 * 收 Permit 而非 Actor：单据可达性由平台的 `loadAuthorized/findAuthorized` 判定
 * （公司/部门/属主一次编译到 WHERE），装配器内不再出现 `canAccessCompany` 这类判断。
 * 凭证由路由按「打印动作」签发，故「能打印的行」= 该授权触达的行集。
 */
import type { Permit } from '../authz/core/index.ts'
import type { BuiltDoc } from './types.ts'

export interface DocBuilder {
  /** 资源中文名（批量文件名用） */
  label(): string
  /**
   * 打印动作之外还须同时满足的权限码（如报表阅读码）。
   * 路由经 allOf 一并判定；未声明则只判 print/export。
   */
  requiredCodes?: readonly string[]
  buildDocs(permit: Permit, ids: string[]): Promise<BuiltDoc[]>
  /** 查询上下文虚拟单据（无记录 id）；未实现则走 ids */
  buildFromContext?(permit: Permit, context: Record<string, unknown>): Promise<BuiltDoc[]>
}

export type DocBuilderMap = Map<string, DocBuilder>
