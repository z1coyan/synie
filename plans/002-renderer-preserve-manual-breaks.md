# Plan 002: 渲染器保留模板自带手工分页符

> **执行者须知**:逐步执行,每步跑完验证命令确认预期结果再进下一步。只改 In scope 文件。命中 STOP 条件立即停手上报,不要自行绕道。按 Git workflow 提交。跳过「更新 plans/README.md」——评审者维护索引。上报前对照本会话的工具输出核对每一条声明,只报有据可查的内容。
>
> **漂移检查(先跑)**:确认 Plan 001 已落地——`grep -n "max_row" backend/apps/synie_core/lib/synie_core/printing/renderer.ex` 应有多处匹配;没有则 STOP(依赖未就绪)。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-renderer-max-row-offset.md
- **Category**: bug
- **Planned at**: commit `67a4f3f`, 2026-07-23

## Why this matters

ADR(`docs/adr/2026-07-23-print-template.md`)定案「版式主权完全在 Excel……转换必须严格尊重模板 page setup」。手工分页符(rowBreaks)是页面设置的一部分:模板作者做两页版式(如第 1 页单据、第 2 页回执联)靠它分页。现状 `rebuild_sheet` 无条件 `remove_old_row_breaks` 剥掉模板自带 rowBreaks,单份打印输出**完全没有** rowBreaks,批量时也只剩块间边界分页符——已运行时复现(模板带 `<rowBreaks><brk id="1"/></rowBreaks>`,单份渲染后输出不含任何 `<rowBreaks`)。结果:两页版式被 LibreOffice 压成一页/错页,且用户无从规避(模板里怎么设都会被剥)。修复后:模板 rowBreaks 保留,随循环区展开与批量块偏移顺移,再叠加块间边界分页符。

## 现状

- `backend/apps/synie_core/lib/synie_core/printing/renderer.ex`(以 Plan 001 落地后的代码为准):
  - 模块头正则:`@brks_re ~r/<rowBreaks\b[^>]*?(?:\/>|>[\s\S]*?<\/rowBreaks>)/`。
  - `expand_sheet/3`:展开单块;内部 `loop_plan`(`[{模板行号, 条目数}]`)与 `delta_before/2` 已存在:

    ```elixir
    defp delta_before(loop_plan, row) do
      Enum.reduce(loop_plan, 0, fn {t_r, n}, acc ->
        if t_r < row, do: acc + n - 1, else: acc
      end)
    end
    ```

  - `stitch_blocks/1`:单块返回 `breaks = []`;多块只生成块间 `brk_id`。
  - `rebuild_sheet/5`:`remove_old_row_breaks()` 后仅在 breaks 非空时插入新 `<rowBreaks>`;`insert_row_breaks` 把块插到 `</worksheet>` 前(合法位置)。
  - `do_render_sheets/2`:每 sheet 传 `breaks = []`。
- rowBreaks XML 形状:`<rowBreaks count="N" manualBreakCount="N"><brk id="R" max="16383" man="1"/></rowBreaks>`,语义:第 R 行**之后**分页。
- `backend/apps/synie_core/test/support/printing_fixture.ex`:`build` 暂不支持 rowBreaks(需加 `row_breaks: [1, 5]` 选项,生成上述 XML 置于 sheet 末尾 `</worksheet>` 前;`page_setup` 选项已有,照它接线)。
- 仓库约定:中文 moduledoc/注释;`mix format`;引擎测试无 Repo、`async: true`。

## 需要的命令

| 用途 | 命令 | 预期 |
|------|------|------|
| 环境 | `export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"` | mix 可用 |
| 引擎测试 | `cd backend/apps/synie_core && mix test test/synie_core/printing/renderer_test.exs` | 全绿 |
| 打印全套 | `cd backend/apps/synie_core && mix test test/synie_core/printing/` | 全绿 |
| 格式 | `cd backend && mix format --check-formatted` | exit 0 |

## Scope

**In scope**:
- `backend/apps/synie_core/lib/synie_core/printing/renderer.ex`
- `backend/apps/synie_core/test/support/printing_fixture.ex`(加 `row_breaks:` 选项)
- `backend/apps/synie_core/test/synie_core/printing/renderer_test.exs`

