package operations

import "github.com/z1coyan/synie/server/internal/platform/meta"

func ResourceMetas() []meta.ResourceMeta {
	return []meta.ResourceMeta{
		AttendancePunchResourceMeta(),
		AttendanceImportResourceMeta(),
		AttendanceDayResourceMeta(),
		AttendanceCorrectionResourceMeta(),
		PayrollResourceMeta(),
		PayrollPaymentResourceMeta(),
		EmployeeLoanResourceMeta(),
	}
}

func AttendancePunchResourceMeta() meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: "hrAttendancePunches", PermissionPrefix: "hr.attendance_punch",
		PermissionLabel: "打卡记录", Table: "hr_attendance_punch",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.ScalarField("attendance_no", "attendanceNo", meta.TypeString, "考勤机编号(原始留痕)", true, true),
			meta.ScalarField("punched_at", "punchedAt", meta.TypeDatetime, "打卡时间", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.RefField("employee_id", "employeeId", "员工", meta.Ref("hrEmployees", "employee", "name"), true),
			meta.RefField("import_id", "importId", "导入批次", meta.Ref("hrAttendanceImports", "import", "error"), true),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "import", Label: "导入", Scope: "both"},
		},
	}
}

func AttendanceImportResourceMeta() meta.ResourceMeta {
	destroy := "destroyHrAttendanceImport"
	return meta.ResourceMeta{
		Name: "hrAttendanceImports", PermissionPrefix: "hr.attendance_punch",
		PermissionLabel: "打卡记录",
		// 旧 GridMeta 对拍 actor 只有 punch:read 仍可拿到批次列定义，但实际
		// 批次 query/action 全部要求 punch:import；保留这项历史不对称。
		ReadPermissionsAny: []string{"hr.attendance_punch:read", "hr.attendance_punch:import"},
		Table:              "hr_attendance_import",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.EnumField("status", "status", meta.TypeEnum, "状态", []meta.EnumOption{
				{Value: AttendanceImportParsed, Label: "已解析"},
				{Value: AttendanceImportFailed, Label: "解析失败"},
				{Value: AttendanceImportImported, Label: "已导入"},
			}, true),
			meta.ScalarField("error", "error", meta.TypeString, "解析失败原因", true, true),
			meta.ScalarField("total_rows", "totalRows", meta.TypeInteger, "总行数", true, true),
			meta.ScalarField("bad_rows", "badRows", meta.TypeInteger, "坏行数", true, true),
			meta.ScalarField("dup_rows", "dupRows", meta.TypeInteger, "文件内重复行数", true, true),
			meta.ScalarField("matched_rows", "matchedRows", meta.TypeInteger, "已匹配行数", true, true),
			meta.ScalarField("unmatched_rows", "unmatchedRows", meta.TypeInteger, "未匹配行数", true, true),
			meta.ScalarField("unmatched_detail", "unmatchedDetail", meta.TypeString, "未匹配编号清单(编号×行数)", true, true),
			meta.ScalarField("imported_count", "importedCount", meta.TypeInteger, "导入打卡数", true, true),
			meta.ScalarField("skipped_existing_rows", "skippedExistingRows", meta.TypeInteger, "跳过已存在行数", true, true),
			meta.ScalarField("skipped_unmatched_rows", "skippedUnmatchedRows", meta.TypeInteger, "跳过未匹配行数", true, true),
			meta.ScalarField("auto_created_count", "autoCreatedCount", meta.TypeInteger, "自动创建员工数", true, true),
			meta.ScalarField("imported_at", "importedAt", meta.TypeDatetime, "导入时间", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("file_id", "fileId", "导入文件", meta.Ref("sysFiles", "file", "filename"), true),
			meta.RefField("created_by_id", "createdById", "发起人", meta.Ref("sysUsers", "createdBy", "name"), true),
			meta.RefField("imported_by_id", "importedById", "导入人", meta.Ref("sysUsers", "importedBy", "name"), true),
			metaCalculated(meta.ScalarField("punch_count", "punchCount", meta.TypeInteger, "打卡数", false, false)),
		},
		Actions: []meta.ActionMeta{{Key: "import", Label: "导入", Scope: "both"}},
		Audit:   meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func AttendanceDayResourceMeta() meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: "hrAttendanceDays", PermissionPrefix: "hr.attendance_day",
		PermissionLabel: "日考勤", Table: "hr_attendance_day",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.ScalarField("date", "date", meta.TypeDate, "日期", true, true),
			meta.ScalarField("morning_in", "morningIn", meta.TypeString, "上午上班", false, true),
			meta.ScalarField("morning_out", "morningOut", meta.TypeString, "上午下班", false, true),
			meta.ScalarField("afternoon_in", "afternoonIn", meta.TypeString, "下午上班", false, true),
			meta.ScalarField("afternoon_out", "afternoonOut", meta.TypeString, "下午下班", false, true),
			meta.ScalarField("normal_hours", "normalHours", meta.TypeDecimal, "正常工时", true, true),
			meta.ScalarField("overtime_hours", "overtimeHours", meta.TypeDecimal, "加班工时", true, true),
			meta.ScalarField("bonus_workday", "bonusWorkday", meta.TypeDecimal, "奖励工日", true, true),
			meta.EnumField("status", "status", meta.TypeEnum, "状态", []meta.EnumOption{
				{Value: AttendanceDayOK, Label: "正常"},
				{Value: AttendanceDayMissing, Label: "缺卡"},
			}, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "重算时间", true, true),
			meta.RefField("employee_id", "employeeId", "员工", meta.Ref("hrEmployees", "employee", "name"), true),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			// GridMeta 旧表面把 recalc 作为 capability 而非 extendedAction。
			{Key: "import", PermissionAction: "recalc", Label: "重算", Scope: "both"},
		},
	}
}

