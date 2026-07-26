package sampledata

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialunit"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/companyaccountdefault"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type materialSpec struct {
	Key            string
	Name           string
	Spec           string
	Category       string
	Customer       string
	CustomerPartNo string
}

func seedPrerequisites(ctx context.Context, deps Dependencies, actor *authz.Actor, company companyInfo) (seedCtx, error) {
	unbilledAR, err := ensureAccount(ctx, deps, actor, company.ID, "1124", "未开票应收", "debit", "UNBILLED_RECEIVABLE", "1")
	if err != nil {
		return seedCtx{}, err
	}
	unbilledAP, err := ensureAccount(ctx, deps, actor, company.ID, "2204", "未开票应付", "credit", "UNBILLED_PAYABLE", "2")
	if err != nil {
		return seedCtx{}, err
	}
	accs := accounts{UnbilledAR: unbilledAR, UnbilledAP: unbilledAP}
	for code, set := range map[string]*uuid.UUID{
		"5001": &accs.Revenue, "1405": &accs.Inventory, "1002": &accs.Bank,
		"3001": &accs.Capital, "5602": &accs.Expense, "1122": &accs.Receivable,
		"2202": &accs.Payable, "2221": &accs.Tax,
	} {
		id, err := accountByCode(ctx, deps.Pool, company.ID, code)
		if err != nil {
			return seedCtx{}, err
		}
		*set = id
	}
	if err := ensureCompanyAccountDefault(ctx, deps, actor, company.ID, accs); err != nil {
		return seedCtx{}, err
	}
	rootID, _, err := warehouseBySuffix(ctx, deps.Pool, company.ID, "所有仓库")
	if err != nil {
		return seedCtx{}, err
	}
	defaultID, _, err := warehouseBySuffix(ctx, deps.Pool, company.ID, "默认仓库")
	if err != nil {
		return seedCtx{}, err
	}
	transitID, _, err := warehouseBySuffix(ctx, deps.Pool, company.ID, "在途")
	if err != nil {
		return seedCtx{}, err
	}
	finishedID, err := ensureFinishedWarehouse(ctx, deps, actor, company, rootID)
	if err != nil {
		return seedCtx{}, err
	}
	return seedCtx{
		Company:  company,
		Accounts: accs,
		Warehouses: warehouses{
			Default: defaultID, Transit: transitID, Finished: finishedID, Root: rootID,
		},
	}, nil
}

func ensureAccount(
	ctx context.Context, deps Dependencies, actor *authz.Actor,
	companyID uuid.UUID, code, name, direction, role, rootCode string,
) (uuid.UUID, error) {
	var existing uuid.UUID
	err := deps.Pool.QueryRow(ctx,
		`SELECT id FROM bas_account WHERE company_id = $1 AND code = $2`, companyID, code).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	rootID, err := accountByCode(ctx, deps.Pool, companyID, rootCode)
	if err != nil {
		return uuid.Nil, err
	}
	created, err := deps.Accounts.Create(ctx, actor, account.CreateInput{
		Code: code, Name: name, Direction: direction, Role: ptr(role),
		ParentID: &rootID, CompanyID: companyID,
	})
	if err != nil {
		return uuid.Nil, err
	}
	return created.ID, nil
}

func ensureCompanyAccountDefault(
	ctx context.Context, deps Dependencies, actor *authz.Actor, companyID uuid.UUID, accs accounts,
) error {
	_, err := deps.CompanyAccountDefaults.GetByCompany(ctx, actor, companyID)
	if err == nil {
		return nil
	}
	var appErr *apierror.Error
	if errors.As(err, &appErr) && appErr.Code != apierror.CodeNotFound {
		return err
	}
	_, err = deps.CompanyAccountDefaults.Create(ctx, actor, companyaccountdefault.CreateInput{
		CompanyID:               companyID,
		DeliveryDebitAccountID:  &accs.UnbilledAR,
		DeliveryCreditAccountID: &accs.Revenue,
		ReceiptDebitAccountID:   &accs.Inventory,
		ReceiptCreditAccountID:  &accs.UnbilledAP,
	})
	return err
}

func ensureFinishedWarehouse(
	ctx context.Context, deps Dependencies, actor *authz.Actor, company companyInfo, rootID uuid.UUID,
) (uuid.UUID, error) {
	name := fmt.Sprintf("%s - 成品仓", company.Code)
	var existing uuid.UUID
	err := deps.Pool.QueryRow(ctx,
		`SELECT id FROM inv_warehouse WHERE company_id = $1 AND name = $2`, company.ID, name).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	created, err := deps.Warehouses.Create(ctx, actor, warehouse.CreateInput{
		Name: name, IsLeaf: ptr(true), CompanyID: company.ID, ParentID: &rootID,
	})
	if err != nil {
		return uuid.Nil, err
	}
	return created.ID, nil
}

