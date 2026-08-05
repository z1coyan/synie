# ADR：Permit 凭证式鉴权与 authz 三环边界

2026-08-04。规格见 `.scratch/authz-rewrite/spec.md`。与「封闭谓词代数」ADR 同批定案：代数管判定语言，本篇管执行架构。

- **背景**：路由层零鉴权，~498 处 `requirePermission`/公司闸散布在 36+ 服务文件，模块自造 6 套包装；meta 的 capabilities/requiredCapability 只管前端展示，与服务层检查是两条无关路径，仅靠一个测试文件手工对拍；`readPermissionsAny` 声明而不执行；调度器路径靠 null-actor 与「受信任读」裸函数约定。
- **决策**：
  1. **三环边界（高内聚低耦合）**：`platform/authz/core` 纯判定内核（零 IO、零表知识：decide/Permit/RowFilter AST）→ `platform/authz` 拥有授权存储与 Actor 装配（对外 buildActor/decide/guard）→ db/http 适配层把 RowFilter 编译为 SQL、把 guard 挂路由。**部门树是组织主数据归 IAM 管理**，authz 只消费「用户→部门子树」窄接口，不私有组织结构。
  2. **Permit 凭证式**：服务方法签名收 `Permit`（只能由内核签发，携带 actor 与该动作允许的行集）；绕过鉴权直调服务在**编译期**不成立，取代运行期自查与手工对拍测试。内部调用（调度器/种子/跨模块受信任读）走显式 `systemPermit()`，null-actor 约定废除。
  3. **三个执行点全部平台所有**：列表（listFromSource v2 自动 AND 行过滤，empty 早退义务消失）、单记录（loadAuthorized 统一 not_found 并折叠 FOR UPDATE）、写入（create 公司校验 + 归属盖章；update/delete/工作流命令经 loadAuthorized 取行）。业务模块**零鉴权代码**，特征化测试封路（modules/** 禁 import 授权原语）。
  4. **动作码唯一事实源是 meta**：路由统一挂 `guard(resource, action)` 从 sealed registry 解析（含 anyOf/allOf；打印等客户端提供 prefix 的入口改目录解析），ActionMeta/路由/服务三处真相合一。
- **理由**：集中三个执行点是行级能力的前提（散布检查无处插入行过滤）；Permit 把 fail-closed 从「靠测试盯」升级为「类型不成立」；纯内核可穷举单测并与前端共用 fixtures；部门树归 IAM 避免权限模块私有将来 HR/报表都要用的主数据。
- **不变量**：手写 Hono 链 + zValidator 的 RPC 类型链模式不变（guard 是链上中间件，不引入命令总线）；状态守卫留在服务层；`r.enabled=true` 的角色即时停用语义保留（Actor 30s TTL 缓存内收敛）。
- **影响面**：全部服务方法签名 `(actor, …)` → `(permit, …)`（扫荡期逐模块重写）；6 套模块级包装与 `command-auth.test.ts` 退役；`auth/store.ts` 的 Actor 装配迁入 authz。
