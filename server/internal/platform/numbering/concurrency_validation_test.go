package numbering

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestValidateCreateRejectsInvalidPublicSegments(t *testing.T) {
	paddingMinusOne := -1
	dateField := "date"
	nameField := "name"
	format := "YYYY"
	cases := []struct {
		name     string
		resource string
		segments []Segment
	}{
		{name: "unknown resource", resource: "not.real", segments: validSegments()},
		{name: "empty text", resource: "acc.gl_journal", segments: []Segment{
			{Type: "text", Value: stringPointer("")}, {Type: "seq"},
		}},
		{name: "missing sequence", resource: "acc.gl_journal", segments: []Segment{
			{Type: "text", Value: stringPointer("J-")},
		}},
		{name: "duplicate sequence", resource: "acc.gl_journal", segments: []Segment{
			{Type: "seq"}, {Type: "seq"},
		}},
		{name: "negative padding", resource: "acc.gl_journal", segments: []Segment{
			{Type: "seq", Padding: &paddingMinusOne},
		}},
		{name: "unknown field", resource: "acc.gl_journal", segments: []Segment{
			{Type: "field", Field: stringPointer("notReal")}, {Type: "seq"},
		}},
		{name: "date missing format", resource: "acc.gl_journal", segments: []Segment{
			{Type: "field", Field: &dateField}, {Type: "seq"},
		}},
		{name: "non-date with format", resource: "mfg.operation", segments: []Segment{
			{Type: "field", Field: &nameField, Format: &format}, {Type: "seq"},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateCreate(&CreateInput{
				Resource: tc.resource, Name: "边界测试", Segments: tc.segments,
			}, loadCatalog())
			if errorCodeForNumbering(err) != apierror.CodeValidation {
				t.Fatalf("error = %#v", err)
			}
		})
	}
}

func TestPostgresConcurrentNextReturnsUniqueGapTolerantSequence(t *testing.T) {
	pool, ctx := numberingTestPool(t)
	service := NewService(pool)
	resource := unusedEnabledResource(t, ctx, pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "numbering-concurrency"}
	padding := 2
	rule, err := service.Create(ctx, actor, CreateInput{
		Resource: resource, Name: "并发取号-" + uuid.NewString(),
		Segments:   []Segment{{Type: "text", Value: stringPointer("NC-")}, {Type: "seq", Padding: &padding}},
		PerCompany: boolPointer(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupNumberingRules(t, pool, actor.UserID, []uuid.UUID{rule.ID})

	const workers = 20
	start := make(chan struct{})
	numbers := make(chan string, workers)
	errs := make(chan error, workers)
	var wait sync.WaitGroup
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			number, nextErr := service.Next(context.Background(), NextInput{Resource: resource})
			if nextErr != nil {
				errs <- nextErr
				return
			}
			numbers <- number
		}()
	}
	close(start)
	wait.Wait()
	close(numbers)
	close(errs)
	for err := range errs {
		t.Errorf("Next error: %v", err)
	}
	seen := make(map[string]struct{}, workers)
	for number := range numbers {
		seen[number] = struct{}{}
	}
	if len(seen) != workers {
		t.Fatalf("unique numbers = %d, values = %#v", len(seen), seen)
	}
	for index := 1; index <= workers; index++ {
		expected := fmt.Sprintf("NC-%02d", index)
		if _, ok := seen[expected]; !ok {
			t.Fatalf("missing %q, values = %#v", expected, seen)
		}
	}
}

func TestPostgresConcurrentEnabledRuleCreationAllowsExactlyOne(t *testing.T) {
	pool, ctx := numberingTestPool(t)
	service := NewService(pool)
	resource := unusedEnabledResource(t, ctx, pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "numbering-unique"}
	prefix := "并发唯一-" + uuid.NewString()
	start := make(chan struct{})
	results := make(chan Rule, 2)
	errs := make(chan error, 2)
	var wait sync.WaitGroup
	for index := range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			rule, createErr := service.Create(context.Background(), actor, CreateInput{
				Resource: resource, Name: fmt.Sprintf("%s-%d", prefix, index),
				Segments: validSegments(), PerCompany: boolPointer(false),
			})
			if createErr != nil {
				errs <- createErr
				return
			}
			results <- rule
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	close(errs)
	created := make([]uuid.UUID, 0, 1)
	for rule := range results {
		created = append(created, rule.ID)
	}
	cleanupNumberingRules(t, pool, actor.UserID, created)
	conflicts := 0
	for err := range errs {
		var appErr *apierror.Error
		if errors.As(err, &appErr) && appErr.Code == apierror.CodeConflict {
			conflicts++
			continue
		}
		t.Errorf("unexpected create error: %v", err)
	}
	if len(created) != 1 || conflicts != 1 {
		t.Fatalf("created=%d conflicts=%d", len(created), conflicts)
	}
}

func validSegments() []Segment {
	return []Segment{
		{Type: "text", Value: stringPointer("N-")},
		{Type: "seq"},
	}
}

func numberingTestPool(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, ctx
}

func unusedEnabledResource(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	for _, resource := range loadCatalog().PublicResources() {
		var count int
		if err := pool.QueryRow(ctx,
			"SELECT count(*) FROM sys_numbering_rule WHERE resource=$1 AND enabled=true",
			resource.Prefix,
		).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 0 {
			return resource.Prefix
		}
	}
	t.Skip("test database has enabled rules for every numberable resource")
	return ""
}

func cleanupNumberingRules(
	t *testing.T,
	pool *pgxpool.Pool,
	actorID uuid.UUID,
	ruleIDs []uuid.UUID,
) {
	t.Helper()
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE actor_id=$1", actorID)
		if len(ruleIDs) > 0 {
			_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_numbering_rule WHERE id=ANY($1)", ruleIDs)
		}
	})
}
