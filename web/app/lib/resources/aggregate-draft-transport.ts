/**
 * 聚合草稿 transport 工厂：GET :id/draft / POST / PUT :id 三连。
 *
 * 对标 restTransport 对标准 REST CRUD 的收口——凡端点形状统一为草稿三连的资源，
 * 一律经本工厂生成 AggregateDraftAdapter；资源文件只声明端点引用与可选 wire 转换，
 * 不再逐资源手写三方法样板。wire 字段（decimal 字符串化、集合 fail-closed 等）
 * 仍属领域差异，由调用方以 options.wire 注入。
 *
 * 端点形状随后端各波统一后，新聚合资源在此逐资源切换；偏离三连的资源继续手写。
 */
import {
  readApiResponse,
  type ApiResponseAdapter,
} from '../api/client'
import type { AggregateDraftAdapter } from './catalog/types'

/* eslint-disable @typescript-eslint/no-explicit-any --
   endpoint 参数在 hc 处已按资源精确类型化；此处只约束端点形状，
   用 any 让异构资源的精确函数类型可装入同一结构 interface。 */

/** hc 草稿端点函数的最小形状；response 走 ApiResponseAdapter seam。 */
type EndpointFn = (args: any) => Promise<ApiResponseAdapter>

/**
 * 标准聚合草稿端点：集合 POST 创建、:id PUT 整单替换、:id/draft GET 装载。
 * 资源端点树上多余的动词（$get / $patch / audit 等）不妨碍结构性匹配。
 */
export interface AggregateDraftEndpoints {
  readonly $post: EndpointFn
  readonly ':id': {
    readonly $put: EndpointFn
    readonly draft: {
      readonly $get: EndpointFn
    }
  }
}

export interface AggregateDraftTransportOptions<TDraft> {
  /**
   * create/replace 前对 body 做 wire 转换（decimal 字符串化、集合显式性校验等）。
   * 缺省原样提交。
   */
  readonly wire?: (input: TDraft) => unknown
}

/**
 * 生成标准聚合草稿 Adapter。
 * wire 断言与 response 断言集中在工厂内，与 restTransport 口径一致。
 */
export function aggregateDraftTransport<TDraft, TSaved = TDraft>(
  endpoints: AggregateDraftEndpoints,
  options: AggregateDraftTransportOptions<TDraft> = {},
): AggregateDraftAdapter<TDraft, TSaved> {
  const toWire = options.wire ?? ((input: TDraft) => input as unknown)

  return {
    async loadDraft(id) {
      return (await readApiResponse(
        await endpoints[':id'].draft.$get({ param: { id } }),
      )) as TSaved
    },
    async createDraft(input) {
      return (await readApiResponse(
        await endpoints.$post({ json: toWire(input) as never }),
      )) as TSaved
    },
    async replaceDraft(id, input) {
      return (await readApiResponse(
        await endpoints[':id'].$put({
          param: { id },
          json: toWire(input) as never,
        }),
      )) as TSaved
    },
  }
}
