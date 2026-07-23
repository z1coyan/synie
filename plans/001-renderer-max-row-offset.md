# Plan 001: 渲染器块偏移改按最大行号,修批量打印行号冲突

> **执行者须知**:逐步执行,每步跑完验证命令确认预期结果再进下一步。只改 In scope 文件。命中 STOP 条件立即停手上报,不要自行绕道。按 Git workflow 提交。跳过「更新 plans/README.md」——评审者维护索引。上报前对照本会话的工具输出核对每一条声明,只报有据可查的内容。
>
> **漂移检查(先跑)**:`git diff --stat 67a4f3f..HEAD -- backend/apps/synie_core/lib/synie_core/printing/renderer.ex backend/apps/synie_core/test/support/printing_fixture.ex`
> 若有变更,先对照下方「现状」摘录与实际代码;不一致即 STOP。

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED(改批量打印核心偏移语义,靠回归测试兜底)
- **Depends on**: 无
- **Category**: bug
- **Planned at**: commit `67a4f3f`, 2026-07-23

## Why this matters

批量打印把 N 份单据的模板块顺序铺进同一个 sheet,块偏移量取的是**行元素个数** `length(rows)`,而不是**最大行号**。Excel 保存时会省略没有内容的空白行(不写 `<row>` 元素),所以模板里只要有一个视觉空行(单据版式里极常见的留白行),行元素个数就小于实际占用行数,第二块的行号会与第一块尾部**重叠**。已用真实模板结构在运行时复现:模板行号 {1,3}(第 2 行空白)批量 2 份,输出行号序列 `["1","3","3","5"]` —— 行 3 重复,产物是损坏的 xlsx(Excel 打开报修复,LibreOffice 转 PDF 内容错乱)。修复后偏移与分页符、dimension 一律按最大行号计。

## 现状

- `backend/apps/synie_core/lib/synie_core/printing/renderer.ex` — 纯 Elixir xlsx 填充引擎。关键位置:
  - `expand_sheet/3`(约 379–443 行)展开单块,返回 `%{rows: out_rows, merges: merges, height: length(out_rows), max_col: max_column(out_rows)}` —— `height` 就是问题字段(行元素个数)。
  - `stitch_blocks/1`(约 227–250 行)拼接多块:

    ```elixir
    defp stitch_blocks([only]) do
      %{rows: rows, merges: merges, height: height, max_col: max_col} = only
      dim = dimension_ref(max_col, height)
      {rows, merges, [], dim}
    end

    defp stitch_blocks(blocks) do
      {rows, merges, breaks, offset, max_col} =
        Enum.reduce(blocks, {[], [], [], 0, 1}, fn block, {rs, ms, brs, off, mc} ->
          shifted_rows = Enum.map(block.rows, &shift_row_xml(&1, off))
          shifted_merges = Enum.map(block.merges, &shift_ref(&1, off))
          new_off = off + block.height
          # 分页符在块末行(Excel brk id = 该行之后分页,用块最后一行号)
          brk_id = new_off
          ...
    ```

    偏移 `off + block.height`、分页符 `brk_id = new_off`、`dimension_ref(max_col, offset)` 三处全用 `height`。
  - `do_render_sheets/2`(约 254–274 行)每 sheet 调 `dimension_ref(block.max_col, block.height)` —— 同样应改 max_row(dimension 正确性,非冲突路径)。
  - `row_number!/1`(约 707–712 行)已有:从 row XML 读 `r` 属性,缺失时 raise `RenderError`。
  - `shift_print_areas/4` 经 `block_offsets/1`(约 696–703 行)累计 `b.height` —— 打印区域偏移同样要改。
- `backend/apps/synie_core/test/support/printing_fixture.ex` — 测试夹具,`build(rows: [[...]])` 生成**连续**行号(r=1..n)的最小 xlsx;要复现空白行需要它支持显式行号。`sheet_xml/4`(184 行起)按 `Enum.with_index(rows, 1)` 之类的方式生成行(以实际代码为准)。
- 仓库约定:模块中文 moduledoc;`mix format` 全库强制;测试 `async: true`、引擎测试不落库(见 `renderer_test.exs` 既有风格)。

## 需要的命令

| 用途 | 命令 | 预期 |
|------|------|------|
| 环境 | `export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"` | mix 可用 |
| 引擎测试 | `cd backend/apps/synie_core && mix test test/synie_core/printing/renderer_test.exs` | 全绿 |
| 打印全套 | `cd backend/apps/synie_core && mix test test/synie_core/printing/` | 全绿(基线 48 过 1 排除) |
| 格式 | `cd backend && mix format --check-formatted` | exit 0 |

## Scope

