# 打印模板模块 — 实施计划索引

由 /improve 定向审计(打印模板模块整体架构)于 2026-07-23 生成,基线 commit `67a4f3f`。
按下表顺序执行;每份计划自包含,执行者读完整计划再动手,触发 STOP 条件立即停手上报。

## 执行顺序与状态

| Plan | 标题 | 优先级 | 工作量 | 依赖 | 状态 |
|------|------|--------|--------|------|------|
| 001 | 渲染器块偏移改按最大行号,修批量打印行号冲突 | P1 | S | — | DONE(d7589fe + ea3cbec 评审修订:空块 max_row 兜底) |
| 002 | 渲染器保留模板自带手工分页符 | P1 | M | 001 | DONE(060aff3) |
| 003 | DocBuilder 格式化兜底安全化(map/嵌套结构不再崩) | P1 | S | — | DONE(eb4833e) |
| 004 | 打印/导出权限与模板管理权限解耦 + field-catalog 端点加权限门 | P1 | M | — | DONE(3209ce6) |
| 005 | 模板文件挂接 attachment(下载授权 + 生命周期) | P2 | M | — | DONE(b8560d3) |
| 006 | PdfConverter 超时杀进程 + 全局并发上限 | P2 | M | — | DONE(9d6c668;计划经 f67befb 修订——本机 uutils timeout 的 `-s KILL` 静默失效,改默认 TERM + `-k` 升级) |

状态取值:TODO | IN PROGRESS | DONE | BLOCKED(附一行原因)| REJECTED(附一行理由)

## 依赖说明

- 002 依赖 001:两者都改 `renderer.ex` 的 `expand_sheet`/`stitch_blocks`/`rebuild_sheet` 一带,001 先落定块偏移语义(max_row),002 的分页符偏移在其上实现,避免冲突返工。
- 其余计划互不依赖,可任意顺序;但 004 与 005 都动 `template_and_export_test.exs`,顺序执行省合并。

## 已评审但不立项的发现(勿重复审计)

- **批量打印 N+1 查询**(`printing.ex:132-152` 逐条 `Ash.get` + `doc_builder.ex:19` 逐条 `Ash.load!` + party 逐条查):真实存在,但批量上限 100 封顶、单据打印非高频路径,当前量级可接受。量级上来或出现慢打印工单时再立项(改一次性 `filter id in ^ids` + 批量 load)。
- **render_pages 保留模板其余 sheet,LibreOffice 转 PDF 时可能多出页**:`renderer.ex` moduledoc 明示「其余 sheet 原样保留」是既定行为;是否成为问题取决于真实模板习惯,先观察,不改。
- **仅改名/备注的 update 也重新下载并校验模板文件**(`template.ex:178-184` update 恒挂 `ValidateFile`):有代价但顺带兜住字段清单漂移(代码演进后旧模板失效能被尽早点名),维持现状。
- **控制器错误码细节**(PDF 服务不可用返回 422 而非规格建议的 503;`encode_filename` 用 `filename=` + URI 编码而非 FileController 的 RFC 5987 `filename*=`):前端只消费 message/自定文件名,实害为零,不单独立项。

## 审计定案参照(执行者不必读,评审者备查)

- ADR:`docs/adr/2026-07-23-print-template.md`、`docs/adr/2026-07-23-print-universal-catalog.md`
- 规格:`.scratch/print-*/spec.md`;总览 `.scratch/print-engine/map.md`
- 已定案取舍(不是 bug,勿"修"):一条引擎两产物、LO 只做哑转换、批量=单 xlsx 多块不合并 PDF、版式主权在 Excel、模板全局不留痕、上传即校验拒未知占位符、旧拍平键不兼容。
