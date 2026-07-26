package numbering

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestPostgresConfiguredRuleDrivesNumbersAndEditableCounter(t *testing.T) {
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var currencyID uuid.UUID
	if err := pool.QueryRow(ctx, "SELECT id FROM bas_currency ORDER BY iso_code LIMIT 1").Scan(&currencyID); err != nil {
		t.Fatal(err)
	}
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	var companyID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO bas_company (code,name,short_name,base_currency_id)
		VALUES ($1,$2,$2,$3) RETURNING id
	`, "N"+suffix, "编号测试公司-"+suffix, currencyID).Scan(&companyID); err != nil {
		t.Fatal(err)
	}
	actor := &authz.Actor{UserID: uuid.New(), Username: "numbering-test"}
	var ruleID uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id=$1", actor.UserID)
		if ruleID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_numbering_rule WHERE id=$1", ruleID)
		}
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=$1", companyID)
	})

	service := NewService(pool)
	padding := 4
	dateFormat := "YYYYMM"
	rule, err := service.Create(ctx, actor, CreateInput{
		Resource: "acc.gl_journal",
		Name:     "凭证测试规则",
		Segments: []Segment{
			{Type: "text", Value: stringPointer("记")},
			{Type: "field", Field: stringPointer("company.code")},
			{Type: "text", Value: stringPointer("-")},
			{Type: "field", Field: stringPointer("date"), Format: &dateFormat},
			{Type: "text", Value: stringPointer("-")},
			{Type: "seq", Padding: &padding},
		},
		PerCompany: boolPointer(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	ruleID = rule.ID

	input := NextInput{
		Resource: "acc.gl_journal",
		Values: map[string]any{
			"company_id": companyID,
			"date":       time.Date(2026, time.July, 15, 0, 0, 0, 0, time.UTC),
		},
	}
	first, err := service.Next(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Next(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if first != "记N"+suffix+"-202607-0001" || second != "记N"+suffix+"-202607-0002" {
		t.Fatalf("numbers = %q, %q", first, second)
	}

	counters, err := service.ListCounters(ctx, CounterListQuery{RuleID: &rule.ID, Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	if counters.Count != 1 || len(counters.Results) != 1 ||
		counters.Results[0].ScopeKey != "N"+suffix+"|记N"+suffix+"-202607-" {
		t.Fatalf("counters = %#v", counters)
	}
	if _, err := service.UpdateCounter(ctx, actor, counters.Results[0].ID, 100); err != nil {
		t.Fatal(err)
	}
	next, err := service.Next(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if next != "记N"+suffix+"-202607-0101" {
		t.Fatalf("number after counter adjustment = %q", next)
	}
}

func stringPointer(value string) *string { return &value }
func boolPointer(value bool) *bool       { return &value }
