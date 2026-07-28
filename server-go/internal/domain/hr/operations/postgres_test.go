package operations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type testFileReader struct {
	files map[uuid.UUID]testFileValue
}

type testFileValue struct {
	file    fileplatform.File
	content []byte
}

func (reader testFileReader) ReadStoredFile(_ context.Context, id uuid.UUID) (fileplatform.File, []byte, error) {
	value, ok := reader.files[id]
	if !ok {
		return fileplatform.File{}, nil, apierror.New(apierror.CodeNotFound, "文件不存在")
	}
	return value.file, value.content, nil
}

type barrierFileReader struct {
	testFileReader
	mu      sync.Mutex
	arrived int
	release chan struct{}
}

func (reader *barrierFileReader) ReadStoredFile(ctx context.Context, id uuid.UUID) (fileplatform.File, []byte, error) {
	value, content, err := reader.testFileReader.ReadStoredFile(ctx, id)
	if err != nil {
		return value, content, err
	}
	reader.mu.Lock()
	reader.arrived++
	if reader.arrived == 2 {
		close(reader.release)
	}
	release := reader.release
	reader.mu.Unlock()
	select {
	case <-release:
		return value, content, nil
	case <-ctx.Done():
		return fileplatform.File{}, nil, ctx.Err()
	}
}

