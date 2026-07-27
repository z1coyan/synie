package currency

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// currencyContractFixture 固化 basCurrencies 的创建/校验契约
// （原 contracts/fixtures/base/currency.json，迁入本包 testdata 并 fail-closed 消费）。
type currencyContractFixture struct {
	Resource         string `json:"resource"`
	PermissionPrefix string `json:"permissionPrefix"`
	Cases            []struct {
		Name            string         `json:"name"`
		Input           map[string]any `json:"input"`
		Expected        map[string]any `json:"expected"`
		InvalidISOCodes []string       `json:"invalidIsoCodes"`
		ISOCode         string         `json:"isoCode"`
		Error           string         `json:"error"`
	} `json:"cases"`
}

func loadCurrencyContractFixture(t *testing.T) currencyContractFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/fixtures/currency.json")
	if err != nil {
		t.Fatalf("currency 契约 fixture 缺失或不可读（fail-closed）: %v", err)
	}
	var fixture currencyContractFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Resource != ResourceName || fixture.PermissionPrefix != "base.currency" ||
		len(fixture.Cases) == 0 {
		t.Fatalf("fixture 约定头变更: %#v", fixture)
	}
	return fixture
}

// TestCurrencyContractFixtureStateless 覆盖 fixture 中无需数据库的用例：
// ISO 必须三位大写字母、ISO 创建后不可改（UpdateInput 结构上无 isoCode 入口）。
func TestCurrencyContractFixtureStateless(t *testing.T) {
	fixture := loadCurrencyContractFixture(t)
	var sawISOFormat, sawImmutable bool
	for _, tc := range fixture.Cases {
		switch {
		case len(tc.InvalidISOCodes) > 0:
			sawISOFormat = true
			for _, code := range tc.InvalidISOCodes {
				input := CreateInput{Name: "测试", ISOCode: code}
				err := validateCreate(&input)
				if err == nil {
					t.Fatalf("用例 %q: ISO %q 应被拒绝", tc.Name, code)
				}
				var apiErr *apierror.Error
				if !errors.As(err, &apiErr) || len(apiErr.Fields["isoCode"]) == 0 {
					t.Fatalf("用例 %q: ISO %q 缺少 isoCode 字段错误: %v", tc.Name, code, err)
				}
			}
		case tc.ISOCode != "":
			sawImmutable = true
			if _, ok := reflect.TypeOf(UpdateInput{}).FieldByName("ISOCode"); ok {
				t.Fatalf("用例 %q: UpdateInput 不得暴露 ISOCode（创建后不可改）", tc.Name)
			}
		}
	}
	if !sawISOFormat || !sawImmutable {
		t.Fatalf("fixture 用例覆盖缺失: isoFormat=%v immutable=%v", sawISOFormat, sawImmutable)
	}
}

