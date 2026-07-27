package setup

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/auth"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/testutil"
)

func TestPostgresSetupFirstUserConcurrencyCurrenciesAndComplete(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	// 本测试做全表清点与默认存储种子(全局单例改写),须与并行包的同类测试互斥
	testutil.GlobalSingletonLock(t, ctx, pool)

	var originalCompleted *time.Time
	if err := pool.QueryRow(ctx, `SELECT setup_completed_at FROM sys_setting ORDER BY id LIMIT 1`).Scan(&originalCompleted); err != nil {
		t.Fatal(err)
	}
	if originalCompleted != nil {
		t.Skip("real PostgreSQL setup test requires an uninitialized database")
	}
	var existingUsers bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sys_user)`).Scan(&existingUsers); err != nil {
		t.Fatal(err)
	}
	if existingUsers {
		t.Skip("real PostgreSQL setup test requires a database without users")
	}
	var existingCompanies bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bas_company)`).Scan(&existingCompanies); err != nil {
		t.Fatal(err)
	}
	if existingCompanies {
		t.Skip("real PostgreSQL setup test requires a database without companies")
	}
	var existingCategories bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM inv_material_category)`).Scan(&existingCategories); err != nil {
		t.Fatal(err)
	}
	if existingCategories {
		t.Skip("real PostgreSQL setup test requires a database without material categories")
	}

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	usernameA, usernameB := "setup_a_"+suffix, "setup_b_"+suffix
	existingStorageIDs, err := queryUUIDSet(ctx, pool, `SELECT id FROM sys_storage`)
	if err != nil {
		t.Fatal(err)
	}
	existingRuleIDs, err := queryUUIDSet(ctx, pool, `SELECT id FROM sys_numbering_rule`)
	if err != nil {
		t.Fatal(err)
	}
	existingUnitIDs, err := queryUUIDSet(ctx, pool, `SELECT id FROM bas_unit`)
	if err != nil {
		t.Fatal(err)
	}
	hasher := auth.NewPasswordHasher(auth.Argon2Params{Memory: 64, Iterations: 1, Parallelism: 1, SaltLength: 8, KeyLength: 16})
	service := NewService(pool, hasher, auth.NewTokenManager([]byte("setup-postgres-test-secret"), time.Hour))
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		_, _ = pool.Exec(cleanup, `DELETE FROM sys_user WHERE username::text = ANY($1)`, []string{usernameA, usernameB})
		_, _ = pool.Exec(cleanup, `UPDATE sys_setting SET setup_completed_at = NULL`)
		_, _ = pool.Exec(cleanup, `DELETE FROM sys_storage WHERE NOT (id = ANY($1))`, existingStorageIDs)
		_, _ = pool.Exec(cleanup, `DELETE FROM inv_material_category`)
		_, _ = pool.Exec(cleanup, `DELETE FROM sys_numbering_rule WHERE NOT (id = ANY($1))`, existingRuleIDs)
		_, _ = pool.Exec(cleanup, `DELETE FROM bas_unit WHERE NOT (id = ANY($1))`, existingUnitIDs)
	})

	inputs := []FirstUserInput{{Username: usernameA, Password: "secret-a"}, {Username: usernameB, Password: "secret-b"}}
	results := make([]FirstUserResult, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range inputs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = service.CreateFirstUser(ctx, inputs[i])
		}(i)
	}
	wg.Wait()
	successes, conflicts := 0, 0
	var winner FirstUserResult
	for i, err := range errs {
		if err == nil {
			successes++
			winner = results[i]
			continue
		}
		var appErr *apierror.Error
		if errors.As(err, &appErr) && appErr.Code == apierror.CodeConflict {
			conflicts++
		} else {
			t.Fatalf("unexpected create error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 || winner.Token == "" {
		t.Fatalf("successes=%d conflicts=%d token=%q errs=%v", successes, conflicts, winner.Token, errs)
	}
	var superAdmin, allCompanies bool
	if err := pool.QueryRow(ctx, `SELECT super_admin, all_companies FROM sys_user WHERE id = $1`, winner.User.ID).Scan(&superAdmin, &allCompanies); err != nil {
		t.Fatal(err)
	}
	if !superAdmin || !allCompanies {
		t.Fatalf("first user flags: super_admin=%v all_companies=%v", superAdmin, allCompanies)
	}

	created, err := service.SeedCommonCurrencies(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if created < 0 || created > len(commonCurrencies) {
		t.Fatalf("created=%d", created)
	}
	if second, err := service.SeedCommonCurrencies(ctx); err != nil || second != 0 {
		t.Fatalf("idempotent seed created=%d err=%v", second, err)
	}
	var cnyID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM bas_currency WHERE iso_code = 'CNY'`).Scan(&cnyID); err != nil {
		t.Fatal(err)
	}
	if err := service.ActivateBaseCurrency(ctx, cnyID); err != nil {
		t.Fatal(err)
	}
	var activeCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM bas_currency WHERE active`).Scan(&activeCount); err != nil {
		t.Fatal(err)
	}
	if activeCount != 1 {
		t.Fatalf("active currencies=%d", activeCount)
	}

	actor := &authz.Actor{UserID: winner.User.ID, Username: winner.User.Username, SuperAdmin: true, AllCompanies: true}
	// 无公司时 seedSampleData=true 应跳过示例并完成空白初始化
	if err := service.Complete(ctx, actor, "zh-CN", true); err != nil {
		t.Fatal(err)
	}
	var language string
	if err := pool.QueryRow(ctx, `SELECT preferred_language FROM sys_user WHERE id = $1`, winner.User.ID).Scan(&language); err != nil {
		t.Fatal(err)
	}
	if language != "zh-CN" {
		t.Fatalf("language=%q", language)
	}
	var completed *time.Time
	if err := pool.QueryRow(ctx, `SELECT setup_completed_at FROM sys_setting ORDER BY id LIMIT 1`).Scan(&completed); err != nil || completed == nil {
		t.Fatalf("completed=%v err=%v", completed, err)
	}
	var storage, rules, categories, units int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM sys_storage WHERE name='local'), (SELECT count(*) FROM sys_numbering_rule), (SELECT count(*) FROM inv_material_category), (SELECT count(*) FROM bas_unit)`).Scan(&storage, &rules, &categories, &units); err != nil {
		t.Fatal(err)
	}
	if storage < 1 || rules < 22 || categories < 1 || units < 1 {
		t.Fatalf("seed counts storage=%d rules=%d categories=%d units=%d", storage, rules, categories, units)
	}
}

func queryUUIDSet(ctx context.Context, pool *pgxpool.Pool, statement string) ([]uuid.UUID, error) {
	rows, err := pool.Query(ctx, statement)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