func TestPostgresHROperationsTransactionsConcurrencyAndGlobalScope(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	userID, employeeID, fileID, secondFileID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	attendanceNo := "ATT-" + suffix
	_, err := pool.Exec(ctx, `INSERT INTO sys_user(id,username,name,hashed_password)
		VALUES($1,$2,$3,'test')`, userID, "hr-ops-"+suffix, "HR测试-"+suffix)
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO hr_employees(
			id,code,name,attendance_no,daily_wage,monthly_allowance)
			VALUES($1,$2,$3,$4,100,10)`,
			employeeID, "EMP-"+suffix, "员工-"+suffix, attendanceNo)
	}
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO sys_file(
			id,storage,key,filename,size,sha256,uploaded_by_id)
			VALUES($1,'test',$2,$3,100,$4,$6),
			      ($5,'test',$7,$8,100,$9,$6)`,
			fileID, "hr/"+suffix+".dat", suffix+".dat", "sha-"+suffix,
			secondFileID, userID, "hr/"+suffix+"-2.dat", suffix+"-2.dat", "sha2-"+suffix)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_audit_log
			WHERE actor_id=$1 OR (resource LIKE 'hr_%' AND record_label LIKE '%' || $2 || '%')`,
			userID, suffix)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_payroll_payment WHERE employee_id=$1`, employeeID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_employee_loan WHERE employee_id=$1`, employeeID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_payroll WHERE employee_id=$1`, employeeID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_attendance_correction WHERE employee_id=$1`, employeeID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_attendance_day WHERE employee_id=$1`, employeeID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_attendance_import WHERE file_id=ANY($1::uuid[])`,
			[]uuid.UUID{fileID, secondFileID})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_file WHERE id=ANY($1::uuid[])`,
			[]uuid.UUID{fileID, secondFileID})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_employees WHERE id=$1`, employeeID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_user WHERE id=$1`, userID)
	})

	content := []byte(
		attendanceNo + " 2026-07-06 08:00:00\n" +
			attendanceNo + " 2026-07-06 11:59:59\n" +
			attendanceNo + " 2026-07-06 12:00:00\n" +
			attendanceNo + " 2026-07-06 19:31:00\n",
	)
	reader := testFileReader{files: map[uuid.UUID]testFileValue{
		fileID: {
			file: fileplatform.File{
				ID: fileID, SHA256: "sha-" + suffix, Filename: suffix + ".dat",
			},
			content: content,
		},
		secondFileID: {
			file: fileplatform.File{
				ID: secondFileID, SHA256: "sha2-" + suffix, Filename: suffix + "-2.dat",
			},
			content: content,
		},
	}}
	service := NewService(pool, reader, nil)
	actor := &authz.Actor{
		UserID: userID, Username: "hr-ops-" + suffix,
		Permissions: map[string]struct{}{
			"sys.file:read":                   {},
			"hr.attendance_punch:read":        {},
			"hr.attendance_punch:import":      {},
			"hr.attendance_day:read":          {},
			"hr.attendance_day:recalc":        {},
			"hr.attendance_correction:read":   {},
			"hr.attendance_correction:create": {},
			"hr.attendance_correction:update": {},
			"hr.attendance_correction:delete": {},
			"hr.payroll:read":                 {},
			"hr.payroll:create":               {},
			"hr.payroll:update":               {},
			"hr.payroll:delete":               {},
			"hr.payroll_payment:read":         {},
			"hr.payroll_payment:create":       {},
			"hr.payroll_payment:delete":       {},
			"hr.employee_loan:read":           {},
			"hr.employee_loan:create":         {},
			"hr.employee_loan:update":         {},
			"hr.employee_loan:delete":         {},
		},
		// 故意不给公司；七资源仍须全局可见。
	}

	batch, err := service.CreateAttendanceImport(ctx, actor, AttendanceImportCreateInput{FileID: fileID})
	if err != nil || batch.Status != AttendanceImportParsed ||
		batch.MatchedRows == nil || *batch.MatchedRows != 4 {
		t.Fatalf("create import = %#v, %v", batch, err)
	}
	if _, err = service.CreateAttendanceImport(ctx, actor, AttendanceImportCreateInput{FileID: fileID}); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("duplicate file = %#v", err)
	}
	batch, err = service.ImportAttendance(ctx, actor, batch.ID, AttendanceImportExecuteInput{})
	if err != nil || batch.Status != AttendanceImportImported ||
		batch.ImportedCount == nil || *batch.ImportedCount != 4 {
		t.Fatalf("execute import = %#v, %v", batch, err)
	}
	if _, err = service.ImportAttendance(ctx, actor, batch.ID, AttendanceImportExecuteInput{}); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("double import = %#v", err)
	}

	days, err := service.QueryAttendanceDays(ctx, actor, ListQuery{
		Limit: 20, Filter: map[string]json.RawMessage{
			"employeeId": json.RawMessage(`{"kind":"fk","values":["` + employeeID.String() + `"]}`),
		},
	})
	if err != nil || days.Count != 1 || days.Results[0].NormalHours != "7.5" ||
		days.Results[0].OvertimeHours != "3.5" || days.Results[0].BonusWorkday != "0.5" {
		t.Fatalf("attendance days = %#v, %v", days, err)
	}
	correction, err := service.CreateAttendanceCorrection(ctx, actor, AttendanceCorrectionInput{
		EmployeeID: employeeID, Date: "2026-07-06",
		Times: []string{"08:00:00", "08:00:00", "11:59:59"},
	})
	if err != nil || len(correction.Times) != 2 {
		t.Fatalf("correction = %#v, %v", correction, err)
	}
	summary, err := service.AttendanceMonthSummary(ctx, actor, "2026-07")
	if err != nil || len(summary) != 1 || summary[0].Workdays != "1.4375" {
		t.Fatalf("month summary = %#v, %v", summary, err)
	}

	payroll, err := service.CreatePayroll(ctx, actor, PayrollInput{
		EmployeeID: employeeID, Month: "2026-07",
	})
	if err != nil || payroll.Payable != "0" {
		t.Fatalf("zero-default payroll = %#v, %v", payroll, err)
	}
	workdays, wage, allowance, bonus, fine, deduction := "2", "100", "10", "5", "2", "20"
	payroll, err = service.UpdatePayroll(ctx, actor, payroll.ID, PayrollUpdateInput{
		Workdays: &workdays, DailyWage: &wage, Allowance: &allowance,
		Bonus: &bonus, Fine: &fine, LoanDeduction: &deduction,
	})
	if err != nil || payroll.BaseAmount != "200" || payroll.Payable != "193" {
		t.Fatalf("updated payroll = %#v, %v", payroll, err)
	}
	loan, err := service.CreateEmployeeLoan(ctx, actor, EmployeeLoanInput{
		EmployeeID: employeeID, Kind: LoanBorrow, OccurredOn: "2026-07-01", Amount: "50",
	})
	if err != nil {
		t.Fatal(err)
	}
	normal, err := service.CreatePayrollPayment(ctx, actor, PayrollPaymentInput{
		PayrollID: payroll.ID, PaidOn: "2026-07-31", Amount: "193",
	})
	if err != nil || normal.Kind == nil || *normal.Kind != PaymentNormal {
		t.Fatalf("normal payment = %#v, %v", normal, err)
	}
	balances, err := service.EmployeeLoanBalances(ctx, actor)
	if err != nil || len(balances) != 1 || balances[0].Balance != "30" {
		t.Fatalf("balances after pay = %#v, %v", balances, err)
	}
	if _, err = service.UpdateEmployeeLoan(ctx, actor, loan.ID, EmployeeLoanUpdateInput{}); err != nil {
		t.Fatalf("manual loan no-op update: %v", err)
	}
	if _, err = service.PayRemainingPayroll(ctx, actor, PayrollPayRemainingInput{
		PayrollID: payroll.ID, PaidOn: "2026-07-31",
	}); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("no remaining = %#v", err)
	}
	supplement, err := service.CreatePayrollPayment(ctx, actor, PayrollPaymentInput{
		PayrollID: payroll.ID, PaidOn: "2026-08-01", Amount: "-5",
	})
	if err != nil || supplement.Kind == nil || *supplement.Kind != PaymentSupplement {
		t.Fatalf("supplement = %#v, %v", supplement, err)
	}
	if err = service.DeletePayrollPayment(ctx, actor, normal.ID); err != nil {
		t.Fatal(err)
	}
	payroll, err = service.GetPayroll(ctx, actor, payroll.ID)
	if err != nil || payroll.Status != PayrollPending || payroll.PaidTotal == nil || *payroll.PaidTotal != "-5" {
		t.Fatalf("pending with supplement = %#v, %v", payroll, err)
	}
	if err = service.DeletePayroll(ctx, actor, payroll.ID); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("pending payroll with supplement FK = %#v", err)
	}
	if err = service.DeletePayrollPayment(ctx, actor, supplement.ID); err != nil {
		t.Fatal(err)
	}
	if err = service.DeletePayroll(ctx, actor, payroll.ID); err != nil {
		t.Fatal(err)
	}

	// 同一工资单 FOR UPDATE 串行：并发 pay_remaining 只有一个成功。
	racePayroll, err := service.CreatePayroll(ctx, actor, PayrollInput{
		EmployeeID: employeeID, Month: "2026-08", Workdays: "1", DailyWage: "100",
	})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, payErr := service.PayRemainingPayroll(context.Background(), actor, PayrollPayRemainingInput{
				PayrollID: racePayroll.ID, PaidOn: "2026-08-31",
			})
			errs <- payErr
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	successes, conflicts := 0, 0
	for payErr := range errs {
		switch errorCode(payErr) {
		case "":
			successes++
		case apierror.CodeConflict:
			conflicts++
		default:
			t.Fatalf("concurrent pay = %#v", payErr)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent pay successes=%d conflicts=%d", successes, conflicts)
	}

	if err = service.DeleteAttendanceImport(ctx, actor, batch.ID); err != nil {
		t.Fatal(err)
	}
	if day, getErr := service.QueryAttendanceDays(ctx, actor, ListQuery{Limit: 20}); getErr != nil || day.Count != 1 {
		t.Fatalf("correction keeps derived day = %#v, %v", day, getErr)
	}
	if err = service.DeleteAttendanceCorrection(ctx, actor, correction.ID); err != nil {
		t.Fatal(err)
	}
	var remainingDays int64
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM hr_attendance_day WHERE employee_id=$1`, employeeID).Scan(&remainingDays); err != nil || remainingDays != 0 {
		t.Fatalf("remaining attendance days=%d, %v", remainingDays, err)
	}

	// 两个不同 sha 批次同时写相同 (员工,时刻)：预查都通过后由 unique 拒绝一方，
	// 失败方批次状态与全部 punch/day/audit 写入均随事务回滚。
	firstRaceBatch, err := service.CreateAttendanceImport(ctx, actor, AttendanceImportCreateInput{FileID: fileID})
	if err != nil {
		t.Fatal(err)
	}
	secondRaceBatch, err := service.CreateAttendanceImport(ctx, actor, AttendanceImportCreateInput{FileID: secondFileID})
	if err != nil {
		t.Fatal(err)
	}
	barrier := &barrierFileReader{testFileReader: reader, release: make(chan struct{})}
	raceImportService := NewService(pool, barrier, nil)
	importStart := make(chan struct{})
	importErrs := make(chan error, 2)
	for _, id := range []uuid.UUID{firstRaceBatch.ID, secondRaceBatch.ID} {
		wg.Add(1)
		go func(batchID uuid.UUID) {
			defer wg.Done()
			<-importStart
			_, importErr := raceImportService.ImportAttendance(
				context.Background(), actor, batchID, AttendanceImportExecuteInput{})
			importErrs <- importErr
		}(id)
	}
	close(importStart)
	wg.Wait()
	close(importErrs)
	importSuccesses, importConflicts := 0, 0
	for importErr := range importErrs {
		switch errorCode(importErr) {
		case "":
			importSuccesses++
		case apierror.CodeConflict:
			importConflicts++
		default:
			t.Fatalf("concurrent import = %#v", importErr)
		}
	}
	if importSuccesses != 1 || importConflicts != 1 {
		t.Fatalf("concurrent import successes=%d conflicts=%d", importSuccesses, importConflicts)
	}
	var punchCount, parsedBatches int64
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM hr_attendance_punch
		WHERE import_id=ANY($1::uuid[])`, []uuid.UUID{firstRaceBatch.ID, secondRaceBatch.ID}).
		Scan(&punchCount); err != nil || punchCount != 4 {
		t.Fatalf("race punch count=%d, %v", punchCount, err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM hr_attendance_import
		WHERE id=ANY($1::uuid[]) AND status='parsed'`,
		[]uuid.UUID{firstRaceBatch.ID, secondRaceBatch.ID}).Scan(&parsedBatches); err != nil || parsedBatches != 1 {
		t.Fatalf("rolled back parsed batches=%d, %v", parsedBatches, err)
	}

	var auditRows int64
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM sys_audit_log
		WHERE actor_id=$1 AND resource=ANY($2::text[])`,
		userID, []string{"hr_attendance_import", "hr_attendance_correction", "hr_payroll",
			"hr_payroll_payment", "hr_employee_loan"}).Scan(&auditRows); err != nil || auditRows < 15 {
		t.Fatalf("audit rows=%d, %v", auditRows, err)
	}
}