func seedMaster(ctx context.Context, deps Dependencies, actor *authz.Actor, company companyInfo) (masterData, error) {
	customers := map[string]customer.Customer{}
	for _, row := range []struct{ code, name, short string }{
		{"C01", "宁波海纳电气有限公司", "海纳电气"},
		{"C02", "温州联成机电有限公司", "联成机电"},
		{"C03", "杭州远景新能源有限公司", "远景新能源"},
		{"C04", "上海昊阳自动化设备有限公司", "昊阳自动化"},
		{"C05", "苏州凯迪电子科技有限公司", "凯迪电子"},
		{"C06", "广州南控电气有限公司", "南控电气"},
	} {
		created, err := deps.Customers.Create(ctx, actor, customer.CreateInput{
			Code: row.code, Name: row.name, ShortName: ptr(row.short),
		})
		if err != nil {
			return masterData{}, err
		}
		customers[row.code] = created
	}

	suppliers := map[string]supplier.Supplier{}
	for _, row := range []struct{ code, name, short string }{
		{"S01", "铜陵精铜材料有限公司", "精铜材料"},
		{"S02", "义乌宏达标准件厂", "宏达标准件"},
		{"S03", "上海申绝缘科技有限公司", "申绝缘"},
		{"S04", "无锡恒力钣金有限公司", "恒力钣金"},
		{"S05", "余姚创新塑业有限公司", "创新塑业"},
		{"S06", "温州顺达包装有限公司", "顺达包装"},
	} {
		created, err := deps.Suppliers.Create(ctx, actor, supplier.CreateInput{
			Code: row.code, Name: row.name, ShortName: ptr(row.short),
		})
		if err != nil {
			return masterData{}, err
		}
		suppliers[row.code] = created
	}

	pcs, err := unitBySymbol(ctx, deps.Pool, "pcs")
	if err != nil {
		return masterData{}, err
	}
	materials := map[string]materialRef{}
	for _, spec := range materialSpecs() {
		catID, err := leafCategory(ctx, deps.Pool, spec.Category)
		if err != nil {
			return masterData{}, err
		}
		input := material.CreateInput{
			Name: spec.Name, Spec: ptr(spec.Spec), CategoryID: catID, DefaultUnitID: pcs,
		}
		if spec.Customer != "" {
			c := customers[spec.Customer]
			input.IsCustomerMaterial = ptr(true)
			input.CustomerID = &c.ID
			input.CustomerPartNo = ptr(spec.CustomerPartNo)
		}
		created, err := deps.Materials.Create(ctx, actor, input)
		if err != nil {
			return masterData{}, err
		}
		materials[spec.Key] = materialRef{ID: created.ID, DefaultUnitID: created.DefaultUnitID}
	}

	pack, err := unitBySymbol(ctx, deps.Pool, "包")
	if err != nil {
		return masterData{}, err
	}
	if _, err := deps.MaterialUnits.Create(ctx, actor, materialunit.CreateInput{
		MaterialID: materials["carton"].ID, UnitID: pack, Factor: "0.05",
	}); err != nil {
		return masterData{}, err
	}

	employees := map[string]employee.Employee{}
	for _, row := range []struct {
		name, phone, wage, allowance string
	}{
		{"张伟强", "13857610001", "260", "300"},
		{"李秀英", "13857610002", "220", "300"},
		{"王建军", "13857610003", "240", "500"},
		{"陈晓梅", "13857610004", "200", "200"},
	} {
		created, err := deps.Employees.Create(ctx, actor, employee.CreateInput{
			Name: row.name, Phone: ptr(row.phone),
			DailyWage: ptr(row.wage), MonthlyAllowance: ptr(row.allowance),
		})
		if err != nil {
			return masterData{}, err
		}
		employees[row.name] = created
	}

	return masterData{
		Company: company, Customers: customers, Suppliers: suppliers,
		Materials: materials, Employees: employees,
	}, nil
}

func materialSpecs() []materialSpec {
	return []materialSpec{
		{Key: "box_shell", Name: "配电箱壳体", Spec: "HN-BX-100 定制", Category: "F(P)", Customer: "C01", CustomerPartNo: "HN-BX-100"},
		{Key: "busbar", Name: "汇流铜排组件", Spec: "HN-BB-08 8 路", Category: "F(P)", Customer: "C01", CustomerPartNo: "HN-BB-08"},
		{Key: "mount_plate", Name: "断路器安装板", Spec: "LC-MB-63", Category: "F(P)", Customer: "C02", CustomerPartNo: "LC-MB-63"},
		{Key: "terminal_assy", Name: "端子排组件", Spec: "YJ-TB-12", Category: "F(P)", Customer: "C03", CustomerPartNo: "YJ-TB-12"},
		{Key: "terminal_block", Name: "接线端子座", Spec: "UK-2.5B 灰", Category: "F(G)"},
		{Key: "copper_terminal", Name: "铜接线端子", Spec: "OT-6", Category: "F(G)"},
		{Key: "rail", Name: "导轨", Spec: "C45 35×7.5×1000", Category: "F(G)"},
		{Key: "copper_bar", Name: "紫铜排", Spec: "T2 3×30×1000", Category: "F(S)"},
		{Key: "copper_rod", Name: "紫铜棒", Spec: "T2 φ20", Category: "F(S)"},
		{Key: "steel_sheet", Name: "冷轧钢板", Spec: "DC01 1.5×1250×2500", Category: "F(S)"},
		{Key: "stamped_part", Name: "冲压安装支架", Spec: "ST-40", Category: "F(S)"},
		{Key: "abs_pellet", Name: "ABS 粒料", Spec: "PA-757 白", Category: "F(S)"},
		{Key: "scrap_copper", Name: "废铜边角料", Spec: "混合", Category: "F(S)"},
		{Key: "screw", Name: "十字盘头螺丝", Spec: "M4×12 镀锌", Category: "M(C)"},
		{Key: "insul_sleeve", Name: "绝缘护套", Spec: "φ6 黑 100m/卷", Category: "M(C)"},
		{Key: "stretch_film", Name: "缠绕膜", Spec: "50cm×300m", Category: "M(C)"},
		{Key: "carton", Name: "五层纸箱", Spec: "40×30×30", Category: "P(C)"},
	}
}

