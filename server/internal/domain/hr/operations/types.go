package operations

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

const (
	AttendanceImportParsed   = "PARSED"
	AttendanceImportFailed   = "FAILED"
	AttendanceImportImported = "IMPORTED"
	AttendanceDayOK          = "OK"
	AttendanceDayMissing     = "MISSING"
	PayrollPending           = "PENDING"
	PayrollPaid              = "PAID"
	PaymentNormal            = "NORMAL"
	PaymentSupplement        = "SUPPLEMENT"
	LoanBorrow               = "BORROW"
	LoanRepay                = "REPAY"
)

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type AttendancePunch struct {
	ID           uuid.UUID `json:"id"`
	AttendanceNo string    `json:"attendanceNo"`
	PunchedAt    time.Time `json:"punchedAt"`
	InsertedAt   time.Time `json:"insertedAt"`
	EmployeeID   uuid.UUID `json:"employeeId"`
	ImportID     uuid.UUID `json:"importId"`
}

type AttendancePunchList struct {
	Count   int64             `json:"count"`
	Results []AttendancePunch `json:"results"`
}

type AttendanceImport struct {
	ID                   uuid.UUID  `json:"id"`
	Status               string     `json:"status"`
	Error                *string    `json:"error"`
	TotalRows            *int64     `json:"totalRows"`
	BadRows              *int64     `json:"badRows"`
	DupRows              *int64     `json:"dupRows"`
	MatchedRows          *int64     `json:"matchedRows"`
	UnmatchedRows        *int64     `json:"unmatchedRows"`
	UnmatchedDetail      *string    `json:"unmatchedDetail"`
	ImportedCount        *int64     `json:"importedCount"`
	SkippedExistingRows  *int64     `json:"skippedExistingRows"`
	SkippedUnmatchedRows *int64     `json:"skippedUnmatchedRows"`
	AutoCreatedCount     *int64     `json:"autoCreatedCount"`
	ImportedAt           *time.Time `json:"importedAt"`
	InsertedAt           time.Time  `json:"insertedAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
	FileID               uuid.UUID  `json:"fileId"`
	CreatedByID          *uuid.UUID `json:"createdById"`
	ImportedByID         *uuid.UUID `json:"importedById"`
	PunchCount           int64      `json:"punchCount"`
}

type AttendanceImportList struct {
	Count   int64              `json:"count"`
	Results []AttendanceImport `json:"results"`
}

type AttendanceImportCreateInput struct{ FileID uuid.UUID }
type AttendanceImportExecuteInput struct{ AutoCreateEmployees bool }

type AttendanceDay struct {
	ID            uuid.UUID `json:"id"`
	Date          string    `json:"date"`
	MorningIn     *string   `json:"morningIn"`
	MorningOut    *string   `json:"morningOut"`
	AfternoonIn   *string   `json:"afternoonIn"`
	AfternoonOut  *string   `json:"afternoonOut"`
	NormalHours   string    `json:"normalHours"`
	OvertimeHours string    `json:"overtimeHours"`
	BonusWorkday  string    `json:"bonusWorkday"`
	Status        string    `json:"status"`
	InsertedAt    time.Time `json:"insertedAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	EmployeeID    uuid.UUID `json:"employeeId"`
}

type AttendanceDayList struct {
	Count   int64           `json:"count"`
	Results []AttendanceDay `json:"results"`
}

type AttendanceMonthSummary struct {
	EmployeeID    uuid.UUID `json:"employeeId"`
	EmployeeCode  string    `json:"employeeCode"`
	EmployeeName  string    `json:"employeeName"`
	Days          int64     `json:"days"`
	MissingDays   int64     `json:"missingDays"`
	NormalHours   string    `json:"normalHours"`
	OvertimeHours string    `json:"overtimeHours"`
	BonusWorkdays string    `json:"bonusWorkdays"`
	Workdays      string    `json:"workdays"`
}

