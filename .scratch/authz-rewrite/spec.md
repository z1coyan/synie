# 权限系统重构：封闭谓词代数与 Permit 凭证式鉴权

Status: ready-for-agent
2026-08-04 grill-with-docs 定案。取代 `.scratch/data-scope-foundation/`（已删除，从未实施）。

## 0. 背景与动机（代码现状盘点结论）

现有授权维度只有「权限码（含通配）× 公司集合」，执行完全散布在服务层：

- 约 498 处检查散布在 36+ 个服务文件；路由层零鉴权；模块自造 6 套包装（`requirePerm`/`requireAnyPermission`/`requireCreateOrUpdate`/`requireCompanyWrite`/两个 `requireAction`）。
- 「actor 能否碰这家公司」有 4 种写法、2 种 HTTP 语义（`forbidden`/`not_found` 混用，`warehouse-service.ts` 单文件两种都有）。
- `ResourceMeta` 没有公司域声明，40 个 list 调用点各自判断要不要过公司过滤；`companyScopeWhere` 的 `empty` 早退义务手工重复 25 次，另有 4 处手滚变体。
- meta 的 `capabilities`/`CommandDocument.requiredCapability` 只管前端展示，与服务层 `requirePermission` 是两条无关代码路径，仅靠 `command-auth.test.ts` 手工对拍 3 个动作；`readPermissionsAny` 声明了但不执行（orderflow 在路由和服务里又手写两遍）。
- 行级概念完全空白：`created_by_id` 存在于 ~25 张表但从未进授权 WHERE；部门只有菜单占位符；文件下载可达性一个谓词实现了三遍、三种语义。
- 全部散布检查可折叠为 9 种判定形态 + 2 个非权限伴生物（状态守卫、授权目录闭包）。

重构目标：**判定词汇表收束为封闭集（永不增长）**；**授权成为元数据能力**（声明 → seal 校验 → 平台执行 → 前端投影，对齐编号/审计/附件已验证的范式）；支撑部门、本人等行级数据范围。系统在开发期，**不做兼容**。

## 1. 封闭谓词代数

判定词汇表分三层，每层是封闭枚举，**未来一切权限需求不得新增谓词**：

```
主体种类（3）:   user | system | superAdmin
码级组合子（3）: one(code) | anyOf(codes) | allOf(codes)
行级范围原子（6）: all | company | deptTree | dept | self | granted
行级组合子（1）:  via(link)
```

### 1.1 行级范围原子语义

| 原子 | 语义 | SQL 编译形态 |
|---|---|---|
| `company` | 行的公司 ∈ actor 授权公司；声明了公司域即恒定生效，不可授出 | `company_id = ANY($ids)`；`nullable` 声明时 `(col IS NULL OR col = ANY($ids))` |
| `all` | 公司边界内不再限行 | `true` |
| `deptTree` | 行的部门列 ∈ actor 部门子树（含本部门） | `dept_col = ANY($subtreeIds)` |
| `dept` | 行的部门列 = actor 部门 | `dept_col = $deptId` |
| `self` | 行的属主列 = actor 本人 | `owner_col = $userId` |
| `granted` | 存在显式记录级授权行（**第一期不实现**，见 §9） | `EXISTS (SELECT 1 FROM sys_record_grant …)` |

**有效行集 = company ∧ (授予范围原子的并集)**。范围原子在格上嵌套 `self ⊆ dept ⊆ deptTree ⊆ all`，`granted` 正交并联。多角色授予同码不同范围时取格上最大 ∪ granted。

### 1.2 封闭性论证（三个泄压口）

未来新需求只落进三个口子，都不产生新谓词：

1. **主体侧计算**（岗位/角色组/代理人等）：只改变 Actor 装配时 `deptId`/`grants` 的计算方式，代数不动。
2. **对象侧显式授权**（`granted` + `sys_record_grant`）：一切「临时共享/委派给个人」类需求的固定归宿。
3. **派生资源**（`via`）：附件随宿主、子行随单头、只读投影随源资源——声明一条 link，判定递归到宿主资源自己的 decide()。

### 1.3 划出权限系统的事项

- 状态前置条件（草稿才能改等，~60 处）：领域不变量，留服务层抛 `conflict`。
- 内置角色冻结、授权目录闭包：IAM 写侧校验。
- 字段敏感性 / writeOnly / FieldInputPolicy：投影层继续负责。

### 1.4 错误语义（唯一规则）

