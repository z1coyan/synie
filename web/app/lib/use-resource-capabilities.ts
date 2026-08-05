/**
 * 资源能力门控 hook（工单 14）：消费 ResourceDocument v3 投影的 capabilities/authz，
 * 取代页面硬编码权限码。复用 fetchResourceDocument 的模块级缓存。
 * forbidden（403）/pending/错误一律 fail-closed（has=false、scopeOf=undefined）。
 */
import { useQuery } from '@tanstack/react-query'
import {
  hasCapability,
  type CapabilityEntry,
  type DataScope,
  type ResourceDocument,
  type ResourceDocumentAuthz,
} from '@synie/shared'
import { resourceDocumentQuery } from '~/lib/resources/catalog/client'

export interface ResourceCapabilities {
  /** 文档未解析（拉取中/失败）时为 true；此间 has/scopeOf 一律 fail-closed */
  pending: boolean
  /** 文档成功取回（含读权）即为 true；forbidden/失败为 false */
  readable: boolean
  has: (action: string) => boolean
  scopeOf: (action: string) => DataScope | undefined
  /** 行级判定维度（company 形态且声明 owner/dept 绑定时携带） */
  authz: ResourceDocumentAuthz | undefined
}

/** ResourceDocument → 门控视图（纯函数，便于测试）；文档缺失即 fail-closed 态 */
export function resourceCapabilitiesOf(
  document: ResourceDocument | undefined,
): ResourceCapabilities {
  const capabilities: readonly CapabilityEntry[] = document?.capabilities ?? []
  return {
    pending: !document,
    readable: document !== undefined,
    has: (action) => hasCapability(capabilities, action),
    scopeOf: (action) => capabilities.find((entry) => entry.action === action)?.scope,
    authz: document?.authz,
  }
}

/** 消费资源文档投影的能力门控；forbidden 即全部 false（fail-closed） */
export function useResourceCapabilities(resource: string): ResourceCapabilities {
  const query = useQuery({ ...resourceDocumentQuery(resource), retry: false })
  return resourceCapabilitiesOf(query.data)
}
