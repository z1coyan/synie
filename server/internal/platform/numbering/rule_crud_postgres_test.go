package numbering

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestPostgresRuleCRUDSearchAndCascadeCounters(t *testing.T) {
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
	service := NewService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "numbering-crud-test"}
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	var ruleID uuid.UUID
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id=$1", actor.UserID)
		if ruleID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_numbering_rule WHERE id=$1", ruleID)
		}
	})

	padding := 3
	rule, err := service.Create(ctx, actor, CreateInput{
		Resource: "mfg.operation",
		Name:     "工序规则-" + suffix,
		Segments: []Segment{
			{Type: "text", Value: stringPointer("OP-")},
			{Type: "field", Field: stringPointer("name")},
			{Type: "text", Value: stringPointer("-")},
			{Type: "seq", Padding: &padding},
		},
		PerCompany: boolPointer(false),
		Enabled:    boolPointer(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	ruleID = rule.ID

	got, err := service.GetRule(ctx, rule.ID)
	if err != nil || got.Resource != "mfg.operation" || got.Name != rule.Name {
		t.Fatalf("GetRule = %#v, %v", got, err)
	}
	filter := map[string]json.RawMessage{
		"enabled": json.RawMessage(`{"kind":"bool","eq":false}`),
	}
	list, err := service.ListRules(ctx, RuleListQuery{
		Limit: 20, Search: suffix, Filter: filter,
	})
	if err != nil {
		t.Fatal(err)
	}
	if list.Count != 1 || len(list.Results) != 1 || list.Results[0].ID != rule.ID {
		t.Fatalf("ListRules = %#v", list)
	}

	updatedName := "工序新规则-" + suffix
	updated, err := service.UpdateRule(ctx, actor, rule.ID, UpdateInput{
		Name:    &updatedName,
		Enabled: boolPointer(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Resource != rule.Resource || updated.Name != updatedName || !updated.Enabled {
		t.Fatalf("UpdateRule = %#v", updated)
	}
	number, err := service.Next(ctx, NextInput{
		Resource: "mfg.operation", Values: map[string]any{"name": "车削"},
	})
	if err != nil || number != "OP-车削-001" {
		t.Fatalf("Next = %q, %v", number, err)
	}

	deletedID := rule.ID
	if err := service.DeleteRule(ctx, actor, deletedID); err != nil {
		t.Fatal(err)
	}
	ruleID = uuid.Nil
	if _, err := service.GetRule(ctx, deletedID); errorCodeForNumbering(err) != apierror.CodeNotFound {
		t.Fatalf("GetRule after delete error = %#v", err)
	}
	var counters, auditRows int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM sys_numbering_counter WHERE rule_id=$1", deletedID).Scan(&counters); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE actor_id=$1 AND resource='sys_numbering_rule' AND record_id=$2
	`, actor.UserID, deletedID).Scan(&auditRows); err != nil {
		t.Fatal(err)
	}
	if counters != 0 || auditRows != 3 {
		t.Fatalf("cascade/audit rows: counters=%d audit=%d", counters, auditRows)
	}
}

func errorCodeForNumbering(err error) apierror.Code {
	var appErr *apierror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}