动作码不满足 → `forbidden`；行级范围不命中（公司/部门/本人）→ 一律 `not_found`（不泄露存在性）。现存 4 写法 2 语义分叉全部消除。

## 2. 部门维度

- **部门挂公司**：`sys_department(id, company_id NOT NULL → bas_company, parent_id 自引用可空, code, name, path 物化路径, enabled)`，`(company_id, code)` 唯一；树深不限，子树查询走 path 前缀。组织主数据**归 IAM 管理**（authz 不拥有此表）。
- **用户单部门**：`sys_user.department_id uuid NULL → sys_department`。一人恰一部门；兼任需求出现时再演进为关系表（显式决策：接受届时迁移）。
- **写侧一致性硬校验**（IAM）：设置用户部门时，部门所在公司必须已在该用户公司授权集内；回收公司授权时若用户部门属该公司，拦截并提示先移部门。不留「配了但永远编译为空集」的幽灵配置。
- **dept 谓词绑定：单列 + 两形态**，每资源在 meta 声明恰好一列：
  - **归属部门**（stamped，缺省形态）：约定列名 `owner_dept_id`，创建时按创建人部门自动盖章，不可手填，人调部门不追溯存量行。
  - **指派部门**（assigned，显式声明）：业务字段（如需求单 `assigned_dept_id` 下发车间），**填写不受 actor 部门约束**（计划员可下发任意车间），谁能改由动作码 + 行级范围管。
- 无部门用户：dept/deptTree 范围编译为空集；其创建行归属部门为 NULL，仅 all/self 范围可见。
- 列按需生长：只有声明了 owner/dept 绑定的资源才需要相应物理列（seal 校验列存在），不做全库加列。

**试点场景（验收基准）**：需求单由计划员创建（scope=all 的角色维护），头级下发冲压车间（`mfg_demand.assigned_dept_id`）；冲压车间生产经理持 `mfg.demand:read scope=dept` 只看到下发本车间的需求单，从行安排生产工单；工单资源用归属部门形态，车间自建自见。跨车间需求拆单。

## 3. 授权存储

| 表 | 变更 |
|---|---|
| `sys_role_permission` | 加 `scope text NOT NULL DEFAULT 'all'`（`all/dept_tree/dept/self`；`granted` 预留值第一期拒写）。授权 = (role, code, scope) 三元组 |
| `sys_role` | 加 `grants_all boolean NOT NULL DEFAULT false`：Actor 装配时展开为全目录 all 范围，新权限码自动覆盖。内置 admin 改用此旗标 |
| `sys_department` / `sys_user.department_id` | 见 §2 |
| `sys_record_grant` | **第一期不建**，设计见 §9 |
| `sys_user_company` | 不动。公司授权维持用户级、fail-closed（显式决策） |

**通配符全部取消**：匹配退化为精确 Map 查找；`candidates()` 三份实现（`server/src/platform/authz/permission.ts` + web 两份）全删；种子 admin 的 `*` 行改为 `grants_all=true`；`syncRolePermissions` 的目录闭包校验保留（含 scope 合法性：资源不支持的维度拒授）；`contracts/fixtures/authz/permission_matches.json` 对拍夹具换代为 decide fixtures。

## 4. Actor v2 与装配

```ts
interface Actor {
  kind: 'user' | 'system'
  userId: string
  superAdmin: boolean
  companies: { all: boolean; ids: readonly string[] }   // all_companies 旗标折叠进来
  deptId: string | null
  deptSubtreeIds: readonly string[]                      // 装配时按 path 物化（含本部门）
  grants: ReadonlyMap<string, ScopeSet>                  // 精确码 → 范围位集（grants_all 已展开）
}
```

- 装配在 `platform/authz`（吸收现 `auth/store.ts` 的 `actorByUserId`）：用户行 + 角色授权（含 scope、`r.enabled=true` 语义不变）+ 公司集 + 部门子树，短 TTL 缓存（30s；接受角色变更最长 30s 延迟，替代现状每请求 3 查询无缓存）。
- `system` 主体经 `systemPermit()` 显式获取（调度器/种子/跨模块受信任读），杀掉 null-actor 分支与「受信任读」裸函数约定。

## 5. 元数据声明：`ResourceMeta.authz`（注册期强制）

