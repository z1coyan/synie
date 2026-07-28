package order

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var materialAuditFields = []string{
	"quantity", "remarks", "order_item_id", "company_id", "material_id", "unit_id",
}

func (s *Service) GetMaterial(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Material, error) {
	if err := requirePurchase(actor, "read"); err != nil {
		return Material{}, err
	}
	row, err := queryMaterialByID(ctx, s.pool, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Material{}, materialNotFound()
	}
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取发料清单行失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Material{}, materialNotFound()
	}
	return materialFromRow(row), nil
}

func (s *Service) ListMaterials(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (MaterialListResult, error) {
	if err := requirePurchase(actor, "read"); err != nil {
		return MaterialListResult{}, err
	}
	if err := pagination(&query); err != nil {
		return MaterialListResult{}, err
	}
	built, err := filterbuild.Build(MaterialResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search, Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return MaterialListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "inserted_at" ASC,"id" ASC`
	} else {
		orderBy += `,"id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return MaterialListResult{}, apierror.Wrap(apierror.CodeInternal, "查询发料清单失败", err)
	}
	defer tx.Rollback(ctx)
	source := materialSource()
	var result MaterialListResult
	if err := tx.QueryRow(ctx, "SELECT count(*)"+source+where, args...).Scan(&result.Count); err != nil {
		return MaterialListResult{}, apierror.Wrap(apierror.CodeInternal, "统计发料清单失败", err)
	}
	listArgs, at := append([]any(nil), args...), len(args)+1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,quantity,issued_qty,remarks,inserted_at,updated_at,
		order_item_id,company_id,material_id,material_code,material_name,material_spec,
		unit_id,unit_name,order_no,order_status,order_is_outsourced,
		party_type,party_id`+source+where+orderBy+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return MaterialListResult{}, apierror.Wrap(apierror.CodeInternal, "查询发料清单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Material, 0, query.Limit)
	for rows.Next() {
		row, scanErr := scanMaterialRow(rows)
		if scanErr != nil {
			return MaterialListResult{}, apierror.Wrap(apierror.CodeInternal, "读取发料清单结果失败", scanErr)
		}
		result.Results = append(result.Results, materialFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return MaterialListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历发料清单结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return MaterialListResult{}, apierror.Wrap(apierror.CodeInternal, "完成发料清单查询失败", err)
	}
	return result, nil
}

func (s *Service) CreateMaterial(
	ctx context.Context, actor *authz.Actor, input CreateMaterialInput,
) (Material, error) {
	if err := requirePurchase(actor, "create"); err != nil {
		return Material{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "创建发料清单行失败", err)
	}
	defer tx.Rollback(ctx)
	parent, companyID, err := lockPurchaseOrderForItem(ctx, tx, actor, input.OrderItemID)
	if err != nil {
		return Material{}, err
	}
	if parent.Status != "draft" {
		return Material{}, apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	if err := validateOutsourcingLine(ctx, tx, input.MaterialID, input.UnitID, input.Quantity, input.Remarks); err != nil {
		return Material{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO pur_order_item_material(
		quantity,remarks,order_item_id,company_id,material_id,unit_id)
		VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
		input.Quantity, pgconv.Text(input.Remarks), input.OrderItemID, companyID,
		input.MaterialID, input.UnitID).Scan(&id)
	if err != nil {
		return Material{}, writeError("创建发料清单行失败", err)
	}
	row, err := queryMaterialByID(ctx, tx, id)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取新建发料清单行失败", err)
	}
	result := materialFromRow(row)
	if err := writeAudit(ctx, tx, actor, "pur_order_item_material", id, "",
		"create", "create", result.CompanyID,
		audit.Created(materialSnapshotMap(result), materialAuditFields)); err != nil {
		return Material{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, writeError("创建发料清单行失败", err)
	}
	return result, nil
}

func (s *Service) UpdateMaterial(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateMaterialInput,
) (Material, error) {
	if err := requirePurchase(actor, "update"); err != nil {
		return Material{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "更新发料清单行失败", err)
	}
	defer tx.Rollback(ctx)
	var orderItemID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT order_item_id FROM pur_order_item_material WHERE id=$1`, id).Scan(&orderItemID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Material{}, materialNotFound()
		}
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取发料清单行失败", err)
	}
	parent, _, err := lockPurchaseOrderForItem(ctx, tx, actor, orderItemID)
	if err != nil {
		return Material{}, materialNotFound()
	}
	if parent.Status != "draft" {
		return Material{}, apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	row, err := queryMaterialByID(ctx, tx, id)
	if err != nil {
		return Material{}, materialNotFound()
	}
	before := materialFromRow(row)
	after := before
	if input.MaterialID != nil {
		after.MaterialID = *input.MaterialID
	}
	if input.UnitID != nil {
		after.UnitID = *input.UnitID
	}
	if input.Quantity != nil {
		after.Quantity = *input.Quantity
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	if err := validateOutsourcingLine(ctx, tx, after.MaterialID, after.UnitID, after.Quantity, after.Remarks); err != nil {
		return Material{}, err
	}
	changes := audit.Diff(materialSnapshotMap(before), materialSnapshotMap(after), materialAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Material{}, writeError("更新发料清单行失败", err)
		}
		return before, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE pur_order_item_material SET quantity=$2,remarks=$3,
		material_id=$4,unit_id=$5,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.Quantity, pgconv.Text(after.Remarks), after.MaterialID, after.UnitID); err != nil {
		return Material{}, writeError("更新发料清单行失败", err)
	}
	row, err = queryMaterialByID(ctx, tx, id)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取更新后发料清单行失败", err)
	}
	result := materialFromRow(row)
	if err := writeAudit(ctx, tx, actor, "pur_order_item_material", id, "",
		"update", "update", result.CompanyID, changes); err != nil {
		return Material{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, writeError("更新发料清单行失败", err)
	}
	return result, nil
}

