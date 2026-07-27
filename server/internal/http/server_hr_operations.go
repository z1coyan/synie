package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"
	hroperations "github.com/z1coyan/synie/server/internal/domain/hr/operations"
	"github.com/z1coyan/synie/server/internal/http/gen"
)

func hrListQuery(body listBody) hroperations.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return hroperations.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func (s *Server) QueryHrAttendancePunches(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "hr.attendance_punch:read", hrListQuery, s.HROperations.QueryAttendancePunches,
		func(result hroperations.AttendancePunchList) any {
			return gen.AttendancePunchList{
				Count: result.Count, Results: mapItems(result.Results, attendancePunchDTO),
			}
		})
}

func (s *Server) GetHrAttendancePunch(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.attendance_punch:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.HROperations.GetAttendancePunch(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, attendancePunchDTO(item))
}

func (s *Server) QueryHrAttendanceImports(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "hr.attendance_punch:import", hrListQuery, s.HROperations.QueryAttendanceImports,
		func(result hroperations.AttendanceImportList) any {
			return gen.AttendanceImportList{
				Count: result.Count, Results: mapItems(result.Results, attendanceImportDTO),
			}
		})
}

func (s *Server) GetHrAttendanceImport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.attendance_punch:import")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.HROperations.GetAttendanceImport(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, attendanceImportDTO(item))
}

func (s *Server) CreateHrAttendanceImport(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.attendance_punch:import")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.AttendanceImportCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.HROperations.CreateAttendanceImport(
		r.Context(), actor, hroperations.AttendanceImportCreateInput{FileID: body.FileId},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, attendanceImportDTO(item))
}

func (s *Server) ImportHrAttendanceImport(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, err := actorWithPermission(r, "hr.attendance_punch:import")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.AttendanceImportExecute
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := hroperations.AttendanceImportExecuteInput{}
	if body.AutoCreateEmployees != nil {
		input.AutoCreateEmployees = *body.AutoCreateEmployees
	}
	item, err := s.HROperations.ImportAttendance(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, attendanceImportDTO(item))
}

func (s *Server) DeleteHrAttendanceImport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.attendance_punch:import")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.HROperations.DeleteAttendanceImport(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryHrAttendanceDays(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "hr.attendance_day:read", hrListQuery, s.HROperations.QueryAttendanceDays,
		func(result hroperations.AttendanceDayList) any {
			return gen.AttendanceDayList{
				Count: result.Count, Results: mapItems(result.Results, attendanceDayDTO),
			}
		})
}

func (s *Server) GetHrAttendanceDay(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.attendance_day:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.HROperations.GetAttendanceDay(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, attendanceDayDTO(item))
}

func (s *Server) RecalcHrAttendanceDays(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.attendance_day:recalc")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.AttendanceDayRecalc
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	count, err := s.HROperations.RecalcAttendanceDays(
		r.Context(), actor, body.DateFrom.Time.Format(time.DateOnly),
		body.DateTo.Time.Format(time.DateOnly),
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.AttendanceDayRecalcResult{Count: int(count)})
}

func (s *Server) GetHrAttendanceMonthSummary(
	w http.ResponseWriter,
	r *http.Request,
	params gen.GetHrAttendanceMonthSummaryParams,
) {
	actor, err := actorWithPermission(r, "hr.attendance_day:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	result, err := s.HROperations.AttendanceMonthSummary(r.Context(), actor, params.Month)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make(gen.AttendanceMonthSummaryList, 0, len(result))
	for _, item := range result {
		code, name := item.EmployeeCode, item.EmployeeName
		items = append(items, gen.AttendanceMonthSummary{
			EmployeeId: item.EmployeeID, EmployeeCode: &code, EmployeeName: &name,
			Days: int(item.Days), MissingDays: int(item.MissingDays),
			NormalHours: item.NormalHours, OvertimeHours: item.OvertimeHours,
			BonusWorkdays: item.BonusWorkdays, Workdays: item.Workdays,
		})
	}
	s.writeJSON(w, http.StatusOK, items)
}

func (s *Server) QueryHrAttendanceCorrections(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "hr.attendance_correction:read", hrListQuery, s.HROperations.QueryAttendanceCorrections,
		func(result hroperations.AttendanceCorrectionList) any {
			return gen.AttendanceCorrectionList{
				Count: result.Count, Results: mapItems(result.Results, attendanceCorrectionDTO),
			}
		})
}

func (s *Server) GetHrAttendanceCorrection(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.attendance_correction:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.HROperations.GetAttendanceCorrection(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, attendanceCorrectionDTO(item))
}