```ts
authz:
  | { kind: 'company'
      companyColumn?: string          // 缺省 company_id
      nullable?: boolean              // audit/attachment 类可空公司列
      owner?: { column?: string }     // 缺省 created_by_id；声明即启用 self 范围
      dept?: { column?: string; mode: 'stamped' | 'assigned' }  // stamped 缺省列 owner_dept_id
      recordGrants?: boolean }        // 第一期声明即注册期报错（预留）
  | { kind: 'global' }                // 全局资源：只有码级判定
  | { kind: 'via'; parent: string; fk: string; anyOf?: string[] }
      // 派生/子行/投影资源：判定递归到宿主资源；anyOf 取代 readPermissionsAny 且真正执行
```

- register 缺失 `authz` 即抛错（与 classification 同等强制）；seal 校验声明列存在于 fields、via.parent 在目录内、global 资源确无 company_id 列（防漏声明）。
- `owner` 绑定缺省复用 `created_by_id`（已有盖章逻辑，语义=创建人即初始属主）；资源需要「可转移属主」时显式声明独立 `owner_id` 列。
- 权限目录投影每个 prefix 的 `supportedScopes`（由声明推导：无 owner 声明则无 self，无 dept 声明则无 dept/deptTree），矩阵 UI 与授权 sync 共同基准。

## 6. 判定内核与三环边界

```
platform/authz/core   纯函数、零 IO、零表知识：Actor/ScopeSet/decide()/Permit/RowFilter AST
platform/authz        授权存储 + Actor 装配 + systemPermit；对外 buildActor/decide/guard
db 适配（db/list 等）  RowFilter AST → SQL；listFromSource v2 / loadAuthorized
http 适配             guard(resource, action) 中间件
```

```ts
decide(actor, resource, action): Decision        // deny | permit
// Permit = { actor, resource, action, rowFilter }，只能从内核获得
// RowFilter = { company: 'bypass' | 'none' | { ids, nullable }, atoms: ScopeAtom[] }
```

判定逻辑固定：superAdmin/system → allow(all)；`grants[code]` 缺失 → deny；命中 → allow(company ∧ scopes)。**未来所有权限需求不改此函数**。

**Permit 凭证式（显式决策）**：服务方法签名从 `(actor, …)` 改为 `(permit, …)`；绕过鉴权直接调服务在编译期不成立，取代 `command-auth.test.ts` 的运行期对拍。特征化测试封路：`modules/**` 禁止 import `requirePermission`/`hasPermission`/`companyScopeWhere`。

## 7. 三个执行点（平台所有，模块零鉴权代码）

1. **列表**：`listFromSource` v2 收 Permit，自动 AND 编译产物；`empty` 早退义务消失（编译器产出 `sql\`false\``）；audit/files/todo 的 NULL-admitting 手滚变体收编为 `nullable` 声明。
2. **单记录**：`loadAuthorized(permit, id, { forUpdate? })` 取代全库 ~200 处「loadX + 公司闸」组合；统一 `not_found`；`FOR UPDATE` 折叠（对齐 `lockOrder`/`lockDraft` 实践）。
3. **写入**：create 校验公司 ∈ 授权公司（不命中 `not_found`），自动盖章 `created_by_id`（既有）与 `owner_dept_id`（声明了 stamped 才盖）；assigned 列为业务字段不受 actor 部门约束。update/delete/工作流命令一律经 `loadAuthorized` 用该动作的 rowFilter 取行——「只能改本人/本部门单据」零模块代码。

**路由接线**：保持手写 Hono 链（保 RPC 类型链），入口统一 `guard(resource, action)`：查 sealed registry 确认 (resource, action) 存在（杜绝客户端提供 prefix 的路径，如打印）、调 decide、把 Permit 放 ctx。动作码唯一事实源是 meta。分支内二次授权（如导入自动建员工需 `hr.employee:create`）在分支内再取一张 Permit；`anyOf`/`allOf` 由 guard 支持。

## 8. 前端投影

