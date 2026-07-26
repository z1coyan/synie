package documents

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

const invoiceColumns = `id,doc_no,direction,invoice_date,posting_date,party_type,
	party_id,invoice_kind,invoice_code,invoice_no,seller_name,seller_tax_no,
	seller_address_phone,seller_bank_account,buyer_name,buyer_tax_no,
	buyer_address_phone,buyer_bank_account,array_to_json(items)::text,net_total,
	tax_total,gross_total,issuer,reviewer,payee,remarks,red_invoice_no,status,
	audited_at,inserted_at,updated_at,company_id,party_account_id,amount_account_id,
	tax_account_id,mirror_invoice_id,created_by_id,audited_by_id,
	sal_reconciliation_id,pur_reconciliation_id`

func (s *Service) QueryVatInvoices(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (VatInvoiceList, error) {
	if err := requirePermission(actor, "acc.vat_invoice:read"); err != nil {
		return VatInvoiceList{}, err
	}
	if err := validateList(&query); err != nil {
		return VatInvoiceList{}, err
	}
	built, err := filterbuild.Build(VatInvoiceResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return VatInvoiceList{}, err
	}
	built.Where, built.Args = companyScope(actor, built.Where, built.Args, "company_id")
	var result VatInvoiceList
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM acc_vat_invoice`+
		built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计增值税发票失败", err)
	}
	sql, args := appendPagination(`SELECT `+invoiceColumns+` FROM acc_vat_invoice`+
		built.Where+built.OrderBy, built.Args, query)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询增值税发票失败", err)
	}
	defer rows.Close()
	result.Results = make([]VatInvoice, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanVatInvoice(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取增值税发票失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	return result, rows.Err()
}

func (s *Service) GetVatInvoice(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (VatInvoice, error) {
	if err := requirePermission(actor, "acc.vat_invoice:read"); err != nil {
		return VatInvoice{}, err
	}
	where, args := companyScope(actor, " WHERE id=$1", []any{id}, "company_id")
	item, err := scanVatInvoice(s.pool.QueryRow(ctx,
		`SELECT `+invoiceColumns+` FROM acc_vat_invoice`+where, args...))
	if err != nil {
		return VatInvoice{}, notFound("增值税发票", err)
	}
	return item, nil
}

func (s *Service) CreateVatInvoice(
	ctx context.Context, actor *authz.Actor, input VatInvoiceInput,
) (VatInvoice, error) {
	if err := requirePermission(actor, "acc.vat_invoice:create"); err != nil {
		return VatInvoice{}, err
	}
	if err := requireCompany(actor, input.CompanyID, "增值税发票"); err != nil {
		return VatInvoice{}, err
	}
	normalized, err := normalizeVatInvoiceInput(input)
	if err != nil {
		return VatInvoice{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VatInvoice{}, apierror.Wrap(apierror.CodeInternal, "创建增值税发票失败", err)
	}
	defer tx.Rollback(ctx)
	if err = validateInvoiceReferences(ctx, tx, normalized, uuid.Nil, false); err != nil {
		return VatInvoice{}, err
	}
	docNo := ""
	if normalized.DocNo != nil {
		docNo = strings.TrimSpace(*normalized.DocNo)
	}
	if docNo == "" {
		docNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "acc.vat_invoice",
			Values:   map[string]any{"company_id": normalized.CompanyID, "posting_date": time.Now().UTC()},
		})
		if err != nil {
			return VatInvoice{}, err
		}
	}
	normalized.DocNo = &docNo
	id := uuid.New()
	invoiceDate, err := dateArg(normalized.InvoiceDate, "invoiceDate")
	if err != nil {
		return VatInvoice{}, err
	}
	if _, err = invoiceItemsArray(normalized.Items); err != nil {
		return VatInvoice{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO acc_vat_invoice(
		id,doc_no,direction,invoice_date,party_type,party_id,invoice_kind,invoice_code,
		invoice_no,seller_name,seller_tax_no,seller_address_phone,seller_bank_account,
		buyer_name,buyer_tax_no,buyer_address_phone,buyer_bank_account,items,net_total,
		tax_total,gross_total,issuer,reviewer,payee,remarks,company_id,party_account_id,
		amount_account_id,tax_account_id,mirror_invoice_id,created_by_id,
		sal_reconciliation_id,pur_reconciliation_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
		ARRAY(SELECT jsonb_array_elements($18::jsonb)),$19,$20,$21,$22,$23,$24,
		$25,$26,$27,$28,$29,$30,$31,$32,$33)`,
		id, docNo, lower(normalized.Direction), invoiceDate, lower(normalized.PartyType),
		normalized.PartyID, lower(normalized.InvoiceKind), normalized.InvoiceCode,
		normalized.InvoiceNo, normalized.SellerName, normalized.SellerTaxNo,
		normalized.SellerAddressPhone, normalized.SellerBankAccount, normalized.BuyerName,
		normalized.BuyerTaxNo, normalized.BuyerAddressPhone, normalized.BuyerBankAccount,
		normalized.Items, normalized.NetTotal, normalized.TaxTotal, normalized.GrossTotal,
		normalized.Issuer, normalized.Reviewer, normalized.Payee, normalized.Remarks,
		normalized.CompanyID, normalized.PartyAccountID, normalized.AmountAccountID,
		normalized.TaxAccountID, normalized.MirrorInvoiceID, actorID(actor),
		normalized.SalesReconciliationID, normalized.PurchaseReconciliationID)
	if err != nil {
		return VatInvoice{}, databaseWriteError("创建增值税发票失败", err)
	}
	result, err := queryVatInvoice(ctx, tx, id, false)
	if err != nil {
		return VatInvoice{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_vat_invoice", id, docNo,
		"create", "create", &result.CompanyID, createdChanges(invoiceSnapshot(result))); err != nil {
		return VatInvoice{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return VatInvoice{}, databaseWriteError("创建增值税发票失败", err)
	}
	return result, nil
}

func (s *Service) UpdateVatInvoice(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input VatInvoiceUpdateInput,
) (VatInvoice, error) {
	if err := requirePermission(actor, "acc.vat_invoice:update"); err != nil {
		return VatInvoice{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VatInvoice{}, apierror.Wrap(apierror.CodeInternal, "更新增值税发票失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockVatInvoice(ctx, tx, id, actor)
	if err != nil {
		return VatInvoice{}, err
	}
	if before.Status != StatusDraft {
		return VatInvoice{}, apierror.New(apierror.CodeConflict, "仅草稿发票可修改或删除")
	}
	merged := overlayVatInvoice(before, input)
	normalized, err := normalizeVatInvoiceInput(merged)
	if err != nil {
		return VatInvoice{}, err
	}
	if err = validateInvoiceReferences(ctx, tx, normalized, id, false); err != nil {
		return VatInvoice{}, err
	}
	invoiceDate, err := dateArg(normalized.InvoiceDate, "invoiceDate")
	if err != nil {
		return VatInvoice{}, err
	}
	if _, err = invoiceItemsArray(normalized.Items); err != nil {
		return VatInvoice{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE acc_vat_invoice SET doc_no=$2,direction=$3,
		invoice_date=$4,party_type=$5,party_id=$6,invoice_kind=$7,invoice_code=$8,
		invoice_no=$9,seller_name=$10,seller_tax_no=$11,seller_address_phone=$12,
		seller_bank_account=$13,buyer_name=$14,buyer_tax_no=$15,
		buyer_address_phone=$16,buyer_bank_account=$17,
		items=ARRAY(SELECT jsonb_array_elements($18::jsonb)),
		net_total=$19,tax_total=$20,gross_total=$21,issuer=$22,reviewer=$23,payee=$24,
		remarks=$25,party_account_id=$26,amount_account_id=$27,tax_account_id=$28,
		mirror_invoice_id=$29,sal_reconciliation_id=$30,pur_reconciliation_id=$31,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, normalized.DocNo, lower(normalized.Direction), invoiceDate,
		lower(normalized.PartyType), normalized.PartyID, lower(normalized.InvoiceKind),
		normalized.InvoiceCode, normalized.InvoiceNo, normalized.SellerName,
		normalized.SellerTaxNo, normalized.SellerAddressPhone, normalized.SellerBankAccount,
		normalized.BuyerName, normalized.BuyerTaxNo, normalized.BuyerAddressPhone,
		normalized.BuyerBankAccount, normalized.Items, normalized.NetTotal, normalized.TaxTotal,
		normalized.GrossTotal, normalized.Issuer, normalized.Reviewer, normalized.Payee,
		normalized.Remarks, normalized.PartyAccountID, normalized.AmountAccountID,
		normalized.TaxAccountID, normalized.MirrorInvoiceID,
		normalized.SalesReconciliationID, normalized.PurchaseReconciliationID)
	if err != nil {
		return VatInvoice{}, databaseWriteError("更新增值税发票失败", err)
	}
	result, err := queryVatInvoice(ctx, tx, id, false)
	if err != nil {
		return VatInvoice{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_vat_invoice", id, invoiceLabel(result),
		"update", "update", &result.CompanyID,
		changedValues(invoiceSnapshot(before), invoiceSnapshot(result))); err != nil {
		return VatInvoice{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return VatInvoice{}, databaseWriteError("更新增值税发票失败", err)
	}
	return result, nil
}

func (s *Service) DeleteVatInvoice(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := requirePermission(actor, "acc.vat_invoice:delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除增值税发票失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockVatInvoice(ctx, tx, id, actor)
	if err != nil {
		return err
	}
	if before.Status != StatusDraft {
		return apierror.New(apierror.CodeConflict, "仅草稿发票可修改或删除")
	}
	if _, err = tx.Exec(ctx, `DELETE FROM acc_vat_invoice WHERE id=$1`, id); err != nil {
		return databaseWriteError("删除增值税发票失败", err)
	}
	if err = writeAudit(ctx, tx, actor, "acc_vat_invoice", id, invoiceLabel(before),
		"delete", "delete", &before.CompanyID, changedValues(invoiceSnapshot(before), map[string]any{})); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return databaseWriteError("删除增值税发票失败", err)
	}
	return nil
}

func (s *Service) AuditVatInvoice(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, postingDate string,
) (VatInvoice, error) {
	if err := requirePermission(actor, "acc.vat_invoice:audit"); err != nil {
		return VatInvoice{}, err
	}
	posting, err := parseDate(postingDate, "postingDate")
	if err != nil {
		return VatInvoice{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VatInvoice{}, apierror.Wrap(apierror.CodeInternal, "审核增值税发票失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockVatInvoice(ctx, tx, id, actor)
	if err != nil {
		return VatInvoice{}, err
	}
	if before.Status != StatusDraft {
		return VatInvoice{}, apierror.New(apierror.CodeConflict, "仅草稿发票可审核")
	}
	input := vatInvoiceToInput(before)
	if err = validateInvoiceReferences(ctx, tx, input, id, true); err != nil {
		return VatInvoice{}, err
	}
	entries, err := invoiceGLEntries(before)
	if err != nil {
		return VatInvoice{}, err
	}
	reconEntries, side, reconciliationID, err := reconciliationGLEntries(ctx, tx, before)
	if err != nil {
		return VatInvoice{}, err
	}
	entries = append(entries, reconEntries...)
	now := time.Now().UTC()
	tag, err := tx.Exec(ctx, `UPDATE acc_vat_invoice SET status='audited',
		posting_date=$2,audited_at=$3,audited_by_id=$4,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1 AND status='draft'`,
		id, posting, now, actorID(actor))
	if err != nil {
		return VatInvoice{}, databaseWriteError("审核增值税发票失败", err)
	}
	if tag.RowsAffected() != 1 {
		return VatInvoice{}, apierror.New(apierror.CodeConflict, "发票已被并发处理")
	}
	if err = s.ledger.Post(ctx, tx, gl.Voucher{
		Type: "acc.vat_invoice", ID: id, No: invoiceLabel(before),
		CompanyID: before.CompanyID, PostingDate: posting,
	}, entries); err != nil {
		return VatInvoice{}, err
	}
	if reconciliationID != nil {
		if _, err = s.reconciliations.CloseFromInvoice(
			ctx, tx, actor, side, *reconciliationID,
		); err != nil {
			return VatInvoice{}, err
		}
	}
	result, err := queryVatInvoice(ctx, tx, id, false)
	if err != nil {
		return VatInvoice{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_vat_invoice", id, invoiceLabel(result),
		"update", "audit", &result.CompanyID,
		changedValues(invoiceSnapshot(before), invoiceSnapshot(result))); err != nil {
		return VatInvoice{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return VatInvoice{}, databaseWriteError("审核增值税发票失败", err)
	}
	return result, nil
}

func (s *Service) VoidVatInvoice(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (VatInvoice, error) {
	return s.endVatInvoice(ctx, actor, id, false, ReverseVatInvoiceInput{})
}

func (s *Service) ReverseVatInvoice(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input ReverseVatInvoiceInput,
) (VatInvoice, error) {
	return s.endVatInvoice(ctx, actor, id, true, input)
}

func (s *Service) endVatInvoice(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, reverse bool,
	input ReverseVatInvoiceInput,
) (VatInvoice, error) {
	action := "void"
	if reverse {
		action = "reverse"
	}
	if err := requirePermission(actor, "acc.vat_invoice:"+action); err != nil {
		return VatInvoice{}, err
	}
	var posting time.Time
	var err error
	if reverse {
		posting, err = parseDate(input.PostingDate, "postingDate")
		if err != nil {
			return VatInvoice{}, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VatInvoice{}, apierror.Wrap(apierror.CodeInternal, "处理增值税发票失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockVatInvoice(ctx, tx, id, actor)
	if err != nil {
		return VatInvoice{}, err
	}
	if before.Status != StatusAudited {
		return VatInvoice{}, apierror.New(apierror.CodeConflict, "仅已审核发票可作废或红冲")
	}
	var referenced bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM acc_expense_report_item i
		JOIN acc_expense_report r ON r.id=i.report_id
		WHERE i.invoice_id=$1 AND r.status<>'voided')`, id).Scan(&referenced); err != nil {
		return VatInvoice{}, apierror.Wrap(apierror.CodeInternal, "检查发票报销引用失败", err)
	}
	if referenced {
		return VatInvoice{}, apierror.New(apierror.CodeConflict,
			"发票已被报销单引用,请先在报销单上移除该行或作废报销单")
	}
	nextStatus := "voided"
	if reverse {
		nextStatus = "reversed"
		if err = s.ledger.Reverse(ctx, tx,
			gl.VoucherRef{Type: "acc.vat_invoice", ID: id}, posting); err != nil {
			return VatInvoice{}, err
		}
	} else if err = s.ledger.Cancel(ctx, tx,
		gl.VoucherRef{Type: "acc.vat_invoice", ID: id}); err != nil {
		return VatInvoice{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE acc_vat_invoice SET status=$2,
		red_invoice_no=$3,sal_reconciliation_id=NULL,pur_reconciliation_id=NULL,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, nextStatus, func() *string {
			if reverse {
				return input.RedInvoiceNo
			}
			return before.RedInvoiceNo
		}())
	if err != nil {
		return VatInvoice{}, databaseWriteError("处理增值税发票失败", err)
	}
	if before.SalesReconciliationID != nil {
		if _, err = s.reconciliations.ReopenFromInvoice(ctx, tx, actor,
			reconciliation.SideSales, *before.SalesReconciliationID); err != nil {
			return VatInvoice{}, err
		}
	}
	if before.PurchaseReconciliationID != nil {
		if _, err = s.reconciliations.ReopenFromInvoice(ctx, tx, actor,
			reconciliation.SidePurchase, *before.PurchaseReconciliationID); err != nil {
			return VatInvoice{}, err
		}
	}
	result, err := queryVatInvoice(ctx, tx, id, false)
	if err != nil {
		return VatInvoice{}, err
	}
	if err = writeAudit(ctx, tx, actor, "acc_vat_invoice", id, invoiceLabel(result),
		"update", action, &result.CompanyID,
		changedValues(invoiceSnapshot(before), invoiceSnapshot(result))); err != nil {
		return VatInvoice{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return VatInvoice{}, databaseWriteError("处理增值税发票失败", err)
	}
	return result, nil
}

func (s *Service) OCRVatInvoice(
	ctx context.Context, actor *authz.Actor, input OCRInput,
) (OCRPrefill, error) {
	if err := requirePermission(actor, "acc.vat_invoice:create"); err != nil {
		return nil, err
	}
	if s.files == nil || s.ocr == nil {
		return nil, apierror.New(apierror.CodeInternal, "OCR 服务未配置")
	}
	if err := s.requireAccessibleFile(ctx, actor, input.FileID); err != nil {
		return nil, err
	}
	file, content, err := s.files.ReadStoredFile(ctx, input.FileID)
	if err != nil {
		return nil, err
	}
	result, err := s.ocr.Recognize(ctx, OCRVatInvoice, file, content)
	if err != nil {
		return nil, err
	}
	return OCRPrefill(result), nil
}

func (s *Service) requireAccessibleFile(
	ctx context.Context, actor *authz.Actor, fileID uuid.UUID,
) error {
	if actor == nil {
		return apierror.New(apierror.CodeNotFound, "文件不存在")
	}
	if actor.SuperAdmin || actor.AllCompanies {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sys_file WHERE id=$1)`,
			fileID).Scan(&exists); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "检查文件失败", err)
		}
		if exists {
			return nil
		}
		return apierror.New(apierror.CodeNotFound, "文件不存在")
	}
	var accessible bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM sys_file f WHERE f.id=$1 AND (
			f.uploaded_by_id=$2 OR EXISTS(
				SELECT 1 FROM sys_attachment a WHERE a.file_id=f.id
				AND a.company_id=ANY($3::uuid[])
			)
		))`, fileID, actor.UserID, actor.CompanyIDs).Scan(&accessible)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查文件权限失败", err)
	}
	if !accessible {
		return apierror.New(apierror.CodeNotFound, "文件不存在")
	}
	return nil
}

func normalizeVatInvoiceInput(input VatInvoiceInput) (VatInvoiceInput, error) {
	input.Direction, input.PartyType, input.InvoiceKind = upper(input.Direction), upper(input.PartyType), upper(input.InvoiceKind)
	input.InvoiceCode = strings.TrimSpace(input.InvoiceCode)
	if input.Items == "" {
		input.Items = "[]"
	}
	fields := map[string][]string{}
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if input.Direction != DirectionInbound && input.Direction != DirectionOutbound {
		fields["direction"] = []string{"不合法"}
	}
	if input.PartyID == uuid.Nil {
		fields["partyId"] = []string{"必填"}
	}
	if input.PartyType != PartySupplier && input.PartyType != PartyCustomer &&
		input.PartyType != PartyCompany && input.PartyType != PartyEmployee {
		fields["partyType"] = []string{"不合法"}
	}
	if input.PartyType == PartyCompany && input.PartyID == input.CompanyID {
		fields["partyId"] = []string{"对手不能是本公司"}
	}
	if input.PartyType == PartyEmployee && input.Direction != DirectionInbound {
		fields["direction"] = []string{"员工对手的发票必须为开入方向"}
	}
	validKinds := map[string]bool{
		InvoiceSpecial: true, InvoiceNormal: true, InvoiceElectronicSpecial: true,
		InvoiceElectronicNormal: true, InvoiceDigitalSpecial: true, InvoiceDigitalNormal: true,
	}
	if !validKinds[input.InvoiceKind] {
		fields["invoiceKind"] = []string{"不合法"}
	}
	switch {
	case input.PartyType == PartyEmployee:
		if input.SalesReconciliationID != nil || input.PurchaseReconciliationID != nil {
			fields["reconciliation"] = []string{"费用报销发票不关联对账单"}
		}
	case input.Direction == DirectionOutbound:
		if input.SalesReconciliationID == nil || input.PurchaseReconciliationID != nil {
			fields["salReconciliationId"] = []string{"开出发票必须且仅关联销售对账单"}
		}
	case input.Direction == DirectionInbound:
		if input.PurchaseReconciliationID == nil || input.SalesReconciliationID != nil {
			fields["purReconciliationId"] = []string{"开入发票必须且仅关联采购对账单"}
		}
	}
	if _, err := invoiceItemsArray(input.Items); err != nil {
		fields["items"] = []string{"必须是 JSON 数组字符串"}
	}
	if len(fields) > 0 {
		return input, apierror.Validation("增值税发票参数不合法", fields)
	}
	return input, nil
}

func invoiceItemsArray(value string) ([]string, error) {
	var items []json.RawMessage
	if err := json.Unmarshal([]byte(value), &items); err != nil {
		return nil, err
	}
	result := make([]string, len(items))
	for index := range items {
		result[index] = string(items[index])
	}
	return result, nil
}

func validateInvoiceReferences(
	ctx context.Context, tx pgx.Tx, input VatInvoiceInput, ownID uuid.UUID, auditMode bool,
) error {
	var partyExists bool
	err := tx.QueryRow(ctx, `SELECT CASE $1::text
		WHEN 'supplier' THEN EXISTS(SELECT 1 FROM pur_supplier WHERE id=$2)
		WHEN 'customer' THEN EXISTS(SELECT 1 FROM sal_customers WHERE id=$2)
		WHEN 'company' THEN EXISTS(SELECT 1 FROM bas_company WHERE id=$2)
		WHEN 'employee' THEN EXISTS(SELECT 1 FROM hr_employees WHERE id=$2)
		ELSE false END`, lower(input.PartyType), input.PartyID).Scan(&partyExists)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验发票对手失败", err)
	}
	if !partyExists {
		return apierror.Validation("增值税发票参数不合法",
			map[string][]string{"partyId": {"对手不存在"}})
	}
	if input.MirrorInvoiceID != nil {
		var exists bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM acc_vat_invoice
			WHERE id=$1 AND id<>$2)`, input.MirrorInvoiceID, ownID).Scan(&exists)
		if err != nil || !exists {
			return apierror.Validation("增值税发票参数不合法",
				map[string][]string{"mirrorInvoiceId": {"对向发票不存在"}})
		}
	}
	if !auditMode {
		return validateReconciliationLinkExists(ctx, tx, input)
	}
	if input.InvoiceDate == nil || input.InvoiceNo == nil ||
		strings.TrimSpace(*input.InvoiceNo) == "" {
		return apierror.Validation("发票审核条件不完整",
			map[string][]string{"invoice": {"开票日期与发票号码必填"}})
	}
	net, err := parseOptionalDecimal(input.NetTotal, "netTotal", false, true)
	if err != nil || net == nil {
		return apierror.Validation("发票审核条件不完整",
			map[string][]string{"netTotal": {"必填且不能为负数"}})
	}
	tax, err := parseOptionalDecimal(input.TaxTotal, "taxTotal", false, true)
	if err != nil || tax == nil {
		return apierror.Validation("发票审核条件不完整",
			map[string][]string{"taxTotal": {"必填且不能为负数"}})
	}
	gross, err := parseOptionalDecimal(input.GrossTotal, "grossTotal", true, false)
	if err != nil || gross == nil || !net.Add(*tax).Equal(*gross) {
		return apierror.Validation("发票审核条件不完整",
			map[string][]string{"grossTotal": {"必须大于零且不含税金额+税额=价税合计"}})
	}
	if input.PartyAccountID == nil || input.AmountAccountID == nil {
		return apierror.Validation("发票审核条件不完整",
			map[string][]string{"accounts": {"往来科目与金额科目必填"}})
	}
	if tax.IsPositive() && input.TaxAccountID == nil {
		return apierror.Validation("发票审核条件不完整",
			map[string][]string{"taxAccountId": {"有税额时必填"}})
	}
	return nil
}

func validateReconciliationLinkExists(
	ctx context.Context, tx pgx.Tx, input VatInvoiceInput,
) error {
	if input.SalesReconciliationID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sal_reconciliation
			WHERE id=$1)`, input.SalesReconciliationID).Scan(&exists); err != nil || !exists {
			return apierror.Validation("增值税发票参数不合法",
				map[string][]string{"salReconciliationId": {"关联销售对账单不存在"}})
		}
	}
	if input.PurchaseReconciliationID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pur_reconciliation
			WHERE id=$1)`, input.PurchaseReconciliationID).Scan(&exists); err != nil || !exists {
			return apierror.Validation("增值税发票参数不合法",
				map[string][]string{"purReconciliationId": {"关联采购对账单不存在"}})
		}
	}
	return nil
}

func invoiceGLEntries(invoice VatInvoice) ([]gl.Entry, error) {
	net, _ := decimal.NewFromString(*invoice.NetTotal)
	tax, _ := decimal.NewFromString(*invoice.TaxTotal)
	gross, _ := decimal.NewFromString(*invoice.GrossTotal)
	partyType := lower(invoice.PartyType)
	entries := make([]gl.Entry, 0, 3)
	if invoice.Direction == DirectionOutbound {
		entries = append(entries, gl.Entry{
			AccountID: *invoice.PartyAccountID, Debit: gross, Credit: decimal.Zero,
			PartyType: &partyType, PartyID: &invoice.PartyID,
		}, gl.Entry{
			AccountID: *invoice.AmountAccountID, Debit: decimal.Zero, Credit: net,
		})
		if tax.IsPositive() {
			entries = append(entries, gl.Entry{
				AccountID: *invoice.TaxAccountID, Debit: decimal.Zero, Credit: tax,
			})
		}
	} else {
		entries = append(entries, gl.Entry{
			AccountID: *invoice.AmountAccountID, Debit: net, Credit: decimal.Zero,
		})
		if tax.IsPositive() {
			entries = append(entries, gl.Entry{
				AccountID: *invoice.TaxAccountID, Debit: tax, Credit: decimal.Zero,
			})
		}
		entries = append(entries, gl.Entry{
			AccountID: *invoice.PartyAccountID, Debit: decimal.Zero, Credit: gross,
			PartyType: &partyType, PartyID: &invoice.PartyID,
		})
	}
	return entries, nil
}

func reconciliationGLEntries(
	ctx context.Context, tx pgx.Tx, invoice VatInvoice,
) ([]gl.Entry, reconciliation.Side, *uuid.UUID, error) {
	id, side, table := invoice.SalesReconciliationID, reconciliation.SideSales, "sal_reconciliation"
	if id == nil {
		id, side, table = invoice.PurchaseReconciliationID, reconciliation.SidePurchase, "pur_reconciliation"
	}
	if id == nil {
		return nil, side, nil, nil
	}
	var kind, status, partyType string
	var companyID, partyID, debitID, creditID uuid.UUID
	var gross pgtype.Numeric
	itemTable := "sal_reconciliation_item"
	if side == reconciliation.SidePurchase {
		itemTable = "pur_reconciliation_item"
	}
	err := tx.QueryRow(ctx, `SELECT h.reconciliation_type,h.status,h.company_id,h.party_type,
		h.party_id,(SELECT COALESCE(sum(i.base_amount),0) FROM `+itemTable+
		` i WHERE i.reconciliation_id=h.id),h.debit_account_id,h.credit_account_id
		FROM `+table+` h WHERE h.id=$1 FOR UPDATE`, *id).
		Scan(&kind, &status, &companyID, &partyType,
			&partyID, &gross, &debitID, &creditID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, side, id, apierror.New(apierror.CodeConflict, "关联对账单不存在")
	}
	if err != nil {
		return nil, side, id, apierror.Wrap(apierror.CodeInternal, "锁定关联对账单失败", err)
	}
	invoiceGross, _ := decimal.NewFromString(*invoice.GrossTotal)
	if kind != "regular" || status != "confirmed" || companyID != invoice.CompanyID ||
		upper(partyType) != invoice.PartyType || partyID != invoice.PartyID ||
		!invoiceGross.Equal(decimal.NewFromBigInt(gross.Int, gross.Exp)) {
		return nil, side, id, apierror.New(apierror.CodeConflict,
			"关联对账单必须为同公司、同对手、同金额的已确认常规单")
	}
	column := "sal_reconciliation_id"
	if side == reconciliation.SidePurchase {
		column = "pur_reconciliation_id"
	}
	var occupied bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM acc_vat_invoice
		WHERE `+column+`=$1 AND id<>$2 AND status IN ('audited','voided','reversed'))`,
		*id, invoice.ID).Scan(&occupied); err != nil {
		return nil, side, id, apierror.Wrap(apierror.CodeInternal, "检查对账单发票占用失败", err)
	}
	if occupied {
		return nil, side, id, apierror.New(apierror.CodeConflict, "关联对账单已被其他发票使用")
	}
	value := decimal.NewFromBigInt(gross.Int, gross.Exp)
	partyDB := lower(invoice.PartyType)
	if side == reconciliation.SideSales {
		return []gl.Entry{
			{AccountID: debitID, Debit: value, Credit: decimal.Zero},
			{AccountID: creditID, Debit: decimal.Zero, Credit: value,
				PartyType: &partyDB, PartyID: &invoice.PartyID},
		}, side, id, nil
	}
	return []gl.Entry{
		{AccountID: debitID, Debit: value, Credit: decimal.Zero,
			PartyType: &partyDB, PartyID: &invoice.PartyID},
		{AccountID: creditID, Debit: decimal.Zero, Credit: value},
	}, side, id, nil
}

func queryVatInvoice(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, lock bool,
) (VatInvoice, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	item, err := scanVatInvoice(tx.QueryRow(ctx,
		`SELECT `+invoiceColumns+` FROM acc_vat_invoice WHERE id=$1`+suffix, id))
	if err != nil {
		return VatInvoice{}, notFound("增值税发票", err)
	}
	return item, nil
}

func lockVatInvoice(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, actor *authz.Actor,
) (VatInvoice, error) {
	item, err := queryVatInvoice(ctx, tx, id, true)
	if err != nil {
		return VatInvoice{}, err
	}
	if err = requireCompany(actor, item.CompanyID, "增值税发票"); err != nil {
		return VatInvoice{}, err
	}
	return item, nil
}

type scanner interface{ Scan(...any) error }

func scanVatInvoice(row scanner) (VatInvoice, error) {
	var item VatInvoice
	var docNo, invoiceNo, sellerName, sellerTaxNo, sellerAddressPhone,
		sellerBankAccount, buyerName, buyerTaxNo, buyerAddressPhone,
		buyerBankAccount, issuer, reviewer, payee, remarks, redInvoiceNo pgtype.Text
	var invoiceDate, postingDate pgtype.Date
	var net, tax, gross pgtype.Numeric
	var auditedAt pgtype.Timestamp
	err := row.Scan(&item.ID, &docNo, &item.Direction, &invoiceDate, &postingDate,
		&item.PartyType, &item.PartyID, &item.InvoiceKind, &item.InvoiceCode, &invoiceNo,
		&sellerName, &sellerTaxNo, &sellerAddressPhone, &sellerBankAccount, &buyerName,
		&buyerTaxNo, &buyerAddressPhone, &buyerBankAccount, &item.Items, &net, &tax,
		&gross, &issuer, &reviewer, &payee, &remarks, &redInvoiceNo, &item.Status,
		&auditedAt, &item.InsertedAt, &item.UpdatedAt, &item.CompanyID,
		&item.PartyAccountID, &item.AmountAccountID, &item.TaxAccountID,
		&item.MirrorInvoiceID, &item.CreatedByID, &item.AuditedByID,
		&item.SalesReconciliationID, &item.PurchaseReconciliationID)
	if err != nil {
		return item, err
	}
	item.DocNo, item.InvoiceNo = pgText(docNo), pgText(invoiceNo)
	item.SellerName, item.SellerTaxNo = pgText(sellerName), pgText(sellerTaxNo)
	item.SellerAddressPhone, item.SellerBankAccount = pgText(sellerAddressPhone), pgText(sellerBankAccount)
	item.BuyerName, item.BuyerTaxNo = pgText(buyerName), pgText(buyerTaxNo)
	item.BuyerAddressPhone, item.BuyerBankAccount = pgText(buyerAddressPhone), pgText(buyerBankAccount)
	item.Issuer, item.Reviewer, item.Payee = pgText(issuer), pgText(reviewer), pgText(payee)
	item.Remarks, item.RedInvoiceNo = pgText(remarks), pgText(redInvoiceNo)
	item.InvoiceDate, item.PostingDate = datePointer(invoiceDate), datePointer(postingDate)
	item.NetTotal, item.TaxTotal, item.GrossTotal = decimalPointer(net), decimalPointer(tax), decimalPointer(gross)
	if auditedAt.Valid {
		value := auditedAt.Time.UTC()
		item.AuditedAt = &value
	}
	item.Direction, item.PartyType = upper(item.Direction), upper(item.PartyType)
	item.InvoiceKind, item.Status = upper(item.InvoiceKind), upper(item.Status)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, nil
}

func pgText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func invoiceLabel(invoice VatInvoice) string {
	if invoice.DocNo != nil && *invoice.DocNo != "" {
		return *invoice.DocNo
	}
	if invoice.InvoiceNo != nil {
		return *invoice.InvoiceNo
	}
	return invoice.ID.String()
}

func vatInvoiceToInput(value VatInvoice) VatInvoiceInput {
	return VatInvoiceInput{
		CompanyID: value.CompanyID, DocNo: value.DocNo, Direction: value.Direction,
		InvoiceDate: value.InvoiceDate, PartyType: value.PartyType, PartyID: value.PartyID,
		InvoiceKind: value.InvoiceKind, InvoiceCode: value.InvoiceCode, InvoiceNo: value.InvoiceNo,
		SellerName: value.SellerName, SellerTaxNo: value.SellerTaxNo,
		SellerAddressPhone: value.SellerAddressPhone, SellerBankAccount: value.SellerBankAccount,
		BuyerName: value.BuyerName, BuyerTaxNo: value.BuyerTaxNo,
		BuyerAddressPhone: value.BuyerAddressPhone, BuyerBankAccount: value.BuyerBankAccount,
		Items: value.Items, NetTotal: value.NetTotal, TaxTotal: value.TaxTotal,
		GrossTotal: value.GrossTotal, Issuer: value.Issuer, Reviewer: value.Reviewer,
		Payee: value.Payee, Remarks: value.Remarks, PartyAccountID: value.PartyAccountID,
		AmountAccountID: value.AmountAccountID, TaxAccountID: value.TaxAccountID,
		MirrorInvoiceID:          value.MirrorInvoiceID,
		SalesReconciliationID:    value.SalesReconciliationID,
		PurchaseReconciliationID: value.PurchaseReconciliationID,
	}
}

func overlayVatInvoice(before VatInvoice, update VatInvoiceUpdateInput) VatInvoiceInput {
	result := vatInvoiceToInput(before)
	applyOptionalString(&result.DocNo, update.DocNo)
	if update.Direction != nil {
		result.Direction = *update.Direction
	}
	applyOptionalString(&result.InvoiceDate, update.InvoiceDate)
	if update.PartyType != nil {
		result.PartyType = *update.PartyType
	}
	if update.PartyID != nil {
		result.PartyID = *update.PartyID
	}
	if update.InvoiceKind != nil {
		result.InvoiceKind = *update.InvoiceKind
	}
	if update.InvoiceCode != nil {
		result.InvoiceCode = *update.InvoiceCode
	}
	applyOptionalString(&result.InvoiceNo, update.InvoiceNo)
	applyOptionalString(&result.SellerName, update.SellerName)
	applyOptionalString(&result.SellerTaxNo, update.SellerTaxNo)
	applyOptionalString(&result.SellerAddressPhone, update.SellerAddressPhone)
	applyOptionalString(&result.SellerBankAccount, update.SellerBankAccount)
	applyOptionalString(&result.BuyerName, update.BuyerName)
	applyOptionalString(&result.BuyerTaxNo, update.BuyerTaxNo)
	applyOptionalString(&result.BuyerAddressPhone, update.BuyerAddressPhone)
	applyOptionalString(&result.BuyerBankAccount, update.BuyerBankAccount)
	if update.Items != nil {
		result.Items = *update.Items
	}
	applyOptionalString(&result.NetTotal, update.NetTotal)
	applyOptionalString(&result.TaxTotal, update.TaxTotal)
	applyOptionalString(&result.GrossTotal, update.GrossTotal)
	applyOptionalString(&result.Issuer, update.Issuer)
	applyOptionalString(&result.Reviewer, update.Reviewer)
	applyOptionalString(&result.Payee, update.Payee)
	applyOptionalString(&result.Remarks, update.Remarks)
	applyOptionalUUID(&result.PartyAccountID, update.PartyAccountID)
	applyOptionalUUID(&result.AmountAccountID, update.AmountAccountID)
	applyOptionalUUID(&result.TaxAccountID, update.TaxAccountID)
	applyOptionalUUID(&result.MirrorInvoiceID, update.MirrorInvoiceID)
	applyOptionalUUID(&result.SalesReconciliationID, update.SalesReconciliationID)
	applyOptionalUUID(&result.PurchaseReconciliationID, update.PurchaseReconciliationID)
	return result
}

func applyOptionalString(target **string, value OptionalString) {
	if value.Set {
		*target = value.Value
	}
}

func applyOptionalUUID(target **uuid.UUID, value OptionalUUID) {
	if value.Set {
		*target = value.Value
	}
}

func invoiceSnapshot(value VatInvoice) map[string]any {
	return map[string]any{
		"doc_no": value.DocNo, "direction": value.Direction,
		"invoice_date": value.InvoiceDate, "posting_date": value.PostingDate,
		"party_type": value.PartyType, "party_id": value.PartyID,
		"invoice_kind": value.InvoiceKind, "invoice_code": value.InvoiceCode,
		"invoice_no": value.InvoiceNo, "items": value.Items,
		"net_total": value.NetTotal, "tax_total": value.TaxTotal,
		"gross_total": value.GrossTotal, "remarks": value.Remarks,
		"status": value.Status, "company_id": value.CompanyID,
		"party_account_id": value.PartyAccountID, "amount_account_id": value.AmountAccountID,
		"tax_account_id":        value.TaxAccountID,
		"sal_reconciliation_id": value.SalesReconciliationID,
		"pur_reconciliation_id": value.PurchaseReconciliationID,
	}
}