func (s *Service) DeleteMaterial(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requirePurchase(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除发料清单行失败", err)
	}
	defer tx.Rollback(ctx)
	var orderItemID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT order_item_id FROM pur_order_item_material WHERE id=$1`, id).Scan(&orderItemID); err != nil {
		return materialNotFound()
	}
	parent, _, err := lockPurchaseOrderForItem(ctx, tx, actor, orderItemID)
	if err != nil {
		return materialNotFound()
	}
	if parent.Status != "draft" {
		return apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	row, err := queryMaterialByID(ctx, tx, id)
	if err != nil {
		return materialNotFound()
	}
	item := materialFromRow(row)
	if err := writeAudit(ctx, tx, actor, "pur_order_item_material", id, "",
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(materialSnapshotMap(item), materialAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM pur_order_item_material WHERE id=$1`, id); err != nil {
		return writeError("删除发料清单行失败", err)
	}
	return commitChild(ctx, tx, "删除发料清单行失败")
}

func (s *Service) GetByproduct(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Byproduct, error) {
	if err := requirePurchase(actor, "read"); err != nil {
		return Byproduct{}, err
	}
	row, err := queryByproductByID(ctx, s.pool, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(row.CompanyID)) {
		return Byproduct{}, byproductNotFound()
	}
	if err != nil {
		return Byproduct{}, apierror.Wrap(apierror.CodeInternal, "读取副产物清单行失败", err)
	}
	return byproductFromRow(row), nil
}

