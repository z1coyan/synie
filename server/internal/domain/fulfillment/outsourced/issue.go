package outsourced

import (
	"context"
	"errors"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/domain/trading/order"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var issueItemAuditFields = []string{
	"idx", "qty", "base_qty", "material_code", "material_name", "material_spec",
	"unit_name", "order_no", "remarks", "issue_id", "company_id",
	"order_item_material_id", "material_id", "unit_id", "from_warehouse_id",
	"outsourced_warehouse_id",
}

type materialSnapshot struct {
	orderItemMaterialID uuid.UUID
	orderItemID         uuid.UUID
	companyID           uuid.UUID
	partyType           string
	partyID             uuid.UUID
	orderStatus         string
	isOutsourced        bool
	orderNo             string
	materialID          uuid.UUID
	defaultUnitID       uuid.UUID
	unitID              uuid.UUID
	materialCode        string
	materialName        string
	materialSpec        *string
	unitName            string
}

func (s *Service) CreateIssueItem(ctx context.Context, actor *authz.Actor, input CreateIssueItemInput) (IssueItem, error) {
	if err := require(actor, issuePermissionPrefix, "create"); err != nil {
		return IssueItem{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return IssueItem{}, apierror.Wrap(apierror.CodeInternal, "创建委外发料行失败", err)
	}
	defer tx.Rollback(ctx)
	parent, err := lockDraftIssue(ctx, tx, actor, input.IssueID)
	if err != nil {
		return IssueItem{}, err
	}
	item := IssueItem{
		Idx: input.Idx, Qty: input.Qty, IssueID: input.IssueID,
		OrderItemMaterialID: input.OrderItemMaterialID, Remarks: input.Remarks,
	}
	if input.FromWarehouseID != nil {
		item.FromWarehouseID = *input.FromWarehouseID
	} else if parent.FromWarehouseID != nil {
		item.FromWarehouseID = *parent.FromWarehouseID
	}
	if input.OutsourcedWarehouseID != nil {
		item.OutsourcedWarehouseID = *input.OutsourcedWarehouseID
	} else if parent.OutsourcedWarehouseID != nil {
		item.OutsourcedWarehouseID = *parent.OutsourcedWarehouseID
	}
	if err := deriveIssueItem(ctx, tx, parent, &item); err != nil {
		return IssueItem{}, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO pur_outsourced_issue_item(
		idx,qty,base_qty,material_code,material_name,material_spec,unit_name,order_no,
		remarks,issue_id,company_id,order_item_material_id,material_id,unit_id,
		from_warehouse_id,outsourced_warehouse_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		RETURNING id`, item.Idx, item.Qty, item.BaseQty, item.MaterialCode,
		item.MaterialName, pgconv.Text(item.MaterialSpec), item.UnitName, item.OrderNo,
		pgconv.Text(item.Remarks), item.IssueID, item.CompanyID, item.OrderItemMaterialID,
		item.MaterialID, item.UnitID, item.FromWarehouseID, item.OutsourcedWarehouseID).
		Scan(&item.ID)
	if err != nil {
		return IssueItem{}, writeError("创建委外发料行", err)
	}
	result, err := queryIssueItem(ctx, tx, item.ID, false)
	if err != nil {
		return IssueItem{}, apierror.Wrap(apierror.CodeInternal, "读取新建委外发料行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, issueItemTable, result.ID,
		strconv.FormatInt(result.Idx, 10), "create", "create", result.CompanyID,
		audit.Created(issueItemSnapshot(result), issueItemAuditFields)); err != nil {
		return IssueItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return IssueItem{}, writeError("创建委外发料行", err)
	}
	return result, nil
}

func (s *Service) UpdateIssueItem(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateIssueItemInput) (IssueItem, error) {
	if err := require(actor, issuePermissionPrefix, "update"); err != nil {
		return IssueItem{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return IssueItem{}, apierror.Wrap(apierror.CodeInternal, "更新委外发料行失败", err)
	}
	defer tx.Rollback(ctx)
	var parentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT issue_id FROM pur_outsourced_issue_item WHERE id=$1`, id).Scan(&parentID); err != nil {
		return IssueItem{}, apierror.New(apierror.CodeNotFound, "委外发料行不存在")
	}
	parent, err := lockDraftIssue(ctx, tx, actor, parentID)
	if err != nil {
		return IssueItem{}, err
	}
	before, err := queryIssueItem(ctx, tx, id, false)
	if err != nil {
		return IssueItem{}, apierror.New(apierror.CodeNotFound, "委外发料行不存在")
	}
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.OrderItemMaterialID != nil {
		after.OrderItemMaterialID = *input.OrderItemMaterialID
	}
	if input.FromWarehouseID != nil {
		after.FromWarehouseID = *input.FromWarehouseID
	}
	if input.OutsourcedWarehouseID != nil {
		after.OutsourcedWarehouseID = *input.OutsourcedWarehouseID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if err := deriveIssueItem(ctx, tx, parent, &after); err != nil {
		return IssueItem{}, err
	}
	changes := audit.Diff(issueItemSnapshot(before), issueItemSnapshot(after), issueItemAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return IssueItem{}, writeError("更新委外发料行", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE pur_outsourced_issue_item SET idx=$2,qty=$3,
		base_qty=$4,material_code=$5,material_name=$6,material_spec=$7,unit_name=$8,
		order_no=$9,remarks=$10,order_item_material_id=$11,material_id=$12,unit_id=$13,
		from_warehouse_id=$14,outsourced_warehouse_id=$15,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.Idx, after.Qty, after.BaseQty, after.MaterialCode, after.MaterialName,
		pgconv.Text(after.MaterialSpec), after.UnitName, after.OrderNo, pgconv.Text(after.Remarks),
		after.OrderItemMaterialID, after.MaterialID, after.UnitID, after.FromWarehouseID,
		after.OutsourcedWarehouseID)
	if err != nil {
		return IssueItem{}, writeError("更新委外发料行", err)
	}
	result, err := queryIssueItem(ctx, tx, id, false)
	if err != nil {
		return IssueItem{}, apierror.Wrap(apierror.CodeInternal, "读取更新后委外发料行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, issueItemTable, id,
		strconv.FormatInt(result.Idx, 10), "update", "update", result.CompanyID, changes); err != nil {
		return IssueItem{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return IssueItem{}, writeError("更新委外发料行", err)
	}
	return result, nil
}

func (s *Service) DeleteIssueItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, issuePermissionPrefix, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除委外发料行失败", err)
	}
	defer tx.Rollback(ctx)
	var parentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT issue_id FROM pur_outsourced_issue_item WHERE id=$1`, id).Scan(&parentID); err != nil {
		return apierror.New(apierror.CodeNotFound, "委外发料行不存在")
	}
	if _, err := lockDraftIssue(ctx, tx, actor, parentID); err != nil {
		return err
	}
	item, err := queryIssueItem(ctx, tx, id, false)
	if err != nil {
		return apierror.New(apierror.CodeNotFound, "委外发料行不存在")
	}
	if err := writeAudit(ctx, tx, actor, issueItemTable, id,
		strconv.FormatInt(item.Idx, 10), "destroy", "destroy", item.CompanyID,
		audit.Destroyed(issueItemSnapshot(item), issueItemAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM pur_outsourced_issue_item WHERE id=$1`, id); err != nil {
		return writeError("删除委外发料行", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除委外发料行", err)
	}
	return nil
}

func deriveIssueItem(ctx context.Context, tx pgx.Tx, parent Issue, item *IssueItem) error {
	fields := map[string][]string{}
	if item.OrderItemMaterialID == uuid.Nil {
		fields["orderItemMaterialId"] = []string{"必填"}
	}
	if item.FromWarehouseID == uuid.Nil {
		fields["fromWarehouseId"] = []string{"必填"}
	}
	if item.OutsourcedWarehouseID == uuid.Nil {
		fields["outsourcedWarehouseId"] = []string{"必填"}
	}
	if item.FromWarehouseID == item.OutsourcedWarehouseID && item.FromWarehouseID != uuid.Nil {
		fields["warehouses"] = []string{"调出仓与外协仓不能相同"}
	}
	if item.Remarks != nil && utf8.RuneCountInString(*item.Remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if !item.Qty.GreaterThan(decimal.Zero) {
		fields["qty"] = []string{"必须大于 0"}
	}
	if len(fields) > 0 {
		return apierror.Validation("委外发料行参数不合法", fields)
	}
	source, err := loadMaterialSnapshot(ctx, tx, item.OrderItemMaterialID)
	if err != nil {
		return err
	}
	if source.orderStatus != "audited" || !source.isOutsourced {
		return apierror.Validation("委外发料行参数不合法", map[string][]string{"orderItemMaterialId": {"来源须为已审核委外订单发料清单行"}})
	}
	if source.companyID != parent.CompanyID || source.partyType != parent.PartyType || source.partyID != parent.PartyID {
		return apierror.Validation("委外发料行参数不合法", map[string][]string{"orderItemMaterialId": {"来源订单公司或对手不一致"}})
	}
	if err := validateWarehouse(ctx, tx, parent.CompanyID, item.FromWarehouseID); err != nil {
		return err
	}
	if err := validateOutsourcedWarehouse(ctx, tx, parent.CompanyID, parent.PartyType, parent.PartyID, item.OutsourcedWarehouseID); err != nil {
		return err
	}
	baseQty, _, err := deriveBaseQty(ctx, tx, source.materialID, source.defaultUnitID, source.unitID, item.Qty)
	if err != nil {
		return err
	}
	item.BaseQty, item.CompanyID = baseQty, parent.CompanyID
	item.MaterialID, item.UnitID = source.materialID, source.unitID
	item.MaterialCode, item.MaterialName, item.MaterialSpec = source.materialCode, source.materialName, source.materialSpec
	item.UnitName, item.OrderNo = source.unitName, source.orderNo
	return nil
}

func loadMaterialSnapshot(ctx context.Context, tx pgx.Tx, id uuid.UUID) (materialSnapshot, error) {
	var result materialSnapshot
	var spec pgtype.Text
	err := tx.QueryRow(ctx, `SELECT ml.id,ml.order_item_id,o.company_id,o.party_type,
		o.party_id,o.status,o.is_outsourced,o.order_no,ml.material_id,m.default_unit_id,
		ml.unit_id,m.code,m.name,m.spec,u.name
		FROM pur_order_item_material ml
		JOIN pur_order_item oi ON oi.id=ml.order_item_id
		JOIN pur_order o ON o.id=oi.order_id
		JOIN inv_material m ON m.id=ml.material_id
		JOIN bas_unit u ON u.id=ml.unit_id WHERE ml.id=$1`, id).Scan(
		&result.orderItemMaterialID, &result.orderItemID, &result.companyID,
		&result.partyType, &result.partyID, &result.orderStatus, &result.isOutsourced,
		&result.orderNo, &result.materialID, &result.defaultUnitID, &result.unitID,
		&result.materialCode, &result.materialName, &spec, &result.unitName)
	if errors.Is(err, pgx.ErrNoRows) {
		return materialSnapshot{}, apierror.Validation("委外发料行参数不合法", map[string][]string{"orderItemMaterialId": {"来源发料清单行不存在"}})
	}
	if err != nil {
		return materialSnapshot{}, apierror.Wrap(apierror.CodeInternal, "读取来源发料清单行失败", err)
	}
	result.materialSpec = pgconv.TextPtr(spec)
	return result, nil
}

func (s *Service) AuditIssue(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Issue, error) {
	if err := require(actor, issuePermissionPrefix, "audit"); err != nil {
		return Issue{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "审核委外发料单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockDraftIssue(ctx, tx, actor, id)
	if err != nil {
		return Issue{}, err
	}
	items, err := loadIssueActionItems(ctx, tx, id)
	if err != nil {
		return Issue{}, err
	}
	if len(items) == 0 {
		return Issue{}, apierror.New(apierror.CodeConflict, "委外发料单至少需要一条发料行")
	}
	projection := make([]order.OutsourcedIssueLine, 0, len(items))
	stockLines := make([]stock.Line, 0, len(items)*2)
	for _, item := range items {
		if err := deriveIssueItem(ctx, tx, before, &item); err != nil {
			return Issue{}, err
		}
		projection = append(projection, order.OutsourcedIssueLine{
			OrderItemMaterialID: item.OrderItemMaterialID, BaseQty: item.BaseQty,
		})
		stockLines = append(stockLines,
			stock.Line{WarehouseID: item.FromWarehouseID, MaterialID: item.MaterialID, Quantity: item.BaseQty.Neg(), Remarks: item.Remarks},
			stock.Line{WarehouseID: item.OutsourcedWarehouseID, MaterialID: item.MaterialID, Quantity: item.BaseQty, Remarks: item.Remarks})
	}
	if err := s.orders.PostOutsourcedIssue(ctx, tx, order.OutsourcedIssueInput{
		CompanyID: before.CompanyID, PartyType: before.PartyType, PartyID: before.PartyID,
		Lines: projection,
	}); err != nil {
		return Issue{}, err
	}
	if err := stock.Post(ctx, tx, stock.Voucher{
		Type: "purchase.outsourced_issue", ID: before.ID, No: before.IssueNo,
		CompanyID: before.CompanyID, PostingDate: before.IssueDate,
	}, stockLines); err != nil {
		return Issue{}, err
	}
	now := time.Now().UTC()
	var auditedBy *uuid.UUID
	if actor.UserID != uuid.Nil {
		auditedBy = &actor.UserID
	}
	if _, err := tx.Exec(ctx, `UPDATE pur_outsourced_issue SET status='audited',
		audited_at=$2,audited_by_id=$3,updated_at=$2 WHERE id=$1`,
		id, pgconv.Timestamp(now), auditedBy); err != nil {
		return Issue{}, writeError("审核委外发料单", err)
	}
	result, err := queryIssue(ctx, tx, id, false)
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "读取审核后委外发料单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, issueTable, id, result.IssueNo,
		"update", "audit", result.CompanyID,
		audit.Diff(issueSnapshot(before), issueSnapshot(result), issueAuditFields)); err != nil {
		return Issue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, writeError("审核委外发料单", err)
	}
	return result, nil
}

func (s *Service) VoidIssue(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Issue, error) {
	if err := require(actor, issuePermissionPrefix, "void"); err != nil {
		return Issue{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "作废委外发料单失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockIssue(ctx, tx, actor, id)
	if err != nil {
		return Issue{}, err
	}
	if before.Status != StatusAudited {
		return Issue{}, apierror.New(apierror.CodeConflict, "仅已审核委外发料单可作废")
	}
	items, err := loadIssueActionItems(ctx, tx, id)
	if err != nil {
		return Issue{}, err
	}
	projection := make([]order.OutsourcedIssueLine, 0, len(items))
	for _, item := range items {
		projection = append(projection, order.OutsourcedIssueLine{
			OrderItemMaterialID: item.OrderItemMaterialID, BaseQty: item.BaseQty,
		})
	}
	if err := s.orders.ReverseOutsourcedIssue(ctx, tx, order.OutsourcedIssueInput{
		CompanyID: before.CompanyID, PartyType: before.PartyType, PartyID: before.PartyID,
		Lines: projection,
	}); err != nil {
		return Issue{}, err
	}
	if err := stock.Cancel(ctx, tx, stock.VoucherRef{
		Type: "purchase.outsourced_issue", ID: id,
	}, time.Now().UTC()); err != nil {
		return Issue{}, err
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `UPDATE pur_outsourced_issue SET status='voided',
		updated_at=$2 WHERE id=$1`, id, pgconv.Timestamp(now)); err != nil {
		return Issue{}, writeError("作废委外发料单", err)
	}
	result, err := queryIssue(ctx, tx, id, false)
	if err != nil {
		return Issue{}, apierror.Wrap(apierror.CodeInternal, "读取作废后委外发料单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, issueTable, id, result.IssueNo,
		"update", "void", result.CompanyID,
		audit.Diff(issueSnapshot(before), issueSnapshot(result), issueAuditFields)); err != nil {
		return Issue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, writeError("作废委外发料单", err)
	}
	return result, nil
}

func loadIssueActionItems(ctx context.Context, tx pgx.Tx, id uuid.UUID) ([]IssueItem, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM pur_outsourced_issue_item WHERE issue_id=$1 ORDER BY idx,id`, id)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取委外发料行失败", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return nil, apierror.Wrap(apierror.CodeInternal, "读取委外发料行失败", err)
		}
		ids = append(ids, itemID)
	}
	rows.Close()
	items := make([]IssueItem, 0, len(ids))
	for _, itemID := range ids {
		item, err := queryIssueItem(ctx, tx, itemID, false)
		if err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取委外发料行失败", err)
		}
		items = append(items, item)
	}
	return items, nil
}

func issueItemSnapshot(item IssueItem) map[string]any {
	return map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty,
		"material_code": item.MaterialCode, "material_name": item.MaterialName,
		"material_spec": item.MaterialSpec, "unit_name": item.UnitName,
		"order_no": item.OrderNo, "remarks": item.Remarks, "issue_id": item.IssueID,
		"company_id": item.CompanyID, "order_item_material_id": item.OrderItemMaterialID,
		"material_id": item.MaterialID, "unit_id": item.UnitID,
		"from_warehouse_id":       item.FromWarehouseID,
		"outsourced_warehouse_id": item.OutsourcedWarehouseID,
	}
}
