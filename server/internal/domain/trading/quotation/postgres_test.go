package quotation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/platform/optional"
	"github.com/z1coyan/synie/server/internal/testutil"
)

type quotationNumberer struct {
	value string
}

func (n quotationNumberer) NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error) {
	return n.value, nil
}

type quotationFixture struct {
	pool                               *pgxpool.Pool
	companyID, otherCompanyID          uuid.UUID
	userID, currencyID                 uuid.UUID
	customerID, otherCustomerID        uuid.UUID
	supplierID                         uuid.UUID
	categoryID                         uuid.UUID
	unitID, alternateUnitID, badUnitID uuid.UUID
	materialID, customerMaterialID     uuid.UUID
	suffix                             string
}

func TestPostgresQuotationSalesLifecycleSnapshotsFiltersAndFreeze(t *testing.T) {
	f := newQuotationFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	actor := quotationActor(f, SideSales)
	service := NewService(f.pool, quotationNumberer{value: "SQ-" + f.suffix})
	quotationDate := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	validUntil := quotationDate.AddDate(0, 1, 0)
	head, err := service.CreateQuotation(ctx, actor, SideSales, CreateQuotationInput{
		CompanyID: f.companyID, QuotationDate: &quotationDate, ValidUntil: validUntil,
		PartyType: "CUSTOMER", PartyID: f.customerID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if head.QuotationNo != "SQ-"+f.suffix || head.Status != StatusDraft ||
		head.CurrencyID != f.currencyID || head.PartyType != "CUSTOMER" ||
		head.CreatedByID == nil || *head.CreatedByID != f.userID {
		t.Fatalf("created sales quotation = %#v", head)
	}
	headList, err := service.ListQuotations(ctx, actor, SideSales, ListQuery{
		Limit: 20,
		Filter: map[string]json.RawMessage{
			"status":        json.RawMessage(`{"kind":"enum","values":["DRAFT"]}`),
			"companyId":     fkFilter(f.companyID),
			"partyType":     json.RawMessage(`{"kind":"enum","values":["CUSTOMER"]}`),
			"partyId":       fkFilter(f.customerID),
			"quotationDate": json.RawMessage(`{"kind":"date","op":"between","gte":"2026-07-01"}`),
			"validUntil":    json.RawMessage(`{"kind":"date","op":"between","lte":"2026-08-01"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if headList.Count != 1 || headList.Results[0].ID != head.ID {
		t.Fatalf("structured quotation filters = %#v", headList)
	}
	fixedPrice := decimal.RequireFromString("12.50")
	fixed, err := service.CreateItem(ctx, actor, SideSales, CreateItemInput{
		QuotationID: head.ID, Idx: 1, MaterialID: f.materialID, UnitID: f.alternateUnitID,
		PricingMode: PricingFixed, Price: &fixedPrice,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fixed.Price == nil || !fixed.Price.Equal(fixedPrice) ||
		fixed.MaterialCode != "M"+f.suffix || fixed.MaterialName != "报价测试物料-"+f.suffix ||
		fixed.UnitName != "报价测试箱-"+f.suffix || fixed.CompanyID != f.companyID {
		t.Fatalf("fixed item snapshots = %#v", fixed)
	}
	tiered, err := service.CreateItem(ctx, actor, SideSales, CreateItemInput{
		QuotationID: head.ID, Idx: 2, MaterialID: f.customerMaterialID, UnitID: f.unitID,
		PricingMode: PricingQtyTiered,
	})
	if err != nil {
		t.Fatal(err)
	}
	if tiered.Price != nil || tiered.CustomerPartNo == nil ||
		*tiered.CustomerPartNo != "CP-"+f.suffix {
		t.Fatalf("tiered item snapshots = %#v", tiered)
	}
	tier, err := service.CreateTier(ctx, actor, SideSales, CreateTierInput{
		ItemID: tiered.ID, MinQty: decimal.NewFromInt(10), Price: decimal.NewFromInt(8),
	})
	if err != nil {
		t.Fatal(err)
	}
	itemList, err := service.ListItems(ctx, actor, SideSales, ListQuery{
		Limit: 20,
		Filter: map[string]json.RawMessage{
			"quotationStatus": json.RawMessage(`{"kind":"enum","values":["DRAFT"]}`),
			"companyId":       fkFilter(f.companyID),
			"partyType":       json.RawMessage(`{"kind":"enum","values":["CUSTOMER"]}`),
			"partyId":         fkFilter(f.customerID),
			"quotationDate":   json.RawMessage(`{"kind":"date","op":"between","lte":"2026-07-01"}`),
			"validUntil":      json.RawMessage(`{"kind":"date","op":"between","gte":"2026-08-01"}`),
			"currencyId":      fkFilter(f.currencyID),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if itemList.Count != 2 || itemList.Results[1].TierCount != 1 {
		t.Fatalf("derived item filters = %#v", itemList)
	}
	newPrice := decimal.NewFromInt(9)
	mode := PricingFixed
	tiered, err = service.UpdateItem(ctx, actor, SideSales, tiered.ID, UpdateItemInput{
		PricingMode: &mode, Price: decimalValuePtr(newPrice),
	})
	if err != nil {
		t.Fatal(err)
	}
	var tierCount int
	if err := f.pool.QueryRow(ctx, "SELECT count(*) FROM sal_quotation_tier WHERE item_id=$1", tiered.ID).
		Scan(&tierCount); err != nil || tierCount != 0 {
		t.Fatalf("fixed-mode tier purge count=%d err=%v", tierCount, err)
	}
	if _, err := service.GetTier(ctx, actor, SideSales, tier.ID); quotationErrorCode(err) != apierror.CodeNotFound {
		t.Fatalf("purged tier get error = %#v", err)
	}
	mode = PricingQtyTiered
	tiered, err = service.UpdateItem(ctx, actor, SideSales, tiered.ID, UpdateItemInput{
		PricingMode: &mode,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuditQuotation(ctx, actor, SideSales, head.ID); quotationErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("missing tier audit error = %#v", err)
	}
	if _, err := service.CreateTier(ctx, actor, SideSales, CreateTierInput{
		ItemID: tiered.ID, MinQty: decimal.NewFromInt(1), Price: decimal.NewFromInt(10),
	}); err != nil {
		t.Fatal(err)
	}
	newCurrency := uuid.New()
	if _, err := service.UpdateQuotation(ctx, actor, SideSales, head.ID,
		UpdateQuotationInput{CurrencyID: &newCurrency}); quotationErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("head freeze error = %#v", err)
	}
	type auditResult struct {
		item Quotation
		err  error
	}
	start := make(chan struct{})
	results := make(chan auditResult, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			item, auditErr := service.AuditQuotation(ctx, actor, SideSales, head.ID)
			results <- auditResult{item: item, err: auditErr}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for result := range results {
		switch quotationErrorCode(result.err) {
		case "":
			successes++
			head = result.item
		case apierror.CodeConflict:
			conflicts++
		default:
			t.Fatalf("unexpected concurrent audit error: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent audit successes=%d conflicts=%d", successes, conflicts)
	}
	if head.Status != StatusAudited || head.AuditedAt == nil ||
		head.AuditedByID == nil || *head.AuditedByID != f.userID {
		t.Fatalf("audited quotation = %#v", head)
	}
	var auditCount int
	if err := f.pool.QueryRow(ctx, `
		SELECT count(*) FROM sys_audit_log
		WHERE company_id=$1 AND record_id=$2 AND action_name='audit'
	`, f.companyID, head.ID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("concurrent audit log count=%d err=%v", auditCount, err)
	}
	if _, err := service.UpdateItem(ctx, actor, SideSales, fixed.ID,
		UpdateItemInput{Idx: &fixed.Idx}); quotationErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("audited item update error = %#v", err)
	}
	head, err = service.VoidQuotation(ctx, actor, SideSales, head.ID)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != StatusVoided {
		t.Fatalf("voided quotation = %#v", head)
	}
	var actions []string
	rows, err := f.pool.Query(ctx, `
		SELECT action_name FROM sys_audit_log
		WHERE company_id=$1 AND record_id=ANY($2::uuid[])
	`, f.companyID, []uuid.UUID{head.ID, fixed.ID, tiered.ID, tier.ID})
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			t.Fatal(err)
		}
		actions = append(actions, action)
	}
	rows.Close()
	for _, required := range []string{"create", "purge", "audit", "void"} {
		if !hasString(actions, required) {
			t.Fatalf("audit actions %v missing %s", actions, required)
		}
	}
}

func TestPostgresQuotationPurchaseAndSalesCustomerMaterialRulesAndScope(t *testing.T) {
	f := newQuotationFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	service := NewService(f.pool, quotationNumberer{value: "Q-" + f.suffix})
	date := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	salesActor := quotationActor(f, SideSales)
	sales, err := service.CreateQuotation(ctx, salesActor, SideSales, CreateQuotationInput{
		CompanyID: f.companyID, QuotationDate: &date, ValidUntil: date,
		PartyType: "customer", PartyID: f.otherCustomerID,
		QuotationNo: stringPtr("SQ-RULE-" + f.suffix),
	})
	if err != nil {
		t.Fatal(err)
	}
	price := decimal.NewFromInt(1)
	if _, err := service.CreateItem(ctx, salesActor, SideSales, CreateItemInput{
		QuotationID: sales.ID, Idx: 1, MaterialID: f.customerMaterialID,
		UnitID: f.unitID, PricingMode: PricingFixed, Price: &price,
	}); quotationErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("other customer material error = %#v", err)
	}
	if _, err := service.CreateItem(ctx, salesActor, SideSales, CreateItemInput{
		QuotationID: sales.ID, Idx: 1, MaterialID: f.materialID,
		UnitID: f.badUnitID, PricingMode: PricingFixed, Price: &price,
	}); quotationErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("unavailable unit error = %#v", err)
	}
	purchaseActor := quotationActor(f, SidePurchase)
	purchase, err := service.CreateQuotation(ctx, purchaseActor, SidePurchase, CreateQuotationInput{
		CompanyID: f.companyID, QuotationDate: &date, ValidUntil: date,
		PartyType: "SUPPLIER", PartyID: f.supplierID,
		QuotationNo: stringPtr("PQ-" + f.suffix),
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := service.CreateItem(ctx, purchaseActor, SidePurchase, CreateItemInput{
		QuotationID: purchase.ID, Idx: 1, MaterialID: f.customerMaterialID,
		UnitID: f.unitID, PricingMode: PricingFixed, Price: &price,
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.CustomerPartNo == nil || *item.CustomerPartNo != "CP-"+f.suffix {
		t.Fatalf("purchase customer-material snapshot = %#v", item)
	}
	outsider := &authz.Actor{
		Permissions: map[string]struct{}{"purchase.quotation:*": {}},
		CompanyIDs:  []uuid.UUID{f.otherCompanyID},
	}
	if _, err := service.GetQuotation(ctx, outsider, SidePurchase, purchase.ID); quotationErrorCode(err) != apierror.CodeNotFound {
		t.Fatalf("cross-company get error = %#v", err)
	}
	list, err := service.ListQuotations(ctx, outsider, SidePurchase, ListQuery{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if list.Count != 0 {
		t.Fatalf("cross-company list = %#v", list)
	}
	emptyScope := &authz.Actor{
		Permissions: map[string]struct{}{"purchase.quotation:*": {}},
	}
	list, err = service.ListQuotations(ctx, emptyScope, SidePurchase, ListQuery{
		Limit: 20,
		Filter: map[string]json.RawMessage{
			"companyId": fkFilter(f.companyID),
		},
	})
	if err != nil {
		t.Fatalf("empty company scope with filter: %v", err)
	}
	if list.Count != 0 {
		t.Fatalf("empty company scope list = %#v", list)
	}
	if _, err := service.GetQuotation(ctx, &authz.Actor{}, SidePurchase, purchase.ID); quotationErrorCode(err) != apierror.CodeForbidden {
		t.Fatalf("missing permission error = %#v", err)
	}
	purchase, err = service.AuditQuotation(ctx, purchaseActor, SidePurchase, purchase.ID)
	if err != nil || purchase.Status != StatusAudited {
		t.Fatalf("purchase audit = %#v, err=%v", purchase, err)
	}
}

func newQuotationFixture(t *testing.T) quotationFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := testutil.NewPool(t, ctx)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	f := quotationFixture{
		pool: pool, companyID: uuid.New(), otherCompanyID: uuid.New(),
		userID: uuid.New(), currencyID: uuid.New(),
		customerID: uuid.New(), otherCustomerID: uuid.New(), supplierID: uuid.New(),
		categoryID: uuid.New(), unitID: uuid.New(), alternateUnitID: uuid.New(),
		badUnitID: uuid.New(), materialID: uuid.New(), customerMaterialID: uuid.New(),
		suffix: suffix,
	}
	batch := &pgx.Batch{}
	batch.Queue(`INSERT INTO bas_currency(id,name,iso_code,active) VALUES($1,$2,$3,true)`,
		f.currencyID, "报价测试币-"+suffix, "Q"+suffix)
	batch.Queue(`INSERT INTO bas_company(id,code,name,short_name,base_currency_id)
		VALUES($1,$2,$3,$3,$4),($5,$6,$7,$7,$4)`,
		f.companyID, "Q"+suffix, "报价测试公司-"+suffix, f.currencyID,
		f.otherCompanyID, "O"+suffix, "其他报价测试公司-"+suffix)
	batch.Queue(`INSERT INTO sys_user(id,username,name,hashed_password,super_admin,all_companies)
		VALUES($1,$2,$3,'test',false,false)`,
		f.userID, "quotation-"+suffix, "报价测试用户-"+suffix)
	batch.Queue(`INSERT INTO sal_customers(id,code,name) VALUES
		($1,$2,$3),($4,$5,$6)`,
		f.customerID, "C"+suffix, "报价测试客户-"+suffix,
		f.otherCustomerID, "D"+suffix, "其他报价测试客户-"+suffix)
	batch.Queue(`INSERT INTO pur_supplier(id,code,name) VALUES($1,$2,$3)`,
		f.supplierID, "S"+suffix, "报价测试供应商-"+suffix)
	// unit_type 取每次运行唯一值:bas_unit 对 is_base=true 有全库唯一的
	// 每类型一行约束,字面量类型会与并行包撞唯一索引(与 order/standard 同一约定)。
	batch.Queue(`INSERT INTO bas_unit(id,unit_type,is_base,name,symbol,ratio) VALUES
		($1,$10,true,$2,$3,1),($4,$10,false,$5,$6,10),
		($7,$10,false,$8,$9,1)`,
		f.unitID, "报价测试个-"+suffix, "EA"+suffix,
		f.alternateUnitID, "报价测试箱-"+suffix, "BOX"+suffix,
		f.badUnitID, "报价测试错误单位-"+suffix, "BAD"+suffix, "quotation-"+suffix)
	batch.Queue(`INSERT INTO inv_material_category(id,code,name,is_leaf,active)
		VALUES($1,$2,$3,true,true)`,
		f.categoryID, "MC"+suffix, "报价测试分类-"+suffix)
	batch.Queue(`INSERT INTO inv_material(
		id,code,name,spec,category_id,default_unit_id,is_customer_material,customer_id
	) VALUES($1,$2,$3,$4,$5,$6,false,NULL),
		($7,$8,$9,$10,$5,$6,true,$11)`,
		f.materialID, "M"+suffix, "报价测试物料-"+suffix, "SPEC-"+suffix,
		f.categoryID, f.unitID,
		f.customerMaterialID, "CM"+suffix, "报价测试客户物料-"+suffix, "CSPEC-"+suffix,
		f.customerID)
	batch.Queue(`UPDATE inv_material SET customer_part_no=$2 WHERE id=$1`,
		f.customerMaterialID, "CP-"+suffix)
	batch.Queue(`INSERT INTO inv_material_unit(material_id,unit_id,factor) VALUES($1,$2,10)`,
		f.materialID, f.alternateUnitID)
	results := pool.SendBatch(ctx, batch)
	if err := results.Close(); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_audit_log WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_quotation WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM pur_quotation WHERE company_id=$1", f.companyID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_unit WHERE material_id=ANY($1::uuid[])",
			[]uuid.UUID{f.materialID, f.customerMaterialID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material WHERE id=ANY($1::uuid[])",
			[]uuid.UUID{f.materialID, f.customerMaterialID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM inv_material_category WHERE id=$1", f.categoryID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_unit WHERE id=ANY($1::uuid[])",
			[]uuid.UUID{f.unitID, f.alternateUnitID, f.badUnitID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM pur_supplier WHERE id=$1", f.supplierID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sal_customers WHERE id=ANY($1::uuid[])",
			[]uuid.UUID{f.customerID, f.otherCustomerID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM sys_user WHERE id=$1", f.userID)
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_company WHERE id=ANY($1::uuid[])",
			[]uuid.UUID{f.companyID, f.otherCompanyID})
		_, _ = pool.Exec(cleanupCtx, "DELETE FROM bas_currency WHERE id=$1", f.currencyID)
		var residue int
		if err := pool.QueryRow(cleanupCtx, `
			SELECT (SELECT count(*) FROM sal_quotation WHERE company_id=$1) +
			       (SELECT count(*) FROM pur_quotation WHERE company_id=$1) +
			       (SELECT count(*) FROM sys_audit_log WHERE company_id=$1)
		`, f.companyID).Scan(&residue); err != nil {
			t.Errorf("verify cleanup: %v", err)
		} else if residue != 0 {
			t.Errorf("quotation fixture residue = %d", residue)
		}
		pool.Close()
	})
	return f
}

func quotationActor(f quotationFixture, side Side) *authz.Actor {
	return &authz.Actor{
		UserID: f.userID, Username: "quotation-test",
		Permissions: map[string]struct{}{mustSpec(side).prefix + ":*": {}},
		CompanyIDs:  []uuid.UUID{f.companyID},
	}
}

func quotationErrorCode(err error) apierror.Code {
	var target *apierror.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func fkFilter(id uuid.UUID) json.RawMessage {
	return json.RawMessage(`{"kind":"fk","values":["` + id.String() + `"]}`)
}

func stringPtr(value string) *string {
	return &value
}

func decimalValuePtr(value decimal.Decimal) optional.Optional[decimal.Decimal] {
	return optional.Of(value)
}

func hasString(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}