func (s *Service) ListByproducts(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (ByproductListResult, error) {
	if err := requirePurchase(actor, "read"); err != nil {
		return ByproductListResult{}, err
	}
	if err := pagination(&query); err != nil {
		return ByproductListResult{}, err
	}
	built, err := filterbuild.Build(ByproductResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search, Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ByproductListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "inserted_at" ASC,"id" ASC`
	} else {
		orderBy += `,"id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ByproductListResult{}, apierror.Wrap(apierror.CodeInternal, "查询副产物清单失败", err)
	}
	defer tx.Rollback(ctx)
	source := byproductSource()
	var result ByproductListResult
	if err := tx.QueryRow(ctx, "SELECT count(*)"+source+where, args...).Scan(&result.Count); err != nil {
		return ByproductListResult{}, apierror.Wrap(apierror.CodeInternal, "统计副产物清单失败", err)
	}
	listArgs, at := append([]any(nil), args...), len(args)+1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,quantity,remarks,inserted_at,updated_at,
		order_item_id,company_id,material_id,material_code,material_name,material_spec,
		unit_id,unit_name`+source+where+orderBy+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return ByproductListResult{}, apierror.Wrap(apierror.CodeInternal, "查询副产物清单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Byproduct, 0, query.Limit)
	for rows.Next() {
		row, scanErr := scanByproductRow(rows)
		if scanErr != nil {
			return ByproductListResult{}, apierror.Wrap(apierror.CodeInternal, "读取副产物清单结果失败", scanErr)
		}
		result.Results = append(result.Results, byproductFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return ByproductListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历副产物清单结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ByproductListResult{}, apierror.Wrap(apierror.CodeInternal, "完成副产物清单查询失败", err)
	}
	return result, nil
}

func (s *Service) CreateByproduct(
	ctx context.Context, actor *authz.Actor, input CreateByproductInput,
) (Byproduct, error) {
	if err := requirePurchase(actor, "create"); err != nil {
		return Byproduct{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Byproduct{}, apierror.Wrap(apierror.CodeInternal, "创建副产物清单行失败", err)
	}
	defer tx.Rollback(ctx)
	parent, companyID, err := lockPurchaseOrderForItem(ctx, tx, actor, input.OrderItemID)
	if err != nil {
		return Byproduct{}, err
	}
	if parent.Status != "draft" {
		return Byproduct{}, apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	if err := validateOutsourcingLine(ctx, tx, input.MaterialID, input.UnitID, input.Quantity, input.Remarks); err != nil {
		return Byproduct{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO pur_order_item_byproduct(
		quantity,remarks,order_item_id,company_id,material_id,unit_id)
		VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
		input.Quantity, pgconv.Text(input.Remarks), input.OrderItemID, companyID,
		input.MaterialID, input.UnitID).Scan(&id)
	if err != nil {
		return Byproduct{}, writeError("创建副产物清单行失败", err)
	}
	row, err := queryByproductByID(ctx, tx, id)
	if err != nil {
		return Byproduct{}, apierror.Wrap(apierror.CodeInternal, "读取新建副产物清单行失败", err)
	}
	result := byproductFromRow(row)
	if err := writeAudit(ctx, tx, actor, "pur_order_item_byproduct", id, "",
		"create", "create", result.CompanyID,
		audit.Created(byproductSnapshot(result), materialAuditFields)); err != nil {
		return Byproduct{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Byproduct{}, writeError("创建副产物清单行失败", err)
	}
	return result, nil
}

func (s *Service) UpdateByproduct(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateByproductInput,
) (Byproduct, error) {
	if err := requirePurchase(actor, "update"); err != nil {
		return Byproduct{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Byproduct{}, apierror.Wrap(apierror.CodeInternal, "更新副产物清单行失败", err)
	}
	defer tx.Rollback(ctx)
	var orderItemID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT order_item_id FROM pur_order_item_byproduct WHERE id=$1`, id).Scan(&orderItemID); err != nil {
		return Byproduct{}, byproductNotFound()
	}
	parent, _, err := lockPurchaseOrderForItem(ctx, tx, actor, orderItemID)
	if err != nil {
		return Byproduct{}, byproductNotFound()
	}
	if parent.Status != "draft" {
		return Byproduct{}, apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	row, err := queryByproductByID(ctx, tx, id)
	if err != nil {
		return Byproduct{}, byproductNotFound()
	}
	before := byproductFromRow(row)
	after := before
	if input.MaterialID != nil {
		after.MaterialID = *input.MaterialID
	}
	if input.UnitID != nil {
		after.UnitID = *input.UnitID
	}
	if input.Quantity != nil {
		after.Quantity = *input.Quantity
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	if err := validateOutsourcingLine(ctx, tx, after.MaterialID, after.UnitID, after.Quantity, after.Remarks); err != nil {
		return Byproduct{}, err
	}
	changes := audit.Diff(byproductSnapshot(before), byproductSnapshot(after), materialAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Byproduct{}, writeError("更新副产物清单行失败", err)
		}
		return before, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE pur_order_item_byproduct SET quantity=$2,remarks=$3,
		material_id=$4,unit_id=$5,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.Quantity, pgconv.Text(after.Remarks), after.MaterialID, after.UnitID); err != nil {
		return Byproduct{}, writeError("更新副产物清单行失败", err)
	}
	row, err = queryByproductByID(ctx, tx, id)
	if err != nil {
		return Byproduct{}, apierror.Wrap(apierror.CodeInternal, "读取更新后副产物清单行失败", err)
	}
	result := byproductFromRow(row)
	if err := writeAudit(ctx, tx, actor, "pur_order_item_byproduct", id, "",
		"update", "update", result.CompanyID, changes); err != nil {
		return Byproduct{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Byproduct{}, writeError("更新副产物清单行失败", err)
	}
	return result, nil
}

func (s *Service) DeleteByproduct(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requirePurchase(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除副产物清单行失败", err)
	}
	defer tx.Rollback(ctx)
	var orderItemID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT order_item_id FROM pur_order_item_byproduct WHERE id=$1`, id).Scan(&orderItemID); err != nil {
		return byproductNotFound()
	}
	parent, _, err := lockPurchaseOrderForItem(ctx, tx, actor, orderItemID)
	if err != nil {
		return byproductNotFound()
	}
	if parent.Status != "draft" {
		return apierror.New(apierror.CodeConflict, "仅草稿订单可编辑条目")
	}
	row, err := queryByproductByID(ctx, tx, id)
	if err != nil {
		return byproductNotFound()
	}
	item := byproductFromRow(row)
	if err := writeAudit(ctx, tx, actor, "pur_order_item_byproduct", id, "",
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(byproductSnapshot(item), materialAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM pur_order_item_byproduct WHERE id=$1`, id); err != nil {
		return writeError("删除副产物清单行失败", err)
	}
	return commitChild(ctx, tx, "删除副产物清单行失败")
}

func lockPurchaseOrderForItem(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, orderItemID uuid.UUID,
) (orderRow, uuid.UUID, error) {
	var orderID, companyID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT order_id,company_id FROM pur_order_item WHERE id=$1`,
		orderItemID).Scan(&orderID, &companyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return orderRow{}, uuid.Nil, itemNotFound()
	}
	if err != nil {
		return orderRow{}, uuid.Nil, apierror.Wrap(apierror.CodeInternal, "读取采购订单条目失败", err)
	}
	parent, err := lockOrder(ctx, tx, mustSpec(SidePurchase), actor, orderID)
	if err != nil {
		return orderRow{}, uuid.Nil, err
	}
	var stillExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pur_order_item WHERE id=$1 AND order_id=$2)`,
		orderItemID, orderID).Scan(&stillExists); err != nil || !stillExists {
		return orderRow{}, uuid.Nil, itemNotFound()
	}
	return parent, companyID, nil
}

