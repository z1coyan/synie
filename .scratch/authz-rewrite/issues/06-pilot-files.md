# 06 — 试点：files（via + owner，三套语义收敛）

**What to build:** 文件/附件域迁到新体系，作为 `via` 组合子与 owner 维度的第一消费者：`sys_file` 声明 `owner: uploaded_by_id`（孤儿文件 read/attach 范围=self）；挂接可达性（现 `owner-registry.resolveOwner`）、下载可达性（现 `files/service.ts:329`）、发票凭证附件（现 `invoice-service.ts:requireAccessibleFile`）三套各异语义收敛为一个 via 实现（以 owner-registry 语义为准：宿主 read 权限 + 公司范围，孤儿走 owner）。`AttachmentsMeta.companyScoped` 并入 authz 声明口径。uploader-only 裸 superAdmin 旗标读全部消除。

**Blocked by:** 04

**Status:** done

- [x] sys_file / sys_attachment / sys_storage 三资源 authz 声明与服务签名 Permit 化
- [x] via 实现：挂接→宿主递归判定（宿主 read + 公司；nullable 公司=全局宿主）
- [x] 下载/挂接/删除三径统一语义，invoice requireAccessibleFile 删除改走平台判定
- [x] 现有文件域集成测试全绿 + 新增孤儿/跨公司/无宿主权限用例
- [x] 封路豁免清单移除 platform/files 与相关 finance 项

## Comments

**可达性收敛（唯一规则，`platform/files/reachability.ts`）**

```
挂接可达 = 业务宿主行可达（宿主 read 码 + 宿主自身 authz 编译的行谓词）
文件可达 = 孤儿（未挂任何宿主）∧ 文件自身行过滤命中
         ∨ 任一挂接可达
```

原三套语义的忠实翻译：旧下载闸是 `attachments.length === 0 ? (superAdmin ∨ uploader) : 宿主可达`——
分支保留，只把「superAdmin ∨ uploader」换成 `sys_file` 的行过滤（decide 给 superAdmin all 范围，
授 `sys.file:read scope=self` 得到 uploader-only）。裸 `actor.superAdmin` 旗标读因此全部消失，
而**跨公司宿主对全域读者也不可达**（若改成「自身过滤 ∨ 宿主可达」的纯析取，all 范围读者就能下载
任何公司的附件——那是回归，明确不取）。

**三资源声明**

| 资源 | 声明 | 理由 |
|---|---|---|
| `sysFiles` | `{ kind: 'global', owner: { column: 'uploaded_by_id' } }` | 无公司列；owner 绑上传者列 → 开放 self 范围（`sys.file` 是目录里唯一 `supportedScopes = [all, self]` 的前缀） |
| `sysAttachments`（新建 meta） | `{ kind: 'via', parent: 'sysFiles', fk: 'file_id' }` | 挂接不设独立权限点（沿用 `sys.file:*`），且 via 的 `supportedScopes = []` 不参与同前缀交集——否则会把文件的 self 范围交没了 |
| `sysStorages` | `{ kind: 'global' }`（原样） | 只有码级判定 |

**多态宿主的设计张力与决策**

`sys_attachment.owner_type/owner_id` 是多态的，静态 `via` 只能声明单 parent。分工落定为：

- 静态 `via(sysFiles, file_id)` 供**码级**判定与外键闭包（guard 从归宿解析出 `sys.file:read/create/delete`）；
- **行级**判定动态解析：`ownerReachableWhere` 遍历 OwnerRegistry，每个宿主类型各取一张 read 凭证
  （`authz.decideFor`）、用宿主自己的 `authzTarget` 编译行谓词，拼成 `owner_type = $t AND EXISTS(...)` 的析取。
  码不满足的宿主类型直接不进 SQL。判定逻辑仍只有内核 `decide` 一份，本文件零主体/公司分支。
- 因此挂接行的行级判定**不用** via 链编译出的文件谓词（那会把附件面板锁成「只看得见自己上传的附件」）。
  `sys_attachment.company_id` 退化为展示/筛选列，不再是授权谓词——公司边界由宿主自己的声明提供。

**语义变化点（forbidden → not_found，行级不命中不泄露存在性）**

| 路径 | 旧 | 新 |
|---|---|---|
| 下载他人的孤儿文件 | `forbidden` 无权下载该文件 | `not_found` 文件不存在 |
| 下载/读元数据：宿主跨公司 | `forbidden` | `not_found` |
| 挂接非本人上传的文件 | `forbidden` 仅能挂接本人上传的文件 | 收敛进可达性：孤儿=本人（self 范围）→ 否则 `not_found` |
| `resolveOwner` 宿主行不存在/跨公司 | `forbidden` 无权访问该宿主记录 | `not_found` 宿主记录不存在 |
| `resolveOwner` 宿主 read 码不满足 | `forbidden` | `forbidden`（不变，码级判定） |
| 删挂接：跨公司 | `forbidden` 无权限删除其他公司的附件 | `not_found` 附件不存在 |
| 文件列表 / 删文件 | 有 `sys.file:read`/`:delete` 即见全库 | 加行过滤（scope=self 只见本人可达的） |
| 附件列表 | `sys.file:read` + 公司 NULL-admitting 手滚过滤 | **宿主可达**（更严：过去同公司但无宿主读权也看得见） |
| OCR 读文件（发票/承兑） | 无 `sys.file` 码要求，自造 SQL 闸 | 要求 `sys.file:read`（缺码 `forbidden`）+ 统一可达性 |

