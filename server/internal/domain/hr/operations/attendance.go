package operations

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

const (
	punchColumns  = `id,attendance_no,punched_at,inserted_at,employee_id,import_id`
	importColumns = `i.id,i.status,i.error,i.total_rows,i.bad_rows,i.dup_rows,
		i.matched_rows,i.unmatched_rows,i.unmatched_detail,i.imported_count,
		i.skipped_existing_rows,i.skipped_unmatched_rows,i.auto_created_count,
		i.imported_at,i.inserted_at,i.updated_at,i.file_id,i.created_by_id,
		i.imported_by_id,(SELECT count(*) FROM hr_attendance_punch p WHERE p.import_id=i.id)`
	dayColumns = `id,date,to_char(morning_in,'HH24:MI:SS'),to_char(morning_out,'HH24:MI:SS'),
		to_char(afternoon_in,'HH24:MI:SS'),to_char(afternoon_out,'HH24:MI:SS'),
		normal_hours,overtime_hours,bonus_workday,status,inserted_at,updated_at,employee_id`
	correctionColumns = `id,date,
		ARRAY(SELECT to_char(value,'HH24:MI:SS') FROM unnest(times) value ORDER BY value),
		note,inserted_at,updated_at,employee_id,created_by_id`
)

func (s *Service) QueryAttendancePunches(ctx context.Context, actor *authz.Actor, query ListQuery) (AttendancePunchList, error) {
	if err := requirePermission(actor, "hr.attendance_punch:read"); err != nil {
		return AttendancePunchList{}, err
	}
	if err := validateList(&query); err != nil {
		return AttendancePunchList{}, err
	}
	built, err := filterbuild.Build(AttendancePunchResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return AttendancePunchList{}, err
	}
	var result AttendancePunchList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM hr_attendance_punch`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计打卡记录失败", err)
	}
	sql, args := appendPagination(`SELECT `+punchColumns+` FROM hr_attendance_punch`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询打卡记录失败", err)
	}
	defer rows.Close()
	result.Results = make([]AttendancePunch, 0, query.Limit)
	for rows.Next() {
		value, scanErr := scanPunch(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取打卡记录失败", scanErr)
		}
		result.Results = append(result.Results, value)
	}
	return result, rows.Err()
}

func (s *Service) GetAttendancePunch(ctx context.Context, actor *authz.Actor, id uuid.UUID) (AttendancePunch, error) {
	if err := requirePermission(actor, "hr.attendance_punch:read"); err != nil {
		return AttendancePunch{}, err
	}
	value, err := scanPunch(s.pool.QueryRow(ctx, `SELECT `+punchColumns+` FROM hr_attendance_punch WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return AttendancePunch{}, apierror.New(apierror.CodeNotFound, "打卡记录不存在")
	}
	if err != nil {
		return AttendancePunch{}, apierror.Wrap(apierror.CodeInternal, "读取打卡记录失败", err)
	}
	return value, nil
}

func (s *Service) QueryAttendanceImports(ctx context.Context, actor *authz.Actor, query ListQuery) (AttendanceImportList, error) {
	if err := requirePermission(actor, "hr.attendance_punch:import"); err != nil {
		return AttendanceImportList{}, err
	}
	if err := validateList(&query); err != nil {
		return AttendanceImportList{}, err
	}
	built, err := filterbuild.Build(AttendanceImportResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return AttendanceImportList{}, err
	}
	var result AttendanceImportList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM hr_attendance_import`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计考勤导入失败", err)
	}
	sql, args := appendPagination(`SELECT `+importColumns+` FROM hr_attendance_import i`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询考勤导入失败", err)
	}
	defer rows.Close()
	result.Results = make([]AttendanceImport, 0, query.Limit)
	for rows.Next() {
		value, scanErr := scanImport(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取考勤导入失败", scanErr)
		}
		result.Results = append(result.Results, value)
	}
	return result, rows.Err()
}

func (s *Service) GetAttendanceImport(ctx context.Context, actor *authz.Actor, id uuid.UUID) (AttendanceImport, error) {
	if err := requirePermission(actor, "hr.attendance_punch:import"); err != nil {
		return AttendanceImport{}, err
	}
	value, err := scanImport(s.pool.QueryRow(ctx, `SELECT `+importColumns+` FROM hr_attendance_import i WHERE i.id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return AttendanceImport{}, apierror.New(apierror.CodeNotFound, "考勤导入批次不存在")
	}
	if err != nil {
		return AttendanceImport{}, apierror.Wrap(apierror.CodeInternal, "读取考勤导入失败", err)
	}
	return value, nil
}

