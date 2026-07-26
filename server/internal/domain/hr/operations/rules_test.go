package operations

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestAttendanceParserAndRulesContract(t *testing.T) {
	parsed, err := parseAttendanceFile([]byte(
		"001 2026-07-01 08:01:01 0 0\n" +
			"001\t2026-07-01\t08:01:01\n" +
			"001 2026-07-01 12:00:00\n" +
			"bad\n",
	))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.TotalRows != 4 || parsed.BadRows != 1 || parsed.DupRows != 1 ||
		len(parsed.Rows) != 2 || parsed.Rows[0].AttendanceNo != "001" ||
		parsed.Rows[0].PunchedAt.Format("2006-01-02 15:04:05") != "2026-07-01 00:01:01" {
		t.Fatalf("parsed = %#v", parsed)
	}

	day, err := computeAttendanceDay([]string{
		"07:59:59", "12:00:00", "16:00:00", "19:31:00",
	})
	if err != nil {
		t.Fatal(err)
	}
	if numericString(day.NormalHours) != "4" || numericString(day.OvertimeHours) != "3.5" ||
		numericString(day.BonusWorkday) != "0.5" || day.Status != "missing" ||
		day.MorningIn == nil || *day.MorningIn != "07:59:59" {
		t.Fatalf("day = %#v", day)
	}
}

func TestEveryPublicEntryChecksPermissionBeforeDatabaseOrInput(t *testing.T) {
	service := NewService(nil, nil, nil)
	denied := &authz.Actor{UserID: uuid.New()}
	tests := []func() error{
		func() error {
			_, err := service.QueryAttendancePunches(t.Context(), denied, ListQuery{Limit: -1})
			return err
		},
		func() error { _, err := service.GetAttendanceImport(t.Context(), denied, uuid.Nil); return err },
		func() error { _, err := service.RecalcAttendanceDays(t.Context(), denied, "bad", "bad"); return err },
		func() error {
			_, err := service.CreateAttendanceCorrection(t.Context(), denied, AttendanceCorrectionInput{})
			return err
		},
		func() error { _, err := service.CreatePayroll(t.Context(), denied, PayrollInput{}); return err },
		func() error {
			_, err := service.PayRemainingPayroll(t.Context(), denied, PayrollPayRemainingInput{})
			return err
		},
		func() error {
			_, err := service.CreateEmployeeLoan(t.Context(), denied, EmployeeLoanInput{})
			return err
		},
	}
	for i, call := range tests {
		var target *apierror.Error
		if err := call(); !errors.As(err, &target) || target.Code != apierror.CodeForbidden {
			t.Fatalf("call %d error = %#v", i, err)
		}
	}
}
