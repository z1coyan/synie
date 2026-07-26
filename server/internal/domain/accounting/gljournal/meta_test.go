package gljournal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestMetaContractShape(t *testing.T) {
	journalNames := []string{}
	for _, field := range ResourceMeta().Fields {
		journalNames = append(journalNames, field.APIName)
	}
	if want := []string{
		"id", "voucherNo", "date", "postingDate", "remarks", "status",
		"submittedAt", "insertedAt", "updatedAt", "companyId", "createdById",
		"submittedById", "debitTotal", "creditTotal",
	}; !reflect.DeepEqual(journalNames, want) {
		t.Fatalf("journal fields = %v", journalNames)
	}
	lineNames := []string{}
	for _, field := range LineResourceMeta().Fields {
		lineNames = append(lineNames, field.APIName)
	}
	if want := []string{
		"id", "idx", "debit", "credit", "partyType", "partyId", "remarks",
		"insertedAt", "updatedAt", "journalId", "companyId", "accountId", "currencyId",
	}; !reflect.DeepEqual(lineNames, want) {
		t.Fatalf("line fields = %v", lineNames)
	}
	if ResourceMeta().DestroyMutation == nil ||
		*ResourceMeta().DestroyMutation != "destroyAccGlJournal" ||
		LineResourceMeta().DestroyMutation == nil ||
		*LineResourceMeta().DestroyMutation != "destroyAccGlJournalLine" {
		t.Fatal("destroy mutations do not match the captured contract")
	}
	actions := ResourceMeta().Actions
	if len(actions) != 6 || actions[4].Key != "audit" ||
		actions[4].Mutation != "auditAccGlJournal" || actions[5].Key != "cancel" ||
		actions[5].Mutation != "cancelAccGlJournal" || !actions[5].IsDanger {
		t.Fatalf("journal actions = %#v", actions)
	}
}

func TestMetaMatchesCapturedSnapshots(t *testing.T) {
	registry := meta.NewRegistry()
	registry.MustRegister(ResourceMeta())
	registry.MustRegister(LineResourceMeta())
	cases := []struct {
		resource string
		snapshot string
		actor    *authz.Actor
	}{
		{ResourceName, "accGlJournals.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{ResourceName, "accGlJournals.read-only.grid.json", &authz.Actor{
			Permissions: map[string]struct{}{"acc.gl_journal:read": {}},
		}},
		{LineResourceName, "accGlJournalLines.superadmin.grid.json", &authz.Actor{SuperAdmin: true}},
		{LineResourceName, "accGlJournalLines.read-only.grid.json", &authz.Actor{
			Permissions: map[string]struct{}{"acc.gl_journal:read": {}},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.snapshot, func(t *testing.T) {
			document, err := registry.BuildDocument(tc.resource, tc.actor)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join("..", "..", "..", "..", "..", ".scratch",
				"migration", "snapshots", "pr-2.12", tc.snapshot)
			raw, err := os.ReadFile(path)
			if os.IsNotExist(err) {
				t.Skip("repository .scratch snapshots are outside the mounted server module")
			}
			if err != nil {
				t.Fatal(err)
			}
			var want meta.GridMetaDTO
			if err := json.Unmarshal(raw, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(document.Grid, want) {
				gotJSON, _ := json.MarshalIndent(document.Grid, "", "  ")
				wantJSON, _ := json.MarshalIndent(want, "", "  ")
				t.Fatalf("captured GridMeta mismatch\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func TestSplitJournalLineFilter(t *testing.T) {
	accountID := uuid.New()
	filter, lines, err := splitJournalLineFilter(map[string]json.RawMessage{
		"status": json.RawMessage(`{"kind":"enum","values":["AUDITED"]}`),
		"lines": json.RawMessage(`{"accountId":{"eq":"` + accountID.String() +
			`"},"debit":{"greaterThan":"0"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(filter) != 1 || lines == nil || lines.accountID != accountID ||
		lines.side != "debit" || !lines.amount.IsZero() {
		t.Fatalf("ordinary=%v lines=%#v", filter, lines)
	}
}