**删掉的旧件**

- `invoice-service.ts` / `bill-service.ts` 各一份 `requireAccessibleFile`（两份完全相同的复制品，工单只点了发票那份）
  → 平台 `files.readReachableFile(actor, id)`，一次调用同时完成判定与取字节。
- `owner-registry.resolveOwner` 的 `hasPermission` / `canAccessCompany` 版 → 迁到 `reachability.ts` 走 decide + `findAuthorized`。
- `AttachmentsMeta.companyScoped`（9 处声明 + 派生期 company_id 列校验）：公司域改由宿主 `authz.kind` 推导。
  逐一核对过 9 个宿主，`companyScoped` 与 `kind === 'company'` 100% 一致，故是零行为变更的纯收口。
- `OwnerSpec.permissionPrefix` / `.companyScoped` → `{ resource, table }`（前缀与公司域都回 meta 拿，不留第二份事实）。
- files 服务手滚的 `buildListQuery` + kysely 列表拼装 → `listFromSource`；storage 同理走 `listAuthorized` / `loadAuthorized`。
- `service.ts` 手抄的 `ATTACHMENT_AUDIT_FIELDS` → `auditFieldsOf(attachmentResourceMeta())`（原注释预告的那步）。

**封路豁免清单：一行未动**（`modules/authz-firewall.test.ts` 3 例全绿）

- `platform/files/**` 不在 `modules/**` 扫描范围内，但已实测零旧原语 import。
- `invoice-service.ts` / `bill-service.ts` 删掉 `requireAccessibleFile` 后仍有 `hasPermission`/`requirePermission`/
  `requireCompanyAccess`（各自的 `requireAction` 等），按「无僵尸项」断言必须**保留**豁免行；
  `invoice-service.ts` 的 `companyFilter` 导入随 helper 一起删了。

**测试**

- 全量：`512 pass / 4 fail`（516 across 79 files）。4 例失败全部与本轮无关：
  hr / printing / market 三个基线红（stash 掉本轮改动后逐个复跑，报错数字一模一样，如 printing 的 `61 vs 64`）
  \+ order-draft 并行截断偶发红（单文件跑 5 pass）。
- `test/files.integration.test.ts` 5 例全绿，Permit 化并新增：他人孤儿文件 `not_found`、跨公司宿主
  下载/元数据 `not_found`（含上传者本人也不例外）、无宿主 read 码 → 下载 `not_found` + 附件列表 0 条 +
  挂接 `forbidden`、孤儿仅上传者可见（`get` 命中 / 陌生人 `not_found` / 列表不含）、
  挂接固化宿主公司、`readReachableFile` 三态（可达/不可达 `not_found`/缺码 `forbidden`）。
  夹具改为 `createSealedResourceRegistry()` + 真凭证（`authz.decideFor`），宿主仍用廉价表
  （`salCustomers` 全局 / `accGlJournals` 公司域）。
- 快照三处：`catalog-seal` 104→105、`resource-authz` 形态分布 via 35→36、supportedScopes 断言改为
  「仅 `sys.file` 是 `[all, self]`」并加一例「via 挂接资源不新增权限码」。`menu-permission-contract`
  无需改（前缀集合没变，`sys.file` 早有菜单注解）。
- web `typecheck` 干净（未动前端；`supportedScopes` 目前无前端消费者，范围 UI 是工单 13）。

**坑**

- 同前缀多资源会撞打印字段目录的「打印头不明确」启动期断言：`sysFiles` 得显式 `printHead: true`
  （`sysAttachments` 不声明 `print`）。同前缀标签也必须一致（Registry 注册期校验），故挂接的
  `permissionLabel` 沿用「附件」。
- `permissionCatalog` 的 `supportedScopes` 取同前缀各资源的**交集**：给挂接选 `company` 形态会把
  文件的 `self` 交没（矩阵再也授不出「仅本人」）。这是选 `via` 而非 `company + nullable` 的决定性理由。
- `assertAuthzClosure` 的「global 不得有 company_id 列」防呆对 via 提前返回，所以带 `company_id` 的
  挂接资源只能是 company 或 via 两种声明之一。
- `FOR UPDATE` 与 WHERE 里的 EXISTS 子查询可以共存（只锁主表行）；子查询里的宿主表不会被锁。
- 路由用 `guard(资源, 动作)` 时 `allOf` 的附加码从 `authz.targetOf(资源).prefix` 拼（挂接要求 read+create），
  不写字面量权限码。

**留给后续（有意不在本工单动）**

- `hr/attendance-service.ts` 与 `finance/banking-import.ts` 仍用 `readStoredFile` + 自查 `sys.file:read`
  读用户传入的 fileId（无行级可达性判定）：属工单 11/12 扫荡范围，届时改 `readReachableFile`。
- `readStoredFile` 保留为受信任读（打印模板渲染、导入回读自己写下的 file_id），签名未动。
- 附件列表收严为「宿主可达」后，**宿主读权成了看附件的前置**：如订单列表里的物料图纸缩略图需要
  `inv.material:read`。存量角色若缺宿主读权，表现为缩略图/附件面板空——上线前值得扫一遍角色授权。
- `sys.file:read` 建议按 self 范围授给普通角色（孤儿文件即「我刚上传待挂接的文件」）；授 all 等于
  开放全库文件列表与孤儿文件下载，是文件管理员的口径。
