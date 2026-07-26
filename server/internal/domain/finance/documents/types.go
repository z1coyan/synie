package documents

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

const (
	StatusDraft    = "DRAFT"
	StatusAudited  = "AUDITED"
	StatusVoided   = "VOIDED"
	StatusReversed = "REVERSED"

	DirectionInbound  = "INBOUND"
	DirectionOutbound = "OUTBOUND"

	PartySupplier = "SUPPLIER"
	PartyCustomer = "CUSTOMER"
	PartyCompany  = "COMPANY"
	PartyEmployee = "EMPLOYEE"

	InvoiceSpecial           = "SPECIAL"
	InvoiceNormal            = "NORMAL"
	InvoiceElectronicSpecial = "ELECTRONIC_SPECIAL"
	InvoiceElectronicNormal  = "ELECTRONIC_NORMAL"
	InvoiceDigitalSpecial    = "DIGITAL_SPECIAL"
	InvoiceDigitalNormal     = "DIGITAL_NORMAL"

	ExpenseInvoiced = "INVOICED"
	ExpenseManual   = "MANUAL"

	BillBankAcceptance           = "BANK_ACCEPTANCE"
	BillCommercialAcceptance     = "COMMERCIAL_ACCEPTANCE"
	BillFinanceCompanyAcceptance = "FINANCE_COMPANY_ACCEPTANCE"

	TransactionReceive    = "RECEIVE"
	TransactionEndorse    = "ENDORSE"
	TransactionSettle     = "SETTLE"
	TransactionDiscount   = "DISCOUNT"
	TransactionReallocate = "REALLOCATE"

	OCRVatInvoice      = "VAT_INVOICE"
	OCRBillTransaction = "BILL_TRANSACTION"
)

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type OptionalString struct {
	Set   bool
	Value *string
}

type OptionalUUID struct {
	Set   bool
	Value *uuid.UUID
}

type OptionalBool struct {
	Set   bool
	Value bool
}

type VatInvoice struct {
	ID                       uuid.UUID  `json:"id"`
	DocNo                    *string    `json:"docNo"`
	Direction                string     `json:"direction"`
	InvoiceDate              *string    `json:"invoiceDate"`
	PostingDate              *string    `json:"postingDate"`
	PartyType                string     `json:"partyType"`
	PartyID                  uuid.UUID  `json:"partyId"`
	InvoiceKind              string     `json:"invoiceKind"`
	InvoiceCode              string     `json:"invoiceCode"`
	InvoiceNo                *string    `json:"invoiceNo"`
	SellerName               *string    `json:"sellerName"`
	SellerTaxNo              *string    `json:"sellerTaxNo"`
	SellerAddressPhone       *string    `json:"sellerAddressPhone"`
	SellerBankAccount        *string    `json:"sellerBankAccount"`
	BuyerName                *string    `json:"buyerName"`
	BuyerTaxNo               *string    `json:"buyerTaxNo"`
	BuyerAddressPhone        *string    `json:"buyerAddressPhone"`
	BuyerBankAccount         *string    `json:"buyerBankAccount"`
	Items                    string     `json:"items"`
	NetTotal                 *string    `json:"netTotal"`
	TaxTotal                 *string    `json:"taxTotal"`
	GrossTotal               *string    `json:"grossTotal"`
	Issuer                   *string    `json:"issuer"`
	Reviewer                 *string    `json:"reviewer"`
	Payee                    *string    `json:"payee"`
	Remarks                  *string    `json:"remarks"`
	RedInvoiceNo             *string    `json:"redInvoiceNo"`
	Status                   string     `json:"status"`
	AuditedAt                *time.Time `json:"auditedAt"`
	InsertedAt               time.Time  `json:"insertedAt"`
	UpdatedAt                time.Time  `json:"updatedAt"`
	CompanyID                uuid.UUID  `json:"companyId"`
	PartyAccountID           *uuid.UUID `json:"partyAccountId"`
	AmountAccountID          *uuid.UUID `json:"amountAccountId"`
	TaxAccountID             *uuid.UUID `json:"taxAccountId"`
	MirrorInvoiceID          *uuid.UUID `json:"mirrorInvoiceId"`
	CreatedByID              *uuid.UUID `json:"createdById"`
	AuditedByID              *uuid.UUID `json:"auditedById"`
	SalesReconciliationID    *uuid.UUID `json:"salReconciliationId"`
	PurchaseReconciliationID *uuid.UUID `json:"purReconciliationId"`
}

