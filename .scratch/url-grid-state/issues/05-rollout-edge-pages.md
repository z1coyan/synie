# 05 — 边缘页面验收与并存约定

Status: ready-for-agent

## 背景

机制已默认对全部页面级 `SynieDataGrid` 开启。下列页面有额外 search 语义或双网格，需人工验收并在必要时改 prop / 键策略，而不是再「迁移开关」。

## 改动面与关注点

1. **`finance/entries.tsx`**  
   - 已有 `validateSearch` 下钻参数 + `defaultFilters` + `key={JSON.stringify(search)}`  
   - 验收：下钻进入后筛选可见可清；用户再改筛选写 `f` 后刷新；与 `companyId` 等下钻键不互相覆盖  
   - 若冲突：下钻只作 defaultFilters 初值（`f` 缺席），`f` 在场以 `f` 为准（当前实现已如此）

2. **`base/market.tsx`**  
   - 已有 `tab` search；双 Tab 各一网格（价点 / 品种）  
   - 验收：切 tab 保留 `tab`；网格写 `q/page/...` 不丢掉 `tab`（merge 语义）  
   - 两网格若同页挂载会争用同一组网格键：确认 Tabs 是否卸载非活跃面板；若双挂载，较弱侧加 `urlState={false}` 或后续做资源命名空间

3. **多网格同页**  
   - 例：部分 layout 是否同时挂两个列表（少见）  
   - 策略：同页仅一个网格拥有 URL；其余 `urlState={false}`

4. **与 `url-record-drawer` 并存**（依赖并行工作线）  
   - 网格键：`q/page/ps/sort/f`  
   - 抽屉键（约定）：`record`/`mode`（以该 ADR 为准）  
   - 双方必须函数式 merge，禁止 `search: { ...整包 }`

5. **与 `route-loader-prefetch`**  
   - loader 若预取列表，应用与网格相同的 search 解析（`parseGridUrlSearch`），避免首屏与 URL 不一致  
   - 本票仅文档交叉引用；prefetch 落地时再接线

## 验收标准

- entries 下钻 + 分享链接手工测通
- market 切 tab + 筛选/翻页 URL 手工测通
- 代码库无 `navigate({ search: { ...固定对象 } })` 抹掉网格或抽屉键的新增用法（存量 market 整包 tab 写入需改为 merge，见下）
- 存量 `base/market.tsx` 中 `navigate({ search: { tab } })` 改为函数式 merge（否则会抹掉网格键）——**优先修**

## 建议修复示例

```ts
navigate({
  search: (prev) => ({ ...prev, tab: 'prices' }),
  replace: true,
})
```