func AttendanceCorrectionResourceMeta() meta.ResourceMeta {
	destroy := "destroyHrAttendanceCorrection"
	return meta.ResourceMeta{
		Name: "hrAttendanceCorrections", PermissionPrefix: "hr.attendance_correction",
		PermissionLabel: "补卡单", Table: "hr_attendance_correction",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.ScalarField("date", "date", meta.TypeDate, "日期", true, true),
			meta.ScalarField("times", "times", meta.TypeString, "补卡时刻", false, false),
			meta.ScalarField("note", "note", meta.TypeString, "备注", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("employee_id", "employeeId", "员工", meta.Ref("hrEmployees", "employee", "name"), true),
			meta.RefField("created_by_id", "createdById", "录入人", meta.Ref("sysUsers", "createdBy", "name"), true),
		},
		Actions: meta.CRUDActions(), Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func PayrollResourceMeta() meta.ResourceMeta {
	destroy := "destroyHrPayroll"
	return meta.ResourceMeta{
		Name: "hrPayrolls", PermissionPrefix: "hr.payroll",
		PermissionLabel: "工资单", Table: "hr_payroll",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.ScalarField("month", "month", meta.TypeString, "月份", true, true),
			meta.ScalarField("workdays", "workdays", meta.TypeDecimal, "月工日", true, true),
			meta.ScalarField("attendance_days", "attendanceDays", meta.TypeInteger, "出勤天数", true, true),
			meta.ScalarField("missing_days", "missingDays", meta.TypeInteger, "缺卡天数", true, true),
			meta.ScalarField("overtime_hours", "overtimeHours", meta.TypeDecimal, "加班工时", true, true),
			meta.ScalarField("daily_wage", "dailyWage", meta.TypeDecimal, "日薪", true, true),
			meta.ScalarField("base_amount", "baseAmount", meta.TypeDecimal, "基本工资", true, true),
			meta.ScalarField("allowance", "allowance", meta.TypeDecimal, "补贴", true, true),
			meta.ScalarField("bonus", "bonus", meta.TypeDecimal, "奖金", true, true),
			meta.ScalarField("fine", "fine", meta.TypeDecimal, "罚款", true, true),
			meta.ScalarField("loan_deduction", "loanDeduction", meta.TypeDecimal, "借款抵扣", true, true),
			meta.ScalarField("payable", "payable", meta.TypeDecimal, "应发工资", true, true),
			meta.EnumField("status", "status", meta.TypeEnum, "状态", []meta.EnumOption{
				{Value: PayrollPending, Label: "待发放"},
				{Value: PayrollPaid, Label: "已发放"},
			}, true),
			meta.ScalarField("remarks", "remarks", meta.TypeString, "备注", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("employee_id", "employeeId", "员工", meta.Ref("hrEmployees", "employee", "name"), true),
			metaCalculated(meta.ScalarField("paid_total", "paidTotal", meta.TypeDecimal, "实发合计", false, false)),
		},
		Actions:    meta.CRUDActions(),
		PrintHead:  true,
		PrintLoops: []meta.PrintLoopMeta{{Name: "payments", Resource: "hrPayrollPayments"}},
		Audit:      meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func PayrollPaymentResourceMeta() meta.ResourceMeta {
	destroy := "destroyHrPayrollPayment"
	return meta.ResourceMeta{
		Name: "hrPayrollPayments", PermissionPrefix: "hr.payroll_payment",
		PermissionLabel: "工资发放", Table: "hr_payroll_payment",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.ScalarField("month", "month", meta.TypeString, "月份", true, true),
			meta.ScalarField("paid_on", "paidOn", meta.TypeDate, "发放日期", true, true),
			meta.ScalarField("amount", "amount", meta.TypeDecimal, "发放金额", true, true),
			meta.EnumField("kind", "kind", meta.TypeEnum, "类型", []meta.EnumOption{
				{Value: PaymentNormal, Label: "发放"},
				{Value: PaymentSupplement, Label: "补发"},
			}, true),
			meta.ScalarField("remarks", "remarks", meta.TypeString, "备注", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("payroll_id", "payrollId", "工资单", meta.Ref("hrPayrolls", "payroll", "month"), true),
			meta.RefField("employee_id", "employeeId", "员工", meta.Ref("hrEmployees", "employee", "name"), true),
			meta.RefField("created_by_id", "createdById", "经办人", meta.Ref("sysUsers", "createdBy", "name"), true),
		},
		Actions: []meta.ActionMeta{
			{Key: "read", Label: "查看", Scope: "both"},
			{Key: "create", Label: "新增", Scope: "both"},
			{Key: "delete", Label: "删除", Scope: "row", IsDanger: true},
		},
		Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

func EmployeeLoanResourceMeta() meta.ResourceMeta {
	destroy := "destroyHrEmployeeLoan"
	return meta.ResourceMeta{
		Name: "hrEmployeeLoans", PermissionPrefix: "hr.employee_loan",
		PermissionLabel: "员工借款", Table: "hr_employee_loan",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.EnumField("kind", "kind", meta.TypeEnum, "类型", []meta.EnumOption{
				{Value: LoanBorrow, Label: "借款"},
				{Value: LoanRepay, Label: "归还"},
			}, true),
			meta.ScalarField("occurred_on", "occurredOn", meta.TypeDate, "发生日期", true, true),
			meta.ScalarField("amount", "amount", meta.TypeDecimal, "金额", true, true),
			meta.ScalarField("remarks", "remarks", meta.TypeString, "备注", true, true),
			meta.ScalarField("inserted_at", "insertedAt", meta.TypeDatetime, "创建时间", true, true),
			meta.ScalarField("updated_at", "updatedAt", meta.TypeDatetime, "更新时间", true, true),
			meta.RefField("employee_id", "employeeId", "员工", meta.Ref("hrEmployees", "employee", "name"), true),
			meta.RefField("payroll_id", "payrollId", "关联工资单", meta.Ref("hrPayrolls", "payroll", "month"), true),
			meta.RefField("created_by_id", "createdById", "经办人", meta.Ref("sysUsers", "createdBy", "name"), true),
		},
		Actions: meta.CRUDActions(), Audit: meta.AuditMeta{Enabled: true}, DestroyMutation: &destroy,
	}
}

// metaCalculated 标记计算/投影字段：打印字段目录做一层关联展开时跳过。
func metaCalculated(field meta.FieldMeta) meta.FieldMeta {
	field.Calculated = true
	return field
}