type VatInvoiceList struct {
	Count   int64        `json:"count"`
	Results []VatInvoice `json:"results"`
}

type VatInvoiceInput struct {
	CompanyID                uuid.UUID
	DocNo                    *string
	Direction                string
	InvoiceDate              *string
	PartyType                string
	PartyID                  uuid.UUID
	InvoiceKind              string
	InvoiceCode              string
	InvoiceNo                *string
	SellerName               *string
	SellerTaxNo              *string
	SellerAddressPhone       *string
	SellerBankAccount        *string
	BuyerName                *string
	BuyerTaxNo               *string
	BuyerAddressPhone        *string
	BuyerBankAccount         *string
	Items                    string
	NetTotal                 *string
	TaxTotal                 *string
	GrossTotal               *string
	Issuer                   *string
	Reviewer                 *string
	Payee                    *string
	Remarks                  *string
	PartyAccountID           *uuid.UUID
	AmountAccountID          *uuid.UUID
	TaxAccountID             *uuid.UUID
	MirrorInvoiceID          *uuid.UUID
	SalesReconciliationID    *uuid.UUID
	PurchaseReconciliationID *uuid.UUID
}

// VatInvoiceUpdateInput deliberately excludes company_id. Every public update
// locks and reloads the current draft, overlays only Set fields, then validates
// the complete resulting document.
type VatInvoiceUpdateInput struct {
	DocNo                    OptionalString
	Direction                *string
	InvoiceDate              OptionalString
	PartyType                *string
	PartyID                  *uuid.UUID
	InvoiceKind              *string
	InvoiceCode              *string
	InvoiceNo                OptionalString
	SellerName               OptionalString
	SellerTaxNo              OptionalString
	SellerAddressPhone       OptionalString
	SellerBankAccount        OptionalString
	BuyerName                OptionalString
	BuyerTaxNo               OptionalString
	BuyerAddressPhone        OptionalString
	BuyerBankAccount         OptionalString
	Items                    *string
	NetTotal                 OptionalString
	TaxTotal                 OptionalString
	GrossTotal               OptionalString
	Issuer                   OptionalString
	Reviewer                 OptionalString
	Payee                    OptionalString
	Remarks                  OptionalString
	PartyAccountID           OptionalUUID
	AmountAccountID          OptionalUUID
	TaxAccountID             OptionalUUID
	MirrorInvoiceID          OptionalUUID
	SalesReconciliationID    OptionalUUID
	PurchaseReconciliationID OptionalUUID
}

type ReverseVatInvoiceInput struct {
	PostingDate  string
	RedInvoiceNo *string
}

type OCRInput struct {
	FileID uuid.UUID
}

type OCRPrefill map[string]any

