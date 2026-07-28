package listexec_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
	"github.com/z1coyan/synie/server/internal/testutil"
)

// accountResource 是测试用的最小 bas_account 资源 meta。
func accountResource() meta.ResourceMeta {
	return meta.ResourceMeta{
		Name: "listexecTestAccounts", PermissionPrefix: "test.account",
		PermissionLabel: "测试科目", Table: "bas_account",
		Fields: []meta.FieldMeta{
			meta.IDField(),
			meta.Field("code", "code", meta.TypeString, "编码", true, true, false),
			meta.Field("name", "name", meta.TypeString, "名称", true, true, false),
			meta.RefField("company_id", "companyId", "公司", meta.Ref("basCompanies", "company", "name"), false),
		},
	}
}

type accountRow struct {
	ID   uuid.UUID
	Code string
	Name string
}

func scanAccountRow(rows pgx.Rows) (accountRow, error) {
	var row accountRow
	if err := rows.Scan(&row.ID, &row.Code, &row.Name); err != nil {
		return accountRow{}, err
	}
	return row, nil
}

// TestListAgainstRealPostgres 验证执行器的 count/分页/公司隔离语义（含空集合
// 语义：无可见公司时结果为空）。
func TestListAgainstRealPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)

	suffix := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
	var cnyID, companyA, companyB uuid.UUID
	var err error
	if err = pool.QueryRow(ctx, `
INSERT INTO bas_currency (name, iso_code, symbol)
VALUES ($1, $2, '¥') RETURNING id
`, "listexec-"+suffix, "LX"+strings.ToUpper(suffix[:6])).Scan(&cnyID); err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"LA" + suffix, "LB" + suffix} {
		var id uuid.UUID
		if err = pool.QueryRow(ctx, `
INSERT INTO bas_company (code, name, short_name, base_currency_id)
VALUES ($1, $2, $2, $3) RETURNING id
`, code, "listexec公司-"+suffix, cnyID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if companyA == uuid.Nil {
			companyA = id
		} else {
			companyB = id
		}
	}
	for i, companyID := range []uuid.UUID{companyA, companyA, companyB} {
		if _, err = pool.Exec(ctx, `
INSERT INTO bas_account (code, name, direction, company_id)
VALUES ($1, $2, 'debit', $3)
`, "AC"+suffix+string(rune('0'+i)), "listexec科目-"+suffix, companyID); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_account WHERE name LIKE $1`, "listexec科目-"+suffix)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_company WHERE id = ANY($1::uuid[])`, []uuid.UUID{companyA, companyB})
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM bas_currency WHERE id = $1`, cnyID)
	})

	spec := func(actor *authz.Actor) listexec.Spec[accountRow] {
		return listexec.Spec[accountRow]{
			Pool: pool, Resource: accountResource(), Label: "测试科目", Actor: actor,
			Source:       ` FROM bas_account`,
			Select:       `SELECT id, code, name`,
			DefaultOrder: ` ORDER BY "code" ASC, "id" ASC`,
			Tiebreaker:   `, "id" ASC`,
			Scan:         scanAccountRow,
		}
	}

	actorA := &authz.Actor{UserID: uuid.New(), Username: "listexec-a", CompanyIDs: []uuid.UUID{companyA}}
	result, err := listexec.List(ctx, spec(actorA), listexec.Query{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if result.Count != 2 || len(result.Results) != 2 {
		t.Fatalf("公司A应见2条, 得到 count=%d n=%d", result.Count, len(result.Results))
	}

	// 空集合语义：无可见公司时结果为空（永假条件）。
	emptyActor := &authz.Actor{UserID: uuid.New(), Username: "listexec-empty"}
	empty, err := listexec.List(ctx, spec(emptyActor), listexec.Query{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if empty.Count != 0 || len(empty.Results) != 0 {
		t.Fatalf("无可见公司应为空, 得到 count=%d n=%d", empty.Count, len(empty.Results))
	}

	// 分页边界：Limit 上限校验单点化。
	if _, err = listexec.List(ctx, spec(actorA), listexec.Query{Limit: 201}); err == nil {
		t.Fatal("Limit=201 应报分页错误")
	}
	// 默认 Limit：Limit==0 按 20 处理且合法。
	if _, err = listexec.List(ctx, spec(actorA), listexec.Query{}); err != nil {
		t.Fatalf("默认分页应合法: %v", err)
	}
	// 分页：Limit=1 Offset=1 取第二条。
	page, err := listexec.List(ctx, spec(actorA), listexec.Query{Limit: 1, Offset: 1})
	if err != nil {
		t.Fatal(err)
	}
	if page.Count != 2 || len(page.Results) != 1 {
		t.Fatalf("分页结果不符: count=%d n=%d", page.Count, len(page.Results))
	}
}
