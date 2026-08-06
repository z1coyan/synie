# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`docs/术语表.md`** — 领域术语（ubiquitous language）的唯一定义处。
- **`docs/系统架构/adr/`** — read ADRs that touch the area you're about to work in.
- **`docs/业务模块/`** — 按业务模块分篇的功能说明书，已交付行为的权威描述。

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates 术语表 / ADRs lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
docs/
├── 术语表.md          ← 领域术语唯一定义
├── 系统架构/
│   ├── 模块结构.md     ← 后端分层与依赖规则
│   ├── 资源接入.md     ← 新增资源的前后端接入点清单
│   └── adr/           ← 架构决策记录
└── 业务模块/           ← 功能说明书（按业务模块分篇）
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/术语表.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR (event-sourced orders) — but worth reopening because…_
