# Plan 003: DocBuilder 格式化兜底安全化(map/嵌套结构不再崩)

> **执行者须知**:逐步执行,每步跑完验证命令确认预期结果再进下一步。只改 In scope 文件。命中 STOP 条件立即停手上报。按 Git workflow 提交。跳过「更新 plans/README.md」。上报前对照工具输出核对声明。
>
> **漂移检查(先跑)**:`git diff --stat 67a4f3f..HEAD -- backend/apps/synie_core/lib/synie_core/printing/doc_builder.ex`
> 若有变更,对照「现状」摘录;不一致即 STOP。

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 无
- **Category**: bug
- **Planned at**: commit `67a4f3f`, 2026-07-23

## Why this matters

DocBuilder 对**每条记录的全部公开字段**急切格式化(不管模板用没用到),格式化兜底分支是 `to_string(value)`——对 map 抛 `Protocol.UndefinedError`(已运行时验证)。而 `acc_vat_invoice`(增值税发票)的 `items` 是 `public? true` 的 `{:array, :map}` 属性(`backend/apps/synie_core/lib/synie_core/acc/vat_invoice.ex:793`),`sys_numbering_rule.segments` 同为 `{:array, :map}`。后果:**对增值税发票等含 map 属性的资源发起任何模板打印/导出,必 500 崩溃**,即使模板一个 map 字段都没引用。打印模板体系的卖点是「全资源零代码接入」,一个格式化兜底把一整类资源打没了。修复后 map/嵌套结构安全序列化为 JSON 文本,任何资源都装配得出 doc。

## 现状

- `backend/apps/synie_core/lib/synie_core/printing/doc_builder.ex` — 通用装配器。`format/2`(约 152–171 行):

  ```elixir
  defp format(_type, nil), do: ""

  defp format({:array, inner}, values) when is_list(values),
    do: Enum.map_join(values, ", ", &format(inner, &1))

  defp format(type, value) do
    cond do
      enum_type?(type) -> enum_label(type, value)
      match?(%Date{}, value) -> Date.to_iso8601(value)
      match?(%Time{}, value) -> Time.to_iso8601(value)
      match?(%NaiveDateTime{}, value) -> NaiveDateTime.to_iso8601(value)
      match?(%DateTime{}, value) -> DateTime.to_iso8601(value)
      match?(%Decimal{}, value) -> Decimal.to_string(value)
      is_boolean(value) -> if(value, do: "是", else: "否")
      is_atom(value) -> Atom.to_string(value)
      true -> to_string(value)
    end
  end
  ```

  `%{...}`(非 struct map)与无 `String.Chars` 实现的 struct 都会落进 `true -> to_string(value)` 崩掉。
- 装配契约(moduledoc 与 spec 定案):「取值一律转字符串、空值归空串」;显示格式由单元格 Excel 格式承载,引擎不发明格式化语法。
- Jason 在依赖里(Phoenix/Ash 标配),可直接用。
- 集成测试样板:`backend/apps/synie_core/test/synie_core/printing/template_and_export_test.exs`(真库沙箱,`Ash.Seed.seed!` 造数)。`sys_numbering_rule` 资源:`backend/apps/synie_core/lib/synie_core/numbering/rule.ex`(`segments` 为 `{:array, :map}`,资源码 `sys.numbering_rule`,权限前缀同名)。

## 需要的命令

| 用途 | 命令 | 预期 |
|------|------|------|
| 环境 | `export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"` | mix 可用 |
| 打印全套 | `cd backend/apps/synie_core && mix test test/synie_core/printing/` | 全绿 |
| 格式 | `cd backend && mix format --check-formatted` | exit 0 |

## Scope

**In scope**:
- `backend/apps/synie_core/lib/synie_core/printing/doc_builder.ex`
- `backend/apps/synie_core/test/synie_core/printing/template_and_export_test.exs`(加回归用例)

**Out of scope**:
- FieldCatalog 的派生规则(是否把 map 字段从清单排除是产品问题,不在本计划;本计划只保证不崩)。
- Renderer、控制器、前端。

## Git workflow

- 当前分支,单提交:`fix: DocBuilder 格式化兜底安全化,map/嵌套结构序列化为 JSON 文本`。

## Steps

### Step 1: format 兜底改安全序列化

`format/2` 的 cond 末尾改为(顺序敏感,放在 `is_atom` 之后):

```elixir
is_map(value) and not is_struct(value) -> Jason.encode!(value)
true -> safe_to_string(value)
```

新增私有函数:

```elixir
# 打印容错从宽:无 String.Chars 实现的罕见类型降级为 inspect,不让单条字段崩掉整次打印
defp safe_to_string(value) do
  to_string(value)
rescue
  Protocol.UndefinedError -> inspect(value)
end
```

注意 `{:array, :map}` 走 `format({:array, inner}, ...)` 分支后逐元素进 `format(:map, %{...})`,map 分支必须在兜底之前命中。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/` → 全绿。

### Step 2: 回归测试

`template_and_export_test.exs` 新增用例「含 map 数组属性的资源可装配导出(sys.numbering_rule)」:

- `Ash.Seed.seed!` 造一条 `SynieCore.Numbering.Rule`(看该资源必填属性,`segments` 给 `[%{"type" => "literal", "text" => "SO"}]` 之类的最小合法值;若 seed 需要绕过校验,`Ash.Seed.seed!` 本就绕过 action 校验,直接给属性)。
- 断言 `SynieCore.Printing.DocBuilder.build("sys.numbering_rule", rule)` 返回 `{:ok, %{fields: fields}}` 且 `fields["segments"]` 是含 `"literal"` 的 JSON 字符串(`=~ "literal"` 即可,不锁完整 JSON 形状)。
- 加一行负向说明性断言:`fields` 全部 value 都 `is_binary`(维持「值均为字符串」契约):`assert Enum.all?(fields, fn {_, v} -> is_binary(v) end)`。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/template_and_export_test.exs` → 全绿含新用例。

## Test plan

见 Step 2;样板照同文件「导出端到端:无 has_many 主数据资源(物料)」用例。

## Done criteria

- [ ] `cd backend/apps/synie_core && mix test test/synie_core/printing/` 全绿,含新用例
- [ ] `cd backend && mix format --check-formatted` exit 0
- [ ] `git status` 无 in-scope 外改动
- [ ] `grep -n "true -> to_string(value)" backend/apps/synie_core/lib/synie_core/printing/doc_builder.ex` 无匹配

## STOP conditions

- 「现状」摘录与实际代码不符。
- `SynieCore.Numbering.Rule` 无法用 `Ash.Seed.seed!` 造出(如有数据库层强约束)且 15 分钟内找不到等价含 map 属性资源可替代——停下上报,勿硬造。
- Jason 不在 synie_core 依赖树(`grep jason backend/apps/synie_core/mix.exs backend/mix.lock`)——停下上报改用别的序列化前先确认。

## Maintenance notes

- 若未来 FieldCatalog 决定把 map 字段整体排除出清单,本兜底仍应保留(防御性:清单排除≠装配不遇到)。
- 评审重点:JSON 输出对模板作者是否可用是次要的(几乎无人在模板里印 map);关键是**不崩**。
