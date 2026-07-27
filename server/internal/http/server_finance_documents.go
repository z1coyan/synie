package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/finance/documents"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func documentOptionalString(
	fields map[string]json.RawMessage,
	key string,
	value *string,
) documents.OptionalString {
	_, set := fields[key]
	return documents.OptionalString{Set: set, Value: value}
}

func documentOptionalUUID(
	fields map[string]json.RawMessage,
	key string,
	value *uuid.UUID,
) documents.OptionalUUID {
	_, set := fields[key]
	return documents.OptionalUUID{Set: set, Value: value}
}

func documentOptionalDate(
	fields map[string]json.RawMessage,
	key string,
	value *openapi_types.Date,
) documents.OptionalString {
	return documentOptionalString(fields, key, financeDate(value))
}

func (s *Server) QueryFinanceVatInvoices(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.vat_invoice:read", financeDocumentsList,
		func(ctx context.Context, actor *authz.Actor, query documents.ListQuery) (map[string]any, error) {
			result, err := s.FinanceDocuments.QueryVatInvoices(ctx, actor, query)
			if err != nil {
				return nil, err
			}
			items := make([]map[string]any, 0, len(result.Results))
			for _, item := range result.Results {
				converted, convertErr := financeInvoiceResponse(item)
				if convertErr != nil {
					return nil, apierror.Wrap(apierror.CodeInternal, "转换增值税发票响应失败", convertErr)
				}
				items = append(items, converted)
			}
			return map[string]any{"count": result.Count, "results": items}, nil
		}, passthroughListResponse)
}