func errorCode(err error) apierror.Code {
	if err == nil {
		return ""
	}
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return "unknown"
}

func TestPostgresGenerateUniqueConflictRollsBackWholeBatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	userID, employeeA, employeeB := uuid.New(), uuid.New(), uuid.New()
	target := employeeB
	if employeeA.String() > employeeB.String() {
		target = employeeA
	}
	functionName := "hr_generate_conflict_" + suffix
	triggerName := "hr_generate_conflict_trigger_" + suffix
	_, err := pool.Exec(ctx, `INSERT INTO sys_user(id,username,hashed_password) VALUES($1,$2,'test')`,
		userID, "hr-generate-"+suffix)
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO hr_employees(id,code,name)
			VALUES($1,$2,$3),($4,$5,$6)`,
			employeeA, "GA-"+suffix, "生成A-"+suffix,
			employeeB, "GB-"+suffix, "生成B-"+suffix)
	}
	if err == nil {
		_, err = pool.Exec(ctx, `INSERT INTO hr_attendance_day(
			date,normal_hours,overtime_hours,bonus_workday,status,employee_id)
			VALUES('2099-12-01',8,0,0,'ok',$1),('2099-12-01',8,0,0,'ok',$2)`,
			employeeA, employeeB)
	}
	if err == nil {
		_, err = pool.Exec(ctx, fmt.Sprintf(`
			CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
			  IF NEW.month='2099-12'
			     AND NEW.employee_id='%s'::uuid
			     AND pg_trigger_depth()=1 THEN
			    INSERT INTO hr_payroll(month,employee_id) VALUES(NEW.month,NEW.employee_id);
			  END IF;
			  RETURN NEW;
			END $$;
			CREATE TRIGGER %s BEFORE INSERT ON hr_payroll
			FOR EACH ROW EXECUTE FUNCTION %s()`,
			functionName, target, triggerName, functionName))
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, fmt.Sprintf("DROP TRIGGER IF EXISTS %s ON hr_payroll", triggerName))
		_, _ = pool.Exec(cleanupCtx, fmt.Sprintf("DROP FUNCTION IF EXISTS %s()", functionName))
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_audit_log WHERE actor_id=$1`, userID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_payroll WHERE employee_id=ANY($1::uuid[])`,
			[]uuid.UUID{employeeA, employeeB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_attendance_day WHERE employee_id=ANY($1::uuid[])`,
			[]uuid.UUID{employeeA, employeeB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM hr_employees WHERE id=ANY($1::uuid[])`,
			[]uuid.UUID{employeeA, employeeB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM sys_user WHERE id=$1`, userID)
	})

	service := NewService(pool, nil, nil)
	actor := &authz.Actor{
		UserID: userID, Username: "hr-generate-" + suffix,
		Permissions: map[string]struct{}{"hr.payroll:create": {}},
	}
	if _, err = service.GeneratePayrolls(ctx, actor, "2099-12"); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("generate conflict = %#v", err)
	}
	var payrolls, audits int64
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM hr_payroll
		WHERE employee_id=ANY($1::uuid[])`, []uuid.UUID{employeeA, employeeB}).Scan(&payrolls); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM sys_audit_log
		WHERE actor_id=$1 AND resource='hr_payroll'`, userID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if payrolls != 0 || audits != 0 {
		t.Fatalf("generate rollback payrolls=%d audits=%d", payrolls, audits)
	}
}
