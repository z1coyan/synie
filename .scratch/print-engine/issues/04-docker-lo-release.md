# 04 — 生产镜像内置 LibreOffice + CJK + release

**What to build:** Docker/release 可运行后端；镜像含 LO 与中文字体；SOFFICE 可用。

**Blocked by:** 03 — PDF 转换器 + 配置

**Status:** resolved

- [x] umbrella release 定义
- [x] Dockerfile multi-stage + libreoffice + Noto CJK
- [x] prod 监听 0.0.0.0/PORT 文档齐全

## Answer

已在 2026-07-23 实现并合入。