func (s *Server) GetFinanceVatInvoice(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.GetVatInvoice(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	converted, err := financeInvoiceResponse(item)
	if err != nil {
		s.writeError(w, r, apierror.Wrap(apierror.CodeInternal, "转换增值税发票响应失败", err))
		return
	}
	s.writeJSON(w, http.StatusOK, converted)
}

func (s *Server) CreateFinanceVatInvoice(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.VatInvoiceCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	items, err := financeItemsJSON(body.Items)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	invoiceCode := ""
	if body.InvoiceCode != nil {
		invoiceCode = *body.InvoiceCode
	}
	item, err := s.FinanceDocuments.CreateVatInvoice(r.Context(), actor, documents.VatInvoiceInput{
		CompanyID: body.CompanyId, DocNo: body.DocNo,
		Direction: string(body.Direction), InvoiceDate: financeDate(body.InvoiceDate),
		PartyType: string(body.PartyType), PartyID: body.PartyId,
		InvoiceKind: string(body.InvoiceKind), InvoiceCode: invoiceCode,
		InvoiceNo: body.InvoiceNo, SellerName: body.SellerName,
		SellerTaxNo: body.SellerTaxNo, SellerAddressPhone: body.SellerAddressPhone,
		SellerBankAccount: body.SellerBankAccount, BuyerName: body.BuyerName,
		BuyerTaxNo: body.BuyerTaxNo, BuyerAddressPhone: body.BuyerAddressPhone,
		BuyerBankAccount: body.BuyerBankAccount, Items: items,
		NetTotal: body.NetTotal, TaxTotal: body.TaxTotal, GrossTotal: body.GrossTotal,
		Issuer: body.Issuer, Reviewer: body.Reviewer, Payee: body.Payee, Remarks: body.Remarks,
		PartyAccountID: body.PartyAccountId, AmountAccountID: body.AmountAccountId,
		TaxAccountID: body.TaxAccountId, MirrorInvoiceID: body.MirrorInvoiceId,
		SalesReconciliationID:    body.SalReconciliationId,
		PurchaseReconciliationID: body.PurReconciliationId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	converted, err := financeInvoiceResponse(item)
	if err != nil {
		s.writeError(w, r, apierror.Wrap(apierror.CodeInternal, "转换增值税发票响应失败", err))
		return
	}
	s.writeJSON(w, http.StatusCreated, converted)
}

func (s *Server) UpdateFinanceVatInvoice(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.VatInvoiceUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := documents.VatInvoiceUpdateInput{
		DocNo:       documentOptionalString(fields, "docNo", body.DocNo),
		InvoiceDate: documentOptionalDate(fields, "invoiceDate", body.InvoiceDate),
		InvoiceNo:   documentOptionalString(fields, "invoiceNo", body.InvoiceNo),
		SellerName:  documentOptionalString(fields, "sellerName", body.SellerName),
		SellerTaxNo: documentOptionalString(fields, "sellerTaxNo", body.SellerTaxNo),
		SellerAddressPhone: documentOptionalString(
			fields, "sellerAddressPhone", body.SellerAddressPhone,
		),
		SellerBankAccount: documentOptionalString(
			fields, "sellerBankAccount", body.SellerBankAccount,
		),
		BuyerName:  documentOptionalString(fields, "buyerName", body.BuyerName),
		BuyerTaxNo: documentOptionalString(fields, "buyerTaxNo", body.BuyerTaxNo),
		BuyerAddressPhone: documentOptionalString(
			fields, "buyerAddressPhone", body.BuyerAddressPhone,
		),
		BuyerBankAccount: documentOptionalString(
			fields, "buyerBankAccount", body.BuyerBankAccount,
		),
		NetTotal:        documentOptionalString(fields, "netTotal", body.NetTotal),
		TaxTotal:        documentOptionalString(fields, "taxTotal", body.TaxTotal),
		GrossTotal:      documentOptionalString(fields, "grossTotal", body.GrossTotal),
		Issuer:          documentOptionalString(fields, "issuer", body.Issuer),
		Reviewer:        documentOptionalString(fields, "reviewer", body.Reviewer),
		Payee:           documentOptionalString(fields, "payee", body.Payee),
		Remarks:         documentOptionalString(fields, "remarks", body.Remarks),
		PartyAccountID:  documentOptionalUUID(fields, "partyAccountId", body.PartyAccountId),
		AmountAccountID: documentOptionalUUID(fields, "amountAccountId", body.AmountAccountId),
		TaxAccountID:    documentOptionalUUID(fields, "taxAccountId", body.TaxAccountId),
		MirrorInvoiceID: documentOptionalUUID(fields, "mirrorInvoiceId", body.MirrorInvoiceId),
		SalesReconciliationID: documentOptionalUUID(
			fields, "salReconciliationId", body.SalReconciliationId,
		),
		PurchaseReconciliationID: documentOptionalUUID(
			fields, "purReconciliationId", body.PurReconciliationId,
		),
	}
	if body.Direction != nil {
		value := string(*body.Direction)
		input.Direction = &value
	}
	if body.PartyType != nil {
		value := string(*body.PartyType)
		input.PartyType = &value
	}
	input.PartyID = body.PartyId
	if body.InvoiceKind != nil {
		value := string(*body.InvoiceKind)
		input.InvoiceKind = &value
	}
	input.InvoiceCode = body.InvoiceCode
	if _, set := fields["items"]; set {
		items, encodeErr := financeItemsJSON(body.Items)
		if encodeErr != nil {
			s.writeError(w, r, invalidJSON(encodeErr))
			return
		}
		input.Items = &items
	}
	item, err := s.FinanceDocuments.UpdateVatInvoice(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeFinanceInvoice(w, r, item)
}

func (s *Server) DeleteFinanceVatInvoice(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.FinanceDocuments.DeleteVatInvoice(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) AuditFinanceVatInvoice(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:audit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PostingDateAction
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	postingDate := ""
	if body.PostingDate != nil {
		postingDate = body.PostingDate.Time.Format(time.DateOnly)
	}
	item, err := s.FinanceDocuments.AuditVatInvoice(r.Context(), actor, id, postingDate)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeFinanceInvoice(w, r, item)
}

func (s *Server) VoidFinanceVatInvoice(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:void")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.VoidVatInvoice(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeFinanceInvoice(w, r, item)
}

func (s *Server) ReverseFinanceVatInvoice(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:reverse")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.VatInvoiceReverse
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.FinanceDocuments.ReverseVatInvoice(r.Context(), actor, id, documents.ReverseVatInvoiceInput{
		PostingDate: body.PostingDate.Time.Format(time.DateOnly), RedInvoiceNo: body.RedInvoiceNo,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeFinanceInvoice(w, r, item)
}

func (s *Server) OcrFinanceVatInvoice(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.OCRRequest
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.FinanceDocuments.OCRVatInvoice(
		r.Context(), actor, documents.OCRInput{FileID: body.FileId},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) writeFinanceInvoice(
	w http.ResponseWriter,
	r *http.Request,
	item documents.VatInvoice,
) {
	converted, err := financeInvoiceResponse(item)
	if err != nil {
		s.writeError(w, r, apierror.Wrap(apierror.CodeInternal, "转换增值税发票响应失败", err))
		return
	}
	s.writeJSON(w, http.StatusOK, converted)
}

func (s *Server) QueryFinanceExpenseReports(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.expense_report:read", financeDocumentsList,
		s.FinanceDocuments.QueryExpenseReports, passthroughListResponse)
}

func (s *Server) GetFinanceExpenseReport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.expense_report:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.GetExpenseReport(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceExpenseReport(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.expense_report:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.ExpenseReportCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	docNo := body.DocNo
	item, err := s.FinanceDocuments.CreateExpenseReport(r.Context(), actor, documents.ExpenseReportInput{
		CompanyID: body.CompanyId, DocNo: &docNo,
		ExpenseDate: body.ExpenseDate.Time.Format(time.DateOnly),
		PostingDate: financeDate(body.PostingDate), Remarks: body.Remarks,
		EmployeeID: body.EmployeeId, PaymentAccountID: body.PaymentAccountId,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateFinanceExpenseReport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.expense_report:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.ExpenseReportUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := documents.ExpenseReportUpdateInput{
		DocNo:       documentOptionalString(fields, "docNo", body.DocNo),
		PostingDate: documentOptionalDate(fields, "postingDate", body.PostingDate),
		Remarks:     documentOptionalString(fields, "remarks", body.Remarks),
		EmployeeID:  body.EmployeeId, PaymentAccountID: body.PaymentAccountId,
	}
	if body.ExpenseDate != nil {
		value := body.ExpenseDate.Time.Format(time.DateOnly)
		input.ExpenseDate = &value
	}
	item, err := s.FinanceDocuments.UpdateExpenseReport(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceExpenseReport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.expense_report:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.FinanceDocuments.DeleteExpenseReport(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) AuditFinanceExpenseReport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.expense_report:audit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PostingDateAction
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	postingDate := ""
	if body.PostingDate != nil {
		postingDate = body.PostingDate.Time.Format(time.DateOnly)
	}
	item, err := s.FinanceDocuments.AuditExpenseReport(r.Context(), actor, id, postingDate)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) VoidFinanceExpenseReport(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.expense_report:void")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.VoidExpenseReport(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) QueryFinanceExpenseReportItems(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.expense_report:read", financeDocumentsList,
		s.FinanceDocuments.QueryExpenseReportItems, passthroughListResponse)
}

func (s *Server) GetFinanceExpenseReportItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.expense_report:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.GetExpenseReportItem(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) CreateFinanceExpenseReportItem(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.expense_report:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.ExpenseReportItemCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.FinanceDocuments.CreateExpenseReportItem(
		r.Context(), actor, documents.ExpenseReportItemInput{
			ReportID: body.ReportId, Idx: body.Idx, Kind: string(body.Kind),
			Summary: body.Summary, Amount: body.Amount, Remarks: body.Remarks,
			InvoiceID: body.InvoiceId, ExpenseAccountID: body.ExpenseAccountId,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateFinanceExpenseReportItem(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, err := actorWithPermission(r, "acc.expense_report:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.ExpenseReportItemUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := documents.ExpenseReportItemUpdateInput{
		Idx:       body.Idx,
		Summary:   documentOptionalString(fields, "summary", body.Summary),
		Amount:    documentOptionalString(fields, "amount", body.Amount),
		Remarks:   documentOptionalString(fields, "remarks", body.Remarks),
		InvoiceID: documentOptionalUUID(fields, "invoiceId", body.InvoiceId),
		ExpenseAccountID: documentOptionalUUID(
			fields, "expenseAccountId", body.ExpenseAccountId,
		),
	}
	if body.Kind != nil {
		value := string(*body.Kind)
		input.Kind = &value
	}
	item, err := s.FinanceDocuments.UpdateExpenseReportItem(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceExpenseReportItem(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.expense_report:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.FinanceDocuments.DeleteExpenseReportItem(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBills(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bill:read", financeDocumentsList,
		s.FinanceDocuments.QueryBills, passthroughListResponse)
}

func (s *Server) GetFinanceBill(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.bill:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.GetBill(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) UpdateFinanceBill(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.bill:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.BillUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := documents.BillUpdateInput{
		IssueDate:      documentOptionalDate(fields, "issueDate", body.IssueDate),
		FaceAmount:     documentOptionalString(fields, "faceAmount", body.FaceAmount),
		DrawerName:     documentOptionalString(fields, "drawerName", body.DrawerName),
		DrawerAccount:  documentOptionalString(fields, "drawerAccount", body.DrawerAccount),
		DrawerBankName: documentOptionalString(fields, "drawerBankName", body.DrawerBankName),
		DrawerBankNo:   documentOptionalString(fields, "drawerBankNo", body.DrawerBankNo),
		PayeeName:      documentOptionalString(fields, "payeeName", body.PayeeName),
		PayeeAccount:   documentOptionalString(fields, "payeeAccount", body.PayeeAccount),
		PayeeBankName:  documentOptionalString(fields, "payeeBankName", body.PayeeBankName),
		PayeeBankNo:    documentOptionalString(fields, "payeeBankNo", body.PayeeBankNo),
		AcceptorName:   documentOptionalString(fields, "acceptorName", body.AcceptorName),
		AcceptorAccount: documentOptionalString(
			fields, "acceptorAccount", body.AcceptorAccount,
		),
		AcceptorBankName: documentOptionalString(
			fields, "acceptorBankName", body.AcceptorBankName,
		),
		AcceptorBankNo: documentOptionalString(
			fields, "acceptorBankNo", body.AcceptorBankNo,
		),
		Transferable: body.Transferable,
		AcceptanceDate: documentOptionalDate(
			fields, "acceptanceDate", body.AcceptanceDate,
		),
		Remarks: documentOptionalString(fields, "remarks", body.Remarks),
	}
	if body.BillKind != nil {
		value := string(*body.BillKind)
		input.BillKind = &value
	}
	if body.DueDate != nil {
		value := body.DueDate.Time.Format(time.DateOnly)
		input.DueDate = &value
	}
	item, err := s.FinanceDocuments.UpdateBill(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBill(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.bill:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.FinanceDocuments.DeleteBill(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryFinanceBillTransactions(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bill_transaction:read", financeDocumentsList,
		s.FinanceDocuments.QueryBillTransactions, passthroughListResponse)
}

func (s *Server) GetFinanceBillTransaction(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.bill_transaction:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.GetBillTransaction(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

type billAttrsBody struct {
	BillNo           string  `json:"bill_no"`
	BillKind         string  `json:"bill_kind"`
	IssueDate        *string `json:"issue_date"`
	DueDate          string  `json:"due_date"`
	FaceAmount       *string `json:"face_amount"`
	DrawerName       *string `json:"drawer_name"`
	DrawerAccount    *string `json:"drawer_account"`
	DrawerBankName   *string `json:"drawer_bank_name"`
	DrawerBankNo     *string `json:"drawer_bank_no"`
	PayeeName        *string `json:"payee_name"`
	PayeeAccount     *string `json:"payee_account"`
	PayeeBankName    *string `json:"payee_bank_name"`
	PayeeBankNo      *string `json:"payee_bank_no"`
	AcceptorName     *string `json:"acceptor_name"`
	AcceptorAccount  *string `json:"acceptor_account"`
	AcceptorBankName *string `json:"acceptor_bank_name"`
	AcceptorBankNo   *string `json:"acceptor_bank_no"`
	Transferable     *bool   `json:"transferable"`
	AcceptanceDate   *string `json:"acceptance_date"`
	Remarks          *string `json:"remarks"`
}

func (s *Server) CreateFinanceBillTransaction(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.bill_transaction:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.BillTransactionCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var billAttrs *documents.BillAttrs
	if body.BillAttrs != nil {
		encoded, encodeErr := json.Marshal(*body.BillAttrs)
		if encodeErr != nil {
			s.writeError(w, r, invalidJSON(encodeErr))
			return
		}
		var decoded billAttrsBody
		if decodeErr := json.Unmarshal(encoded, &decoded); decodeErr != nil {
			s.writeError(w, r, invalidJSON(decodeErr))
			return
		}
		billAttrs = &documents.BillAttrs{
			BillNo: decoded.BillNo, BillKind: decoded.BillKind,
			IssueDate: decoded.IssueDate, DueDate: decoded.DueDate,
			FaceAmount: decoded.FaceAmount, DrawerName: decoded.DrawerName,
			DrawerAccount: decoded.DrawerAccount, DrawerBankName: decoded.DrawerBankName,
			DrawerBankNo: decoded.DrawerBankNo, PayeeName: decoded.PayeeName,
			PayeeAccount: decoded.PayeeAccount, PayeeBankName: decoded.PayeeBankName,
			PayeeBankNo: decoded.PayeeBankNo, AcceptorName: decoded.AcceptorName,
			AcceptorAccount: decoded.AcceptorAccount, AcceptorBankName: decoded.AcceptorBankName,
			AcceptorBankNo: decoded.AcceptorBankNo, Transferable: decoded.Transferable,
			AcceptanceDate: decoded.AcceptanceDate, Remarks: decoded.Remarks,
		}
	}
	item, err := s.FinanceDocuments.CreateBillTransaction(
		r.Context(), actor, documents.BillTransactionInput{
			DocNo: body.DocNo, TransactionType: string(body.TransactionType),
			OccurredOn: body.OccurredOn.Time.Format(time.DateOnly),
			SubStart:   body.SubStart, SubEnd: body.SubEnd, Amount: body.Amount,
			PartyType: enumStringPtr(body.PartyType), PartyID: body.PartyId,
			DiscountOrg: body.DiscountOrg, DiscountRate: body.DiscountRate,
			Interest: body.Interest, NetAmount: body.NetAmount,
			PostingDate: financeDate(body.PostingDate),
			Remarks:     body.Remarks, CompanyID: body.CompanyId,
			BankAccountID: body.BankAccountId, ToBankAccountID: body.ToBankAccountId,
			BillID: body.BillId, BillAttrs: billAttrs,
			BillAccountID: body.BillAccountId, SettleAccountID: body.SettleAccountId,
			InterestAccountID: body.InterestAccountId,
		},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, item)
}

func (s *Server) UpdateFinanceBillTransaction(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, err := actorWithPermission(r, "acc.bill_transaction:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.BillTransactionUpdate
	fields, err := decodeFinanceJSON(w, r, &body)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := documents.BillTransactionUpdateInput{
		DocNo:    documentOptionalString(fields, "docNo", body.DocNo),
		SubStart: body.SubStart, SubEnd: body.SubEnd, Amount: body.Amount,
		PartyType:     documentOptionalString(fields, "partyType", enumStringPtr(body.PartyType)),
		PartyID:       documentOptionalUUID(fields, "partyId", body.PartyId),
		DiscountOrg:   documentOptionalString(fields, "discountOrg", body.DiscountOrg),
		DiscountRate:  documentOptionalString(fields, "discountRate", body.DiscountRate),
		Interest:      documentOptionalString(fields, "interest", body.Interest),
		NetAmount:     documentOptionalString(fields, "netAmount", body.NetAmount),
		PostingDate:   documentOptionalDate(fields, "postingDate", body.PostingDate),
		Remarks:       documentOptionalString(fields, "remarks", body.Remarks),
		BankAccountID: body.BankAccountId,
		ToBankAccountID: documentOptionalUUID(
			fields, "toBankAccountId", body.ToBankAccountId,
		),
		BillID:        body.BillId,
		BillAccountID: documentOptionalUUID(fields, "billAccountId", body.BillAccountId),
		SettleAccountID: documentOptionalUUID(
			fields, "settleAccountId", body.SettleAccountId,
		),
		InterestAccountID: documentOptionalUUID(
			fields, "interestAccountId", body.InterestAccountId,
		),
	}
	if body.OccurredOn != nil {
		value := body.OccurredOn.Time.Format(time.DateOnly)
		input.OccurredOn = &value
	}
	item, err := s.FinanceDocuments.UpdateBillTransaction(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) DeleteFinanceBillTransaction(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.bill_transaction:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.FinanceDocuments.DeleteBillTransaction(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) AuditFinanceBillTransaction(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.bill_transaction:audit")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PostingDateAction
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.FinanceDocuments.AuditBillTransaction(
		r.Context(), actor, id,
		documents.AuditBillTransactionInput{PostingDate: financeDate(body.PostingDate)},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) VoidFinanceBillTransaction(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.bill_transaction:void")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.VoidBillTransaction(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func (s *Server) OcrFinanceBillTransaction(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.bill_transaction:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.OCRRequest
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := s.FinanceDocuments.OCRBillTransaction(
		r.Context(), actor, documents.OCRInput{FileID: body.FileId},
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func (s *Server) QueryFinanceBillHoldings(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "acc.bill_holding:read", financeDocumentsList,
		s.FinanceDocuments.QueryBillHoldings, passthroughListResponse)
}

func (s *Server) GetFinanceBillHolding(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "acc.bill_holding:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.FinanceDocuments.GetBillHolding(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, item)
}

func enumStringPtr(value *gen.FinancePartyType) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}
