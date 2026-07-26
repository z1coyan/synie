package employee

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	Next(context.Context, numbering.NextInput) (string, error)
}

type Service struct {
	pool     *pgxpool.Pool
	numberer Numberer
}

func NewService(pool *pgxpool.Pool, numberer Numberer) *Service {
	return &Service{pool: pool, numberer: numberer}
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Employee, error) {
	row, err := dbgen.New(s.pool).GetEmployee(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Employee{}, apierror.New(apierror.CodeNotFound, "员工不存在")
	}
	if err != nil {
		return Employee{}, apierror.Wrap(apierror.CodeInternal, "读取员工失败", err)
	}
	return fromRow(row), nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (ListResult, error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	fields := map[string][]string{}
	if query.Limit < 1 || query.Limit > 200 {
		fields["limit"] = []string{"必须在 1 到 200 之间"}
	}
	if query.Offset < 0 {
		fields["offset"] = []string{"不能小于 0"}
	}
	if len(fields) > 0 {
		return ListResult{}, apierror.Validation("分页参数不合法", fields)
	}
	built, err := filterbuild.Build(ResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ListResult{}, err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "code" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询员工失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM hr_employees`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计员工失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitArg := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `
		SELECT id,code,name,attendance_no,id_number,household_registration,phone,current_address,
		       daily_wage,monthly_allowance,inserted_at,updated_at,insurance_types
		FROM hr_employees`+built.Where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitArg, limitArg+1), args...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询员工失败", err)
	}
	defer rows.Close()
	result.Results = make([]Employee, 0, query.Limit)
	for rows.Next() {
		var row dbgen.HrEmployee
		if err := rows.Scan(
			&row.ID, &row.Code, &row.Name, &row.AttendanceNo, &row.IDNumber,
			&row.HouseholdRegistration, &row.Phone, &row.CurrentAddress,
			&row.DailyWage, &row.MonthlyAllowance, &row.InsertedAt, &row.UpdatedAt,
			&row.InsuranceTypes,
		); err != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取员工结果失败", err)
		}
		result.Results = append(result.Results, fromRow(row))
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历员工结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成员工查询失败", err)
	}
	return result, nil
}

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Employee, error) {
	normalized, err := normalizeCreate(input)
	if err != nil {
		return Employee{}, err
	}
	if normalized.Code == nil || *normalized.Code == "" {
		if s.numberer == nil {
			return Employee{}, apierror.New(apierror.CodeConflict, "未配置启用的编号规则")
		}
		code, err := s.numberer.Next(ctx, numbering.NextInput{Resource: "hr.employee"})
		if err != nil {
			return Employee{}, err
		}
		normalized.Code = &code
	}
	if err := validateCode(*normalized.Code); err != nil {
		return Employee{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Employee{}, apierror.Wrap(apierror.CodeInternal, "创建员工失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).CreateEmployee(ctx, dbgen.CreateEmployeeParams{
		Code:                  *normalized.Code,
		Name:                  normalized.Name,
		AttendanceNo:          toText(normalized.AttendanceNo),
		IDNumber:              toText(normalized.IDNumber),
		HouseholdRegistration: toText(normalized.HouseholdRegistration),
		Phone:                 toText(normalized.Phone),
		CurrentAddress:        toText(normalized.CurrentAddress),
		DailyWage:             toNumeric(normalized.DailyWage),
		MonthlyAllowance:      toNumeric(normalized.MonthlyAllowance),
		InsuranceTypes:        lowerValues(normalized.InsuranceTypes),
	})
	if err != nil {
		return Employee{}, writeError("创建员工失败", err)
	}
	item := fromRow(row)
	changes := createdChanges(rawSnapshot(item))
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "hr_employee", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "create", ActionName: "create", Changes: changes,
	}); err != nil {
		return Employee{}, apierror.Wrap(apierror.CodeInternal, "创建员工失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Employee{}, writeError("创建员工失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Employee, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Employee{}, apierror.Wrap(apierror.CodeInternal, "更新员工失败", err)
	}
	defer tx.Rollback(ctx)
	queries := dbgen.New(tx)
	row, err := queries.LockEmployee(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Employee{}, apierror.New(apierror.CodeNotFound, "员工不存在")
	}
	if err != nil {
		return Employee{}, apierror.Wrap(apierror.CodeInternal, "读取员工失败", err)
	}
	before := fromRow(row)
	after := before
	if input.Code != nil {
		after.Code = *input.Code
	}
	if input.Name != nil {
		after.Name = *input.Name
	}
	applyOptional(&after.AttendanceNo, input.AttendanceNo)
	applyOptional(&after.IDNumber, input.IDNumber)
	applyOptional(&after.HouseholdRegistration, input.HouseholdRegistration)
	applyOptional(&after.Phone, input.Phone)
	applyOptional(&after.CurrentAddress, input.CurrentAddress)
	applyOptional(&after.DailyWage, input.DailyWage)
	applyOptional(&after.MonthlyAllowance, input.MonthlyAllowance)
	if input.InsuranceTypes != nil {
		after.InsuranceTypes = *input.InsuranceTypes
	}
	after, err = normalizeEmployee(after)
	if err != nil {
		return Employee{}, err
	}
	beforeSnapshot, afterSnapshot := rawSnapshot(before), rawSnapshot(after)
	changes := audit.Diff(beforeSnapshot, afterSnapshot, auditedFields)
	if _, changed := changes["id_number"]; changed {
		changes["id_number"] = audit.Change{"from": "[FILTERED]", "to": "[FILTERED]"}
	}
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Employee{}, apierror.Wrap(apierror.CodeInternal, "更新员工失败", err)
		}
		return before, nil
	}
	updated, err := queries.UpdateEmployee(ctx, dbgen.UpdateEmployeeParams{
		ID:                    id,
		Code:                  after.Code,
		Name:                  after.Name,
		AttendanceNo:          toText(after.AttendanceNo),
		IDNumber:              toText(after.IDNumber),
		HouseholdRegistration: toText(after.HouseholdRegistration),
		Phone:                 toText(after.Phone),
		CurrentAddress:        toText(after.CurrentAddress),
		DailyWage:             toNumeric(after.DailyWage),
		MonthlyAllowance:      toNumeric(after.MonthlyAllowance),
		InsuranceTypes:        lowerValues(after.InsuranceTypes),
	})
	if err != nil {
		return Employee{}, writeError("更新员工失败", err)
	}
	item := fromRow(updated)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "hr_employee", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return Employee{}, apierror.Wrap(apierror.CodeInternal, "更新员工失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Employee{}, writeError("更新员工失败", err)
	}
	return item, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除员工失败", err)
	}
	defer tx.Rollback(ctx)
	queries := dbgen.New(tx)
	row, err := queries.LockEmployee(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "员工不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取员工失败", err)
	}
	item := fromRow(row)
	if _, err := queries.DeleteEmployee(ctx, id); err != nil {
		return writeError("删除员工失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "hr_employee", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "destroy", ActionName: "destroy", Changes: destroyedChanges(rawSnapshot(item)),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除员工失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除员工失败", err)
	}
	return nil
}

func normalizeCreate(input CreateInput) (CreateInput, error) {
	if input.Code != nil {
		value := strings.TrimSpace(*input.Code)
		input.Code = &value
	}
	input.Name = strings.TrimSpace(input.Name)
	input.AttendanceNo = normalizedText(input.AttendanceNo)
	input.IDNumber = normalizedText(input.IDNumber)
	input.HouseholdRegistration = normalizedText(input.HouseholdRegistration)
	input.Phone = normalizedText(input.Phone)
	input.CurrentAddress = normalizedText(input.CurrentAddress)
	daily, dailyErr := normalizedDecimal(input.DailyWage, "dailyWage", "日薪不能为负数")
	allowance, allowanceErr := normalizedDecimal(input.MonthlyAllowance, "monthlyAllowance", "月补贴不能为负数")
	input.DailyWage, input.MonthlyAllowance = daily, allowance
	insurance, insuranceErr := normalizedInsurance(input.InsuranceTypes)
	input.InsuranceTypes = insurance
	fields := validateEmployeeFields(input.Name, input.AttendanceNo, input.IDNumber, input.HouseholdRegistration, input.Phone, input.CurrentAddress)
	mergeValidation(fields, dailyErr)
	mergeValidation(fields, allowanceErr)
	mergeValidation(fields, insuranceErr)
	if len(fields) > 0 {
		return CreateInput{}, apierror.Validation("员工参数不合法", fields)
	}
	return input, nil
}

func normalizeEmployee(input Employee) (Employee, error) {
	input.Code, input.Name = strings.TrimSpace(input.Code), strings.TrimSpace(input.Name)
	if err := validateCode(input.Code); err != nil {
		return Employee{}, err
	}
	input.AttendanceNo = normalizedText(input.AttendanceNo)
	input.IDNumber = normalizedText(input.IDNumber)
	input.HouseholdRegistration = normalizedText(input.HouseholdRegistration)
	input.Phone = normalizedText(input.Phone)
	input.CurrentAddress = normalizedText(input.CurrentAddress)
	daily, dailyErr := normalizedDecimal(input.DailyWage, "dailyWage", "日薪不能为负数")
	allowance, allowanceErr := normalizedDecimal(input.MonthlyAllowance, "monthlyAllowance", "月补贴不能为负数")
	input.DailyWage, input.MonthlyAllowance = daily, allowance
	insurance, insuranceErr := normalizedInsurance(input.InsuranceTypes)
	input.InsuranceTypes = insurance
	fields := validateEmployeeFields(input.Name, input.AttendanceNo, input.IDNumber, input.HouseholdRegistration, input.Phone, input.CurrentAddress)
	mergeValidation(fields, dailyErr)
	mergeValidation(fields, allowanceErr)
	mergeValidation(fields, insuranceErr)
	if len(fields) > 0 {
		return Employee{}, apierror.Validation("员工参数不合法", fields)
	}
	return input, nil
}

func validateCode(code string) error {
	if code == "" || utf8.RuneCountInString(code) > 32 {
		return apierror.Validation("员工参数不合法", map[string][]string{
			"code": {"不能为空且最多 32 个字符"},
		})
	}
	return nil
}

func validateEmployeeFields(name string, attendanceNo, idNumber, household, phone, address *string) map[string][]string {
	fields := map[string][]string{}
	if name == "" || utf8.RuneCountInString(name) > 64 {
		fields["name"] = []string{"不能为空且最多 64 个字符"}
	}
	checkLength(fields, "attendanceNo", attendanceNo, 64)
	checkLength(fields, "idNumber", idNumber, 32)
	checkLength(fields, "householdRegistration", household, 128)
	checkLength(fields, "phone", phone, 32)
	checkLength(fields, "currentAddress", address, 255)
	return fields
}

func checkLength(fields map[string][]string, field string, value *string, max int) {
	if value != nil && utf8.RuneCountInString(*value) > max {
		fields[field] = []string{fmt.Sprintf("最多 %d 个字符", max)}
	}
}

func normalizedText(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	if normalized == "" {
		return nil
	}
	return &normalized
}

func normalizedDecimal(value *string, field, negativeMessage string) (*string, map[string][]string) {
	if value == nil {
		return nil, nil
	}
	parsed, err := decimal.NewFromString(strings.TrimSpace(*value))
	if err != nil {
		return nil, map[string][]string{field: {"必须是十进制字符串"}}
	}
	if parsed.IsNegative() {
		return nil, map[string][]string{field: {negativeMessage}}
	}
	normalized := parsed.String()
	return &normalized, nil
}

func normalizedInsurance(values []string) ([]string, map[string][]string) {
	allowed := make(map[string]struct{}, len(insuranceOptions))
	for _, option := range insuranceOptions {
		allowed[option.Value] = struct{}{}
	}
	result := make([]string, len(values))
	for i, value := range values {
		value = strings.ToUpper(strings.TrimSpace(value))
		if _, ok := allowed[value]; !ok {
			return nil, map[string][]string{"insuranceTypes": {"包含未知参保类型"}}
		}
		result[i] = value
	}
	return result, nil
}

func mergeValidation(target map[string][]string, addition map[string][]string) {
	for key, messages := range addition {
		target[key] = messages
	}
}

func applyOptional(target **string, input OptionalString) {
	if input.Set {
		*target = input.Value
	}
}

func rawSnapshot(item Employee) map[string]any {
	return map[string]any{
		"code": item.Code, "name": item.Name, "attendance_no": item.AttendanceNo,
		"id_number": item.IDNumber, "household_registration": item.HouseholdRegistration,
		"phone": item.Phone, "current_address": item.CurrentAddress,
		"daily_wage": item.DailyWage, "monthly_allowance": item.MonthlyAllowance,
		"insurance_types": lowerValues(item.InsuranceTypes),
	}
}

func createdChanges(snapshot map[string]any) map[string]audit.Change {
	changes := make(map[string]audit.Change)
	for _, field := range auditedFields {
		value := snapshot[field]
		if isNilPointer(value) {
			continue
		}
		if field == "id_number" {
			value = "[FILTERED]"
		}
		changes[field] = audit.Change{"to": value}
	}
	return changes
}

func destroyedChanges(snapshot map[string]any) map[string]audit.Change {
	changes := make(map[string]audit.Change)
	for _, field := range auditedFields {
		value := snapshot[field]
		if isNilPointer(value) {
			continue
		}
		if field == "id_number" {
			value = "[FILTERED]"
		}
		changes[field] = audit.Change{"from": value}
	}
	return changes
}

func isNilPointer(value any) bool {
	switch typed := value.(type) {
	case *string:
		return typed == nil
	}
	return value == nil
}

func fromRow(row dbgen.HrEmployee) Employee {
	insurance := make([]string, len(row.InsuranceTypes))
	for i, value := range row.InsuranceTypes {
		insurance[i] = strings.ToUpper(value)
	}
	return Employee{
		ID: row.ID, Code: row.Code, Name: row.Name,
		AttendanceNo: fromText(row.AttendanceNo), IDNumber: fromText(row.IDNumber),
		HouseholdRegistration: fromText(row.HouseholdRegistration), Phone: fromText(row.Phone),
		CurrentAddress: fromText(row.CurrentAddress), DailyWage: fromNumeric(row.DailyWage),
		MonthlyAllowance: fromNumeric(row.MonthlyAllowance), InsuranceTypes: insurance,
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func toText(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func fromText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func toNumeric(value *string) pgtype.Numeric {
	if value == nil {
		return pgtype.Numeric{}
	}
	parsed, _ := decimal.NewFromString(*value)
	return pgtype.Numeric{Int: parsed.Coefficient(), Exp: parsed.Exponent(), Valid: true}
}

func fromNumeric(value pgtype.Numeric) *string {
	if !value.Valid || value.Int == nil || value.NaN || value.InfinityModifier != pgtype.Finite {
		return nil
	}
	result := decimal.NewFromBigInt(value.Int, value.Exp).String()
	return &result
}

func lowerValues(values []string) []string {
	result := make([]string, len(values))
	for i, value := range values {
		result[i] = strings.ToLower(value)
	}
	return result
}

func writeError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			switch pgErr.ConstraintName {
			case "hr_employees_unique_code_index":
				return apierror.Wrap(apierror.CodeConflict, "员工编号已存在", err)
			case "hr_employees_unique_id_number_index":
				return apierror.Wrap(apierror.CodeConflict, "身份证号已存在", err)
			case "hr_employees_unique_attendance_no_index":
				return apierror.Wrap(apierror.CodeConflict, "考勤机编号已存在", err)
			}
			return apierror.Wrap(apierror.CodeConflict, "员工唯一字段已存在", err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "员工已被业务数据引用,不可删除", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}
