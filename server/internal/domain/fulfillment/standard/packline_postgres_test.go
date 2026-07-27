package standard

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// 在夹具公司下补一个第二物料（默认单位与夹具物料共用），供「漏装/多装」
// 双物料场景使用。
func insertPackTestMaterial(t *testing.T, ctx context.Context, f standardPGFixture) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO inv_material(
		id,code,name,spec,customer_part_no,category_id,default_unit_id)
		VALUES($1,$2,$3,$4,$5,$6,$7)`,
		id, "M2-"+f.suffix, "装箱物料二-"+f.suffix, "SPEC2-"+f.suffix, "PART2-"+f.suffix,
		f.categoryID, f.unitID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = f.pool.Exec(cleanupCtx, `DELETE FROM inv_material WHERE id=$1`, id)
	})
	return id
}

// 建一张草稿发货单并写入一条指定物料/数量的发货条目，返回头与条目。
func packTestDelivery(
	t *testing.T,
	ctx context.Context,
	svc *Service,
	actor *authz.Actor,
	f standardPGFixture,
	qty decimal.Decimal,
) Head {
	t.Helper()
	_, orderItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: qty, baseQty: qty,
		price: decimal.NewFromInt(10), amount: qty.Mul(decimal.NewFromInt(10)),
		basePrice: decimal.NewFromInt(10), baseAmount: qty.Mul(decimal.NewFromInt(10)),
		taxRate: decimal.RequireFromString("0.13"),
	})
	head := createStandardHead(t, ctx, svc, actor, f, SideSales, todayUTC(), f.warehouseID)
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: head.ID, Idx: 1, Qty: qty, OrderItemID: orderItemID, WarehouseID: f.warehouseID,
	}); err != nil {
		t.Fatal(err)
	}
	return head
}

func TestPostgresPackLineCrudConversionSnapshotAndCascade(t *testing.T) {
	f := newStandardPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	actor := standardActor(f)
	svc := NewService(f.pool)
	head := packTestDelivery(t, ctx, svc, actor, f, decimal.NewFromInt(30))

	// 形状校验：箱号必填、数量 > 0、物料必填、单位限默认/转换单位
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 1, BoxNo: "  ", Qty: decimal.NewFromInt(1),
		MaterialID: f.materialID,
	}); standardErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("空箱号 error = %#v", err)
	}
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 1, BoxNo: "A-" + f.suffix, Qty: decimal.Zero,
		MaterialID: f.materialID,
	}); standardErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("零数量 error = %#v", err)
	}
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 1, BoxNo: "A-" + f.suffix, Qty: decimal.NewFromInt(1),
		MaterialID: f.materialID, UnitID: &f.unrelatedUnitID,
	}); standardErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("无关单位 error = %#v", err)
	}
	absentUnit := uuid.New()
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 1, BoxNo: "A-" + f.suffix, Qty: decimal.NewFromInt(1),
		MaterialID: f.materialID, UnitID: &absentUnit,
	}); standardErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("不存在单位 error = %#v", err)
	}
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 1, BoxNo: "A-" + f.suffix, Qty: decimal.NewFromInt(1),
		MaterialID: uuid.New(),
	}); standardErrorCode(err) != apierror.CodeValidation {
		t.Fatalf("不存在物料 error = %#v", err)
	}

	// 转换单位行：300 箱 ÷ 10 = 30 base；箱号去空白；备注可空
	remarks := "易碎朝上-" + f.suffix
	line, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 1, BoxNo: "  A-01  ", Qty: decimal.NewFromInt(300),
		MaterialID: f.materialID, UnitID: &f.boxID, Remarks: &remarks,
	})
	if err != nil {
		t.Fatal(err)
	}
	if line.BoxNo != "A-01" || !line.BaseQty.Equal(decimal.NewFromInt(30)) ||
		line.UnitID != f.boxID || line.UnitName != "履约箱-"+f.suffix ||
		line.MaterialCode != "M"+f.suffix || line.MaterialName != "履约物料-"+f.suffix ||
		line.MaterialSpec == nil || *line.MaterialSpec != "SPEC-"+f.suffix ||
		line.CustomerPartNo == nil || *line.CustomerPartNo != "PART-"+f.suffix ||
		line.DeliveryID != head.ID || line.CompanyID != f.companyID ||
		line.Remarks == nil || *line.Remarks != remarks {
		t.Fatalf("转换单位折算/快照 = %#v", line)
	}

	// 默认单位行（不传单位 = 物料默认单位，base = 数量）
	second, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 2, BoxNo: "B-02", Qty: decimal.NewFromInt(5),
		MaterialID: f.materialID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.UnitID != f.unitID || !second.BaseQty.Equal(decimal.NewFromInt(5)) {
		t.Fatalf("默认单位折算 = %#v", second)
	}

	// 列表按发货单过滤，仅本公司可见
	listed, err := svc.ListPackLines(ctx, actor, ListQuery{
		Limit: 20,
		Filter: map[string]json.RawMessage{
			"deliveryId": json.RawMessage(`{"kind":"fk","op":"in","values":["` + head.ID.String() + `"],"labels":[]}`),
		},
	})
	if err != nil || listed.Count != 2 || len(listed.Results) != 2 ||
		listed.Results[0].ID != line.ID || listed.Results[1].ID != second.ID {
		t.Fatalf("列表 = %#v err=%v", listed, err)
	}
	otherActor := &authz.Actor{
		UserID: f.userID, CompanyIDs: []uuid.UUID{f.otherCompanyID},
		Permissions: map[string]struct{}{"sales.delivery:*": {}},
	}
	hidden, err := svc.ListPackLines(ctx, otherActor, ListQuery{Limit: 20})
	if err != nil || hidden.Count != 0 {
		t.Fatalf("他公司列表 = %#v err=%v", hidden, err)
	}
	if _, err := svc.GetPackLine(ctx, otherActor, line.ID); standardErrorCode(err) != apierror.CodeNotFound {
		t.Fatalf("他公司读取 error = %#v", err)
	}

	// 快照冻结：主数据后改不回溯
	if _, err := f.pool.Exec(ctx, `UPDATE inv_material SET code=$2,name=$3,spec=$4,
		customer_part_no=$5 WHERE id=$1`,
		f.materialID, "MX"+f.suffix, "改后物料-"+f.suffix, "NEWSPEC-"+f.suffix, "NEWPART-"+f.suffix); err != nil {
		t.Fatal(err)
	}
	frozen, err := svc.GetPackLine(ctx, actor, line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if frozen.MaterialCode != "M"+f.suffix || frozen.MaterialName != "履约物料-"+f.suffix ||
		frozen.MaterialSpec == nil || *frozen.MaterialSpec != "SPEC-"+f.suffix ||
		frozen.CustomerPartNo == nil || *frozen.CustomerPartNo != "PART-"+f.suffix {
		t.Fatalf("快照未冻结 = %#v", frozen)
	}

	// 更新：换物料（重拍快照）、改数量（重折算）
	newQty := decimal.NewFromInt(7)
	updated, err := svc.UpdatePackLine(ctx, actor, second.ID, UpdatePackLineInput{Qty: &newQty})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.BaseQty.Equal(decimal.NewFromInt(7)) {
		t.Fatalf("更新重折算 = %#v", updated)
	}

	// 删除草稿发货单级联删除装箱行
	if err := svc.DeleteHead(ctx, actor, SideSales, head.ID); err != nil {
		t.Fatal(err)
	}
	requireDecimal(t, ctx, f.pool, "0",
		`SELECT count(*) FROM sal_delivery_pack_line WHERE delivery_id=$1`, head.ID)
}

func TestPostgresPackLinePermissionsFollowDelivery(t *testing.T) {
	f := newStandardPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	actor := standardActor(f)
	svc := NewService(f.pool)
	head := packTestDelivery(t, ctx, svc, actor, f, decimal.NewFromInt(5))
	line, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 1, BoxNo: "A", Qty: decimal.NewFromInt(5),
		MaterialID: f.materialID,
	})
	if err != nil {
		t.Fatal(err)
	}
	qty := decimal.NewFromInt(4)
	cases := []struct {
		name        string
		permissions map[string]struct{}
		run         func(*authz.Actor) error
	}{
		{"读取", map[string]struct{}{"sales.delivery:create": {}, "sales.delivery:update": {}, "sales.delivery:delete": {}},
			func(a *authz.Actor) error {
				_, err := svc.GetPackLine(ctx, a, line.ID)
				return err
			}},
		{"列表", map[string]struct{}{"sales.delivery:create": {}},
			func(a *authz.Actor) error {
				_, err := svc.ListPackLines(ctx, a, ListQuery{Limit: 20})
				return err
			}},
		{"创建", map[string]struct{}{"sales.delivery:read": {}, "sales.delivery:update": {}, "sales.delivery:delete": {}},
			func(a *authz.Actor) error {
				_, err := svc.CreatePackLine(ctx, a, CreatePackLineInput{
					DeliveryID: head.ID, Idx: 2, BoxNo: "B", Qty: decimal.NewFromInt(1),
					MaterialID: f.materialID,
				})
				return err
			}},
		{"更新", map[string]struct{}{"sales.delivery:read": {}, "sales.delivery:create": {}, "sales.delivery:delete": {}},
			func(a *authz.Actor) error {
				_, err := svc.UpdatePackLine(ctx, a, line.ID, UpdatePackLineInput{Qty: &qty})
				return err
			}},
		{"删除", map[string]struct{}{"sales.delivery:read": {}, "sales.delivery:create": {}, "sales.delivery:update": {}},
			func(a *authz.Actor) error {
				return svc.DeletePackLine(ctx, a, line.ID)
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			restricted := &authz.Actor{
				UserID: f.userID, CompanyIDs: []uuid.UUID{f.companyID}, Permissions: tc.permissions,
			}
			if err := tc.run(restricted); standardErrorCode(err) != apierror.CodeForbidden {
				t.Fatalf("缺权限 error = %#v", err)
			}
		})
	}
}

func TestPostgresPackAuditAllOrNothing(t *testing.T) {
	f := newStandardPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	actor := standardActor(f)
	svc := NewService(f.pool)
	seedStock(t, ctx, f, f.warehouseID, decimal.NewFromInt(1000))

	// 全有：转换单位拆多箱（3 行 × 100 箱 ÷ 10 = 30 base）与发货量相等 →
	// 审核通过，审核后装箱行随单锁死
	matched := packTestDelivery(t, ctx, svc, actor, f, decimal.NewFromInt(30))
	for i, box := range []string{"A-01", "A-02", "A-03"} {
		if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
			DeliveryID: matched.ID, Idx: int64(i + 1), BoxNo: box, Qty: decimal.NewFromInt(100),
			MaterialID: f.materialID, UnitID: &f.boxID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	result, err := svc.Audit(ctx, actor, SideSales, matched.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StatusAudited {
		t.Fatalf("审核头 = %#v", result)
	}
	var lockedLineID uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM sal_delivery_pack_line
		WHERE delivery_id=$1 LIMIT 1`, matched.ID).Scan(&lockedLineID); err != nil {
		t.Fatal(err)
	}
	qty := decimal.NewFromInt(9)
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: matched.ID, Idx: 9, BoxNo: "LATE", Qty: decimal.NewFromInt(1),
		MaterialID: f.materialID,
	}); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("审核后新增 error = %#v", err)
	}
	if _, err := svc.UpdatePackLine(ctx, actor, lockedLineID, UpdatePackLineInput{Qty: &qty}); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("审核后更新 error = %#v", err)
	}
	if err := svc.DeletePackLine(ctx, actor, lockedLineID); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("审核后删除 error = %#v", err)
	}

	// 全无：整表不填照常审核
	empty := packTestDelivery(t, ctx, svc, actor, f, decimal.NewFromInt(4))
	if _, err := svc.Audit(ctx, actor, SideSales, empty.ID, nil); err != nil {
		t.Fatalf("空装箱清单审核 err = %#v", err)
	}

	// 装箱量不等：草稿保存不校验，审核硬拦并点名物料与两侧数量
	mismatch := packTestDelivery(t, ctx, svc, actor, f, decimal.NewFromInt(30))
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: mismatch.ID, Idx: 1, BoxNo: "A", Qty: decimal.NewFromInt(29),
		MaterialID: f.materialID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: mismatch.ID, Idx: 2, BoxNo: "B", Qty: decimal.NewFromInt(29),
		MaterialID: f.materialID,
	}); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Audit(ctx, actor, SideSales, mismatch.ID, nil)
	if standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("装箱量不等 error = %#v", err)
	}
	if msg := err.Error(); !strings.Contains(msg, "M"+f.suffix) ||
		!strings.Contains(msg, "30") || !strings.Contains(msg, "58") ||
		!strings.Contains(msg, "履约个-"+f.suffix) {
		t.Fatalf("报错未点名物料/两侧数量/默认单位: %s", msg)
	}
	head, err := svc.GetHead(ctx, actor, SideSales, mismatch.ID)
	if err != nil || head.Status != StatusDraft {
		t.Fatalf("拒审后头 = %#v err=%v", head, err)
	}

	// 漏装物料：两个物料只装一个
	secondMaterialID := insertPackTestMaterial(t, ctx, f)
	_, secondOrderItemID := insertStandardOrder(t, ctx, f, standardOrderSeed{
		side: SideSales, status: "audited", currencyID: f.baseCurrencyID,
		qty: decimal.NewFromInt(5), baseQty: decimal.NewFromInt(5),
		price: decimal.NewFromInt(2), amount: decimal.NewFromInt(10),
		basePrice: decimal.NewFromInt(2), baseAmount: decimal.NewFromInt(10),
		taxRate: decimal.RequireFromString("0.13"), materialID: secondMaterialID,
	})
	missing := packTestDelivery(t, ctx, svc, actor, f, decimal.NewFromInt(10))
	if _, err := svc.CreateItem(ctx, actor, SideSales, CreateItemInput{
		HeadID: missing.ID, Idx: 2, Qty: decimal.NewFromInt(5),
		OrderItemID: secondOrderItemID, WarehouseID: f.warehouseID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: missing.ID, Idx: 1, BoxNo: "A", Qty: decimal.NewFromInt(10),
		MaterialID: f.materialID,
	}); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Audit(ctx, actor, SideSales, missing.ID, nil)
	if standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("漏装 error = %#v", err)
	}
	if msg := err.Error(); !strings.Contains(msg, "M2-"+f.suffix) ||
		!strings.Contains(msg, "未装箱") || !strings.Contains(msg, "装箱 0") ||
		!strings.Contains(msg, "履约个-"+f.suffix) {
		t.Fatalf("漏装报错: %s", msg)
	}

	// 装箱行含发货外物料
	extra := packTestDelivery(t, ctx, svc, actor, f, decimal.NewFromInt(10))
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: extra.ID, Idx: 1, BoxNo: "A", Qty: decimal.NewFromInt(10),
		MaterialID: f.materialID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: extra.ID, Idx: 2, BoxNo: "B", Qty: decimal.NewFromInt(3),
		MaterialID: secondMaterialID,
	}); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Audit(ctx, actor, SideSales, extra.ID, nil)
	if standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("发货外物料 error = %#v", err)
	}
	if msg := err.Error(); !strings.Contains(msg, "M2-"+f.suffix) ||
		!strings.Contains(msg, "不在发货条目中") {
		t.Fatalf("发货外物料报错: %s", msg)
	}
}

func TestPostgresPackAuditRejectionRollsBackNothing(t *testing.T) {
	f := newStandardPGFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	actor := standardActor(f)
	svc := NewService(f.pool)
	seedStock(t, ctx, f, f.warehouseID, decimal.NewFromInt(100))

	// 拒审后装箱行仍在、可修正后再审通过（同负库存回滚语义）
	head := packTestDelivery(t, ctx, svc, actor, f, decimal.NewFromInt(10))
	line, err := svc.CreatePackLine(ctx, actor, CreatePackLineInput{
		DeliveryID: head.ID, Idx: 1, BoxNo: "A", Qty: decimal.NewFromInt(9),
		MaterialID: f.materialID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Audit(ctx, actor, SideSales, head.ID, nil); standardErrorCode(err) != apierror.CodeConflict {
		t.Fatalf("首次审核 error = %#v", err)
	}
	qty := decimal.NewFromInt(10)
	if _, err := svc.UpdatePackLine(ctx, actor, line.ID, UpdatePackLineInput{Qty: &qty}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Audit(ctx, actor, SideSales, head.ID, nil); err != nil {
		t.Fatalf("修正后审核 err = %#v", err)
	}
}
