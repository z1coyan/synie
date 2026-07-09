# 角色权限配置(SyniePermissionSheet)设计

2026-07-09。角色管理补上权限配置能力:permissionCatalog 驱动的勾选矩阵,独立宽 Sheet,角色列表行菜单入口。本轮后端零改动,只消费既有 API(`permissionCatalog`、`sysRolePermissions`、`createSysRolePermission`、`destroySysRolePermission`)。

## 为什么不是通用子表

拿 SynieDataGrid 挂 `sysRolePermissions` 当子表,配权限会变成"逐行新增权限码"(手打或下拉选码点几十次),交互不可用。权限点由代码派生(catalog),正确形态是勾选矩阵——这是一个专用区块,不是通用子表的试点;父子表通用形态留给第一个带行项目的单据资源。

## 组件形态

`web/app/components/synie-permission-sheet/`,沿用区块三件结构:

- `matrix.ts` — 纯函数层:通配匹配、勾选初态、保存 diff
- `SyniePermissionSheet.tsx` — 组件本体
- `permission-labels.ts` — 域/资源/动作三个中文映射表
- `permission-sheet-checks.ts` — bun 直跑断言

```ts
interface SyniePermissionSheetProps {
  roleId: string
  roleName: string                  // 标题「配置权限:{roleName}」
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  readOnly?: boolean                // 页面按 myPermissions 判后传入
}
```

外壳 `@heroui-pro/react` Sheet `placement="right"`,`w-full lg:w-[720px]`(比记录抽屉宽,矩阵需要宽度;断点统一 `lg`)。

## 入口:SynieDataGrid 现成 rowActions

SynieDataGrid 已支持页面级自定义行动作(`rowActions?: RowAction[]`,use-grid-actions 渲染进行菜单),零组件改动。角色页按 myPermissions 判定后传入「配置权限」动作打开 Sheet(RowAction 自带的 `capability` 门控走的是本资源 meta capabilities,跨资源码用不上,由页面条件传入代替)。

## 数据流与勾选初态

打开 Sheet 时并发拉 `permissionCatalog` + `sysRolePermissions`(按 roleId 过滤;按项目统一约定走 offset 分页 `count`/`results` 结构,一页 `limit: 200`(即 max_page_size)取足——权限行数量级小)。

勾选初态:对 catalog 展开的每个码 `prefix:action`,granted 行中存在精确码或通配覆盖即勾上。通配匹配语义与后端 `SynieCore.Authz.Registry` 对齐(granted `X:*` 覆盖 `X:` 下所有动作;granted `X.*` 覆盖前缀 `X.` 的所有码),checks 里放前后端对齐用例。

## 矩阵布局

- 按域分组(域标题行),每个资源一行。
- 列 = catalog 中出现过的动作并集(动作集合来自后端 `Permission.default_actions` 的 10 码:create/read/update/delete/print/import/export/batch_delete/batch_update/batch_print),顺序为前端展示序,非标动作(工作流码)排尾;资源不具备的动作格显示「—」。
- 中文标签查 `permission-labels.ts` 三个映射表,漏码原样显示英文(同 logs.tsx 模式)。
- 整域/整资源全选 v1 不做,列跟进项。

## 保存(diff 增删)

以「勾选集 vs granted 行」算 diff,并发逐条提交、聚合错误:

- 新勾的码逐条 `createSysRolePermission`;取消的精确码按行 id `destroySysRolePermission`。
- 通配行:展开集全部仍勾选 → 保留不动,其覆盖的码不重复 create;有任一码被取消 → 删该通配行,其余仍勾选且无其他行覆盖的码补写逐码。
- UI 不主动写通配码(fail-closed:新上线权限点默认不授予)。
- 部分失败:聚合错误 toast,Sheet 不关,重拉真实勾选态;原子性缺口接受,列跟进项。
- 成功:toast + 关 Sheet;权限不在列表列里,列表无需刷新。

## 门控

按 `myPermissions` 判(前端目前零使用、无全局缓存,由角色页在挂载时拉一次,入口显隐与 `readOnly` 都由页面判定后传入):

- 无 `sys.role_permission:read`:行菜单不显示「配置权限」。
- `sys.role_permission:create` 与 `delete` 需同时具备才可编辑,缺任一则矩阵只读、保存钮不出。
- `super_admin` 是用户级旗标,与矩阵无关。

## 错误处理

遵循项目守则:加载失败 Sheet 内错误态 + 重试;所有 mutation 失败聚合报错 toast,信息含失败的权限码。

## 测试

`permission-sheet-checks.ts`(bun 直跑)+ `bunx tsc --noEmit` 为前端闸门:

- 通配匹配用例:精确命中、资源通配、域通配、不命中。
- diff 用例:纯新增、纯删除、通配保留、通配拆解补码。

## 跟进项

1. 整域/整资源全选快捷操作。
2. 保存原子性:量大后后端加 bulk action(如 `replace_permissions`)。
3. 通配码写入能力(「整域授权」高级操作,授予后新权限点自动继承)。
4. 入口门控依赖的 myPermissions 若各页重复拉取,提全局缓存。
