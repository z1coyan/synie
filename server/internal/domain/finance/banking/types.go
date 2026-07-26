package banking

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

const (
	ImportParsed   = "PARSED"
	ImportFailed   = "FAILED"
	ImportImported = "IMPORTED"

	ReconcileUnreconciled = "UNRECONCILED"
	ReconcilePartial      = "PARTIAL"
	ReconcileReconciled   = "RECONCILED"
)

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type Optional[T any] struct {
	Set   bool
	Value *T
}

type BankAccount struct {
	ID         uuid.UUID  `json:"id"`
	Alias      string     `json:"alias"`
	BankName   string     `json:"bankName"`
	BranchName *string    `json:"branchName"`
	HolderName string     `json:"holderName"`
	AccountNo  string     `json:"accountNo"`
	Active     bool       `json:"active"`
	Note       *string    `json:"note"`
	InsertedAt time.Time  `json:"insertedAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	CompanyID  uuid.UUID  `json:"companyId"`
	CurrencyID uuid.UUID  `json:"currencyId"`
	AccountID  *uuid.UUID `json:"accountId"`
}

type BankAccountList struct {
	Count   int64         `json:"count"`
	Results []BankAccount `json:"results"`
}

type BankAccountCreateInput struct {
	Alias, BankName, HolderName, AccountNo string
	BranchName, Note                       *string
	Active                                 *bool
	CompanyID, CurrencyID                  uuid.UUID
	AccountID                              *uuid.UUID
}

type BankAccountUpdateInput struct {
	Alias, BankName, HolderName, AccountNo *string
	BranchName, Note                       Optional[string]
	Active                                 *bool
	CurrencyID                             *uuid.UUID
	AccountID                              Optional[uuid.UUID]
}

type BankTransaction struct {
	ID                  uuid.UUID        `json:"id"`
	OccurredAt          time.Time        `json:"occurredAt"`
	Income              *decimal.Decimal `json:"income"`
	Expense             *decimal.Decimal `json:"expense"`
	Balance             *decimal.Decimal `json:"balance"`
	CounterpartyName    *string          `json:"counterpartyName"`
	CounterpartyAccount *string          `json:"counterpartyAccount"`
	Summary             *string          `json:"summary"`
	Note                *string          `json:"note"`
	ReconciledAmount    decimal.Decimal  `json:"reconciledAmount"`
	UnreconciledAmount  decimal.Decimal  `json:"unreconciledAmount"`
	ReconcileStatus     string           `json:"reconcileStatus"`
	InsertedAt          time.Time        `json:"insertedAt"`
	UpdatedAt           time.Time        `json:"updatedAt"`
	CompanyID           uuid.UUID        `json:"companyId"`
	BankAccountID       uuid.UUID        `json:"bankAccountId"`
}

type BankTransactionList struct {
	Count   int64             `json:"count"`
	Results []BankTransaction `json:"results"`
}

type BankTransactionCreateInput struct {
	OccurredAt          time.Time
	Income, Expense     *decimal.Decimal
	Balance             *decimal.Decimal
	CounterpartyName    *string
	CounterpartyAccount *string
	Summary, Note       *string
	CompanyID           uuid.UUID
	BankAccountID       uuid.UUID
}

type BankTransactionUpdateInput struct {
	OccurredAt          *time.Time
	Income, Expense     Optional[decimal.Decimal]
	Balance             Optional[decimal.Decimal]
	CounterpartyName    Optional[string]
	CounterpartyAccount Optional[string]
	Summary, Note       Optional[string]
	BankAccountID       *uuid.UUID
}

type BankImportTemplate struct {
	ID                     uuid.UUID `json:"id"`
	Name                   string    `json:"name"`
	StartRow               int64     `json:"startRow"`
	DatetimeCol            *string   `json:"datetimeCol"`
	DatetimeFormat         *string   `json:"datetimeFormat"`
	DateCol                *string   `json:"dateCol"`
	DateFormat             *string   `json:"dateFormat"`
	TimeCol                *string   `json:"timeCol"`
	TimeFormat             *string   `json:"timeFormat"`
	IncomeCol              *string   `json:"incomeCol"`
	ExpenseCol             *string   `json:"expenseCol"`
	AmountCol              *string   `json:"amountCol"`
	BalanceCol             *string   `json:"balanceCol"`
	CounterpartyNameCol    *string   `json:"counterpartyNameCol"`
	CounterpartyAccountCol *string   `json:"counterpartyAccountCol"`
	SummaryCol             *string   `json:"summaryCol"`
	NoteCol                *string   `json:"noteCol"`
	InsertedAt             time.Time `json:"insertedAt"`
	UpdatedAt              time.Time `json:"updatedAt"`
	CompanyID              uuid.UUID `json:"companyId"`
	BankAccountID          uuid.UUID `json:"bankAccountId"`
}

type BankImportTemplateList struct {
	Count   int64                `json:"count"`
	Results []BankImportTemplate `json:"results"`
}

type BankImportTemplateCreateInput struct {
	Name                   string
	StartRow               int64
	DatetimeCol            *string
	DatetimeFormat         *string
	DateCol                *string
	DateFormat             *string
	TimeCol                *string
	TimeFormat             *string
	IncomeCol              *string
	ExpenseCol             *string
	AmountCol              *string
	BalanceCol             *string
	CounterpartyNameCol    *string
	CounterpartyAccountCol *string
	SummaryCol             *string
	NoteCol                *string
	CompanyID              uuid.UUID
	BankAccountID          uuid.UUID
}

type BankImportTemplateUpdateInput struct {
	Name                   *string
	StartRow               *int64
	DatetimeCol            Optional[string]
	DatetimeFormat         Optional[string]
	DateCol                Optional[string]
	DateFormat             Optional[string]
	TimeCol                Optional[string]
	TimeFormat             Optional[string]
	IncomeCol              Optional[string]
	ExpenseCol             Optional[string]
	AmountCol              Optional[string]
	BalanceCol             Optional[string]
	CounterpartyNameCol    Optional[string]
	CounterpartyAccountCol Optional[string]
	SummaryCol             Optional[string]
	NoteCol                Optional[string]
	BankAccountID          *uuid.UUID
}

type BankImport struct {
	ID            uuid.UUID  `json:"id"`
	Status        string     `json:"status"`
	Error         *string    `json:"error"`
	ImportedAt    *time.Time `json:"importedAt"`
	InsertedAt    time.Time  `json:"insertedAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	CompanyID     uuid.UUID  `json:"companyId"`
	BankAccountID uuid.UUID  `json:"bankAccountId"`
	TemplateID    uuid.UUID  `json:"templateId"`
	FileID        uuid.UUID  `json:"fileId"`
	CreatedByID   *uuid.UUID `json:"createdById"`
	ImportedByID  *uuid.UUID `json:"importedById"`
	ItemCount     int64      `json:"itemCount"`
	ErrorCount    int64      `json:"errorCount"`
}