type ExpenseReport struct {
	ID               uuid.UUID  `json:"id"`
	DocNo            string     `json:"docNo"`
	ExpenseDate      string     `json:"expenseDate"`
	PostingDate      *string    `json:"postingDate"`
	Remarks          *string    `json:"remarks"`
	Status           string     `json:"status"`
	AuditedAt        *time.Time `json:"auditedAt"`
	InsertedAt       time.Time  `json:"insertedAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
	CompanyID        uuid.UUID  `json:"companyId"`
	EmployeeID       uuid.UUID  `json:"employeeId"`
	PaymentAccountID uuid.UUID  `json:"paymentAccountId"`
	CreatedByID      *uuid.UUID `json:"createdById"`
	AuditedByID      *uuid.UUID `json:"auditedById"`
}

type ExpenseReportList struct {
	Count   int64           `json:"count"`
	Results []ExpenseReport `json:"results"`
}

type ExpenseReportInput struct {
	CompanyID        uuid.UUID
	DocNo            *string
	ExpenseDate      string
	PostingDate      *string
	Remarks          *string
	EmployeeID       uuid.UUID
	PaymentAccountID uuid.UUID
}

type ExpenseReportUpdateInput struct {
	DocNo            OptionalString
	ExpenseDate      *string
	PostingDate      OptionalString
	Remarks          OptionalString
	EmployeeID       *uuid.UUID
	PaymentAccountID *uuid.UUID
}

type ExpenseReportItem struct {
	ID               uuid.UUID  `json:"id"`
	Idx              int64      `json:"idx"`
	Kind             string     `json:"kind"`
	Summary          *string    `json:"summary"`
	Amount           *string    `json:"amount"`
	Remarks          *string    `json:"remarks"`
	InsertedAt       time.Time  `json:"insertedAt"`
	UpdatedAt        time.Time  `json:"updatedAt"`
	ReportID         uuid.UUID  `json:"reportId"`
	CompanyID        uuid.UUID  `json:"companyId"`
	InvoiceID        *uuid.UUID `json:"invoiceId"`
	ExpenseAccountID *uuid.UUID `json:"expenseAccountId"`
}

type ExpenseReportItemList struct {
	Count   int64               `json:"count"`
	Results []ExpenseReportItem `json:"results"`
}

type ExpenseReportItemInput struct {
	ReportID         uuid.UUID
	Idx              int64
	Kind             string
	Summary          *string
	Amount           *string
	Remarks          *string
	InvoiceID        *uuid.UUID
	ExpenseAccountID *uuid.UUID
}

type ExpenseReportItemUpdateInput struct {
	Idx              *int64
	Kind             *string
	Summary          OptionalString
	Amount           OptionalString
	Remarks          OptionalString
	InvoiceID        OptionalUUID
	ExpenseAccountID OptionalUUID
}

type Bill struct {
	ID               uuid.UUID `json:"id"`
	BillNo           string    `json:"billNo"`
	BillKind         string    `json:"billKind"`
	IssueDate        *string   `json:"issueDate"`
	DueDate          string    `json:"dueDate"`
	FaceAmount       *string   `json:"faceAmount"`
	DrawerName       *string   `json:"drawerName"`
	DrawerAccount    *string   `json:"drawerAccount"`
	DrawerBankName   *string   `json:"drawerBankName"`
	DrawerBankNo     *string   `json:"drawerBankNo"`
	PayeeName        *string   `json:"payeeName"`
	PayeeAccount     *string   `json:"payeeAccount"`
	PayeeBankName    *string   `json:"payeeBankName"`
	PayeeBankNo      *string   `json:"payeeBankNo"`
	AcceptorName     *string   `json:"acceptorName"`
	AcceptorAccount  *string   `json:"acceptorAccount"`
	AcceptorBankName *string   `json:"acceptorBankName"`
	AcceptorBankNo   *string   `json:"acceptorBankNo"`
	Transferable     bool      `json:"transferable"`
	AcceptanceDate   *string   `json:"acceptanceDate"`
	Remarks          *string   `json:"remarks"`
	InsertedAt       time.Time `json:"insertedAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type BillList struct {
	Count   int64  `json:"count"`
	Results []Bill `json:"results"`
}

type BillAttrs struct {
	BillNo           string
	BillKind         string
	IssueDate        *string
	DueDate          string
	FaceAmount       *string
	DrawerName       *string
	DrawerAccount    *string
	DrawerBankName   *string
	DrawerBankNo     *string
	PayeeName        *string
	PayeeAccount     *string
	PayeeBankName    *string
	PayeeBankNo      *string
	AcceptorName     *string
	AcceptorAccount  *string
	AcceptorBankName *string
	AcceptorBankNo   *string
	Transferable     *bool
	AcceptanceDate   *string
	Remarks          *string
}

type BillUpdateInput struct {
	BillKind         *string
	IssueDate        OptionalString
	DueDate          *string
	FaceAmount       OptionalString
	DrawerName       OptionalString
	DrawerAccount    OptionalString
	DrawerBankName   OptionalString
	DrawerBankNo     OptionalString
	PayeeName        OptionalString
	PayeeAccount     OptionalString
	PayeeBankName    OptionalString
	PayeeBankNo      OptionalString
	AcceptorName     OptionalString
	AcceptorAccount  OptionalString
	AcceptorBankName OptionalString
	AcceptorBankNo   OptionalString
	Transferable     *bool
	AcceptanceDate   OptionalString
	Remarks          OptionalString
}

