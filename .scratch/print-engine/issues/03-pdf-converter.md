# 03 — PDF 转换器 + 配置

**What to build:** 独立 PdfConverter：xlsx binary → PDF binary；独立 profile、超时、可配置 SOFFICE_PATH；失败中文/稳定 error。导出路径不调用本模块。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] `convert_xlsx_to_pdf/1` 公共 API
- [x] 路径不存在/超时/非零退出有稳定错误
- [x] 配置项 SOFFICE_PATH（默认 soffice）
- [x] 无真实 LO 时失败路径可单测（假可执行或缺路径）

## Answer

`SynieCore.Printing.PdfConverter` + 假 soffice 脚本单测；真实 LO 测 tag `:libreoffice` 默认排除。
