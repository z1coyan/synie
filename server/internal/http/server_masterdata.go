package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

type listBody struct {
	Limit  *int                       `json:"limit,omitempty"`
	Offset *int                       `json:"offset,omitempty"`
	Search *string                    `json:"search,omitempty"`
	Sort   *gen.Sort                  `json:"sort,omitempty"`
	Filter map[string]json.RawMessage `json:"filter,omitempty"`
}

func listParts(body listBody) (int, int, string, *filterbuild.Sort, map[string]json.RawMessage) {
	var limit, offset int
	var search string
	if body.Limit != nil {
		limit = *body.Limit
	}
	if body.Offset != nil {
		offset = *body.Offset
	}
	if body.Search != nil {
		search = *body.Search
	}
	var sort *filterbuild.Sort
	if body.Sort != nil {
		sort = &filterbuild.Sort{Column: body.Sort.Column, Direction: string(body.Sort.Direction)}
	}
	return limit, offset, search, sort, body.Filter
}

func (s *Server) QuerySalesCustomers(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "sales.customer:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit, offset, search, sort, filter := listParts(body)
	result, err := s.customers.List(r.Context(), customer.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.Customer, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, customerDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.CustomerList{Count: result.Count, Results: items})
}

func (s *Server) GetSalesCustomer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sales.customer:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.customers.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, customerDTO(item))
}

func (s *Server) CreateSalesCustomer(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sales.customer:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.CustomerCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.customers.Create(r.Context(), actor, customer.CreateInput{
		Code: body.Code, Name: body.Name, ShortName: body.ShortName,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, customerDTO(item))
}

func (s *Server) UpdateSalesCustomer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sales.customer:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Code      *string         `json:"code,omitempty"`
		Name      *string         `json:"name,omitempty"`
		ShortName json.RawMessage `json:"shortName,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := customer.UpdateInput{Code: body.Code, Name: body.Name}
	if body.ShortName != nil {
		input.ShortName.Set = true
		if err := json.Unmarshal(body.ShortName, &input.ShortName.Value); err != nil {
			s.writeError(w, r, nullableStringError("客户", "shortName"))
			return
		}
	}
	item, err := s.customers.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, customerDTO(item))
}

func (s *Server) DeleteSalesCustomer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sales.customer:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.customers.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func customerDTO(item customer.Customer) gen.Customer {
	return gen.Customer{
		Id: item.ID, Code: item.Code, Name: item.Name, ShortName: item.ShortName,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
}

func (s *Server) QueryPurchaseSuppliers(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "purchase.supplier:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit, offset, search, sort, filter := listParts(body)
	result, err := s.suppliers.List(r.Context(), supplier.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.Supplier, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, supplierDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.SupplierList{Count: result.Count, Results: items})
}

func (s *Server) GetPurchaseSupplier(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "purchase.supplier:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.suppliers.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, supplierDTO(item))
}

func (s *Server) CreatePurchaseSupplier(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "purchase.supplier:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.SupplierCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.suppliers.Create(r.Context(), actor, supplier.CreateInput{
		Code: body.Code, Name: body.Name, ShortName: body.ShortName,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, supplierDTO(item))
}

func (s *Server) UpdatePurchaseSupplier(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "purchase.supplier:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Code      *string         `json:"code,omitempty"`
		Name      *string         `json:"name,omitempty"`
		ShortName json.RawMessage `json:"shortName,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := supplier.UpdateInput{Code: body.Code, Name: body.Name}
	if body.ShortName != nil {
		input.ShortName.Set = true
		if err := json.Unmarshal(body.ShortName, &input.ShortName.Value); err != nil {
			s.writeError(w, r, nullableStringError("供应商", "shortName"))
			return
		}
	}
	item, err := s.suppliers.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, supplierDTO(item))
}