func (s *Service) CreateAttendanceImport(
	ctx context.Context,
	actor *authz.Actor,
	input AttendanceImportCreateInput,
) (AttendanceImport, error) {
	if err := requirePermission(actor, "hr.attendance_punch:import"); err != nil {
		return AttendanceImport{}, err
	}
	if err := requirePermission(actor, "sys.file:read"); err != nil {
		return AttendanceImport{}, err
	}
	if input.FileID == uuid.Nil {
		return AttendanceImport{}, apierror.Validation("考勤导入参数不合法", map[string][]string{"fileId": {"不能为空"}})
	}
	if s.files == nil {
		return AttendanceImport{}, apierror.New(apierror.CodeConflict, "文件读取模块未配置")
	}
	file, content, err := s.files.ReadStoredFile(ctx, input.FileID)
	if err != nil {
		return AttendanceImport{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AttendanceImport{}, apierror.Wrap(apierror.CodeInternal, "创建考勤导入失败", err)
	}
	defer tx.Rollback(ctx)
	if file.SHA256 != "" {
		var duplicate bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM hr_attendance_import i
			JOIN sys_file f ON f.id=i.file_id
			WHERE f.sha256=$1 AND i.status<>'failed')`, file.SHA256).Scan(&duplicate)
		if err != nil {
			return AttendanceImport{}, apierror.Wrap(apierror.CodeInternal, "校验重复考勤文件失败", err)
		}
		if duplicate {
			return AttendanceImport{}, apierror.New(apierror.CodeConflict, "已存在相同文件的导入批次,如需重新导入请先删除原批次")
		}
	}
	parsed, parseErr := parseAttendanceFile(content)
	status := "parsed"
	var errorText, detail *string
	var total, bad, dup, matched, unmatched *int64
	if parseErr != nil {
		status = "failed"
		message := parseErr.Error()
		if len(message) > 500 {
			message = message[:500]
		}
		errorText = &message
	} else {
		totalValue, badValue, dupValue := parsed.TotalRows, parsed.BadRows, parsed.DupRows
		total, bad, dup = &totalValue, &badValue, &dupValue
		employeeMap, mapErr := loadEmployeeMap(ctx, tx, parsed.Rows)
		if mapErr != nil {
			return AttendanceImport{}, mapErr
		}
		matchedValue := int64(0)
		for _, row := range parsed.Rows {
			if _, ok := employeeMap[row.AttendanceNo]; ok {
				matchedValue++
			}
		}
		unmatchedValue := int64(len(parsed.Rows)) - matchedValue
		matched, unmatched = &matchedValue, &unmatchedValue
		detail = unmatchedDetail(parsed.Rows, employeeMap)
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO hr_attendance_import(
		status,error,total_rows,bad_rows,dup_rows,matched_rows,unmatched_rows,
		unmatched_detail,file_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
		status, errorText, total, bad, dup, matched, unmatched, detail, input.FileID, actorID(actor)).Scan(&id)
	if err != nil {
		return AttendanceImport{}, databaseWriteError("创建考勤导入失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "hr_attendance_import", id, errorLabel(errorText),
		"create", "create", createdChanges(map[string]any{
			"status": status, "error": errorText, "total_rows": total, "bad_rows": bad,
			"dup_rows": dup, "matched_rows": matched, "unmatched_rows": unmatched,
			"unmatched_detail": detail, "file_id": input.FileID, "created_by_id": actorID(actor),
		})); err != nil {
		return AttendanceImport{}, err
	}
	value, err := scanImport(tx.QueryRow(ctx, `SELECT `+importColumns+` FROM hr_attendance_import i WHERE i.id=$1`, id))
	if err != nil {
		return AttendanceImport{}, apierror.Wrap(apierror.CodeInternal, "读取考勤导入失败", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return AttendanceImport{}, databaseWriteError("创建考勤导入失败", err)
	}
	return value, nil
}

func (s *Service) ImportAttendance(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input AttendanceImportExecuteInput,
) (AttendanceImport, error) {
	if err := requirePermission(actor, "hr.attendance_punch:import"); err != nil {
		return AttendanceImport{}, err
	}
	if s.files == nil {
		return AttendanceImport{}, apierror.New(apierror.CodeConflict, "文件读取模块未配置")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AttendanceImport{}, apierror.Wrap(apierror.CodeInternal, "执行考勤导入失败", err)
	}
	defer tx.Rollback(ctx)
	var fileID uuid.UUID
	var status string
	err = tx.QueryRow(ctx, `SELECT file_id,status FROM hr_attendance_import WHERE id=$1 FOR UPDATE`, id).Scan(&fileID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return AttendanceImport{}, apierror.New(apierror.CodeNotFound, "考勤导入批次不存在")
	}
	if err != nil {
		return AttendanceImport{}, apierror.Wrap(apierror.CodeInternal, "锁定考勤导入失败", err)
	}
	if status != "parsed" {
		return AttendanceImport{}, apierror.New(apierror.CodeConflict, "仅「已解析」状态的批次可执行导入")
	}
	_, content, err := s.files.ReadStoredFile(ctx, fileID)
	if err != nil {
		return AttendanceImport{}, err
	}
	parsed, err := parseAttendanceFile(content)
	if err != nil {
		return AttendanceImport{}, apierror.Validation("考勤文件无法重新解析", map[string][]string{"fileId": {err.Error()}})
	}
	employees, err := loadEmployeeMap(ctx, tx, parsed.Rows)
	if err != nil {
		return AttendanceImport{}, err
	}
	missing := missingAttendanceNos(parsed.Rows, employees)
	autoCreated := int64(0)
	if input.AutoCreateEmployees && len(missing) != 0 {
		if err = requirePermission(actor, "hr.employee:create"); err != nil {
			return AttendanceImport{}, apierror.New(apierror.CodeForbidden, "无权自动创建员工(需要「员工-新增」权限),可去掉勾选仅导入已匹配的行")
		}
		if s.numberer == nil {
			return AttendanceImport{}, apierror.New(apierror.CodeConflict, "未配置启用的员工编号规则")
		}
		for _, no := range missing {
			code, nextErr := s.numberer.NextInTx(ctx, tx, numbering.NextInput{Resource: "hr.employee"})
			if nextErr != nil {
				return AttendanceImport{}, nextErr
			}
			var employeeID uuid.UUID
			nextErr = tx.QueryRow(ctx, `INSERT INTO hr_employees(code,name,attendance_no)
				VALUES($1,'[未知]',$2) RETURNING id`, code, no).Scan(&employeeID)
			if nextErr != nil {
				return AttendanceImport{}, databaseWriteError("自动创建员工失败", nextErr)
			}
			if nextErr = writeAudit(ctx, tx, actor, "hr_employee", employeeID, "[未知]",
				"create", "create", createdChanges(map[string]any{
					"code": code, "name": "[未知]", "attendance_no": no,
				})); nextErr != nil {
				return AttendanceImport{}, nextErr
			}
			employees[no] = employeeID
			autoCreated++
		}
	}
	imported, skippedExisting, skippedUnmatched := int64(0), int64(0), int64(0)
	pairs := make(map[attendancePair]struct{})
	for _, row := range parsed.Rows {
		employeeID, ok := employees[row.AttendanceNo]
		if !ok {
			skippedUnmatched++
			continue
		}
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM hr_attendance_punch WHERE employee_id=$1 AND punched_at=$2)`,
			employeeID, row.PunchedAt).Scan(&exists); err != nil {
			return AttendanceImport{}, apierror.Wrap(apierror.CodeInternal, "校验既有打卡失败", err)
		}
		if exists {
			skippedExisting++
			continue
		}
		if _, err = tx.Exec(ctx, `INSERT INTO hr_attendance_punch(
			attendance_no,punched_at,employee_id,import_id) VALUES($1,$2,$3,$4)`,
			row.AttendanceNo, row.PunchedAt, employeeID, id); err != nil {
			return AttendanceImport{}, databaseWriteError("写入打卡失败", err)
		}
		imported++
		pairs[attendancePair{EmployeeID: employeeID, Date: localDate(row.PunchedAt)}] = struct{}{}
	}
	now := time.Now().UTC()
	_, err = tx.Exec(ctx, `UPDATE hr_attendance_import SET status='imported',
		imported_count=$2,skipped_existing_rows=$3,skipped_unmatched_rows=$4,
		auto_created_count=$5,imported_at=$6,imported_by_id=$7,updated_at=$6 WHERE id=$1`,
		id, imported, skippedExisting, skippedUnmatched, autoCreated, now, actorID(actor))
	if err != nil {
		return AttendanceImport{}, databaseWriteError("更新考勤导入失败", err)
	}
	if err = recomputePairs(ctx, tx, pairs); err != nil {
		return AttendanceImport{}, err
	}
	if err = writeAudit(ctx, tx, actor, "hr_attendance_import", id, "",
		"update", "import", map[string]audit.Change{
			"status":                 {"from": "parsed", "to": "imported"},
			"imported_count":         {"to": imported},
			"skipped_existing_rows":  {"to": skippedExisting},
			"skipped_unmatched_rows": {"to": skippedUnmatched},
			"auto_created_count":     {"to": autoCreated},
			"imported_at":            {"to": now},
			"imported_by_id":         {"to": actorID(actor)},
		}); err != nil {
		return AttendanceImport{}, err
	}
	value, err := scanImport(tx.QueryRow(ctx, `SELECT `+importColumns+` FROM hr_attendance_import i WHERE i.id=$1`, id))
	if err != nil {
		return AttendanceImport{}, apierror.Wrap(apierror.CodeInternal, "读取考勤导入失败", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return AttendanceImport{}, databaseWriteError("执行考勤导入失败", err)
	}
	return value, nil
}