type AttendanceCorrection struct {
	ID          uuid.UUID  `json:"id"`
	Date        string     `json:"date"`
	Times       []string   `json:"times"`
	Note        *string    `json:"note"`
	InsertedAt  time.Time  `json:"insertedAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	EmployeeID  uuid.UUID  `json:"employeeId"`
	CreatedByID *uuid.UUID `json:"createdById"`
}

type AttendanceCorrectionList struct {
	Count   int64                  `json:"count"`
	Results []AttendanceCorrection `json:"results"`
}

type AttendanceCorrectionInput struct {
	EmployeeID uuid.UUID
	Date       string
	Times      []string
	Note       *string
}

type AttendanceCorrectionUpdateInput struct {
	EmployeeID *uuid.UUID
	Date       *string
	Times      *[]string
	Note       optional.Optional[string]
}

type Payroll struct {
	ID             uuid.UUID `json:"id"`
	Month          string    `json:"month"`
	Workdays       string    `json:"workdays"`
	AttendanceDays int64     `json:"attendanceDays"`
	MissingDays    int64     `json:"missingDays"`
	OvertimeHours  string    `json:"overtimeHours"`
	DailyWage      string    `json:"dailyWage"`
	BaseAmount     string    `json:"baseAmount"`
	Allowance      string    `json:"allowance"`
	Bonus          string    `json:"bonus"`
	Fine           string    `json:"fine"`
	LoanDeduction  string    `json:"loanDeduction"`
	Payable        string    `json:"payable"`
	Status         string    `json:"status"`
	Remarks        *string   `json:"remarks"`
	InsertedAt     time.Time `json:"insertedAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	EmployeeID     uuid.UUID `json:"employeeId"`
	PaidTotal      *string   `json:"paidTotal"`
}

type PayrollList struct {
	Count   int64     `json:"count"`
	Results []Payroll `json:"results"`
}

type PayrollInput struct {
	EmployeeID     uuid.UUID
	Month          string
	Workdays       string
	AttendanceDays int64
	MissingDays    int64
	OvertimeHours  string
	DailyWage      string
	Allowance      string
	Bonus          string
	Fine           string
	LoanDeduction  string
	Remarks        *string
}

type PayrollUpdateInput struct {
	Workdays       *string
	AttendanceDays *int64
	MissingDays    *int64
	OvertimeHours  *string
	DailyWage      *string
	Allowance      *string
	Bonus          *string
	Fine           *string
	LoanDeduction  *string
	Remarks        optional.Optional[string]
}

type PayrollGenerateResult struct {
	Created int64 `json:"created"`
	Skipped int64 `json:"skipped"`
}

type PayrollMonthStats struct {
	Count        int64  `json:"count"`
	PendingCount int64  `json:"pendingCount"`
	PayableTotal string `json:"payableTotal"`
	PaidTotal    string `json:"paidTotal"`
}

type PayrollPayment struct {
	ID          uuid.UUID  `json:"id"`
	Month       *string    `json:"month"`
	PaidOn      string     `json:"paidOn"`
	Amount      string     `json:"amount"`
	Kind        *string    `json:"kind"`
	Remarks     *string    `json:"remarks"`
	InsertedAt  time.Time  `json:"insertedAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	PayrollID   uuid.UUID  `json:"payrollId"`
	EmployeeID  *uuid.UUID `json:"employeeId"`
	CreatedByID *uuid.UUID `json:"createdById"`
}

type PayrollPaymentList struct {
	Count   int64            `json:"count"`
	Results []PayrollPayment `json:"results"`
}

type PayrollPaymentInput struct {
	PayrollID uuid.UUID
	PaidOn    string
	Amount    string
	Remarks   *string
}

type PayrollPayRemainingInput struct {
	PayrollID uuid.UUID
	PaidOn    string
	Remarks   *string
}

type EmployeeLoan struct {
	ID          uuid.UUID  `json:"id"`
	Kind        string     `json:"kind"`
	OccurredOn  string     `json:"occurredOn"`
	Amount      string     `json:"amount"`
	Remarks     *string    `json:"remarks"`
	InsertedAt  time.Time  `json:"insertedAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	EmployeeID  uuid.UUID  `json:"employeeId"`
	PayrollID   *uuid.UUID `json:"payrollId"`
	CreatedByID *uuid.UUID `json:"createdById"`
}

type EmployeeLoanList struct {
	Count   int64          `json:"count"`
	Results []EmployeeLoan `json:"results"`
}

type EmployeeLoanInput struct {
	EmployeeID uuid.UUID
	Kind       string
	OccurredOn string
	Amount     string
	Remarks    *string
}

type EmployeeLoanUpdateInput struct {
	EmployeeID *uuid.UUID
	Kind       *string
	OccurredOn *string
	Amount     *string
	Remarks    optional.Optional[string]
}

type EmployeeLoanBalance struct {
	EmployeeID   uuid.UUID `json:"employeeId"`
	EmployeeCode string    `json:"employeeCode"`
	EmployeeName string    `json:"employeeName"`
	Borrowed     string    `json:"borrowed"`
	Repaid       string    `json:"repaid"`
	Balance      string    `json:"balance"`
}