func (s *Server) DeletePurchaseSupplier(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "purchase.supplier:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.suppliers.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func supplierDTO(item supplier.Supplier) gen.Supplier {
	return gen.Supplier{
		Id: item.ID, Code: item.Code, Name: item.Name, ShortName: item.ShortName,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
}

func (s *Server) QueryHrEmployees(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "hr.employee:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	limit, offset, search, sort, filter := listParts(body)
	result, err := s.employees.List(r.Context(), employee.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.Employee, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, employeeDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.EmployeeList{Count: result.Count, Results: items})
}

func (s *Server) GetHrEmployee(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "hr.employee:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.employees.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, employeeDTO(item))
}

func (s *Server) CreateHrEmployee(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "hr.employee:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.EmployeeCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	insurance := enumStrings(body.InsuranceTypes)
	item, err := s.employees.Create(r.Context(), actor, employee.CreateInput{
		Code: body.Code, Name: body.Name, AttendanceNo: body.AttendanceNo,
		IDNumber: body.IdNumber, HouseholdRegistration: body.HouseholdRegistration,
		Phone: body.Phone, CurrentAddress: body.CurrentAddress, DailyWage: body.DailyWage,
		MonthlyAllowance: body.MonthlyAllowance, InsuranceTypes: insurance,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, employeeDTO(item))
}

func (s *Server) UpdateHrEmployee(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.employee:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Code                  *string         `json:"code,omitempty"`
		Name                  *string         `json:"name,omitempty"`
		AttendanceNo          json.RawMessage `json:"attendanceNo,omitempty"`
		IDNumber              json.RawMessage `json:"idNumber,omitempty"`
		HouseholdRegistration json.RawMessage `json:"householdRegistration,omitempty"`
		Phone                 json.RawMessage `json:"phone,omitempty"`
		CurrentAddress        json.RawMessage `json:"currentAddress,omitempty"`
		DailyWage             json.RawMessage `json:"dailyWage,omitempty"`
		MonthlyAllowance      json.RawMessage `json:"monthlyAllowance,omitempty"`
		InsuranceTypes        json.RawMessage `json:"insuranceTypes,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := employee.UpdateInput{Code: body.Code, Name: body.Name}
	for _, field := range []struct {
		raw    json.RawMessage
		target *employee.OptionalString
	}{
		{body.AttendanceNo, &input.AttendanceNo},
		{body.IDNumber, &input.IDNumber},
		{body.HouseholdRegistration, &input.HouseholdRegistration},
		{body.Phone, &input.Phone},
		{body.CurrentAddress, &input.CurrentAddress},
		{body.DailyWage, &input.DailyWage},
		{body.MonthlyAllowance, &input.MonthlyAllowance},
	} {
		if field.raw == nil {
			continue
		}
		field.target.Set = true
		if err := json.Unmarshal(field.raw, &field.target.Value); err != nil {
			s.writeError(w, r, apierror.Validation("员工参数不合法", map[string][]string{
				"body": {"可空字段必须是字符串或 null"},
			}))
			return
		}
	}
	if body.InsuranceTypes != nil {
		var values []gen.EmployeeInsuranceType
		if string(body.InsuranceTypes) == "null" || json.Unmarshal(body.InsuranceTypes, &values) != nil {
			s.writeError(w, r, apierror.Validation("员工参数不合法", map[string][]string{
				"insuranceTypes": {"必须是参保类型数组"},
			}))
			return
		}
		converted := make([]string, len(values))
		for i, value := range values {
			converted[i] = string(value)
		}
		input.InsuranceTypes = &converted
	}
	item, err := s.employees.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, employeeDTO(item))
}

func (s *Server) DeleteHrEmployee(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "hr.employee:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.employees.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func employeeDTO(item employee.Employee) gen.Employee {
	insurance := make([]gen.EmployeeInsuranceType, len(item.InsuranceTypes))
	for i, value := range item.InsuranceTypes {
		insurance[i] = gen.EmployeeInsuranceType(value)
	}
	return gen.Employee{
		Id: item.ID, Code: item.Code, Name: item.Name, AttendanceNo: item.AttendanceNo,
		IdNumber: item.IDNumber, HouseholdRegistration: item.HouseholdRegistration,
		Phone: item.Phone, CurrentAddress: item.CurrentAddress, DailyWage: item.DailyWage,
		MonthlyAllowance: item.MonthlyAllowance, InsuranceTypes: insurance,
		InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
}

func enumStrings(values *[]gen.EmployeeInsuranceType) []string {
	if values == nil {
		return []string{}
	}
	result := make([]string, len(*values))
	for i, value := range *values {
		result[i] = string(value)
	}
	return result
}

func nullableStringError(resource, field string) error {
	return apierror.Validation(resource+"参数不合法", map[string][]string{
		field: {"必须是字符串或 null"},
	})
}
