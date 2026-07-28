package glentry

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var roles = []string{
	"unbilled_receivable", "receivable", "advance_received",
	"unbilled_payable", "payable", "advance_paid", "other_payable",
}

var debitRoles = map[string]bool{
	"unbilled_receivable": true,
	"receivable":          true,
	"advance_paid":        true,
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

type partyKey struct {
	kind string
	id   uuid.UUID
	nil  bool
}

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Entry, error) {
	if err := requireRead(actor); err != nil {
		return Entry{}, err
	}
	row, err := dbgen.New(s.pool).GetGLEntry(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Entry{}, apierror.New(apierror.CodeNotFound, "总账分录不存在")
	}
	if err != nil {
		return Entry{}, apierror.Wrap(apierror.CodeInternal, "读取总账分录失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Entry{}, apierror.New(apierror.CodeNotFound, "总账分录不存在")
	}
	return fromRow(row), nil
}

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	if err := requireRead(actor); err != nil {
		return ListResult{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[Entry]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "总账分录", Actor: actor,
		Source: ` FROM acc_gl_entry`,
		Select: `SELECT id,seq,posting_date,debit,credit,party_type,party_id,
voucher_type,voucher_id,voucher_no,is_cancelled,remarks,inserted_at,company_id,
account_id,currency_id,is_reversed,is_reversal`,
		DefaultOrder: ` ORDER BY "seq" ASC`,
		Tiebreaker:   `, "seq" ASC`,
		Scan: func(rows pgx.Rows) (Entry, error) {
			return scanEntry(rows)
		},
	}, listQuery(query))
	if err != nil {
		return ListResult{}, err
	}
	return ListResult{Count: result.Count, Results: result.Results}, nil
}

func listQuery(query ListQuery) listexec.Query {
	return listexec.Query{Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter}
}

func (s *Service) Report(
	ctx context.Context,
	actor *authz.Actor,
	query ReportQuery,
) (Report, error) {
	if err := requireRead(actor); err != nil {
		return Report{}, err
	}
	if query.CompanyID == uuid.Nil || query.AsOf.IsZero() {
		return Report{}, apierror.Validation("应收应付报表参数不合法", map[string][]string{
			"companyId": {"必填"}, "asOf": {"必填"},
		})
	}
	if !actor.CanAccessCompany(query.CompanyID) {
		return Report{}, apierror.New(apierror.CodeForbidden, "无权查看该公司数据")
	}
	q := dbgen.New(s.pool)
	accounts, err := q.ListGLPartyRoleAccounts(ctx, dbgen.ListGLPartyRoleAccountsParams{
		CompanyID: query.CompanyID, Roles: roles,
	})
	if err != nil {
		return Report{}, apierror.Wrap(apierror.CodeInternal, "读取往来科目失败", err)
	}
	result := Report{
		AsOf:         query.AsOf.Format(time.DateOnly),
		RoleAccounts: make(map[string][]RoleAccount),
		Rows:         []ReportRow{},
	}
	if len(accounts) == 0 {
		return result, nil
	}
	roleByAccount := make(map[uuid.UUID]string, len(accounts))
	accountIDs := make([]uuid.UUID, 0, len(accounts))
	for _, account := range accounts {
		role := account.Role.String
		roleByAccount[account.ID] = role
		accountIDs = append(accountIDs, account.ID)
		key := camel(role)
		result.RoleAccounts[key] = append(result.RoleAccounts[key], RoleAccount{
			ID: account.ID, Code: account.Code, Name: account.Name,
		})
	}
	balances, err := q.GLARAPBalances(ctx, dbgen.GLARAPBalancesParams{
		CompanyID: query.CompanyID, PostingDate: pgtype.Date{Time: query.AsOf, Valid: true},
		AccountIds: accountIDs,
	})
	if err != nil {
		return Report{}, apierror.Wrap(apierror.CodeInternal, "汇总应收应付余额失败", err)
	}
	grouped := make(map[partyKey]map[string]decimal.Decimal)
	for _, balance := range balances {
		key := partyKey{nil: balance.PartyID == nil}
		if balance.PartyType.Valid {
			key.kind = balance.PartyType.String
		}
		if balance.PartyID != nil {
			key.id = *balance.PartyID
		}
		if grouped[key] == nil {
			grouped[key] = zeroBalances()
		}
		role := roleByAccount[balance.AccountID]
		value := balance.Debit.Sub(balance.Credit)
		if !debitRoles[role] {
			value = value.Neg()
		}
		grouped[key][camel(role)] = grouped[key][camel(role)].Add(value)
	}
	labels, err := loadPartyLabels(ctx, q, grouped)
	if err != nil {
		return Report{}, err
	}
	for key, sums := range grouped {
		allZero := true
		for _, value := range sums {
			if !value.IsZero() {
				allZero = false
				break
			}
		}
		if allZero {
			continue
		}
		row := ReportRow{Balances: sums, PartyLabel: "未指定对手"}
		if !key.nil {
			kind, id := key.kind, key.id
			row.PartyType, row.PartyID = &kind, &id
			if label := labels[key]; label != "" {
				row.PartyLabel = label
			}
		}
		row.NetReceivable = sums["unbilledReceivable"].
			Add(sums["receivable"]).
			Sub(sums["advanceReceived"])
		row.NetPayable = sums["unbilledPayable"].
			Add(sums["payable"]).
			Add(sums["otherPayable"]).
			Sub(sums["advancePaid"])
		result.Rows = append(result.Rows, row)
	}
	sort.Slice(result.Rows, func(i, j int) bool {
		if result.Rows[i].PartyID == nil {
			return false
		}
		if result.Rows[j].PartyID == nil {
			return true
		}
		return result.Rows[i].PartyLabel < result.Rows[j].PartyLabel
	})
	return result, nil
}

