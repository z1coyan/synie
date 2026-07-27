package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func customerListQuery(body listBody) customer.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return customer.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QuerySalesCustomers(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "sales.customer:read", customerListQuery, ignoreActor(s.Customers.List),
		func(result customer.ListResult) any {
			return gen.CustomerList{Count: result.Count, Results: mapItems(result.Results, customerDTO)}
		})
}

func (s *Server) GetSalesCustomer(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sales.customer:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Customers.Get(r.Context(), id)
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
	item, err := s.Customers.Create(r.Context(), actor, customer.CreateInput{
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
	item, err := s.Customers.Update(r.Context(), actor, id, input)
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
	if err := s.Customers.Delete(r.Context(), actor, id); err != nil {
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

func supplierListQuery(body listBody) supplier.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return supplier.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryPurchaseSuppliers(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "purchase.supplier:read", supplierListQuery, ignoreActor(s.Suppliers.List),
		func(result supplier.ListResult) any {
			return gen.SupplierList{Count: result.Count, Results: mapItems(result.Results, supplierDTO)}
		})
}

func (s *Server) GetPurchaseSupplier(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "purchase.supplier:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Suppliers.Get(r.Context(), id)
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
	item, err := s.Suppliers.Create(r.Context(), actor, supplier.CreateInput{
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
	item, err := s.Suppliers.Update(r.Context(), actor, id, input)
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
	if err := s.Suppliers.Delete(r.Context(), actor, id); err != nil {
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

func employeeListQuery(body listBody) employee.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return employee.ListQuery{Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter}
}

func (s *Server) QueryHrEmployees(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "hr.employee:read", employeeListQuery, ignoreActor(s.Employees.List),
		func(result employee.ListResult) any {
			return gen.EmployeeList{Count: result.Count, Results: mapItems(result.Results, employeeDTO)}
		})
}

func (s *Server) GetHrEmployee(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "hr.employee:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.Employees.Get(r.Context(), id)
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
	item, err := s.Employees.Create(r.Context(), actor, employee.CreateInput{
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
	item, err := s.Employees.Update(r.Context(), actor, id, input)
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
	if err := s.Employees.Delete(r.Context(), actor, id); err != nil {
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
