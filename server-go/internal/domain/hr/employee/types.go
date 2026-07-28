package employee

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/optional"
)

type Employee struct {
	ID                    uuid.UUID `json:"id"`
	Code                  string    `json:"code"`
	Name                  string    `json:"name"`
	AttendanceNo          *string   `json:"attendanceNo"`
	IDNumber              *string   `json:"idNumber"`
	HouseholdRegistration *string   `json:"householdRegistration"`
	Phone                 *string   `json:"phone"`
	CurrentAddress        *string   `json:"currentAddress"`
	DailyWage             *string   `json:"dailyWage"`
	MonthlyAllowance      *string   `json:"monthlyAllowance"`
	InsuranceTypes        []string  `json:"insuranceTypes"`
	InsertedAt            time.Time `json:"insertedAt"`
	UpdatedAt             time.Time `json:"updatedAt"`
}

type CreateInput struct {
	Code                  *string
	Name                  string
	AttendanceNo          *string
	IDNumber              *string
	HouseholdRegistration *string
	Phone                 *string
	CurrentAddress        *string
	DailyWage             *string
	MonthlyAllowance      *string
	InsuranceTypes        []string
}

type UpdateInput struct {
	Code                  *string
	Name                  *string
	AttendanceNo          optional.Optional[string]
	IDNumber              optional.Optional[string]
	HouseholdRegistration optional.Optional[string]
	Phone                 optional.Optional[string]
	CurrentAddress        optional.Optional[string]
	DailyWage             optional.Optional[string]
	MonthlyAllowance      optional.Optional[string]
	InsuranceTypes        *[]string
}

type ListQuery struct {
	Limit  int
	Offset int
	Search string
	Sort   *filterbuild.Sort
	Filter map[string]json.RawMessage
}

type ListResult struct {
	Count   int64      `json:"count"`
	Results []Employee `json:"results"`
}
