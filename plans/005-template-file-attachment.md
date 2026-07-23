# Plan 005: 模板文件挂接 attachment(下载授权 + 生命周期)

> **执行者须知**:逐步执行,每步跑完验证命令确认预期结果再进下一步。只改 In scope 文件。命中 STOP 条件立即停手上报。按 Git workflow 提交。跳过「更新 plans/README.md」。上报前对照工具输出核对声明。
>
> **漂移检查(先跑)**:`git diff --stat 67a4f3f..HEAD -- backend/apps/synie_core/lib/synie_core/printing/template.ex backend/apps/synie_core/lib/synie_core/files/owner_registry.ex`
> 若有变更,对照「现状」;不一致即 STOP。

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 无(与 004 都动 `template_and_export_test.exs`,顺序执行省合并)
- **Category**: bug
- **Planned at**: commit `67a4f3f`, 2026-07-23

## Why this matters

模板文件目前是「裸文件」:前端上传得 `sys_file`,模板资源仅存 `file_id` FK,不建 `sys_attachment`。而统一文件接口的下载授权 `SynieCore.Files.downloadable?/2` 对裸文件只放行**上传者本人或超管**。后果:

1. 管理员 A 上传的模板,管理员 B 在模板抽屉点「下载」直接 403(前端 `downloadFile` 走 `GET /api/files/:id`)——刚合入的「抽屉可查看/下载当前模板文件」功能对非上传者形同虚设。
2. 模板删除或换文件后,旧 `sys_file` 永久成为无主孤儿,文件管理页对非上传者不可见也不可清理。

模板主数据规格(`.scratch/print-template-master/spec.md`)本就要求:「模板应建 attachment 或明确 owner,使文件管理可见」。修复后:模板文件挂 `sys_attachment`(owner=模板自身),下载授权自然落到 `sys.print_template:read`;换文件/删模板时同步清理挂接,不留无主挂接。

## 现状

- `backend/apps/synie_core/lib/synie_core/files/owner_registry.ex` — 附件宿主白名单(fail-closed),形如:

  ```elixir
  @owners %{
    "sal_customer" => SynieCore.Sales.Customer,
    ...
    "acc_bill_transaction" => SynieCore.Acc.BillTransaction
  }
  ```

  **无** `sys_print_template` 条目。key 是 graphql type 名;`Template` 的 graphql type 是 `:sys_print_template`(见 `template.ex` 的 `graphql do type :sys_print_template end`)。
- `backend/apps/synie_core/lib/synie_core/files.ex` 的 `downloadable?/2`(93 行起):有可见 attachment → 按宿主资源 `permission_prefix() <> ":read"` 判;裸文件 → 仅上传者/超管。attachment 的读策略:`is_nil(company_id)` 放行(全局宿主),模板无公司维度 → attachment 的 `company_id` 留空即全站可见、再由权限码把关。
- `backend/apps/synie_core/lib/synie_core/files/attachment.ex` — `sys_attachment` 资源;create 接受 `[:file_id, :owner_type, :owner_id, :category, :company_id]`,有 destroy。
- `backend/apps/synie_core/lib/synie_core/printing/template.ex` — 模板资源:create 接受 `[:name, :resource, :file_id, :remarks]`,update 接受 `[:name, :file_id, :remarks]`(`require_atomic? false`),destroy 已 `require_atomic? false`、`primary? true`。资源挂审计 fragment(`fragments: [SynieCore.Audit.Fragment]`)。
- 受信内部写约定(`backend/CLAUDE.md`):`authorize?: false` 仅限受信内部路径——本计划 after_action 里维护自身文件挂接属于宿主自管,理由写注释。
- 测试样板:`backend/apps/synie_core/test/synie_core/printing/template_and_export_test.exs`(`actor!/1`、`upload_xlsx!/2` 已有;沙箱 + 临时本地存储 setup 已有)。

## 需要的命令

| 用途 | 命令 | 预期 |
|------|------|------|
| 环境 | `export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"` | mix 可用 |
| 打印测试 | `cd backend/apps/synie_core && mix test test/synie_core/printing/` | 全绿 |
| 文件域测试 | `cd backend/apps/synie_core && mix test test/synie_core/files/ 2>/dev/null \|\| true`(若目录存在) | 全绿 |
| 格式 | `cd backend && mix format --check-formatted` | exit 0 |

## Scope

**In scope**:
- `backend/apps/synie_core/lib/synie_core/files/owner_registry.ex`(加一行注册)
- `backend/apps/synie_core/lib/synie_core/printing/template.ex`(create/update/destroy 挂接维护 change)
- `backend/apps/synie_core/test/synie_core/printing/template_and_export_test.exs`

