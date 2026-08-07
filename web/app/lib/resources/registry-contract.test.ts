/**
 * Registry ↔ server 资源目录契约对拍（ADR 2026-08-07-resource-manifest D6）。
 *
 * server Catalog 资源（经资源事实清单）要么在前端注册 ResourceBinding，
 * 要么进显式豁免清单（带理由）；差集不再静默到「打开页面才炸」。
 * 新增 server 资源时本测试强制三选一：挂 binding / 加豁免（写理由）/ 删资源。
 */
import { describe, expect, test } from 'bun:test'
import { RESOURCE_MANIFEST } from '@synie/shared/generated/resource-manifest'
import { listResourceBindingKeys, resourceBindingFor } from './registry'

/**
 * 有意不注册 ResourceBinding 的 server 资源（presentation: 'none'，无独立交互面）。
 * 键存在即豁免；值是理由，供评审与排查。资源一旦注册 binding 必须从此移除。
 */
const NO_BINDING_BY_DESIGN: Readonly<Record<string, string>> = {
  mfgWorkOrderByproducts: '工单副产品快照；打印循环区（ADR 2026-08-07 D12，无用户 CRUD）',
  mfgWorkOrderComponents: '工单 BOM 配料快照；打印循环区（ADR 2026-08-07 D12，无用户 CRUD）',
  mfgWorkOrderRoutes: '工单工艺路线快照；打印循环区（ADR 2026-08-07 D12，无用户 CRUD）',
  sysAttachments: '附件 catalog-only：经 SynieAttachmentPanel/files 接口消费，无独立 binding',
  sysRoleMenus: 'catalog-only：嵌于角色「配置菜单」Sheet，无独立 Client/抽屉',
  sysRolePermissions: 'catalog-only：嵌于角色呈现扩展，无独立 Client/抽屉',
}

describe('Registry ↔ server 资源目录契约', () => {
  const registered = listResourceBindingKeys()

  test('server 目录资源：有 binding 或显式豁免，无第三态', () => {
    for (const name of Object.keys(RESOURCE_MANIFEST)) {
      if (name in NO_BINDING_BY_DESIGN) continue
      expect(
        registered.includes(name),
        `资源「${name}」未注册 ResourceBinding 且不在豁免清单`,
      ).toBe(true)
    }
  })

  test('豁免清单精确：豁免资源确实未注册（注册了必须移出豁免）', () => {
    for (const name of Object.keys(NO_BINDING_BY_DESIGN)) {
      expect(
        registered.includes(name),
        `资源「${name}」已注册 binding，应从豁免清单移除`,
      ).toBe(false)
    }
  })

  test('注册表无目录外资源（transports 不得指向 server 不存在的资源）', () => {
    for (const name of registered) {
      expect(
        RESOURCE_MANIFEST[name],
        `注册资源「${name}」不在 server 资源目录`,
      ).toBeDefined()
    }
  })

  test('每个注册资源都能经 resourceBindingFor 解析', () => {
    for (const name of registered) {
      expect(() => resourceBindingFor(name)).not.toThrow()
    }
  })
})
