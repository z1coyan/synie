# Plan 004: 打印/导出权限与模板管理权限解耦 + field-catalog 端点加权限门

> **执行者须知**:逐步执行,每步跑完验证命令确认预期结果再进下一步。只改 In scope 文件。命中 STOP 条件立即停手上报。按 Git workflow 提交。跳过「更新 plans/README.md」。上报前对照工具输出核对声明。
>
> **漂移检查(先跑)**:`git diff --stat 67a4f3f..HEAD -- backend/apps/synie_core/lib/synie_core/printing.ex backend/apps/synie_web/lib/synie_web/controllers/print_controller.ex`
> 若有变更,对照「现状」;不一致即 STOP。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED(动权限边界,方向是「按规格收敛」,靠正反向测试兜底)
- **Depends on**: 无
- **Category**: bug / security
- **Planned at**: commit `67a4f3f`, 2026-07-23

## Why this matters

规格(`.scratch/print-document-pipeline/spec.md` 权限节)白纸黑字:「**模板管理权限与单据打印权限分离:有 print 无 sys.print_template 仍可打印(用已有模板)**」。现状做反了:

1. 门面 `Printing.list_templates/2` 与 `load_template/3` 都带 actor 走 `Template` 的 read 策略,而该策略要求 `sys.print_template:read`(模板**管理**权限)。业务员只有 `sales.order:print` + `sales.order:read` 时:模板选择弹窗直接 403「无权查看打印模板」,打印/导出也在读模板一步失败。等于全公司想打印的人都得发模板管理权限,权限模型被打穿。现有测试全部给 actor 附带 `sys.print_template:read`,恰好掩盖了这个问题。
2. 反方向,`GET /api/print/field-catalog` 只要登录**零权限**就能拉任意资源的全字段结构(含全部 belongs_to 一层路径与循环区字段)——全站其它端点都权限门控,这里成了资源 schema 的信息泄露面。

修复后:打印/导出/列模板按「该资源的 print/export/batch_print」授权,模板读取在动作权限校验通过后走受信内部读;field-catalog 要求模板管理读权限或该资源任一打印类权限。

## 现状

- `backend/apps/synie_core/lib/synie_core/printing.ex` — 编排门面:

  ```elixir
  def list_templates(resource, actor) when is_binary(resource) do
    Template
    |> Ash.Query.filter(resource == ^resource)
    |> Ash.Query.sort(is_default: :desc, name: :asc)
    |> Ash.read(actor: actor)                       # ← 要求 sys.print_template:read
  end
  ...
  defp check_perm(resource, actor, action) do
    if SynieCore.Authz.has_permission?(actor, "#{resource}:#{action}") do
      :ok
    else
      {:error, :forbidden}
    end
  end
  ...
  defp load_template(template_id, resource, actor) do
    case Ash.get(Template, template_id, actor: actor) do   # ← 同上
      {:ok, %Template{resource: ^resource} = t} -> {:ok, t}
      {:ok, _} -> {:error, "模板与单据资源类型不匹配"}
      {:error, _} -> {:error, "模板不存在或无权访问"}
    end
  end
  ```

  `print/4` 先 `check_perm(resource, actor, "print"|"batch_print")`、`export/4` 先 `check_perm(resource, actor, "export")`,再 `load_template`——即调用链里**动作权限已显式校验**。
- `Template` 资源(`backend/apps/synie_core/lib/synie_core/printing/template.ex`)read 策略:`policy action([:read, ...]) do authorize_if SynieCore.Authz.Checks.HasPermission end` → 派生权限码 `sys.print_template:read`。**不要改这个策略**——GraphQL 管理页(`sysPrintTemplates` 查询)就靠它门控。
- `backend/apps/synie_web/lib/synie_web/controllers/print_controller.ex`:
  - `templates/2`:调 `Printing.list_templates(resource, actor)`,错误一律 403「无权查看打印模板」。
  - `field_catalog/2`:`with_actor(conn, fn _actor -> ...)` —— 只验登录,不验权限。
- 受信内部读的仓库约定(`backend/CLAUDE.md`):「`authorize?: false` 仅限受信内部路径」。本计划的受信理由:动作权限(`资源:print/export/batch_print`)已在进入前显式校验,模板是全局主数据、无公司维度,读它不产生数据权限绕越;在函数注释写明这一句。
- 权限判定函数:`SynieCore.Authz.has_permission?(actor, "sales.order:print")`。
- 测试样板:
  - 门面级:`backend/apps/synie_core/test/synie_core/printing/template_and_export_test.exs`(`actor!/1` 造带权限 actor;`actor_with_company!/2` 造带公司授权 actor)。
  - 控制器级:`backend/apps/synie_web/test/synie_web/print_controller_test.exs`(内联夹具造用户/角色/token,照 file_controller_test 同款)。

## 需要的命令