**Out of scope**:
- `sys_file` 行本身的删除(旧文件成为**有迹可循**的裸文件后,由文件管理页/上传者处置;文件字节 GC 不在本计划)。
- `Files.downloadable?/2`、`FileController`、前端——零改动,授权自然生效。
- 前端上传动线(仍是先传裸文件再建模板,挂接由后端补)。

## Git workflow

- 当前分支,单提交:`fix: 打印模板文件挂 sys_attachment,下载授权走模板读权限并随换文件/删除清理`。

## Steps

### Step 1: OwnerRegistry 注册

`@owners` 加 `"sys_print_template" => SynieCore.Printing.Template`(维持 map 内分组顺序习惯,放 sys 组或末尾)。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/` 相关(registry 若有测试)不红;编译过 `mix compile --warnings-as-errors`(仅本 app)。

### Step 2: Template 资源维护挂接

在 `template.ex` 新增一个 `Ash.Resource.Change`(同文件顶部与 ValidateFile 等并列,如 `SynieCore.Printing.Template.SyncFileAttachment`),挂到 create 与 update 动作;destroy 挂清理。语义:

- after_action(create/update):查 `Attachment` 中 `owner_type == "sys_print_template" and owner_id == record.id` 的行(`authorize?: false`,受信:宿主自管自身挂接):
  - 已有且 `file_id` 一致 → 不动;
  - 已有但 `file_id` 不同(换文件)→ destroy 旧行,建新行;
  - 没有 → 建新行。建行参数:`%{file_id: record.file_id, owner_type: "sys_print_template", owner_id: record.id, category: "template"}`(不传 company_id,模板全局)。
- destroy 动作 after_action(或 before_action,以能拿到 id 为准):destroy 该 owner 的全部 attachment 行。
- 注意:附件行的建删同样走 `authorize?: false` 受信路径并写一行理由注释;若 `Attachment` 的 create 需要经 `Files` 门面做公司去规范化——模板无公司,直接建行即可,但先读 `attachment.ex` 确认 create 无强制 change 依赖宿主查询;若有,依其形状适配。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/` → 全绿(既有用例走 create,不应受影响)。

### Step 3: 回归测试

`template_and_export_test.exs` 新增 describe「模板文件挂接与下载授权」:

1. 建模板后:该文件存在一条 `sys_attachment`(owner_type `sys_print_template`,owner_id=模板 id,`authorize?: false` 读断言);`SynieCore.Files.downloadable?(另一管理员actor, file)` 为 `true`(该 actor 授 `sys.print_template:read`,**不是**上传者)。
2. 无 `sys.print_template:read` 的 actor(如仅 `sales.order:read`)→ `downloadable?` 为 `false`。
3. update 换文件:旧文件 attachment 行消失(旧文件回归裸文件),新文件有 attachment 且 `downloadable?`(非上传者管理员)为 `true`。
4. destroy 模板:attachment 行清空(按 owner 查询为 `[]`)。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/template_and_export_test.exs` → 全绿含 4 个新用例。

## Test plan

见 Step 3;actor 构造照同文件 `actor!/1`。「另一管理员」= 新 user + 新 role 授 `sys.print_template:read`。

## Done criteria

- [ ] `cd backend/apps/synie_core && mix test test/synie_core/printing/` 全绿,新用例在
- [ ] `cd backend && mix format --check-formatted` exit 0
- [ ] `git status` 无 in-scope 外改动
- [ ] `grep -n "sys_print_template" backend/apps/synie_core/lib/synie_core/files/owner_registry.ex` 恰一处

## STOP conditions

- 「现状」摘录与实际代码不符。
- `Attachment` create 有强制依赖宿主 GraphQL 查询/公司去规范化 change,导致直接建行不可行且 30 分钟内无干净适配——停下上报(可能需要走 `Files` 门面新入口,属设计变更)。
- 审计 fragment 与 after_action 建行相互作用导致测试红(如审计要求 actor)且无既有先例可照——停下上报。
- 需要改 `files.ex`/`file_controller.ex` 才能过——超界,停。

## Maintenance notes

- 换下来的旧文件是**裸文件**:上传者与超管在文件管理可见可删;是否自动删 `sys_file` 行留给文件管理策略统一决策(勿在模板侧私设文件 GC)。
- 评审重点:换文件路径的 attachment 建删是否在同一事务语义内(after_action 在事务内);destroy 清理是否覆盖「同 owner 多行」的容错。
- 前端后续可给「下载」失败时更友好的提示,但本计划后 403 场景只剩「无模板读权限」,属预期。