func validateOutsourcingLine(
	ctx context.Context, tx pgx.Tx, materialID, unitID uuid.UUID,
	quantity decimal.Decimal, remarks *string,
) error {
	fields := map[string][]string{}
	if materialID == uuid.Nil {
		fields["materialId"] = []string{"必填"}
	}
	if unitID == uuid.Nil {
		fields["unitId"] = []string{"必填"}
	}
	if !quantity.GreaterThan(decimal.Zero) {
		fields["quantity"] = []string{"必须大于 0"}
	}
	if remarks != nil && utf8.RuneCountInString(*remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("委外清单行参数不合法", fields)
	}
	if _, err := loadOrderMaterial(ctx, tx, materialID, unitID); err != nil {
		return err
	}
	return nil
}

func queryMaterialByID(ctx context.Context, db rowQuerier, id uuid.UUID) (materialRow, error) {
	return scanMaterialRow(db.QueryRow(ctx, `SELECT id,quantity,issued_qty,remarks,inserted_at,
		updated_at,order_item_id,company_id,material_id,material_code,material_name,material_spec,
		unit_id,unit_name,order_no,order_status,
		order_is_outsourced,party_type,party_id`+materialSource()+` WHERE id=$1`, id))
}

func queryByproductByID(ctx context.Context, db rowQuerier, id uuid.UUID) (byproductRow, error) {
	return scanByproductRow(db.QueryRow(ctx, `SELECT id,quantity,remarks,inserted_at,updated_at,
		order_item_id,company_id,material_id,material_code,material_name,material_spec,
		unit_id,unit_name`+byproductSource()+` WHERE id=$1`, id))
}

func materialSnapshotMap(item Material) map[string]any {
	return map[string]any{
		"quantity": item.Quantity, "remarks": item.Remarks, "order_item_id": item.OrderItemID,
		"company_id": item.CompanyID, "material_id": item.MaterialID, "unit_id": item.UnitID,
	}
}

func byproductSnapshot(item Byproduct) map[string]any {
	return map[string]any{
		"quantity": item.Quantity, "remarks": item.Remarks, "order_item_id": item.OrderItemID,
		"company_id": item.CompanyID, "material_id": item.MaterialID, "unit_id": item.UnitID,
	}
}

func commitChild(ctx context.Context, tx pgx.Tx, message string) error {
	if err := tx.Commit(ctx); err != nil {
		return writeError(message, err)
	}
	return nil
}

func lower(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