| 用途 | 命令 | 预期 |
|------|------|------|
| 环境 | `export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"` | mix 可用 |
| 门面测试 | `cd backend/apps/synie_core && mix test test/synie_core/printing/` | 全绿 |
| 控制器测试 | `cd backend/apps/synie_web && mix test test/synie_web/print_controller_test.exs` | 全绿 |
| 格式 | `cd backend && mix format --check-formatted` | exit 0 |

## Scope

**In scope**:
- `backend/apps/synie_core/lib/synie_core/printing.ex`
- `backend/apps/synie_web/lib/synie_web/controllers/print_controller.ex`
- `backend/apps/synie_core/test/synie_core/printing/template_and_export_test.exs`
- `backend/apps/synie_web/test/synie_web/print_controller_test.exs`

**Out of scope**:
- `Template` 资源的 policies(管理页 GraphQL 继续要求 `sys.print_template:read`)。
- 前端(`web/`)——弹窗与报错文案不变。
- `Renderer`/`DocBuilder`/`PdfConverter`。

## Git workflow

- 当前分支,单提交:`fix: 打印/导出与模板管理权限解耦,field-catalog 端点加权限门`。

## Steps

### Step 1: 门面 list_templates 改按打印类权限授权

`list_templates/2` 改为:actor 拥有 `#{resource}:print`、`#{resource}:export`、`#{resource}:batch_print`、`sys.print_template:read` **任一** → `Ash.read(..., authorize?: false)`(注释写受信理由);否则 `{:error, :forbidden}`。抽一个私有 `can_use_templates?(resource, actor)` 供 Step 3 复用。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/` → 全绿(既有 actor 都带权限)。

### Step 2: load_template 改受信读

`load_template/3` 改 `Ash.get(Template, template_id, authorize?: false)`(签名的 actor 参数删掉或保留但不再用于授权——删掉更诚实,同步改两处调用)。保留 `resource` 匹配校验与「模板不存在」错误文案。注释写明:动作权限已由 `check_perm` 显式校验,模板为全局主数据。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/` → 全绿。

### Step 3: field-catalog 端点加权限门

`print_controller.ex` 的 `field_catalog/2`:`with_actor` 内先判 `can_use_templates?`(经 `SynieCore.Printing` 暴露公共函数,如 `def can_use_templates?(resource, actor)`),不过则 `error(conn, 403, "无权限查看字段清单")`。

**验证**:`cd backend/apps/synie_web && mix test test/synie_web/print_controller_test.exs` → 既有「任意权限目录资源返回派生清单」用例会红——它的 actor 无任何权限。**这是预期**,Step 4 修它。

### Step 4: 测试补全(正反向)

门面(`template_and_export_test.exs`):
1. 「仅打印类权限、无模板管理权限,可导出」:管理员 actor(带 `sys.print_template:create` 等)建好模板后,另造 actor 仅授 `sales.order:read` + `sales.order:export` + 公司授权(照 `actor_with_company!`,**不给** `sys.print_template:read`),`Printing.export(...)` 成功返回 binary;`Printing.list_templates("sales.order", 该actor)` 返回含该模板的列表。
2. 「无打印类权限,列模板被拒」:actor 仅 `sales.order:read` → `list_templates` 返回 `{:error, :forbidden}`。

控制器(`print_controller_test.exs`):
3. 既有 field-catalog 用例的 actor 改为授 `sys.print_template:read`(或该资源 print),恢复 200。
4. 新用例:登录但零权限用户 GET field-catalog → 403;GET templates → 403。
5. 新用例:仅 `sales.order:print` 用户 GET templates?resource=sales.order → 200(空列表也算 200)。

**验证**:两条测试命令全绿,含新用例。

## Test plan

见 Step 4。反向用例(2、4)是本计划的灵魂——它们防止将来有人把授权门又挪回 Ash 策略时静默回归。

## Done criteria

- [ ] `cd backend/apps/synie_core && mix test test/synie_core/printing/` 全绿
- [ ] `cd backend/apps/synie_web && mix test test/synie_web/print_controller_test.exs` 全绿
- [ ] `cd backend && mix format --check-formatted` exit 0
- [ ] `git status` 无 in-scope 外改动
- [ ] 门面测试存在一个**不带** `sys.print_template:read` 而导出成功的用例(grep `sys.print_template` 核对该用例权限列表)

## STOP conditions

- 「现状」摘录与实际代码不符。
- `Template` read 策略发现不是 HasPermission 门控(与摘录不符)——权限模型理解有误,停。
- 修完后管理页 GraphQL 相关测试(如有)变红——说明误伤了 Ash 策略,停。
- 需要改 `template.ex` 的 policies 才能过测试——超界,停。

## Maintenance notes

- 评审重点:`authorize?: false` 两处的受信理由注释是否到位;`can_use_templates?` 的权限码拼接是否只认这四个码。
- 后续若新增「打印类」标准动作(如恢复 batch_export),`can_use_templates?` 要同步。
- 前端 `TemplatePrintDialog` 的「无可用模板」引导文案依赖 200+空列表,勿把空列表改成 404。
