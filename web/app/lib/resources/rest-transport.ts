/**
 * 标准 REST 资源 transport：列表 query / 单条 get，加按能力暴露的
 * create / update / delete。
 *
 * 系统中绝大多数资源端点形状一致（POST .query、GET/PATCH/DELETE .[':id']、
 * POST .）；本模块把这套 wire 形状收敛为唯一 implementation，业务资源文件只声明
 * 端点引用与 wire 选项（严格列表、decimal/datetime 字段、能力子集），不再逐资源
 * 手写五个方法的样板。偏离标准形状的资源（单例设置、附件、自定义查询）继续手写。
 *
 * 能力声明与端点形状在编译期关联：未声明 capabilities 时端点必须具备全部写
 * 动词；声明子集后经 RestEndpointsFor 只要求实际存在的动词。wire 类型断言
 * 集中在 apiData / Row 转换这几行，不再散落到各资源文件。
 */
import type { ListQuery } from '@synie/shared'
import { readApiResponse, type ApiResponseAdapter } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  dateTimeWireInput,
  decimalWireInput,
  resourceListBody,
  strictResourceListBody,
  type DecimalWireOptions,
  type ResourceListWireOptions,
} from './resource-wire'
import type {
  ResourceClient,
  ResourceQuery,
  ResourceTransport,
} from './types'

/* eslint-disable @typescript-eslint/no-explicit-any --
   endpoint 参数在 hc 处已按资源精确类型化；此处只约束端点形状，
   用 any 让异构资源的精确函数类型可装入同一结构 interface。 */

/**
 * hc 资源端点函数的最小形状。response 只要求 ApiResponseAdapter seam——
 * 真实 ClientResponse 与测试 fake 都满足该形状；body 类型断言集中在本模块内。
 */
type EndpointFn = (args: any) => Promise<ApiResponseAdapter>

/** 标准读端点：列表 query + 单条 get。 */
interface RestReadEndpoints {
  readonly query: { readonly $post: EndpointFn }
  readonly ':id': { readonly $get: EndpointFn }
}

/** 标准全量 CRUD 端点；缺任一动词的资源走 capabilities 重载。 */
interface RestCrudEndpoints extends RestReadEndpoints {
  readonly $post: EndpointFn
  readonly ':id': {
    readonly $get: EndpointFn
    readonly $patch: EndpointFn
    readonly $delete: EndpointFn
  }
}

/** 声明不支持的单记录写动作；未声明的能力默认全部存在。 */
export interface RestWriteCapabilities {
  readonly create?: boolean
  readonly update?: boolean
  readonly delete?: boolean
}

/** 按声明的能力收窄端点形状：未显式声明为 false 的动词必须存在。 */
type RestEndpointsFor<C extends RestWriteCapabilities> = RestReadEndpoints &
  (C extends { create: false } ? unknown : { readonly $post: EndpointFn }) & {
    readonly ':id': { readonly $get: EndpointFn } &
      (C extends { update: false }
        ? unknown
        : { readonly $patch: EndpointFn }) &
      (C extends { delete: false }
        ? unknown
        : { readonly $delete: EndpointFn })
  }

/** 按声明的能力收窄返回类型：未声明为 false 的写方法在类型上必然存在。 */
type RestTransportFor<C extends RestWriteCapabilities> = ResourceTransport &
  (C extends { create: false }
    ? unknown
    : Required<Pick<ResourceTransport, 'create'>>) &
  (C extends { update: false }
    ? unknown
    : Required<Pick<ResourceTransport, 'update'>>) &
  (C extends { delete: false }
    ? unknown
    : Required<Pick<ResourceTransport, 'delete'>>)

export interface RestTransportWireOptions {
  /** 严格列表：拒绝 fixedFilter/extraFields/joinFields，报错使用业务名。 */
  readonly strictListLabel?: string
  /** 非严格列表的透传选项（默认 merge 口径）。 */
  readonly listOptions?: ResourceListWireOptions
  /** create/update 时收口为 decimal wire string 的字段。 */
  readonly decimalFields?: readonly string[]
  /** decimal 收口的空值口径等选项。 */
  readonly decimalOptions?: DecimalWireOptions
  /** create/update 时把 YYYY-MM-DD 转为 datetime wire 的字段。 */
  readonly dateTimeFields?: readonly string[]
}