type BankImportList struct {
	Count   int64        `json:"count"`
	Results []BankImport `json:"results"`
}

type BankImportCreateInput struct {
	CompanyID, BankAccountID, TemplateID, FileID uuid.UUID
}

type BankImportItem struct {
	ID                  uuid.UUID        `json:"id"`
	RowNo               int64            `json:"rowNo"`
	OccurredAt          *time.Time       `json:"occurredAt"`
	Income              *decimal.Decimal `json:"income"`
	Expense             *decimal.Decimal `json:"expense"`
	Balance             *decimal.Decimal `json:"balance"`
	CounterpartyName    *string          `json:"counterpartyName"`
	CounterpartyAccount *string          `json:"counterpartyAccount"`
	Summary             *string          `json:"summary"`
	Note                *string          `json:"note"`
	Error               *string          `json:"error"`
	InsertedAt          time.Time        `json:"insertedAt"`
	UpdatedAt           time.Time        `json:"updatedAt"`
	ImportID            uuid.UUID        `json:"importId"`
	CompanyID           uuid.UUID        `json:"companyId"`
	TransactionID       *uuid.UUID       `json:"transactionId"`
}

type BankImportItemList struct {
	Count   int64            `json:"count"`
	Results []BankImportItem `json:"results"`
}

type BankImportItemUpdateInput struct {
	OccurredAt          *time.Time
	Income, Expense     Optional[decimal.Decimal]
	Balance             Optional[decimal.Decimal]
	CounterpartyName    Optional[string]
	CounterpartyAccount Optional[string]
	Summary, Note       Optional[string]
}

type BankReconciliation struct {
	ID                uuid.UUID       `json:"id"`
	Amount            decimal.Decimal `json:"amount"`
	InsertedAt        time.Time       `json:"insertedAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
	CompanyID         uuid.UUID       `json:"companyId"`
	BankTransactionID uuid.UUID       `json:"bankTransactionId"`
	JournalID         uuid.UUID       `json:"journalId"`
}

type BankReconciliationList struct {
	Count   int64                `json:"count"`
	Results []BankReconciliation `json:"results"`
}

type BankReconciliationCreateInput struct {
	BankTransactionID, JournalID uuid.UUID
	Amount                       decimal.Decimal
}

type QuickReconciliationInput struct {
	BankTransactionID, CounterAccountID uuid.UUID
	Amount                              decimal.Decimal
	Summary                             *string
	PostingDate                         time.Time
}

type FileReader interface {
	ReadStoredFile(context.Context, uuid.UUID) (fileplatform.File, []byte, error)
}

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

type Ledger interface {
	Post(context.Context, pgx.Tx, gl.Voucher, []gl.Entry, ...gl.PostOptions) error
}

type QuickJournalInput struct {
	CompanyID, BankAccountID, BankLedgerAccountID, CounterAccountID uuid.UUID
	BankTransactionID                                               uuid.UUID
	Income                                                          bool
	Amount                                                          decimal.Decimal
	Summary                                                         *string
	PostingDate                                                     time.Time
}

type QuickJournalWriter interface {
	CreateAndAudit(context.Context, pgx.Tx, *authz.Actor, QuickJournalInput) (uuid.UUID, error)
}

type Dependencies struct {
	Files         FileReader
	Numberer      Numberer
	Ledger        Ledger
	QuickJournals QuickJournalWriter
	UTCOffset     time.Duration
}