func (s *Service) DeleteAttendanceImport(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requirePermission(actor, "hr.attendance_punch:import"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除考勤导入失败", err)
	}
	defer tx.Rollback(ctx)
	value, err := scanImport(tx.QueryRow(ctx, `SELECT `+importColumns+` FROM hr_attendance_import i WHERE i.id=$1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "考勤导入批次不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取考勤导入失败", err)
	}
	rows, err := tx.Query(ctx, `SELECT employee_id,punched_at FROM hr_attendance_punch WHERE import_id=$1`, id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取批次打卡失败", err)
	}
	pairs := make(map[attendancePair]struct{})
	for rows.Next() {
		var employeeID uuid.UUID
		var punchedAt time.Time
		if err = rows.Scan(&employeeID, &punchedAt); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取批次打卡失败", err)
		}
		pairs[attendancePair{EmployeeID: employeeID, Date: localDate(punchedAt)}] = struct{}{}
	}
	rows.Close()
	if _, err = tx.Exec(ctx, `DELETE FROM hr_attendance_import WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除考勤导入失败", err)
	}
	if err = recomputePairs(ctx, tx, pairs); err != nil {
		return err
	}
	if err = writeAudit(ctx, tx, actor, "hr_attendance_import", id, errorLabel(value.Error),
		"destroy", "destroy", destroyedChanges(importSnapshot(value))); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除考勤导入失败", err)
	}
	return nil
}

