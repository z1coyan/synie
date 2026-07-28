package companyaccountdefault

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/optional"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresCompanyAccountDefaultLifecycleValidationAuditAndConcurrency(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	fixture := seedFixture(t, ctx, pool)
	t.Cleanup(func() { fixture.cleanup(pool) })
	service := NewService(pool)
	reader := fixture.actor("sales.setting:read")
	writer := fixture.actor("sales.setting:read", "sales.setting:update")
	outsider := &authz.Actor{
		UserID: uuid.New(), Username: "company-default-outsider",
		Permissions: map[string]struct{}{
			"sales.setting:read": {}, "sales.setting:update": {},
		},
		CompanyIDs: []uuid.UUID{fixture.otherCompanyID},
	}

	if _, err := service.Create(ctx, reader, CreateInput{CompanyID: fixture.companyID}); errorCode(err) != apierror.CodeForbidden {
		t.Fatalf("reader create error = %#v", err)
	}
	if _, err := service.Create(ctx, outsider, CreateInput{CompanyID: fixture.companyID}); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("out-of-scope create error = %#v", err)
	}
	if _, err := service.Create(ctx, writer, CreateInput{
		CompanyID: fixture.companyID, DeliveryDebitAccountID: &fixture.badRoleAccountID,
	}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("bad delivery debit role error = %#v", err)
	}
	if _, err := service.Create(ctx, writer, CreateInput{
		CompanyID: fixture.companyID, ReceiptCreditAccountID: &fixture.otherCompanyAccountID,
	}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("other-company receipt credit error = %#v", err)
	}
	if _, err := service.Create(ctx, writer, CreateInput{
		CompanyID: fixture.companyID, DeliveryCreditAccountID: &fixture.inactiveAccountID,
	}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("inactive delivery credit error = %#v", err)
	}
	if _, err := service.Create(ctx, writer, CreateInput{
		CompanyID: fixture.companyID, ReceiptDebitAccountID: &fixture.groupAccountID,
	}); errorCode(err) != apierror.CodeValidation {
		t.Fatalf("group receipt debit error = %#v", err)
	}

	item, err := service.Create(ctx, writer, CreateInput{
		CompanyID: fixture.companyID, DeliveryDebitAccountID: &fixture.deliveryDebitID,
		ReceiptDebitAccountID: &fixture.receiptDebitID,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.recordIDs = append(fixture.recordIDs, item.ID)
	if item.DeliveryDebitAccountID == nil || *item.DeliveryDebitAccountID != fixture.deliveryDebitID ||
		item.DeliveryCreditAccountID != nil {
		t.Fatalf("created = %#v", item)
	}
	if _, err := service.Get(ctx, outsider, item.ID); errorCode(err) != apierror.CodeNotFound {
		t.Fatalf("out-of-scope get error = %#v", err)
	}
	outsideList, err := service.List(ctx, outsider, ListQuery{Limit: 10})
	if err != nil || outsideList.Count != 0 || len(outsideList.Results) != 0 {
		t.Fatalf("out-of-scope list = %#v, %v", outsideList, err)
	}
	got, err := service.GetByCompany(ctx, reader, fixture.companyID)
	if err != nil || got.ID != item.ID {
		t.Fatalf("get by company = %#v, %v", got, err)
	}
	listed, err := service.List(ctx, reader, ListQuery{Limit: 10})
	if err != nil || listed.Count != 1 || len(listed.Results) != 1 || listed.Results[0].ID != item.ID {
		t.Fatalf("list = %#v, %v", listed, err)
	}
	if _, err := service.Create(ctx, writer, CreateInput{CompanyID: fixture.companyID}); errorCode(err) != apierror.CodeConflict {
		t.Fatalf("duplicate company error = %#v", err)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		_, updateErr := service.Update(ctx, writer, item.ID, UpdateInput{
			DeliveryCreditAccountID: optional.Optional[uuid.UUID]{Set: true, Value: &fixture.deliveryCreditID},
		})
		results <- updateErr
	}()
	go func() {
		<-start
		_, updateErr := service.Update(ctx, writer, item.ID, UpdateInput{
			ReceiptCreditAccountID: optional.Optional[uuid.UUID]{Set: true, Value: &fixture.receiptCreditID},
		})
		results <- updateErr
	}()
	close(start)
	if err := <-results; err != nil {
		t.Fatal(err)
	}
	if err := <-results; err != nil {
		t.Fatal(err)
	}
	updated, err := service.Get(ctx, reader, item.ID)
	if err != nil || updated.DeliveryCreditAccountID == nil ||
		*updated.DeliveryCreditAccountID != fixture.deliveryCreditID ||
		updated.ReceiptCreditAccountID == nil ||
		*updated.ReceiptCreditAccountID != fixture.receiptCreditID {
		t.Fatalf("concurrent updates lost a slot: %#v, %v", updated, err)
	}

	created := make(chan CompanyAccountDefault, 2)
	createErrors := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			row, createErr := service.Create(ctx, writer, CreateInput{CompanyID: fixture.concurrentCompanyID})
			created <- row
			createErrors <- createErr
		}()
	}
	wg.Wait()
	close(created)
	close(createErrors)
	successes, conflicts := 0, 0
	for row := range created {
		if row.ID != uuid.Nil {
			successes++
			fixture.recordIDs = append(fixture.recordIDs, row.ID)
		}
	}
	for createErr := range createErrors {
		switch errorCode(createErr) {
		case "":
		case apierror.CodeConflict:
			conflicts++
		default:
			t.Fatalf("concurrent create error = %#v", createErr)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent create successes=%d conflicts=%d", successes, conflicts)
	}

	cleared, err := service.Update(ctx, writer, item.ID, UpdateInput{
		DeliveryDebitAccountID:  optional.Optional[uuid.UUID]{Set: true},
		DeliveryCreditAccountID: optional.Optional[uuid.UUID]{Set: true},
		ReceiptDebitAccountID:   optional.Optional[uuid.UUID]{Set: true},
		ReceiptCreditAccountID:  optional.Optional[uuid.UUID]{Set: true},
	})
	if err != nil || cleared.DeliveryDebitAccountID != nil || cleared.DeliveryCreditAccountID != nil ||
		cleared.ReceiptDebitAccountID != nil || cleared.ReceiptCreditAccountID != nil {
		t.Fatalf("clear slots = %#v, %v", cleared, err)
	}
	var actions []string
	rows, err := pool.Query(ctx, `
		SELECT action_type, changes FROM sys_audit_log
		WHERE resource='sal_company_account_default' AND record_id=$1
		ORDER BY inserted_at,id
	`, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	var updateFields = map[string]bool{}
	for rows.Next() {
		var action string
		var changes []byte
		if err := rows.Scan(&action, &changes); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		actions = append(actions, action)
		if action == "update" {
			var decoded map[string]any
			if err := json.Unmarshal(changes, &decoded); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			for key := range decoded {
				updateFields[key] = true
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(actions, ",") != "create,update,update,update" {
		t.Fatalf("audit actions = %#v", actions)
	}
	if !updateFields["delivery_credit_account_id"] || !updateFields["receipt_credit_account_id"] {
		t.Fatalf("update audit fields = %#v", updateFields)
	}
}

type pgFixture struct {
	companyID, otherCompanyID, concurrentCompanyID uuid.UUID
	deliveryDebitID, deliveryCreditID              uuid.UUID
	receiptDebitID, receiptCreditID                uuid.UUID
	badRoleAccountID, otherCompanyAccountID        uuid.UUID
	inactiveAccountID, groupAccountID              uuid.UUID
	currencyID                                     uuid.UUID
	recordIDs                                      []uuid.UUID
}

func seedFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *pgFixture {
	t.Helper()
	suffix := strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	f := &pgFixture{}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_currency(name,iso_code,active) VALUES($1,$2,true) RETURNING id
	`, "默认科目测试币-"+suffix, "D"+suffix[:2]).Scan(&f.currencyID); err != nil {
		t.Fatal(err)
	}
	for code, target := range map[string]*uuid.UUID{
		"CD": &f.companyID, "OD": &f.otherCompanyID, "CC": &f.concurrentCompanyID,
	} {
		if err := pool.QueryRow(ctx, `
			INSERT INTO bas_company(code,name,short_name,base_currency_id)
			VALUES($1,$2,$3,$4) RETURNING id
		`, code+suffix, "默认科目测试公司-"+code+suffix, code+suffix, f.currencyID).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	f.deliveryDebitID = insertAccount(t, ctx, pool, f.companyID, "DD"+suffix, "unbilled_receivable", true, false)
	f.deliveryCreditID = insertAccount(t, ctx, pool, f.companyID, "DC"+suffix, "", true, false)
	f.receiptDebitID = insertAccount(t, ctx, pool, f.companyID, "RD"+suffix, "", true, false)
	f.receiptCreditID = insertAccount(t, ctx, pool, f.companyID, "RC"+suffix, "unbilled_payable", true, false)
	f.badRoleAccountID = insertAccount(t, ctx, pool, f.companyID, "BR"+suffix, "receivable", true, false)
	f.otherCompanyAccountID = insertAccount(t, ctx, pool, f.otherCompanyID, "OC"+suffix, "unbilled_payable", true, false)
	f.inactiveAccountID = insertAccount(t, ctx, pool, f.companyID, "IA"+suffix, "", false, false)
	f.groupAccountID = insertAccount(t, ctx, pool, f.companyID, "GA"+suffix, "", true, true)
	return f
}

func insertAccount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	companyID uuid.UUID,
	code, role string,
	active, isGroup bool,
) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	var roleValue any
	if role != "" {
		roleValue = role
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_account(code,name,direction,is_group,active,company_id,role)
		VALUES($1,$2,'debit',$3,$4,$5,$6) RETURNING id
	`, code, "测试科目-"+code, isGroup, active, companyID, roleValue).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *pgFixture) actor(permissions ...string) *authz.Actor {
	grants := make(map[string]struct{}, len(permissions))
	for _, permission := range permissions {
		grants[permission] = struct{}{}
	}
	return &authz.Actor{
		UserID: uuid.New(), Username: "company-default-pg-test",
		Permissions: grants, CompanyIDs: []uuid.UUID{f.companyID, f.concurrentCompanyID},
	}
}

func (f *pgFixture) cleanup(pool *pgxpool.Pool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	companyIDs := []uuid.UUID{f.companyID, f.otherCompanyID, f.concurrentCompanyID}
	_, _ = pool.Exec(ctx, `DELETE FROM sys_audit_log
		WHERE resource='sal_company_account_default' AND company_id=ANY($1::uuid[])`, companyIDs)
	_, _ = pool.Exec(ctx, `DELETE FROM sal_company_account_default WHERE company_id=ANY($1::uuid[])`, companyIDs)
	_, _ = pool.Exec(ctx, `DELETE FROM inv_warehouse WHERE company_id=ANY($1::uuid[])`, companyIDs)
	_, _ = pool.Exec(ctx, `DELETE FROM bas_account WHERE company_id=ANY($1::uuid[])`, companyIDs)
	_, _ = pool.Exec(ctx, `DELETE FROM bas_company WHERE id=ANY($1::uuid[])`, companyIDs)
	_, _ = pool.Exec(ctx, `DELETE FROM bas_currency WHERE id=$1`, f.currencyID)
}
