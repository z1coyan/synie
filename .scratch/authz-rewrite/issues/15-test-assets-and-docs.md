# 15 — 收尾：测试资产换代与文档

**What to build:** 旧体系测试资产与文档全面换代：`.scratch/authz-e2e` 时代的守卫/矩阵测试资产按新体系重述（静态挂载守卫 → 「全资源有 authz 声明 + 全路由有 guard」内省断言；矩阵内核测试 → decide fixtures 穷举）；`contracts/fixtures/authz/permission_matches.json` 删除；`command-auth.test.ts` 退役（Permit 类型化后失去存在意义，其对齐断言移入 catalog 测试）。文档：`docs/architecture/resource-onboarding.md` 补 authz 声明步骤；产品文档系统管理篇复核（部门/范围已在 05/13 分别落节）；CONTEXT.md 术语最终复核。

**Blocked by:** 09, 10, 11, 12, 14

**Status:** ready-for-agent

- [ ] 新静态守卫：目录内全资源有 authz 声明、全挂载路由有 guard、封路豁免清单为空
- [ ] decide fixtures 穷举 + 前后端对拍进 CI；旧 permission_matches.json 删除
- [ ] command-auth.test.ts 退役、authz-e2e 资产标注归档
- [ ] resource-onboarding.md 与产品文档、CONTEXT.md 复核
- [ ] 全库 grep 断言：requirePermission/candidates/companyScopeWhere 旧符号零残留

## Comments