func (s *Service) QueryAttendanceDays(ctx context.Context, actor *authz.Actor, query ListQuery) (AttendanceDayList, error) {
	if err := requirePermission(actor, "hr.attendance_day:read"); err != nil {
		return AttendanceDayList{}, err
	}
	if err := validateList(&query); err != nil {
		return AttendanceDayList{}, err
	}
	built, err := filterbuild.Build(AttendanceDayResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return AttendanceDayList{}, err
	}
	var result AttendanceDayList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM hr_attendance_day`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计日考勤失败", err)
	}
	sql, args := appendPagination(`SELECT `+dayColumns+` FROM hr_attendance_day`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询日考勤失败", err)
	}
	defer rows.Close()
	result.Results = make([]AttendanceDay, 0, query.Limit)
	for rows.Next() {
		value, scanErr := scanDay(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取日考勤失败", scanErr)
		}
		result.Results = append(result.Results, value)
	}
	return result, rows.Err()
}

func (s *Service) GetAttendanceDay(ctx context.Context, actor *authz.Actor, id uuid.UUID) (AttendanceDay, error) {
	if err := requirePermission(actor, "hr.attendance_day:read"); err != nil {
		return AttendanceDay{}, err
	}
	value, err := scanDay(s.pool.QueryRow(ctx, `SELECT `+dayColumns+` FROM hr_attendance_day WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return AttendanceDay{}, apierror.New(apierror.CodeNotFound, "日考勤不存在")
	}
	if err != nil {
		return AttendanceDay{}, apierror.Wrap(apierror.CodeInternal, "读取日考勤失败", err)
	}
	return value, nil
}

func (s *Service) RecalcAttendanceDays(
	ctx context.Context,
	actor *authz.Actor,
	dateFrom, dateTo string,
) (int64, error) {
	if err := requirePermission(actor, "hr.attendance_day:recalc"); err != nil {
		return 0, err
	}
	from, err := parseDate(dateFrom, "dateFrom")
	if err != nil {
		return 0, err
	}
	to, err := parseDate(dateTo, "dateTo")
	if err != nil {
		return 0, err
	}
	if to.Before(from) {
		return 0, apierror.Validation("重算区间不合法", map[string][]string{"dateTo": {"结束日期不能早于开始日期"}})
	}
	if int(to.Sub(from).Hours()/24) > 366 {
		return 0, apierror.Validation("重算区间不合法", map[string][]string{"dateTo": {"重算区间不能超过一年"}})
	}
	rows, err := s.pool.Query(ctx, `
		SELECT employee_id,local_date FROM (
			SELECT employee_id,(punched_at + interval '8 hours')::date local_date
			  FROM hr_attendance_punch
			 WHERE (punched_at + interval '8 hours')::date BETWEEN $1 AND $2
			UNION
			SELECT employee_id,date FROM hr_attendance_correction WHERE date BETWEEN $1 AND $2
			UNION
			SELECT employee_id,date FROM hr_attendance_day WHERE date BETWEEN $1 AND $2
		) pairs ORDER BY employee_id,local_date`, from, to)
	if err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "读取日考勤重算范围失败", err)
	}
	var pairs []attendancePair
	for rows.Next() {
		var pair attendancePair
		var date time.Time
		if err = rows.Scan(&pair.EmployeeID, &date); err != nil {
			rows.Close()
			return 0, apierror.Wrap(apierror.CodeInternal, "读取日考勤重算范围失败", err)
		}
		pair.Date = date.Format("2006-01-02")
		pairs = append(pairs, pair)
	}
	rows.Close()
	// 旧 generic action 明确 transaction?=false；每个 pair 独立提交，不伪造区间原子性。
	for _, pair := range pairs {
		tx, beginErr := s.pool.Begin(ctx)
		if beginErr != nil {
			return 0, apierror.Wrap(apierror.CodeInternal, "开始日考勤重算失败", beginErr)
		}
		if beginErr = recomputePair(ctx, tx, pair); beginErr != nil {
			_ = tx.Rollback(ctx)
			return 0, beginErr
		}
		if beginErr = tx.Commit(ctx); beginErr != nil {
			return 0, databaseWriteError("提交日考勤重算失败", beginErr)
		}
	}
	return int64(len(pairs)), nil
}

