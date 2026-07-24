# 01 — 静态挂载守卫

**What to build:** 一个内省守卫测试，抓「忘了挂」这一最常见事故形态：凡在权限目录声明了权限前缀的资源，必须挂功能权限校验策略；凡带公司字段的资源，必须同时挂公司读过滤与公司写校验。守卫扫出的存量漏挂，就地修复或带书面理由进显式豁免清单。独立可合，先于矩阵产生防御价值。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 守卫覆盖权限目录内全部资源，断言功能权限校验挂载
- [x] 带公司字段的资源断言公司读过滤与公司写校验双挂载
- [x] 存量漏挂：修复，或进带注释理由的显式豁免清单（不允许无理由豁免）
- [x] 失败信息点名资源与缺失的挂载项
- [x] 进现有后端 CI job 常跑，全绿合入

## Comments

已实现于 `apps/synie_core/test/synie_core/authz/mount_guard_test.exs`（纯内省，不碰数据库）。
五条断言：授权器挂载 / permission_prefix 声明 / 每动作 HasPermission 覆盖 /
company_id 资源 read 全被 CompanyScope 覆盖 / 能写 company_id 的动作挂 CompanyAccessible。
静态条件匹配只认 always()/action_type/action 三种形状（全库现存仅此三种），未知形状
按不覆盖处理（宁误报不漏报）。存量扫描未发现真漏挂：全部偏离项都是注释成文的故意设计
（内部专用动作/授权载荷语义），已进带理由豁免清单；豁免清单带失效检查（修复后忘删则红）。
