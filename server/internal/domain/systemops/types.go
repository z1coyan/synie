package systemops

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
)

const (
	AuditLogResourceName = "sysAuditLogs"

	TodoTypeIssueInvoice   = "issue_invoice"
	TodoTypeReceiveInvoice = "receive_invoice"

	TodoStatusActive = "active"
	TodoStatusClosed = "closed"

	TodoClosedByUnconfirm    = "unconfirm"
	TodoClosedByInvoiceAudit = "invoice_audit"

	SourceSalesReconciliation    = "sales.reconciliation"
	SourcePurchaseReconciliation = "purchase.reconciliation"
)

type ListQuery struct {
	Limit, Offset int
	Search        string
	Sort          *filterbuild.Sort
	Filter        map[string]json.RawMessage
}

type AuditLog struct {
	ID          uuid.UUID       `json:"id"`
	InsertedAt  time.Time       `json:"insertedAt"`
	Resource    string          `json:"resource"`
	RecordID    uuid.UUID       `json:"recordId"`
	RecordLabel *string         `json:"recordLabel"`
	ActionType  string          `json:"actionType"`
	ActionName  string          `json:"actionName"`
	ActorID     *uuid.UUID      `json:"actorId"`
	ActorName   *string         `json:"actorName"`
	CompanyID   *uuid.UUID      `json:"companyId"`
	Changes     json.RawMessage `json:"changes"`
}

type AuditLogList struct {
	Count   int64      `json:"count"`
	Results []AuditLog `json:"results"`
}

type TodoListQuery struct {
	ListQuery
	Tab              string
	IncludeDismissed bool
}

type Todo struct {
	ID                 uuid.UUID       `json:"id"`
	Type               string          `json:"type"`
	SourceType         string          `json:"sourceType"`
	SourceID           uuid.UUID       `json:"sourceId"`
	SourceNo           string          `json:"sourceNo"`
	PartyType          string          `json:"partyType"`
	PartyID            uuid.UUID       `json:"partyId"`
	PartyName          string          `json:"partyName"`
	Amount             decimal.Decimal `json:"amount"`
	Status             string          `json:"status"`
	ClosedReason       *string         `json:"closedReason"`
	SourceChangedAt    time.Time       `json:"sourceChangedAt"`
	ClosedAt           *time.Time      `json:"closedAt"`
	InsertedAt         time.Time       `json:"insertedAt"`
	UpdatedAt          time.Time       `json:"updatedAt"`
	CompanyID          uuid.UUID       `json:"companyId"`
	Company            TodoCompany     `json:"company"`
	CreatedByID        *uuid.UUID      `json:"createdById"`
	CreatedBy          *TodoUser       `json:"createdBy"`
	DraftInvoiceLinked bool            `json:"draftInvoiceLinked"`
	MyReadAt           *time.Time      `json:"myReadAt"`
	MyDismissedAt      *time.Time      `json:"myDismissedAt"`
	Dismissed          bool            `json:"dismissed"`
}

type TodoCompany struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	ShortName *string   `json:"shortName"`
}

type TodoUser struct {
	ID       uuid.UUID `json:"id"`
	Username string    `json:"username"`
	Name     *string   `json:"name"`
}

type TodoList struct {
	Count   int64  `json:"count"`
	Results []Todo `json:"results"`
}

type OpenTodoInput struct {
	Type            string
	SourceType      string
	SourceID        uuid.UUID
	SourceNo        string
	CompanyID       uuid.UUID
	PartyType       string
	PartyID         uuid.UUID
	Amount          decimal.Decimal
	SourceChangedAt time.Time
	CreatedByID     *uuid.UUID
}

type TodoStateInput struct {
	TodoID       uuid.UUID
	UserID       uuid.UUID
	ReadAt       *time.Time
	DismissedAt  *time.Time
	ResetBasisAt *time.Time
}