**Out of scope**:
- colBreaks(列分页符,模板里罕见,现状本就原样保留于 sheet XML?——注意:`remove_old_row_breaks` 只匹配 rowBreaks,colBreaks 本来就不受影响,勿动)。
- `doc_builder.ex`/`printing.ex`/控制器/前端;引擎公共 API 签名。

## Git workflow

- 当前分支,单提交:`fix: 渲染器保留模板手工分页符,随循环区与批量块偏移顺移`。

## Steps

### Step 1: 夹具支持 row_breaks

`PrintingFixture.build` 加 `row_breaks: [行号]` 选项(单 sheet 简写与 `sheets:` 形式都支持,照 `merges`/`print_area` 的既有接线方式),在 sheet XML `</worksheet>` 前输出 rowBreaks 块。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/` → 全绿(向后兼容)。

### Step 2: expand_sheet 提取并顺移模板分页符

- 新增 `extract_row_breaks/1`:从模板 sheet XML 里 `Regex.run(@brks_re, ...)` 取块,再 `~r/<brk [^>]*id="(\d+)"/` 扫出行号列表;无块返回 `[]`。
- `expand_sheet/3` 计算 `breaks`:对每个模板分页行号 `b`,顺移后为 `b + delta_before(loop_plan, b + 1)`(`b+1` 使「循环模板行自身带分页符」也按整段展开后计——`delta_before` 用 `t_r < row`,传 `b+1` 即 `t_r <= b` 全计入)。返回 map 增加 `breaks` 字段。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/renderer_test.exs` → 既有全绿(尚无人消费 breaks 字段)。

### Step 3: 拼接与输出消费模板分页符

- `stitch_blocks([only])`:返回 `only.breaks`(不再恒 `[]`)。
- `stitch_blocks(blocks)`:每块把 `Enum.map(block.breaks, &(&1 + off))` 并入,块间边界 `brk_id` 逻辑保留;最终 breaks 去重(`Enum.uniq`)升序(`Enum.sort`)——块尾自带分页符与块间边界重合时不得输出重复 brk。
- `do_render_sheets/2`:`rebuild_sheet(..., block.breaks, ...)` 传每 sheet 自己的顺移后分页符。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/renderer_test.exs` → 既有全绿(既有用例模板无 rowBreaks,行为不变;批量用例断言的块间 brk 仍在)。

### Step 4: 回归测试(新 describe「模板手工分页符」)

1. 单份打印:模板 2 行 + `row_breaks: [1]` → 输出含 `<rowBreaks`,恰一个 `brk id="1"`。
2. 批量 2 份:模板 2 行 + `row_breaks: [1]` → breaks 集合为 `[1, 2, 3]`(块1内部 1、块边界 2、块2内部 3=1+偏移2),升序无重复。
3. 循环区顺移:模板 3 行,第 2 行是循环模板行,`row_breaks: [3]`,循环 3 条 → 输出 brk id = 5(3 + (3-1))。
4. 块尾重合去重:模板 2 行 + `row_breaks: [2]`,批量 2 份 → breaks `[2, 4]`(块边界 2 与模板自带 2 重合只出一次;第二块的 2+2=4 与末块尾部——末块后无边界符,保留 4)。
5. `render_sheets`:模板 2 行 + `row_breaks: [1]` 两份 doc → 每个输出 sheet 各含 `brk id="1"`。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/renderer_test.exs` → 全绿含 5 个新用例。

## Done criteria

- [ ] `cd backend/apps/synie_core && mix test test/synie_core/printing/` 全绿
- [ ] `cd backend && mix format --check-formatted` exit 0
- [ ] `git status` 无 in-scope 之外改动
- [ ] 单份渲染带 rowBreaks 的模板,输出仍含 rowBreaks(新用例 1 即证)

## STOP conditions

- Plan 001 未落地(漂移检查失败)。
- 「现状」与实际代码不符。
- 用例 3(循环区顺移)的期望值与实现推导冲突且无法用 `delta_before` 语义解释——说明顺移语义理解有误,停下上报而不是改期望值凑绿。
- 需要动引擎公共 API 或 `printing.ex` 才能完成。

## Maintenance notes

- Excel 对 `brk id` 超出 dimension 的容忍度较好,但评审时可人工抽查:LibreOffice 打开批量产物,分页预览应与断言一致(可选,`:libreoffice` tag 环境)。
- 后续若支持 colBreaks 场景,照本计划的 extract/顺移/合并三段式复制一份即可。