**In scope(只准改这些)**:
- `backend/apps/synie_core/lib/synie_core/printing/renderer.ex`
- `backend/apps/synie_core/test/support/printing_fixture.ex`(加显式行号能力)
- `backend/apps/synie_core/test/synie_core/printing/renderer_test.exs`(加回归测试)

**Out of scope(勿动)**:
- `rowBreaks` 保留逻辑(`remove_old_row_breaks` 等)——那是 Plan 002 的事,本计划分页符仍只在块间插入,但 **id 改按最大行号**。
- `doc_builder.ex` / `printing.ex` / 控制器 / 前端。
- 引擎公共 API 签名(`render_pages/2`、`render_sheets/2`、`extract_placeholders/1`)。

## Git workflow

- 直接在当前分支(worktree 分支)提交;一个逻辑提交即可。
- 提交信息风格照 `git log`:`fix: 打印批量块偏移按最大行号计,修空白行模板行号冲突`。

## Steps

### Step 1: 夹具支持显式行号

给 `PrintingFixture.build` 的 `rows` 项支持 `{row_no, cells}` 二元组(与既有 `[cell, ...]` 列表混用):遇到二元组按给定行号生成 `<row r="N">`,普通列表沿用递增行号(下一个隐式行号 = 上一行号 + 1)。`dimension`/`lastRow` 相应按最大行号计算。不改既有调用方行为(全部现有测试传纯列表,必须不受影响)。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/` → 全绿(纯夹具向后兼容检查)。

### Step 2: expand_sheet 返回 max_row

`expand_sheet/3` 的返回 map 增加 `max_row`:输出行的最大行号,`out_rows |> Enum.map(&row_number!/1) |> Enum.max()`(rows 非空,已有空 sheet raise 兜底)。保留 `height` 字段可以,但后续偏移一律不再用它;若确认无其他消费方也可直接删掉 `height`(grep 确认)。

**验证**:`grep -n "block.height\|\.height" backend/apps/synie_core/lib/synie_core/printing/renderer.ex` → 记下所有消费点,Step 3 逐一替换。

### Step 3: 偏移、分页符、dimension、打印区域全部改用 max_row

- `stitch_blocks([only])`:`dim = dimension_ref(max_col, max_row)`。
- `stitch_blocks(blocks)`:`new_off = off + block.max_row`;`brk_id = new_off`(块末行号=块内最大行号+当前偏移);`dim = dimension_ref(max_col, offset)`(offset 此时已是累计最大行号)。
- `block_offsets/1`:累计 `b.max_row`。
- `do_render_sheets/2`:`dimension_ref(block.max_col, block.max_row)`。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/renderer_test.exs` → 既有用例全绿(既有夹具行连续,max_row == height,行为不变)。

### Step 4: 回归测试

在 `renderer_test.exs` 的「render_pages/2 批量」describe 下新增用例「模板含空白行(稀疏行号)时批量块不重叠」:

- 模板:`rows: [{1, ["头:${a}"]}, {3, ["尾:${b}"]}]`(第 2 行空白,XML 无该行)。
- `render_pages(tpl, [doc1, doc2])` 后解包 sheet XML(照既有测试的解包辅助),断言:
  1. 输出行号序列为 `["1", "3", "4", "6"]`(第二块偏移 3 = 第一块最大行号);
  2. 行号无重复;
  3. rowBreaks 恰一个,`brk id="3"`;
  4. dimension 尾行为 6。
- 另加 `render_sheets` 稀疏模板单例:dimension 尾行 = 3(非 2)。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/renderer_test.exs` → 全绿含新用例。

## Test plan

见 Step 4;结构照同文件既有「三块且各块高度不同」用例(fixture 构造 → render → 解包断言)。

## Done criteria(全部满足)

- [ ] `cd backend/apps/synie_core && mix test test/synie_core/printing/` 全绿,新用例存在且过
- [ ] `cd backend && mix format --check-formatted` exit 0
- [ ] `git status` 无 in-scope 之外的改动
- [ ] `grep -n "off + block.height" backend/apps/synie_core/lib/synie_core/printing/renderer.ex` 无匹配

## STOP conditions

- 「现状」摘录与实际代码对不上(基线漂移)。
- 既有 renderer 测试在 Step 1(纯夹具改动)后变红——说明夹具兼容性破坏,先停。
- 某步验证连败两次且无明确修法。
- 发现需要改 `printing.ex` 或引擎公共 API 才能完成——超界,停。

## Maintenance notes

- Plan 002(保留手工分页符)会在同一区域叠加逻辑,评审时注意两者对 `stitch_blocks` 的相互作用。
- 评审重点:`max_row` 在含循环区展开的块上是否正确(循环展开后行号已含 delta,`row_number!` 读的是展开后的行号,应天然正确——测试里若能加一个「稀疏+循环区」组合断言更好,非必须)。