// TestPostgresCurrencyContractFixture 覆盖 fixture 中需要真实数据库的用例：
// 创建默认启用且符号可空、可显式创建停用、ISO 唯一、公司本币不可停用。
func TestPostgresCurrencyContractFixture(t *testing.T) {
	url := os.Getenv("SYNIE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set SYNIE_TEST_DATABASE_URL to run the real PostgreSQL tests")
	}
	fixture := loadCurrencyContractFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	svc := NewService(pool)
	actor := &authz.Actor{UserID: uuid.New(), Username: "currency-fixture", SuperAdmin: true}
	// 生成纯大写字母后缀：fixture 字面量 ISO 码在共享测试库会冲突，
	// 且 ISO 校验只接受三位大写字母，因此用 UUID 字节映射到 A-Z。
	seed := uuid.New()
	letters := make([]byte, 4)
	for i := range letters {
		letters[i] = 'A' + seed[i]%26
	}
	suffix := string(letters)

	createdIDs := []uuid.UUID{}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		if _, err := pool.Exec(cleanupCtx,
			`DELETE FROM bas_company WHERE code LIKE 'FX' || $1 || '%'`, suffix); err != nil {
			t.Logf("cleanup companies: %v", err)
		}
		for _, id := range createdIDs {
			if _, err := pool.Exec(cleanupCtx,
				`DELETE FROM bas_currency WHERE id = $1`, id); err != nil {
				t.Logf("cleanup currency %s: %v", id, err)
			}
		}
	})
	// 每个用例分配独立的三位大写字母 ISO 码（fixture 字面量在共享库会冲突）。
	isoPool := []string{
		"X" + suffix[:2], "X" + suffix[2:], "Y" + suffix[:2], "Y" + suffix[2:], "Z" + suffix[:2],
	}
	isoIndex := 0
	nextISO := func() string {
		t.Helper()
		if isoIndex >= len(isoPool) {
			t.Fatal("fixture 用例数超出 ISO 码池")
		}
		code := isoPool[isoIndex]
		isoIndex++
		return code
	}
	create := func(name, isoCode string, active *bool) Currency {
		t.Helper()
		item, err := svc.Create(ctx, actor, CreateInput{
			Name: name + "-" + suffix, ISOCode: isoCode, Active: active,
		})
		if err != nil {
			t.Fatalf("创建货币 %s: %v", isoCode, err)
		}
		createdIDs = append(createdIDs, item.ID)
		return item
	}

	var sawDefaultActive, sawExplicitInactive, sawUnique, sawBaseCurrencyGuard bool
	for _, tc := range fixture.Cases {
		switch {
		case tc.Input != nil && tc.Expected != nil:
			var active *bool
			if raw, ok := tc.Input["active"]; ok {
				value, _ := raw.(bool)
				active = &value
			}
			// ISO 码在 fixture 中是共享字面量，测试库按后缀隔离改用独立码。
			isoCode := nextISO()
			item := create(tc.Name, isoCode, active)
			if want, ok := tc.Expected["active"].(bool); ok && item.Active != want {
				t.Fatalf("用例 %q: active = %v, want %v", tc.Name, item.Active, want)
			}
			if raw, ok := tc.Expected["symbol"]; ok && raw == nil && item.Symbol != nil {
				t.Fatalf("用例 %q: symbol = %v, want nil", tc.Name, *item.Symbol)
			}
			if active == nil {
				sawDefaultActive = true
			} else {
				sawExplicitInactive = true
			}
		case tc.ISOCode != "":
			sawUnique = true
			isoCode := nextISO()
			create(tc.Name, isoCode, nil)
			if _, err := svc.Create(ctx, actor, CreateInput{
				Name: tc.Name + "-重复-" + suffix, ISOCode: isoCode,
			}); err == nil {
				t.Fatalf("用例 %q: 重复 ISO %q 应被拒绝", tc.Name, isoCode)
			} else {
				var apiErr *apierror.Error
				if !errors.As(err, &apiErr) || apiErr.Code != apierror.CodeConflict {
					t.Fatalf("用例 %q: 重复 ISO 错误 = %v, want conflict", tc.Name, err)
				}
			}
		case tc.Error != "":
			sawBaseCurrencyGuard = true
			base := create(tc.Name, nextISO(), nil)
			if _, err := pool.Exec(ctx, `
				INSERT INTO bas_company (code, name, short_name, base_currency_id)
				VALUES ($1, $2, $2, $3)
			`, "FX"+suffix, "本币引用测试公司-"+suffix, base.ID); err != nil {
				t.Fatal(err)
			}
			inactive := false
			_, err := svc.Update(ctx, actor, base.ID, UpdateInput{Active: &inactive})
			if err == nil {
				t.Fatalf("用例 %q: 公司本币应不可停用", tc.Name)
			}
			var apiErr *apierror.Error
			if !errors.As(err, &apiErr) ||
				!slices.Contains(apiErr.Fields["active"], tc.Error) {
				t.Fatalf("用例 %q: 错误 = %v, want active 字段含 %q", tc.Name, err, tc.Error)
			}
		}
	}
	if !sawDefaultActive || !sawExplicitInactive || !sawUnique || !sawBaseCurrencyGuard {
		t.Fatalf("fixture 用例覆盖缺失: default=%v inactive=%v unique=%v guard=%v",
			sawDefaultActive, sawExplicitInactive, sawUnique, sawBaseCurrencyGuard)
	}
}