type BillTransaction struct {
	ID                uuid.UUID  `json:"id"`
	DocNo             *string    `json:"docNo"`
	TransactionType   string     `json:"transactionType"`
	OccurredOn        string     `json:"occurredOn"`
	SubStart          int64      `json:"subStart"`
	SubEnd            int64      `json:"subEnd"`
	Amount            string     `json:"amount"`
	PartyType         *string    `json:"partyType"`
	PartyID           *uuid.UUID `json:"partyId"`
	DiscountOrg       *string    `json:"discountOrg"`
	DiscountRate      *string    `json:"discountRate"`
	Interest          *string    `json:"interest"`
	NetAmount         *string    `json:"netAmount"`
	PostingDate       *string    `json:"postingDate"`
	Status            string     `json:"status"`
	AuditedAt         *time.Time `json:"auditedAt"`
	Remarks           *string    `json:"remarks"`
	InsertedAt        time.Time  `json:"insertedAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
	CompanyID         uuid.UUID  `json:"companyId"`
	BankAccountID     uuid.UUID  `json:"bankAccountId"`
	ToBankAccountID   *uuid.UUID `json:"toBankAccountId"`
	BillID            uuid.UUID  `json:"billId"`
	BillAccountID     *uuid.UUID `json:"billAccountId"`
	SettleAccountID   *uuid.UUID `json:"settleAccountId"`
	InterestAccountID *uuid.UUID `json:"interestAccountId"`
	CreatedByID       *uuid.UUID `json:"createdById"`
	AuditedByID       *uuid.UUID `json:"auditedById"`
}

type BillTransactionList struct {
	Count   int64             `json:"count"`
	Results []BillTransaction `json:"results"`
}

type BillTransactionInput struct {
	DocNo             *string
	TransactionType   string
	OccurredOn        string
	SubStart          int64
	SubEnd            int64
	Amount            string
	PartyType         *string
	PartyID           *uuid.UUID
	DiscountOrg       *string
	DiscountRate      *string
	Interest          *string
	NetAmount         *string
	PostingDate       *string
	Remarks           *string
	CompanyID         uuid.UUID
	BankAccountID     uuid.UUID
	ToBankAccountID   *uuid.UUID
	BillID            *uuid.UUID
	BillAttrs         *BillAttrs
	BillAccountID     *uuid.UUID
	SettleAccountID   *uuid.UUID
	InterestAccountID *uuid.UUID
}

type BillTransactionUpdateInput struct {
	DocNo             OptionalString
	OccurredOn        *string
	SubStart          *int64
	SubEnd            *int64
	Amount            *string
	PartyType         OptionalString
	PartyID           OptionalUUID
	DiscountOrg       OptionalString
	DiscountRate      OptionalString
	Interest          OptionalString
	NetAmount         OptionalString
	PostingDate       OptionalString
	Remarks           OptionalString
	BankAccountID     *uuid.UUID
	ToBankAccountID   OptionalUUID
	BillID            *uuid.UUID
	BillAccountID     OptionalUUID
	SettleAccountID   OptionalUUID
	InterestAccountID OptionalUUID
}

type AuditBillTransactionInput struct {
	PostingDate *string
}

type BillHolding struct {
	ID                  uuid.UUID `json:"id"`
	BillNo              string    `json:"billNo"`
	SubStart            int64     `json:"subStart"`
	SubEnd              int64     `json:"subEnd"`
	Amount              string    `json:"amount"`
	DueDate             string    `json:"dueDate"`
	AcquiredOn          string    `json:"acquiredOn"`
	InsertedAt          time.Time `json:"insertedAt"`
	CompanyID           uuid.UUID `json:"companyId"`
	BankAccountID       uuid.UUID `json:"bankAccountId"`
	BillID              uuid.UUID `json:"billId"`
	SourceTransactionID uuid.UUID `json:"sourceTransactionId"`
}

type BillHoldingList struct {
	Count   int64         `json:"count"`
	Results []BillHolding `json:"results"`
}
