# 术语表

- **物料分类**（MaterialCategory，`inv_material_category`）：物料的树形分类学，全局共享不分公司。
- **叶子分类**（`is_leaf`）：可挂物料的末级分类；叶子不能再有子分类。与科目的 `is_group` 语义相反。
- **分类编号**（`code`）：人工定义、全局唯一的分类学编码（如 01=原材料），将来作为物料编号前缀；可改，已生成的物料编号不追溯。
- **打卡记录**（AttendancePunch，`hr_attendance_punch`）：考勤机原始打卡事实（员工+时刻），导入是唯一入口，不可改；(员工, 时刻) 唯一。
- **考勤导入批次**（AttendanceImport，`hr_attendance_import`）：一次 .dat 导入的留痕单据，只存解析摘要不存暂存行；destroy 即撤销（级联删其打卡）。
- **考勤机编号**（`attendance_no`）：员工在考勤机上的编号，非空时全局唯一；.dat 行凭它匹配员工。
- **[未知] 员工**：导入勾选自动创建的占位员工（name=[未知]，attendance_no 回填），身份落实后直接改名，无合并动线。