- **ResourceDocument v3**：`capabilities` 从 `string[]` 变 `{ action, scope }[]`；文档携带 authz 维度声明与绑定列 apiName（ownerId/ownerDeptId/assignedDeptId 进 wire）。
- **行级 UI 判定**：DataGrid 行动作用同一代数客户端本地求值（me 的 userId/deptId/deptSubtreeIds × 行盖章列），服务端仍是权威；`contracts/fixtures/authz` 换代为 decide fixtures 两端对拍。
- **矩阵范围 UI**：(role, code, scope) 三元组授权，格子/行带范围选择（全部/本部门及以下/本部门/仅本人），仅对 supportedScopes 命中的资源渲染（显式决策：表达力优先，UI 复杂度后解）。
- **me 通道合一**：`lib/permissions.ts` 与 `use-my-perms.ts` 合并为一个 hook（精确码 + grantsAll，无通配展开），未解析期一律 fail-closed（修 `other-stock.tsx` fail-open）；8 个文件的硬编码权限码改消费投影。
- **13 处 `capabilities={[...]}` 硬覆盖删除**：子行资源声明 `via(parent)` 后服务端投影出正确 capabilities。

## 9. granted 预留设计（第一期不实现）

```sql
sys_record_grant(
  id uuid PK, resource text NOT NULL, record_id uuid NOT NULL,
  grantee_kind text NOT NULL CHECK (IN ('user','dept','role')), grantee_id uuid NOT NULL,
  action text NOT NULL,            -- 授出的动作码尾段（read/update/…）
  granted_by uuid NOT NULL → sys_user, expires_at timestamp NULL, inserted_at
)
-- 编译：EXISTS (… WHERE resource=$r AND record_id=t.id AND action=$a
--        AND ((kind='user' AND grantee_id=$uid) OR (kind='dept' AND grantee_id=$deptId) OR (kind='role' AND grantee_id=ANY($roleIds))))
```

授出行为本身由资源新工作流动作 `grant`（进权限目录）门控。首个真实消费者出现时按本节落地：建表、开放 scope 枚举 `granted`、补矩阵与授权入口。在此之前 `recordGrants` 声明与 scope 值均注册期/写侧拒绝。

## 10. 现状形态 → 新归宿映射（覆盖性证明）

| 现状 | 归宿 |
|---|---|
| S1 单码检查（~460 处，6 套包装 3 种拼法） | `guard(resource, action)`，服务零代码 |
| S2 任一码（4 套实现 + readPermissionsAny 不执行） | `via.anyOf` / guard `anyOf()`，声明即执行 |
| S3 全部码（3 处） | guard `allOf()` |
| S4 单记录公司闸（~130 处 4 写法 2 语义） | `loadAuthorized`，统一 `not_found` |
| S5 列表公司谓词（58 处 + 4 手滚） | `compileRowFilter`，`nullable` 收编变体 |
| S6 经关联行可达（文件 3 处 3 语义） | `via(link)` 单实现，语义以 owner-registry 版为准收敛 |
| S7 属主判定（上传者可下载/挂接） | `sys_file` 声明 owner，孤儿文件 read=self |
| S8 主体种类（superAdmin 路由/null-actor） | `kind:'system'` + `systemPermit()`，杀 null-actor 与裸受信任读 |
| S9 请求形态派生动作码（打印 mode+arity、发票 reverseMode） | 路由内派生 action 后照常走 guard |
| 状态守卫（~60 处） | 划出权限系统，服务层 `conflict` |
| D8 分支条件权限 | 分支内二次取 Permit |
| D14 目录闭包 + 内置角色冻结 | 留 IAM 写侧 |

## 11. 批次与工单（见 issues/）

批 0 内核（01-04）→ 批 1 组织地基（05）→ 批 2 试点（06 files / 07 需求单下发 / 08 标准公司域模块）→ 批 3 按模块扫荡（09-12）→ 批 4 收口（13 矩阵范围 UI / 14 前端 v3 / 15 测试资产换代与文档）。

## 12. 决策登记（grill-with-docs 定案）

1. 部门挂公司；2. dept 单列绑定 + 归属/指派两形态（冲压车间场景定案）；3. (role, code, scope) 三元组授权，表达力优先；4. 公司授权维持用户层；5. 需求单下发头级；6. granted 设计定案实现缓行；7. 用户单部门（兼任再演进）；8. 通配符全部取消；9. Permit 凭证式 + systemPermit；10. 三环边界（纯内核 / authz 拥有授权存储与装配 / 部门树归 IAM）；11. 旧 `.scratch/data-scope-foundation/` 与 ADR data-scope-ladder 删除。

## 13. 跟进项（不阻塞本轮）

- granted 首个消费者落地（§9）。
- 兼任/多任职演进（届时 `sys_user.department_id` → 关系表迁移）。
- 矩阵范围 UI 的交互深化（范围选择器首版从简）。
- Actor 缓存失效联动（角色/授权写入主动失效，现按 30s TTL 容忍）。