type PartialWriteEndpoints = RestReadEndpoints & {
  readonly $post?: EndpointFn
  readonly ':id': {
    readonly $get: EndpointFn
    readonly $patch?: EndpointFn
    readonly $delete?: EndpointFn
  }
}

/**
 * 生成标准 REST transport。id 恒为 `rest:${resource}`，与查询缓存身份共用同一约定。
 *
 * 不传 capabilities 时端点必须在类型层具备全部写动词，返回完整 ResourceClient；
 * 能力子集资源显式声明 capabilities，不支持的写方法在返回对象上不存在
 * （与手写 ResourceTransport 的既有约定一致，不写抛错 stub）。
 */
export function restTransport(
  resource: string,
  endpoints: RestCrudEndpoints,
  options?: RestTransportWireOptions,
): ResourceClient
export function restTransport<const C extends RestWriteCapabilities>(
  resource: string,
  endpoints: RestEndpointsFor<C>,
  options: RestTransportWireOptions & { capabilities: C },
): RestTransportFor<C>
export function restTransport(
  resource: string,
  endpoints: PartialWriteEndpoints,
  options: RestTransportWireOptions & {
    capabilities?: RestWriteCapabilities
  } = {},
): ResourceTransport {
  const capabilities = {
    create: true,
    update: true,
    delete: true,
    ...options.capabilities,
  }
  // 编译期关联之外的运行时兜底：手写 fake 端点声明了能力却缺动词时，
  // 模块装配期即失败，不把配置错误延迟到第一次写请求。
  if (capabilities.create && !endpoints.$post) {
    throw new Error(`rest:${resource} 声明了 create 能力但端点缺少 $post`)
  }
  if (capabilities.update && !endpoints[':id'].$patch) {
    throw new Error(`rest:${resource} 声明了 update 能力但端点缺少 $patch`)
  }
  if (capabilities.delete && !endpoints[':id'].$delete) {
    throw new Error(`rest:${resource} 声明了 delete 能力但端点缺少 $delete`)
  }

  function listBody(input: ResourceQuery): ListQuery {
    if (options.strictListLabel) {
      return strictResourceListBody(input, options.strictListLabel)
    }
    return resourceListBody(input, options.listOptions)
  }

  function writeBody(input: Record<string, unknown>): Record<string, unknown> {
    let body = input
    if (options.decimalFields?.length) {
      body = decimalWireInput(body, options.decimalFields, options.decimalOptions)
    }
    if (options.dateTimeFields?.length) {
      body = dateTimeWireInput(body, options.dateTimeFields)
    }
    return body
  }

  return {
    id: `rest:${resource}`,
    async query(input) {
      const result = (await readApiResponse(
        await endpoints.query.$post({ json: listBody(input) }),
      )) as { count: number; results: Row[] }
      return { count: result.count, results: result.results }
    },
    async get(id) {
      return (await readApiResponse(
        await endpoints[':id'].$get({ param: { id } }),
      )) as Row
    },
    ...(capabilities.create
      ? {
          async create(input: Record<string, unknown>) {
            return (await readApiResponse(
              await endpoints.$post!({ json: writeBody(input) }),
            )) as Row
          },
        }
      : {}),
    ...(capabilities.update
      ? {
          async update(id: string, input: Record<string, unknown>) {
            return (await readApiResponse(
              await endpoints[':id'].$patch!({
                param: { id },
                json: writeBody(input),
              }),
            )) as Row
          },
        }
      : {}),
    ...(capabilities.delete
      ? {
          async delete(id: string) {
            await readApiResponse(
              await endpoints[':id'].$delete!({ param: { id } }),
            )
          },
        }
      : {}),
  }
}
