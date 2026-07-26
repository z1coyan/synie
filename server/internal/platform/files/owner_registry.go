package files

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type ownerSpec struct {
	table            string
	permissionPrefix string
	companyScoped    bool
}

var ownerRegistry = map[string]ownerSpec{
	"sal_customer":         {table: "sal_customers", permissionPrefix: "sales.customer"},
	"sal_order_item":       {table: "sal_order_item", permissionPrefix: "sales.order", companyScoped: true},
	"sal_delivery_item":    {table: "sal_delivery_item", permissionPrefix: "sales.delivery", companyScoped: true},
	"pur_supplier":         {table: "pur_supplier", permissionPrefix: "purchase.supplier"},
	"pur_order_item":       {table: "pur_order_item", permissionPrefix: "purchase.order", companyScoped: true},
	"pur_receipt_item":     {table: "pur_receipt_item", permissionPrefix: "purchase.receipt", companyScoped: true},
	"hr_employee":          {table: "hr_employees", permissionPrefix: "hr.employee"},
	"inv_material":         {table: "inv_material", permissionPrefix: "inv.material"},
	"acc_gl_journal":       {table: "acc_gl_journal", permissionPrefix: "acc.gl_journal", companyScoped: true},
	"acc_bank_account":     {table: "acc_bank_account", permissionPrefix: "acc.bank_account", companyScoped: true},
	"acc_bank_transaction": {table: "acc_bank_transaction", permissionPrefix: "acc.bank_transaction", companyScoped: true},
	"acc_vat_invoice":      {table: "acc_vat_invoice", permissionPrefix: "acc.vat_invoice", companyScoped: true},
	"acc_bill":             {table: "acc_bill", permissionPrefix: "acc.bill"},
	"acc_bill_transaction": {table: "acc_bill_transaction", permissionPrefix: "acc.bill_transaction", companyScoped: true},
	"sys_print_template":   {table: "sys_print_template", permissionPrefix: "sys.print_template"},
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func resolveOwner(ctx context.Context, q rowQuerier, actor *authz.Actor, ownerType string, ownerID uuid.UUID) (*uuid.UUID, error) {
	spec, ok := ownerRegistry[ownerType]
	if !ok {
		return nil, apierror.Validation("未知的宿主类型", map[string][]string{"ownerType": {"不在允许的附件宿主白名单"}})
	}
	if !actor.HasPermission(spec.permissionPrefix + ":read") {
		return nil, apierror.New(apierror.CodeForbidden, "无权访问该宿主记录")
	}
	if !spec.companyScoped {
		var exists bool
		if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM "+spec.table+" WHERE id = $1)", ownerID).Scan(&exists); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "校验附件宿主失败", err)
		}
		if !exists {
			return nil, apierror.New(apierror.CodeForbidden, "无权访问该宿主记录")
		}
		return nil, nil
	}
	var companyID uuid.UUID
	err := q.QueryRow(ctx, "SELECT company_id FROM "+spec.table+" WHERE id = $1", ownerID).Scan(&companyID)
	if errors.Is(err, pgx.ErrNoRows) || !actor.CanAccessCompany(companyID) {
		return nil, apierror.New(apierror.CodeForbidden, "无权访问该宿主记录")
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "校验附件宿主失败", err)
	}
	return &companyID, nil
}