func requireRead(actor *authz.Actor) error {
	if actor == nil || !actor.HasPermission("acc.gl_entry:read") {
		return apierror.New(apierror.CodeForbidden, "无权查看总账分录")
	}
	return nil
}

func fromRow(row dbgen.AccGlEntry) Entry {
	return Entry{
		ID: row.ID, Seq: row.Seq, PostingDate: row.PostingDate.Time,
		Debit: row.Debit, Credit: row.Credit,
		PartyType: pgconv.TextPtr(row.PartyType), PartyID: row.PartyID,
		VoucherType: row.VoucherType, VoucherID: row.VoucherID, VoucherNo: row.VoucherNo,
		IsCancelled: row.IsCancelled, IsReversed: row.IsReversed, IsReversal: row.IsReversal,
		Remarks: pgconv.TextPtr(row.Remarks), InsertedAt: row.InsertedAt.Time.UTC(),
		CompanyID: row.CompanyID, AccountID: row.AccountID, CurrencyID: row.CurrencyID,
	}
}

type scanner interface{ Scan(...any) error }

func scanEntry(row scanner) (Entry, error) {
	var item Entry
	var posting pgtype.Date
	var partyType, remarks pgtype.Text
	var inserted pgtype.Timestamp
	err := row.Scan(
		&item.ID, &item.Seq, &posting, &item.Debit, &item.Credit,
		&partyType, &item.PartyID, &item.VoucherType, &item.VoucherID,
		&item.VoucherNo, &item.IsCancelled, &remarks, &inserted,
		&item.CompanyID, &item.AccountID, &item.CurrencyID,
		&item.IsReversed, &item.IsReversal,
	)
	item.PostingDate = posting.Time
	item.PartyType = pgconv.TextPtr(partyType)
	item.Remarks = pgconv.TextPtr(remarks)
	item.InsertedAt = inserted.Time.UTC()
	return item, err
}

func camel(role string) string {
	var result []byte
	upper := false
	for i := 0; i < len(role); i++ {
		if role[i] == '_' {
			upper = true
			continue
		}
		if upper {
			result = append(result, role[i]-'a'+'A')
			upper = false
		} else {
			result = append(result, role[i])
		}
	}
	return string(result)
}

func zeroBalances() map[string]decimal.Decimal {
	result := make(map[string]decimal.Decimal, len(roles))
	for _, role := range roles {
		result[camel(role)] = decimal.Zero
	}
	return result
}

func loadPartyLabels(
	ctx context.Context,
	q *dbgen.Queries,
	grouped map[partyKey]map[string]decimal.Decimal,
) (map[partyKey]string, error) {
	ids := map[string][]uuid.UUID{
		"customer": {}, "supplier": {}, "company": {}, "employee": {},
	}
	for key := range grouped {
		if !key.nil {
			ids[key.kind] = append(ids[key.kind], key.id)
		}
	}
	rows, err := q.ListGLPartyLabels(ctx, dbgen.ListGLPartyLabelsParams{
		CustomerIds: ids["customer"], SupplierIds: ids["supplier"],
		CompanyIds: ids["company"], EmployeeIds: ids["employee"],
	})
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取往来对手名称失败", err)
	}
	result := make(map[partyKey]string, len(rows))
	for _, row := range rows {
		result[partyKey{kind: row.PartyType, id: row.ID}] = row.Name
	}
	return result, nil
}
