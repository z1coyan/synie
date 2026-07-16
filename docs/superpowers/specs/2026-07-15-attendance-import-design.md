# 考勤打卡导入设计

2026-07-15。经拷问访谈定案（决策理由见 `docs/adr/2026-07-15-attendance-import.md`）。

## 后端

- 两个资源，hr 域：`SynieCore.Hr.AttendancePunch`（表 `hr_attendance_punch`，打卡记录）+ `SynieCore.Hr.AttendanceImport`（表 `hr_attendance_import`，导入批次）。
- 打卡记录字段：`employee_id`（belongs_to，必填）/ `attendance_no`（原始考勤机编号，留痕）/ `punched_at`（utc_datetime，.dat 本地时间按 Asia/Shanghai 解析转 UTC）/ `import_id`（belongs_to 批次）。
- `(employee_id, punched_at)` 唯一 identity；无对外 create/update——导入是唯一入口，不可改，无补卡。
- 导入批次：`file_id`（FK `sys_file`，.dat 原文件留痕，校验对 actor 可见照银行 ReadableFile）/ 状态（parsed 已解析 / failed 解析失败 / imported 已导入）/ 解析摘要（总行数、可导行数、未匹配编号清单及各自行数、重复数、坏行数）/ 导入结果（导入数、跳过重复数、自动建员工数、`imported_at`）。
- 两段式但暂存行不落库：建批次即解析 .dat 存摘要（预览）；执行导入带 `auto_create_employees` 参数重新解析文件、bulk stream 直写打卡表。
- .dat 解析：tab/空白分隔，只取前两列（考勤机编号 + 时间 `YYYY-MM-DD HH:MM:SS`），其余列（机号/状态键/验证方式）忽略不存；坏行计数跳过进摘要。解析器写死，无模板配置。
- 员工匹配按 `Employee.attendance_no`，该字段加全局唯一 identity（非空时，部分唯一索引；迁移前需清已有重复）。
- 自动建员工：name=`[未知]`、attendance_no 回填编号、code 走 AutoNumber（hr.employee 规则）；须 actor 兼有 `hr.employee:create`，否则后端拒绝、前端勾选框禁用。
- 幂等去重：撞 `(employee_id, punched_at)` 唯一键静默跳过并计数（同文件重导天然幂等）；未勾自动建时未匹配行跳过计数。
- 撤销 = destroy 批次，级联删其全部打卡（审计日志留操作痕）；无 canceled 状态。
- 全局不挂公司（照 hr.employee）。
- 权限：`hr.attendance_punch` 挂 read / import 两码；批次资源与执行、撤销动作全部复用 import 码（衍生动作不设新码）。两资源均接审计。
- 权限中文标签同步 `permission-labels.ts` 与 `logs.tsx`。

## 前端

- 人事菜单加「考勤」单页 2 tabs（照承兑先例）：「打卡记录」只读 DataGrid（员工 fk 列、时间筛选）+「导入记录」批次列表与上传动线。
- 动线：上传 .dat 走统一文件接口（`POST /api/files`）→ 建批次 → 看摘要（含未匹配编号清单）→ 勾选「自动创建不存在的员工」→ 执行导入 → 看结果（导入/跳过重复/坏行/自动建员工数）。
- 未匹配编号清单让用户可先去员工页补考勤号，避免自动建出与手工员工重复的 `[未知]`。

## 不做（YAGNI）

班次/排班、日考勤计算、月统计、补卡/异常单、考勤设备台账、多时区、解析模板配置、canceled 留痕状态、`[未知]` 员工合并动线（身份落实=直接改名）。
