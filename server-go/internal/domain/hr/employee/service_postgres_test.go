package employee

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/platform/optional"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type fixedNumberer struct {
	value string
	calls int
}

func (numberer *fixedNumberer) Next(_ context.Context, input numbering.NextInput) (string, error) {
	if input.Resource != "hr.employee" {
		return "", errors.New("unexpected numbering resource")
	}
	numberer.calls++
	return numberer.value, nil
}

func TestPostgresEmployeeLifecycleEmptyOptionalsFiltersAndSensitiveAudit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	numberer := &fixedNumberer{value: "EMP-" + suffix}
	service := NewService(pool, numberer)
	actor := &authz.Actor{UserID: uuid.New(), Username: "employee-pg-test", SuperAdmin: true}
	var employeeIDs []uuid.UUID
	var payrollID uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if payrollID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM hr_payroll WHERE id=$1", payrollID)
		}
		for _, id := range employeeIDs {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE resource='hr_employee' AND record_id=$1", id)
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM hr_employees WHERE id=$1", id)
		}
	})

	blank := " \t "
	secretOne := "SECRET-ONE-" + suffix
	dailyWage := "128.50"
	allowance := "20"
	first, err := service.Create(ctx, actor, CreateInput{
		Name:                  "员工数据库测试一-" + suffix,
		AttendanceNo:          &blank,
		IDNumber:              &secretOne,
		HouseholdRegistration: &blank,
		Phone:                 &blank,
		CurrentAddress:        &blank,
		DailyWage:             &dailyWage,
		MonthlyAllowance:      &allowance,
		InsuranceTypes:        []string{"SOCIAL_INJURY", "HOUSING_FUND", "SOCIAL_INJURY"},
	})
	if err != nil {
		t.Fatal(err)
	}
	employeeIDs = append(employeeIDs, first.ID)
	if first.Code != numberer.value || numberer.calls != 1 || first.AttendanceNo != nil ||
		first.HouseholdRegistration != nil || first.Phone != nil || first.CurrentAddress != nil {
		t.Fatalf("created first = %#v; numberer calls=%d", first, numberer.calls)
	}
	var attendance, household, phone, address *string
	var storedInsurance []string
	if err := pool.QueryRow(ctx, `
		SELECT attendance_no,household_registration,phone,current_address,insurance_types
		FROM hr_employees WHERE id=$1
	`, first.ID).Scan(&attendance, &household, &phone, &address, &storedInsurance); err != nil {
		t.Fatal(err)
	}
	if attendance != nil || household != nil || phone != nil || address != nil ||
		strings.Join(storedInsurance, ",") != "social_injury,housing_fund,social_injury" {
		t.Fatalf("stored nulls/insurance = %#v %#v %#v %#v %#v", attendance, household, phone, address, storedInsurance)
	}

	secondCode := "EMP2-" + suffix
	second, err := service.Create(ctx, actor, CreateInput{
		Code: &secondCode, Name: "员工数据库测试二-" + suffix,
		AttendanceNo: &blank, IDNumber: &blank,
	})
	if err != nil {
		t.Fatalf("second employee with empty unique optionals: %v", err)
	}
	employeeIDs = append(employeeIDs, second.ID)
	if second.AttendanceNo != nil || second.IDNumber != nil {
		t.Fatalf("second optional unique fields = %#v", second)
	}

	hasAny, err := service.List(ctx, ListQuery{Limit: 10, Filter: map[string]json.RawMessage{
		"code":           json.RawMessage(`{"kind":"text","op":"contains","value":"` + suffix + `"}`),
		"insuranceTypes": json.RawMessage(`{"kind":"enumArray","op":"hasAny","values":["SOCIAL_INJURY"]}`),
	}})
	if err != nil || hasAny.Count != 1 || len(hasAny.Results) != 1 || hasAny.Results[0].ID != first.ID {
		t.Fatalf("hasAny = %#v, %v", hasAny, err)
	}
	notHas, err := service.List(ctx, ListQuery{Limit: 10, Filter: map[string]json.RawMessage{
		"code":           json.RawMessage(`{"kind":"text","op":"contains","value":"` + suffix + `"}`),
		"insuranceTypes": json.RawMessage(`{"kind":"enumArray","op":"notHas","values":["SOCIAL_INJURY"]}`),
	}})
	if err != nil || notHas.Count != 1 || len(notHas.Results) != 1 || notHas.Results[0].ID != second.ID {
		t.Fatalf("notHas = %#v, %v", notHas, err)
	}

	attendanceValue := "ATT-" + suffix
	idValue := "ID-BEFORE-CLEAR-" + suffix
	if _, err := service.Update(ctx, actor, second.ID, UpdateInput{
		AttendanceNo: optional.Optional[string]{Set: true, Value: &attendanceValue},
		IDNumber:     optional.Optional[string]{Set: true, Value: &idValue},
	}); err != nil {
		t.Fatal(err)
	}
	cleared, err := service.Update(ctx, actor, second.ID, UpdateInput{
		AttendanceNo: optional.Optional[string]{Set: true, Value: &blank},
		IDNumber:     optional.Optional[string]{Set: true, Value: &blank},
	})
	if err != nil || cleared.AttendanceNo != nil || cleared.IDNumber != nil {
		t.Fatalf("blank patch must clear to NULL: %#v, %v", cleared, err)
	}
	var storedAttendance, storedIDNumber *string
	if err := pool.QueryRow(ctx, `
		SELECT attendance_no,id_number FROM hr_employees WHERE id=$1
	`, second.ID).Scan(&storedAttendance, &storedIDNumber); err != nil {
		t.Fatal(err)
	}
	if storedAttendance != nil || storedIDNumber != nil {
		t.Fatalf("blank patch stored values = %#v %#v", storedAttendance, storedIDNumber)
	}

	secretTwo := "SECRET-TWO-" + suffix
	newAllowance := "33.75"
	updated, err := service.Update(ctx, actor, first.ID, UpdateInput{
		IDNumber:         optional.Optional[string]{Set: true, Value: &secretTwo},
		MonthlyAllowance: optional.Optional[string]{Set: true, Value: &newAllowance},
	})
	if err != nil || updated.IDNumber == nil || *updated.IDNumber != secretTwo ||
		updated.MonthlyAllowance == nil || *updated.MonthlyAllowance != newAllowance {
		t.Fatalf("updated first = %#v, %v", updated, err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO hr_payroll (month,employee_id) VALUES ($1,$2) RETURNING id
	`, "PG-"+suffix, first.ID).Scan(&payrollID); err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, actor, first.ID); apierrorCode(err) != apierror.CodeConflict {
		t.Fatalf("referenced delete error = %#v", err)
	}
	if _, err := service.Get(ctx, first.ID); err != nil {
		t.Fatalf("employee must remain after referenced delete: %v", err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM hr_payroll WHERE id=$1", payrollID); err != nil {
		t.Fatal(err)
	}
	payrollID = uuid.Nil
	if err := service.Delete(ctx, actor, first.ID); err != nil {
		t.Fatal(err)
	}

	var sensitiveAuditRows int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE resource='hr_employee' AND record_id=$1 AND changes ? 'id_number'
	`, first.ID).Scan(&sensitiveAuditRows); err != nil {
		t.Fatal(err)
	}
	if sensitiveAuditRows != 3 {
		t.Fatalf("sensitive audit row count = %d", sensitiveAuditRows)
	}
	var leaked int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE resource='hr_employee' AND record_id=$1
		  AND (changes::text LIKE '%' || $2 || '%' OR changes::text LIKE '%' || $3 || '%')
	`, first.ID, secretOne, secretTwo).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatalf("sensitive audit leaked %d rows", leaked)
	}
	var unfiltered int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE resource='hr_employee' AND record_id=$1
		  AND changes ? 'id_number' AND changes::text NOT LIKE '%[FILTERED]%'
	`, first.ID).Scan(&unfiltered); err != nil {
		t.Fatal(err)
	}
	if unfiltered != 0 {
		t.Fatalf("unfiltered sensitive audit rows = %d", unfiltered)
	}
}

func apierrorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