func (s *Server) CreateHrAttendanceCorrection(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.attendance_correction:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.AttendanceCorrectionCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.HROperations.CreateAttendanceCorrection(
		r.Context(), actor, hroperations.AttendanceCorrectionInput{
			EmployeeID: body.EmployeeId, Date: body.Date.Time.Format(time.DateOnly),
			Times: body.Times, Note: body.Note,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, attendanceCorrectionDTO(item))
}

type attendanceCorrectionUpdateBody struct {
	EmployeeID *openapi_types.UUID `json:"employeeId,omitempty"`
	Date       *openapi_types.Date `json:"date,omitempty"`
	Times      *[]string           `json:"times,omitempty"`
	Note       json.RawMessage     `json:"note,omitempty"`
}

func (s *Server) UpdateHrAttendanceCorrection(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, err := actorWithPermission(r, "hr.attendance_correction:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body attendanceCorrectionUpdateBody
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := hroperations.AttendanceCorrectionUpdateInput{
		EmployeeID: body.EmployeeID, Times: body.Times,
	}
	if body.Date != nil {
		date := body.Date.Time.Format(time.DateOnly)
		input.Date = &date
	}
	note, noteErr := optionalUpdate[string](body.Note)
	if noteErr != nil {
		s.writeError(w, r, nullableStringError("补卡单", "note"))
		return
	}
	input.Note = note
	item, err := s.HROperations.UpdateAttendanceCorrection(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, attendanceCorrectionDTO(item))
}

func (s *Server) DeleteHrAttendanceCorrection(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.attendance_correction:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.HROperations.DeleteAttendanceCorrection(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryHrPayrolls(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "hr.payroll:read", hrListQuery, s.HROperations.QueryPayrolls,
		func(result hroperations.PayrollList) any {
			return gen.PayrollList{Count: result.Count, Results: mapItems(result.Results, payrollDTO)}
		})
}

func (s *Server) GetHrPayroll(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.payroll:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.HROperations.GetPayroll(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, payrollDTO(item))
}

func (s *Server) CreateHrPayroll(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.payroll:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PayrollCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.HROperations.CreatePayroll(r.Context(), actor, hroperations.PayrollInput{
		EmployeeID: body.EmployeeId, Month: body.Month,
		Workdays: stringOrZero(body.Workdays), AttendanceDays: intPtrToInt64(body.AttendanceDays),
		MissingDays: intPtrToInt64(body.MissingDays), OvertimeHours: stringOrZero(body.OvertimeHours),
		DailyWage: stringOrZero(body.DailyWage), Allowance: stringOrZero(body.Allowance),
		Bonus: stringOrZero(body.Bonus), Fine: stringOrZero(body.Fine),
		LoanDeduction: stringOrZero(body.LoanDeduction), Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, payrollDTO(item))
}

type payrollUpdateBody struct {
	Workdays       *string         `json:"workdays,omitempty"`
	AttendanceDays *int            `json:"attendanceDays,omitempty"`
	MissingDays    *int            `json:"missingDays,omitempty"`
	OvertimeHours  *string         `json:"overtimeHours,omitempty"`
	DailyWage      *string         `json:"dailyWage,omitempty"`
	Allowance      *string         `json:"allowance,omitempty"`
	Bonus          *string         `json:"bonus,omitempty"`
	Fine           *string         `json:"fine,omitempty"`
	LoanDeduction  *string         `json:"loanDeduction,omitempty"`
	Remarks        json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) UpdateHrPayroll(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.payroll:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body payrollUpdateBody
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := hroperations.PayrollUpdateInput{
		Workdays: body.Workdays, AttendanceDays: intPtrToInt64Ptr(body.AttendanceDays),
		MissingDays: intPtrToInt64Ptr(body.MissingDays), OvertimeHours: body.OvertimeHours,
		DailyWage: body.DailyWage, Allowance: body.Allowance, Bonus: body.Bonus,
		Fine: body.Fine, LoanDeduction: body.LoanDeduction,
	}
	remarks, remarksErr := optionalUpdate[string](body.Remarks)
	if remarksErr != nil {
		s.writeError(w, r, nullableStringError("工资单", "remarks"))
		return
	}
	input.Remarks = remarks
	item, err := s.HROperations.UpdatePayroll(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, payrollDTO(item))
}

func (s *Server) DeleteHrPayroll(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.payroll:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.HROperations.DeletePayroll(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) RefreshHrPayroll(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.payroll:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.HROperations.RefreshPayroll(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, payrollDTO(item))
}

func (s *Server) GenerateHrPayrolls(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.payroll:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PayrollGenerate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.HROperations.GeneratePayrolls(r.Context(), actor, body.Month)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.PayrollGenerateResult{
		Created: int(result.Created), Skipped: int(result.Skipped),
	})
}

func (s *Server) GetHrPayrollMonthStats(
	w http.ResponseWriter,
	r *http.Request,
	params gen.GetHrPayrollMonthStatsParams,
) {
	actor, err := actorWithPermission(r, "hr.payroll:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	result, err := s.HROperations.PayrollMonthStats(r.Context(), actor, params.Month)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.PayrollMonthStats{
		Count: int(result.Count), PendingCount: int(result.PendingCount),
		PayableTotal: result.PayableTotal, PaidTotal: result.PaidTotal,
	})
}

func (s *Server) QueryHrPayrollPayments(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "hr.payroll_payment:read", hrListQuery, s.HROperations.QueryPayrollPayments,
		func(result hroperations.PayrollPaymentList) any {
			return gen.PayrollPaymentList{
				Count: result.Count, Results: mapItems(result.Results, payrollPaymentDTO),
			}
		})
}

func (s *Server) GetHrPayrollPayment(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.payroll_payment:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.HROperations.GetPayrollPayment(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, payrollPaymentDTO(item))
}

func (s *Server) CreateHrPayrollPayment(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.payroll_payment:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PayrollPaymentCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.HROperations.CreatePayrollPayment(r.Context(), actor, hroperations.PayrollPaymentInput{
		PayrollID: body.PayrollId, PaidOn: body.PaidOn.Time.Format(time.DateOnly),
		Amount: body.Amount, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, payrollPaymentDTO(item))
}

func (s *Server) PayRemainingHrPayrollPayment(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.payroll_payment:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PayrollPaymentPayRemaining
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.HROperations.PayRemainingPayroll(r.Context(), actor, hroperations.PayrollPayRemainingInput{
		PayrollID: body.PayrollId, PaidOn: body.PaidOn.Time.Format(time.DateOnly),
		Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, payrollPaymentDTO(item))
}

func (s *Server) DeleteHrPayrollPayment(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.payroll_payment:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.HROperations.DeletePayrollPayment(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryHrEmployeeLoans(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "hr.employee_loan:read", hrListQuery, s.HROperations.QueryEmployeeLoans,
		func(result hroperations.EmployeeLoanList) any {
			return gen.EmployeeLoanList{
				Count: result.Count, Results: mapItems(result.Results, employeeLoanDTO),
			}
		})
}

func (s *Server) GetHrEmployeeLoan(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.employee_loan:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.HROperations.GetEmployeeLoan(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, employeeLoanDTO(item))
}

func (s *Server) CreateHrEmployeeLoan(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.employee_loan:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.EmployeeLoanCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.HROperations.CreateEmployeeLoan(r.Context(), actor, hroperations.EmployeeLoanInput{
		EmployeeID: body.EmployeeId, Kind: string(body.Kind),
		OccurredOn: body.OccurredOn.Time.Format(time.DateOnly),
		Amount:     body.Amount, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, employeeLoanDTO(item))
}

type employeeLoanUpdateBody struct {
	EmployeeID *openapi_types.UUID   `json:"employeeId,omitempty"`
	Kind       *gen.EmployeeLoanKind `json:"kind,omitempty"`
	OccurredOn *openapi_types.Date   `json:"occurredOn,omitempty"`
	Amount     *string               `json:"amount,omitempty"`
	Remarks    json.RawMessage       `json:"remarks,omitempty"`
}

func (s *Server) UpdateHrEmployeeLoan(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.employee_loan:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body employeeLoanUpdateBody
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := hroperations.EmployeeLoanUpdateInput{
		EmployeeID: body.EmployeeID, Amount: body.Amount,
	}
	if body.Kind != nil {
		kind := string(*body.Kind)
		input.Kind = &kind
	}
	if body.OccurredOn != nil {
		occurredOn := body.OccurredOn.Time.Format(time.DateOnly)
		input.OccurredOn = &occurredOn
	}
	remarks, remarksErr := optionalUpdate[string](body.Remarks)
	if remarksErr != nil {
		s.writeError(w, r, nullableStringError("员工借款", "remarks"))
		return
	}
	input.Remarks = remarks
	item, err := s.HROperations.UpdateEmployeeLoan(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, employeeLoanDTO(item))
}

func (s *Server) DeleteHrEmployeeLoan(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.employee_loan:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.HROperations.DeleteEmployeeLoan(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) GetHrEmployeeLoanBalances(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.employee_loan:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	result, err := s.HROperations.EmployeeLoanBalances(r.Context(), actor)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make(gen.EmployeeLoanBalanceList, 0, len(result))
	for _, item := range result {
		code, name := item.EmployeeCode, item.EmployeeName
		items = append(items, gen.EmployeeLoanBalance{
			EmployeeId: item.EmployeeID, EmployeeCode: &code, EmployeeName: &name,
			Borrowed: item.Borrowed, Repaid: item.Repaid, Balance: item.Balance,
		})
	}
	s.writeJSON(w, http.StatusOK, items)
}

func attendancePunchDTO(item hroperations.AttendancePunch) gen.AttendancePunch {
	return gen.AttendancePunch{
		Id: item.ID, AttendanceNo: item.AttendanceNo, PunchedAt: item.PunchedAt,
		InsertedAt: item.InsertedAt, EmployeeId: item.EmployeeID, ImportId: item.ImportID,
	}
}

func attendanceImportDTO(item hroperations.AttendanceImport) gen.AttendanceImport {
	return gen.AttendanceImport{
		Id: item.ID, Status: gen.AttendanceImportStatus(item.Status), Error: item.Error,
		TotalRows: int64PtrToInt(item.TotalRows), BadRows: int64PtrToInt(item.BadRows),
		DupRows: int64PtrToInt(item.DupRows), MatchedRows: int64PtrToInt(item.MatchedRows),
		UnmatchedRows: int64PtrToInt(item.UnmatchedRows), UnmatchedDetail: item.UnmatchedDetail,
		ImportedCount:        int64PtrToInt(item.ImportedCount),
		SkippedExistingRows:  int64PtrToInt(item.SkippedExistingRows),
		SkippedUnmatchedRows: int64PtrToInt(item.SkippedUnmatchedRows),
		AutoCreatedCount:     int64PtrToInt(item.AutoCreatedCount),
		ImportedAt:           item.ImportedAt, InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
		FileId: item.FileID, CreatedById: item.CreatedByID, ImportedById: item.ImportedByID,
		PunchCount: int(item.PunchCount),
	}
}

func attendanceDayDTO(item hroperations.AttendanceDay) gen.AttendanceDay {
	return gen.AttendanceDay{
		Id: item.ID, Date: openAPIDate(item.Date),
		MorningIn: item.MorningIn, MorningOut: item.MorningOut,
		AfternoonIn: item.AfternoonIn, AfternoonOut: item.AfternoonOut,
		NormalHours: item.NormalHours, OvertimeHours: item.OvertimeHours,
		BonusWorkday: item.BonusWorkday, Status: gen.AttendanceDayStatus(item.Status),
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt, EmployeeId: item.EmployeeID,
	}
}

func attendanceCorrectionDTO(item hroperations.AttendanceCorrection) gen.AttendanceCorrection {
	return gen.AttendanceCorrection{
		Id: item.ID, Date: openAPIDate(item.Date), Times: item.Times, Note: item.Note,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
		EmployeeId: item.EmployeeID, CreatedById: item.CreatedByID,
	}
}

func payrollDTO(item hroperations.Payroll) gen.Payroll {
	return gen.Payroll{
		Id: item.ID, Month: item.Month, Workdays: item.Workdays,
		AttendanceDays: int(item.AttendanceDays), MissingDays: int(item.MissingDays),
		OvertimeHours: item.OvertimeHours, DailyWage: item.DailyWage,
		BaseAmount: item.BaseAmount, Allowance: item.Allowance, Bonus: item.Bonus,
		Fine: item.Fine, LoanDeduction: item.LoanDeduction, Payable: item.Payable,
		Status: gen.PayrollStatus(item.Status), Remarks: item.Remarks,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
		EmployeeId: item.EmployeeID, PaidTotal: item.PaidTotal,
	}
}

func payrollPaymentDTO(item hroperations.PayrollPayment) gen.PayrollPayment {
	var kind *gen.PayrollPaymentKind
	if item.Kind != nil {
		converted := gen.PayrollPaymentKind(*item.Kind)
		kind = &converted
	}
	return gen.PayrollPayment{
		Id: item.ID, Month: item.Month, PaidOn: openAPIDate(item.PaidOn),
		Amount: item.Amount, Kind: kind, Remarks: item.Remarks,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
		PayrollId: item.PayrollID, EmployeeId: item.EmployeeID, CreatedById: item.CreatedByID,
	}
}

func employeeLoanDTO(item hroperations.EmployeeLoan) gen.EmployeeLoan {
	return gen.EmployeeLoan{
		Id: item.ID, Kind: gen.EmployeeLoanKind(item.Kind),
		OccurredOn: openAPIDate(item.OccurredOn), Amount: item.Amount, Remarks: item.Remarks,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
		EmployeeId: item.EmployeeID, PayrollId: item.PayrollID, CreatedById: item.CreatedByID,
	}
}

func openAPIDate(value string) openapi_types.Date {
	parsed, _ := time.Parse(time.DateOnly, value)
	return openapi_types.Date{Time: parsed}
}

func stringOrZero(value *string) string {
	if value == nil {
		return "0"
	}
	return *value
}

func intPtrToInt64(value *int) int64 {
	if value == nil {
		return 0
	}
	return int64(*value)
}

func intPtrToInt64Ptr(value *int) *int64 {
	if value == nil {
		return nil
	}
	converted := int64(*value)
	return &converted
}

func int64PtrToInt(value *int64) *int {
	if value == nil {
		return nil
	}
	converted := int(*value)
	return &converted
}