func (s *Service) AttendanceMonthSummary(
	ctx context.Context,
	actor *authz.Actor,
	month string,
) ([]AttendanceMonthSummary, error) {
	if err := requirePermission(actor, "hr.attendance_day:read"); err != nil {
		return nil, err
	}
	first, err := parseMonth(month)
	if err != nil {
		return nil, err
	}
	next := first.AddDate(0, 1, 0)
	rows, err := s.pool.Query(ctx, `
		SELECT d.employee_id,e.code,e.name,count(*)::bigint,
		       count(*) FILTER (WHERE d.status='missing')::bigint,
		       COALESCE(sum(d.normal_hours),0),COALESCE(sum(d.overtime_hours),0),
		       COALESCE(sum(d.bonus_workday),0),
		       COALESCE(sum(d.normal_hours),0)/8+COALESCE(sum(d.bonus_workday),0)
		  FROM hr_attendance_day d
		  JOIN hr_employees e ON e.id=d.employee_id
		 WHERE d.date >= $1 AND d.date < $2
		 GROUP BY d.employee_id,e.code,e.name
		 ORDER BY e.code,e.name`, first, next)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "查询考勤月汇总失败", err)
	}
	defer rows.Close()
	result := make([]AttendanceMonthSummary, 0)
	for rows.Next() {
		var item AttendanceMonthSummary
		var normal, overtime, bonus, workdays pgtype.Numeric
		if err = rows.Scan(&item.EmployeeID, &item.EmployeeCode, &item.EmployeeName,
			&item.Days, &item.MissingDays, &normal, &overtime, &bonus, &workdays); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取考勤月汇总失败", err)
		}
		item.NormalHours, item.OvertimeHours = numericString(normal), numericString(overtime)
		item.BonusWorkdays, item.Workdays = numericString(bonus), numericString(workdays)
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Service) QueryAttendanceCorrections(
	ctx context.Context,
	actor *authz.Actor,
	query ListQuery,
) (AttendanceCorrectionList, error) {
	if err := requirePermission(actor, "hr.attendance_correction:read"); err != nil {
		return AttendanceCorrectionList{}, err
	}
	if err := validateList(&query); err != nil {
		return AttendanceCorrectionList{}, err
	}
	built, err := filterbuild.Build(AttendanceCorrectionResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return AttendanceCorrectionList{}, err
	}
	var result AttendanceCorrectionList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM hr_attendance_correction`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计补卡单失败", err)
	}
	sql, args := appendPagination(`SELECT `+correctionColumns+` FROM hr_attendance_correction`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询补卡单失败", err)
	}
	defer rows.Close()
	result.Results = make([]AttendanceCorrection, 0, query.Limit)
	for rows.Next() {
		value, scanErr := scanCorrection(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取补卡单失败", scanErr)
		}
		result.Results = append(result.Results, value)
	}
	return result, rows.Err()
}

func (s *Service) GetAttendanceCorrection(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
) (AttendanceCorrection, error) {
	if err := requirePermission(actor, "hr.attendance_correction:read"); err != nil {
		return AttendanceCorrection{}, err
	}
	value, err := scanCorrection(s.pool.QueryRow(ctx, `SELECT `+correctionColumns+` FROM hr_attendance_correction WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return AttendanceCorrection{}, apierror.New(apierror.CodeNotFound, "补卡单不存在")
	}
	if err != nil {
		return AttendanceCorrection{}, apierror.Wrap(apierror.CodeInternal, "读取补卡单失败", err)
	}
	return value, nil
}

