# Synie ERP

项目使用中文作为第一语言

## 文档约定

- 产品文档在 `docs/产品文档/`（功能说明书，按业务模块分篇，模板与维护约定见其中 README）。
- 交付新功能或变更业务规则时，必须同步更新 `docs/产品文档/` 对应篇及根目录 `CONTEXT.md`。
- 术语唯一定义在 `CONTEXT.md`；架构取舍在 `docs/adr/`；活跃规格与工单在 `.scratch/`。

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) on each issue's `Status:` line. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/` (+ product docs under `docs/产品文档/`). See `docs/agents/domain.md`.