func (s *Service) CreateAttendanceCorrection(
	ctx context.Context,
	actor *authz.Actor,
	input AttendanceCorrectionInput,
) (AttendanceCorrection, error) {
	if err := requirePermission(actor, "hr.attendance_correction:create"); err != nil {
		return AttendanceCorrection{}, err
	}
	if err := validateCorrectionNote(input.Note); err != nil {
		return AttendanceCorrection{}, err
	}
	date, times, err := validateCorrectionInput(input.Date, input.Times)
	if err != nil {
		return AttendanceCorrection{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AttendanceCorrection{}, apierror.Wrap(apierror.CodeInternal, "创建补卡单失败", err)
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO hr_attendance_correction(
		date,times,note,employee_id,created_by_id)
		VALUES($1,ARRAY(SELECT value::time FROM unnest($2::text[]) value),$3,$4,$5)
		RETURNING id`,
		date, times, input.Note, input.EmployeeID, actorID(actor)).Scan(&id)
	if err != nil {
		return AttendanceCorrection{}, databaseWriteError("创建补卡单失败", err)
	}
	pair := attendancePair{EmployeeID: input.EmployeeID, Date: input.Date}
	if err = recomputePair(ctx, tx, pair); err != nil {
		return AttendanceCorrection{}, err
	}
	value, err := scanCorrection(tx.QueryRow(ctx, `SELECT `+correctionColumns+` FROM hr_attendance_correction WHERE id=$1`, id))
	if err != nil {
		return AttendanceCorrection{}, apierror.Wrap(apierror.CodeInternal, "读取补卡单失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "hr_attendance_correction", id, input.Date,
		"create", "create", createdChanges(correctionSnapshot(value))); err != nil {
		return AttendanceCorrection{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return AttendanceCorrection{}, databaseWriteError("创建补卡单失败", err)
	}
	return value, nil
}

func (s *Service) UpdateAttendanceCorrection(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input AttendanceCorrectionUpdateInput,
) (AttendanceCorrection, error) {
	if err := requirePermission(actor, "hr.attendance_correction:update"); err != nil {
		return AttendanceCorrection{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AttendanceCorrection{}, apierror.Wrap(apierror.CodeInternal, "更新补卡单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := scanCorrection(tx.QueryRow(ctx, `SELECT `+correctionColumns+` FROM hr_attendance_correction WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return AttendanceCorrection{}, apierror.New(apierror.CodeNotFound, "补卡单不存在")
	}
	if err != nil {
		return AttendanceCorrection{}, apierror.Wrap(apierror.CodeInternal, "读取补卡单失败", err)
	}
	after := before
	if input.EmployeeID != nil {
		after.EmployeeID = *input.EmployeeID
	}
	if input.Date != nil {
		after.Date = *input.Date
	}
	if input.Times != nil {
		after.Times = *input.Times
	}
	if input.Note.Set {
		after.Note = input.Note.Value
	}
	if err = validateCorrectionNote(after.Note); err != nil {
		return AttendanceCorrection{}, err
	}
	date, times, err := validateCorrectionInput(after.Date, after.Times)
	if err != nil {
		return AttendanceCorrection{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE hr_attendance_correction SET date=$2,
		times=ARRAY(SELECT value::time FROM unnest($3::text[]) value),note=$4,
		employee_id=$5,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, date, times, after.Note, after.EmployeeID)
	if err != nil {
		return AttendanceCorrection{}, databaseWriteError("更新补卡单失败", err)
	}
	pairs := map[attendancePair]struct{}{
		{EmployeeID: before.EmployeeID, Date: before.Date}: {},
		{EmployeeID: after.EmployeeID, Date: after.Date}:   {},
	}
	if err = recomputePairs(ctx, tx, pairs); err != nil {
		return AttendanceCorrection{}, err
	}
	value, err := scanCorrection(tx.QueryRow(ctx, `SELECT `+correctionColumns+` FROM hr_attendance_correction WHERE id=$1`, id))
	if err != nil {
		return AttendanceCorrection{}, apierror.Wrap(apierror.CodeInternal, "读取补卡单失败", err)
	}
	changes := audit.Diff(correctionSnapshot(before), correctionSnapshot(value),
		[]string{"date", "times", "note", "employee_id"})
	if len(changes) != 0 {
		if err = writeAudit(ctx, tx, actor, "hr_attendance_correction", id, value.Date,
			"update", "update", changes); err != nil {
			return AttendanceCorrection{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return AttendanceCorrection{}, databaseWriteError("更新补卡单失败", err)
	}
	return value, nil
}

func (s *Service) DeleteAttendanceCorrection(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requirePermission(actor, "hr.attendance_correction:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除补卡单失败", err)
	}
	defer tx.Rollback(ctx)
	value, err := scanCorrection(tx.QueryRow(ctx, `SELECT `+correctionColumns+` FROM hr_attendance_correction WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "补卡单不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取补卡单失败", err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM hr_attendance_correction WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除补卡单失败", err)
	}
	if err = recomputePair(ctx, tx, attendancePair{EmployeeID: value.EmployeeID, Date: value.Date}); err != nil {
		return err
	}
	if err = writeAudit(ctx, tx, actor, "hr_attendance_correction", id, value.Date,
		"destroy", "destroy", destroyedChanges(correctionSnapshot(value))); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除补卡单失败", err)
	}
	return nil
}

type rowScanner interface{ Scan(...any) error }

func scanPunch(scanner rowScanner) (AttendancePunch, error) {
	var value AttendancePunch
	err := scanner.Scan(&value.ID, &value.AttendanceNo, &value.PunchedAt, &value.InsertedAt,
		&value.EmployeeID, &value.ImportID)
	value.PunchedAt, value.InsertedAt = value.PunchedAt.UTC(), value.InsertedAt.UTC()
	return value, err
}

func scanImport(scanner rowScanner) (AttendanceImport, error) {
	var value AttendanceImport
	err := scanner.Scan(
		&value.ID, &value.Status, &value.Error, &value.TotalRows, &value.BadRows,
		&value.DupRows, &value.MatchedRows, &value.UnmatchedRows, &value.UnmatchedDetail,
		&value.ImportedCount, &value.SkippedExistingRows, &value.SkippedUnmatchedRows,
		&value.AutoCreatedCount, &value.ImportedAt, &value.InsertedAt, &value.UpdatedAt,
		&value.FileID, &value.CreatedByID, &value.ImportedByID, &value.PunchCount,
	)
	value.Status = upperWire(value.Status)
	if value.ImportedAt != nil {
		at := value.ImportedAt.UTC()
		value.ImportedAt = &at
	}
	value.InsertedAt, value.UpdatedAt = value.InsertedAt.UTC(), value.UpdatedAt.UTC()
	return value, err
}

func scanDay(scanner rowScanner) (AttendanceDay, error) {
	var value AttendanceDay
	var date time.Time
	var normal, overtime, bonus pgtype.Numeric
	err := scanner.Scan(
		&value.ID, &date, &value.MorningIn, &value.MorningOut, &value.AfternoonIn,
		&value.AfternoonOut, &normal, &overtime, &bonus, &value.Status,
		&value.InsertedAt, &value.UpdatedAt, &value.EmployeeID,
	)
	value.Date, value.Status = date.Format("2006-01-02"), upperWire(value.Status)
	value.NormalHours, value.OvertimeHours, value.BonusWorkday =
		numericString(normal), numericString(overtime), numericString(bonus)
	value.InsertedAt, value.UpdatedAt = value.InsertedAt.UTC(), value.UpdatedAt.UTC()
	return value, err
}

func scanCorrection(scanner rowScanner) (AttendanceCorrection, error) {
	var value AttendanceCorrection
	var date time.Time
	err := scanner.Scan(&value.ID, &date, &value.Times, &value.Note, &value.InsertedAt,
		&value.UpdatedAt, &value.EmployeeID, &value.CreatedByID)
	value.Date = date.Format("2006-01-02")
	value.InsertedAt, value.UpdatedAt = value.InsertedAt.UTC(), value.UpdatedAt.UTC()
	return value, err
}

func loadEmployeeMap(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, rows []parsedPunch) (map[string]uuid.UUID, error) {
	seen := make(map[string]struct{})
	nos := make([]string, 0)
	for _, row := range rows {
		if _, ok := seen[row.AttendanceNo]; !ok {
			seen[row.AttendanceNo] = struct{}{}
			nos = append(nos, row.AttendanceNo)
		}
	}
	result := make(map[string]uuid.UUID)
	if len(nos) == 0 {
		return result, nil
	}
	found, err := q.Query(ctx, `SELECT attendance_no,id FROM hr_employees WHERE attendance_no=ANY($1::text[])`, nos)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "匹配考勤员工失败", err)
	}
	defer found.Close()
	for found.Next() {
		var no string
		var id uuid.UUID
		if err = found.Scan(&no, &id); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "匹配考勤员工失败", err)
		}
		result[no] = id
	}
	return result, found.Err()
}

func missingAttendanceNos(rows []parsedPunch, employees map[string]uuid.UUID) []string {
	set := make(map[string]struct{})
	for _, row := range rows {
		if _, ok := employees[row.AttendanceNo]; !ok {
			set[row.AttendanceNo] = struct{}{}
		}
	}
	result := make([]string, 0, len(set))
	for no := range set {
		result = append(result, no)
	}
	sort.Strings(result)
	return result
}

func errorLabel(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func importSnapshot(value AttendanceImport) map[string]any {
	return map[string]any{
		"status": lowerWire(value.Status), "error": value.Error, "total_rows": value.TotalRows,
		"bad_rows": value.BadRows, "dup_rows": value.DupRows, "matched_rows": value.MatchedRows,
		"unmatched_rows": value.UnmatchedRows, "unmatched_detail": value.UnmatchedDetail,
		"imported_count": value.ImportedCount, "skipped_existing_rows": value.SkippedExistingRows,
		"skipped_unmatched_rows": value.SkippedUnmatchedRows, "auto_created_count": value.AutoCreatedCount,
		"imported_at": value.ImportedAt, "file_id": value.FileID,
		"created_by_id": value.CreatedByID, "imported_by_id": value.ImportedByID,
	}
}

func correctionSnapshot(value AttendanceCorrection) map[string]any {
	return map[string]any{
		"date": value.Date, "times": value.Times, "note": value.Note,
		"employee_id": value.EmployeeID, "created_by_id": value.CreatedByID,
	}
}

func validateCorrectionInput(dateValue string, values []string) (time.Time, []string, error) {
	date, err := parseDate(dateValue, "date")
	if err != nil {
		return time.Time{}, nil, err
	}
	if len(values) < 1 || len(values) > 20 {
		return time.Time{}, nil, apierror.Validation("补卡参数不合法", map[string][]string{
			"times": {"必须包含 1 到 20 个时刻"},
		})
	}
	seen := make(map[string]struct{})
	for _, raw := range values {
		parsed, parseErr := time.Parse("15:04:05", raw)
		if parseErr != nil {
			return time.Time{}, nil, apierror.Validation("补卡参数不合法", map[string][]string{
				"times": {"格式应为 HH:MM:SS"},
			})
		}
		seen[parsed.Format("15:04:05")] = struct{}{}
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return date, keys, nil
}

func validateCorrectionNote(value *string) error {
	if value != nil && len([]rune(*value)) > 200 {
		return apierror.Validation("补卡参数不合法", map[string][]string{
			"note": {"最多 200 个字符"},
		})
	}
	return nil
}

type attendancePair struct {
	EmployeeID uuid.UUID
	Date       string
}

func localDate(value time.Time) string {
	return value.UTC().Add(localOffset).Format("2006-01-02")
}

func recomputePairs(ctx context.Context, tx pgx.Tx, pairs map[attendancePair]struct{}) error {
	ordered := make([]attendancePair, 0, len(pairs))
	for pair := range pairs {
		ordered = append(ordered, pair)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].EmployeeID == ordered[j].EmployeeID {
			return ordered[i].Date < ordered[j].Date
		}
		return ordered[i].EmployeeID.String() < ordered[j].EmployeeID.String()
	})
	for _, pair := range ordered {
		if err := recomputePair(ctx, tx, pair); err != nil {
			return err
		}
	}
	return nil
}

func recomputePair(ctx context.Context, tx pgx.Tx, pair attendancePair) error {
	date, err := time.Parse("2006-01-02", pair.Date)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "日考勤日期无效", err)
	}
	start := date.Add(-localOffset).UTC()
	end := start.Add(24 * time.Hour)
	rows, err := tx.Query(ctx, `
		SELECT to_char(local_time,'HH24:MI:SS') FROM (
			SELECT (punched_at + interval '8 hours')::time local_time
			  FROM hr_attendance_punch
			 WHERE employee_id=$1 AND punched_at >= $2 AND punched_at < $3
			UNION ALL
			SELECT unnest(times) FROM hr_attendance_correction
			 WHERE employee_id=$1 AND date=$4
		) source_values`, pair.EmployeeID, start, end, date)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取日考勤来源失败", err)
	}
	var values []string
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取日考勤来源失败", err)
		}
		values = append(values, value)
	}
	rows.Close()
	if len(values) == 0 {
		if _, err = tx.Exec(ctx, `DELETE FROM hr_attendance_day WHERE employee_id=$1 AND date=$2`,
			pair.EmployeeID, date); err != nil {
			return databaseWriteError("清理日考勤失败", err)
		}
		return nil
	}
	computed, err := computeAttendanceDay(values)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO hr_attendance_day(
		date,morning_in,morning_out,afternoon_in,afternoon_out,normal_hours,
		overtime_hours,bonus_workday,status,employee_id)
		VALUES($1,$2::text::time,$3::text::time,$4::text::time,$5::text::time,$6,$7,$8,$9,$10)
		ON CONFLICT(employee_id,date) DO UPDATE SET
		morning_in=excluded.morning_in,morning_out=excluded.morning_out,
		afternoon_in=excluded.afternoon_in,afternoon_out=excluded.afternoon_out,
		normal_hours=excluded.normal_hours,overtime_hours=excluded.overtime_hours,
		bonus_workday=excluded.bonus_workday,status=excluded.status,
		updated_at=(now() AT TIME ZONE 'utc')`,
		date, computed.MorningIn, computed.MorningOut, computed.AfternoonIn,
		computed.AfternoonOut, computed.NormalHours, computed.OvertimeHours,
		computed.BonusWorkday, computed.Status, pair.EmployeeID)
	if err != nil {
		return databaseWriteError("写入日考勤失败", err)
	}
	return nil
}

type computedDay struct {
	MorningIn, MorningOut                    *string
	AfternoonIn, AfternoonOut                *string
	NormalHours, OvertimeHours, BonusWorkday pgtype.Numeric
	Status                                   string
}

func computeAttendanceDay(raw []string) (computedDay, error) {
	var morning, afternoon []time.Time
	for _, value := range raw {
		parsed, err := time.Parse("15:04:05", value)
		if err != nil {
			return computedDay{}, apierror.Wrap(apierror.CodeInternal, "解析日考勤时刻失败", err)
		}
		if parsed.Hour() < 12 {
			morning = append(morning, parsed)
		} else {
			afternoon = append(afternoon, parsed)
		}
	}
	sort.Slice(morning, func(i, j int) bool { return morning[i].Before(morning[j]) })
	sort.Slice(afternoon, func(i, j int) bool { return afternoon[i].Before(afternoon[j]) })
	mIn, mOut := timeBounds(morning)
	aIn, aOut := timeBounds(afternoon)
	mUnits := minInt(spanUnits(morning), 8)
	aUnits := spanUnits(afternoon)
	otUnits := maxInt(aUnits-8, 0)
	normal := decimal.NewFromInt(int64(mUnits + minInt(aUnits, 8))).Div(decimal.NewFromInt(2))
	overtime := decimal.NewFromInt(int64(otUnits)).Div(decimal.NewFromInt(2))
	bonus := decimal.Zero
	if otUnits >= 7 {
		bonus = decimal.RequireFromString("0.5")
	}
	status := "ok"
	if len(morning) == 1 || len(afternoon) == 1 {
		status = "missing"
	}
	return computedDay{
		MorningIn: mIn, MorningOut: mOut, AfternoonIn: aIn, AfternoonOut: aOut,
		NormalHours: numeric(normal), OvertimeHours: numeric(overtime),
		BonusWorkday: numeric(bonus), Status: status,
	}, nil
}

func timeBounds(values []time.Time) (*string, *string) {
	if len(values) == 0 {
		return nil, nil
	}
	first, last := values[0].Format("15:04:05"), values[len(values)-1].Format("15:04:05")
	return &first, &last
}

func spanUnits(values []time.Time) int {
	if len(values) < 2 {
		return 0
	}
	return int(values[len(values)-1].Sub(values[0]) / (30 * time.Minute))
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
