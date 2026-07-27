package execution

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

func demandSnapshot(item Demand) map[string]any {
	return snapshot(map[string]any{
		"demand_no": item.DemandNo, "demand_date": item.DemandDate,
		"remarks": item.Remarks, "status": item.Status, "company_id": item.CompanyID,
		"created_by_id": item.CreatedByID,
	})
}

func demandItemSnapshot(item DemandItem) map[string]any {
	return snapshot(map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty,
		"ordered_qty": item.OrderedQty, "received_qty": item.ReceivedQty,
		"need_date": item.NeedDate, "fulfillment_method": item.FulfillmentMethod,
		"status": item.Status, "material_code": item.MaterialCode,
		"material_name": item.MaterialName, "material_spec": item.MaterialSpec,
		"unit_name": item.UnitName, "remarks": item.Remarks,
		"demand_id": item.DemandID, "company_id": item.CompanyID,
		"material_id": item.MaterialID, "unit_id": item.UnitID,
		"sales_order_item_id": item.SalesOrderItemID,
	})
}

func (s *Service) CreateDemand(
	ctx context.Context, actor *authz.Actor, input CreateDemandInput,
) (Demand, error) {
	if err := require(actor, "mfg.demand", "create"); err != nil {
		return Demand{}, err
	}
	if err := requireCompany(actor, input.CompanyID); err != nil {
		return Demand{}, err
	}
	if input.CompanyID == uuid.Nil {
		return Demand{}, apierror.Validation("履约需求单参数不合法",
			map[string][]string{"companyId": {"必填"}})
	}
	if err := validateRemarks(input.Remarks); err != nil {
		return Demand{}, err
	}
	tx, err := begin(ctx, s.pool, "创建履约需求单失败")
	if err != nil {
		return Demand{}, err
	}
	defer tx.Rollback(ctx)
	demandDate := todayUTC()
	if input.DemandDate != nil {
		demandDate = *input.DemandDate
	}
	no := ""
	if input.DemandNo != nil {
		no = strings.TrimSpace(*input.DemandNo)
	}
	if no == "" {
		no, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "mfg.demand",
			Values: map[string]any{
				"company_id": input.CompanyID, "demand_date": demandDate,
			},
		})
		if err != nil {
			return Demand{}, err
		}
	}
	if err := validateNo(no, "demandNo"); err != nil {
		return Demand{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO mfg_demand
		(demand_no,demand_date,remarks,status,company_id,created_by_id)
		VALUES ($1,$2,$3,'draft',$4,$5) RETURNING id`,
		no, pgconv.DateAlways(demandDate), pgconv.Text(input.Remarks), input.CompanyID, actorID(actor),
	).Scan(&id)
	if err != nil {
		return Demand{}, writeError("创建履约需求单失败", err)
	}
	result, err := queryDemand(ctx, tx, id, false)
	if err != nil {
		return Demand{}, internal("读取新建履约需求单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_demand", id, result.DemandNo,
		"create", "create", result.CompanyID, created(demandSnapshot(result))); err != nil {
		return Demand{}, err
	}
	if err := commit(ctx, tx, "创建履约需求单失败"); err != nil {
		return Demand{}, err
	}
	return result, nil
}

func (s *Service) UpdateDemand(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateDemandInput,
) (Demand, error) {
	if err := require(actor, "mfg.demand", "update"); err != nil {
		return Demand{}, err
	}
	tx, err := begin(ctx, s.pool, "更新履约需求单失败")
	if err != nil {
		return Demand{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryDemand(ctx, tx, id, true)
	if err != nil {
		return Demand{}, rowLockedMessage("履约需求单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Demand{}, err
	}
	if before.Status != DemandStatusDraft {
		return Demand{}, conflict("仅草稿履约需求单可修改或删除")
	}
	after := before
	if input.DemandNo != nil {
		after.DemandNo = strings.TrimSpace(*input.DemandNo)
	}
	if input.DemandDate != nil {
		after.DemandDate = *input.DemandDate
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	if err := validateNo(after.DemandNo, "demandNo"); err != nil {
		return Demand{}, err
	}
	if err := validateRemarks(after.Remarks); err != nil {
		return Demand{}, err
	}
	changes := changed(demandSnapshot(before), demandSnapshot(after))
	if len(changes) == 0 {
		if err := commit(ctx, tx, "更新履约需求单失败"); err != nil {
			return Demand{}, err
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE mfg_demand SET demand_no=$2,demand_date=$3,
		remarks=$4,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.DemandNo, pgconv.DateAlways(after.DemandDate), pgconv.Text(after.Remarks))
	if err != nil {
		return Demand{}, writeError("更新履约需求单失败", err)
	}
	result, err := queryDemand(ctx, tx, id, false)
	if err != nil {
		return Demand{}, internal("读取更新后履约需求单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_demand", id, result.DemandNo,
		"update", "update", result.CompanyID, changes); err != nil {
		return Demand{}, err
	}
	if err := commit(ctx, tx, "更新履约需求单失败"); err != nil {
		return Demand{}, err
	}
	return result, nil
}

func (s *Service) DeleteDemand(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "mfg.demand", "delete"); err != nil {
		return err
	}
	tx, err := begin(ctx, s.pool, "删除履约需求单失败")
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	item, err := queryDemand(ctx, tx, id, true)
	if err != nil {
		return rowLockedMessage("履约需求单", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return err
	}
	if item.Status != DemandStatusDraft {
		return conflict("仅草稿履约需求单可修改或删除")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_demand WHERE id=$1`, id); err != nil {
		return writeError("删除履约需求单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_demand", id, item.DemandNo,
		"destroy", "destroy", item.CompanyID, destroyed(demandSnapshot(item))); err != nil {
		return err
	}
	return commit(ctx, tx, "删除履约需求单失败")
}

type itemProjection struct {
	baseQty      decimal.Decimal
	materialCode string
	materialName string
	materialSpec *string
	unitName     string
}

func deriveItemProjection(
	ctx context.Context, tx pgx.Tx, materialID, unitID uuid.UUID, qty decimal.Decimal,
) (itemProjection, error) {
	if err := ensurePositive(qty, "qty"); err != nil {
		return itemProjection{}, err
	}
	var (
		defaultUnitID uuid.UUID
		code, name    string
		spec          pgtype.Text
	)
	err := tx.QueryRow(ctx, `SELECT default_unit_id,code,name,spec
		FROM inv_material WHERE id=$1`, materialID).Scan(
		&defaultUnitID, &code, &name, &spec)
	if errors.Is(err, pgx.ErrNoRows) {
		return itemProjection{}, apierror.Validation("需求行参数不合法",
			map[string][]string{"materialId": {"物料不存在"}})
	}
	if err != nil {
		return itemProjection{}, internal("读取需求行物料失败", err)
	}
	var unitName string
	if err := tx.QueryRow(ctx, `SELECT name FROM bas_unit WHERE id=$1`, unitID).Scan(&unitName); err != nil {
		return itemProjection{}, apierror.Validation("需求行参数不合法",
			map[string][]string{"unitId": {"单位不存在"}})
	}
	baseQty := qty.Round(6)
	if unitID != defaultUnitID {
		var factor decimal.Decimal
		err := tx.QueryRow(ctx, `SELECT factor FROM inv_material_unit
			WHERE material_id=$1 AND unit_id=$2`, materialID, unitID).Scan(&factor)
		if errors.Is(err, pgx.ErrNoRows) {
			return itemProjection{}, apierror.Validation("需求行参数不合法",
				map[string][]string{"unitId": {"单位必须是物料默认单位或其单位转换单位"}})
		}
		if err != nil {
			return itemProjection{}, internal("读取需求行单位转换失败", err)
		}
		if !factor.GreaterThan(decimal.Zero) {
			return itemProjection{}, conflict("物料单位转换系数必须大于零")
		}
		baseQty = qty.Div(factor).Round(6)
	}
	return itemProjection{
		baseQty: baseQty, materialCode: code, materialName: name,
		materialSpec: pgconv.TextPtr(spec), unitName: unitName,
	}, nil
}

func validFulfillmentMethod(method FulfillmentMethod) bool {
	return method == FulfillmentMake || method == FulfillmentBuy ||
		method == FulfillmentOutsource || method == FulfillmentStock
}

func validateSalesSource(
	ctx context.Context, tx pgx.Tx, id *uuid.UUID, companyID uuid.UUID,
) error {
	if id == nil {
		return nil
	}
	var sourceCompany uuid.UUID
	var orderStatus string
	err := tx.QueryRow(ctx, `SELECT i.company_id,o.status
		FROM sal_order_item i JOIN sal_order o ON o.id=i.order_id WHERE i.id=$1`,
		*id).Scan(&sourceCompany, &orderStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation("需求行参数不合法",
			map[string][]string{"salesOrderItemId": {"销售订单条目不存在"}})
	}
	if err != nil {
		return internal("校验需求行销售来源失败", err)
	}
	switch {
	case sourceCompany != companyID:
		return apierror.Validation("需求行参数不合法",
			map[string][]string{"salesOrderItemId": {"销售订单条目不属于本公司"}})
	case orderStatus != "audited":
		return apierror.Validation("需求行参数不合法",
			map[string][]string{"salesOrderItemId": {"仅已审核未关闭的销售订单条目可纳入"}})
	}
	return nil
}

func (s *Service) CreateDemandItem(
	ctx context.Context, actor *authz.Actor, input CreateDemandItemInput,
) (DemandItem, error) {
	if err := require(actor, "mfg.demand", "create"); err != nil {
		return DemandItem{}, err
	}
	if input.FulfillmentMethod == "" {
		input.FulfillmentMethod = FulfillmentMake
	}
	if !validFulfillmentMethod(input.FulfillmentMethod) {
		return DemandItem{}, apierror.Validation("需求行参数不合法",
			map[string][]string{"fulfillmentMethod": {"履约方式不合法"}})
	}
	if err := validateRemarks(input.Remarks); err != nil {
		return DemandItem{}, err
	}
	tx, err := begin(ctx, s.pool, "创建需求行失败")
	if err != nil {
		return DemandItem{}, err
	}
	defer tx.Rollback(ctx)
	parent, err := queryDemand(ctx, tx, input.DemandID, true)
	if err != nil {
		return DemandItem{}, rowLockedMessage("履约需求单", err)
	}
	if err := requireCompany(actor, parent.CompanyID); err != nil {
		return DemandItem{}, err
	}
	if parent.Status != DemandStatusDraft {
		return DemandItem{}, conflict("仅草稿履约需求单可编辑需求行")
	}
	projection, err := deriveItemProjection(ctx, tx, input.MaterialID, input.UnitID, input.Qty)
	if err != nil {
		return DemandItem{}, err
	}
	if err := validateSalesSource(ctx, tx, input.SalesOrderItemID,
		parent.CompanyID); err != nil {
		return DemandItem{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO mfg_demand_item (
		demand_id,company_id,idx,material_id,unit_id,qty,base_qty,need_date,
		fulfillment_method,status,sales_order_item_id,material_code,material_name,
		material_spec,unit_name,remarks,ordered_qty,received_qty
	) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,$15,0,0)
	RETURNING id`,
		parent.ID, parent.CompanyID, input.Idx, input.MaterialID, input.UnitID,
		input.Qty, projection.baseQty, pgconv.NullableDate(input.NeedDate),
		input.FulfillmentMethod, input.SalesOrderItemID, projection.materialCode,
		projection.materialName, pgconv.Text(projection.materialSpec), projection.unitName,
		pgconv.Text(input.Remarks),
	).Scan(&id)
	if err != nil {
		return DemandItem{}, writeError("创建需求行失败", err)
	}
	result, err := queryDemandItem(ctx, tx, id, false)
	if err != nil {
		return DemandItem{}, internal("读取新建需求行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_demand_item", id,
		fmt.Sprintf("%d", result.Idx), "create", "create", result.CompanyID,
		created(demandItemSnapshot(result))); err != nil {
		return DemandItem{}, err
	}
	if err := commit(ctx, tx, "创建需求行失败"); err != nil {
		return DemandItem{}, err
	}
	return result, nil
}

func (s *Service) UpdateDemandItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateDemandItemInput,
) (DemandItem, error) {
	if err := require(actor, "mfg.demand", "update"); err != nil {
		return DemandItem{}, err
	}
	tx, err := begin(ctx, s.pool, "更新需求行失败")
	if err != nil {
		return DemandItem{}, err
	}
	defer tx.Rollback(ctx)
	var demandID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT demand_id FROM mfg_demand_item WHERE id=$1`,
		id).Scan(&demandID); err != nil {
		return DemandItem{}, notFound("需求行")
	}
	parent, err := queryDemand(ctx, tx, demandID, true)
	if err != nil {
		return DemandItem{}, rowLockedMessage("履约需求单", err)
	}
	if err := requireCompany(actor, parent.CompanyID); err != nil {
		return DemandItem{}, err
	}
	if parent.Status != DemandStatusDraft {
		return DemandItem{}, conflict("仅草稿履约需求单可编辑需求行")
	}
	before, err := queryDemandItem(ctx, tx, id, true)
	if err != nil {
		return DemandItem{}, rowLockedMessage("需求行", err)
	}
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.MaterialID != nil {
		after.MaterialID = *input.MaterialID
	}
	if input.UnitID != nil {
		after.UnitID = *input.UnitID
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.NeedDate.Set {
		after.NeedDate = input.NeedDate.Value
	}
	if input.FulfillmentMethod != nil {
		after.FulfillmentMethod = *input.FulfillmentMethod
	}
	if input.SalesOrderItemID.Set {
		after.SalesOrderItemID = input.SalesOrderItemID.Value
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	if !validFulfillmentMethod(after.FulfillmentMethod) {
		return DemandItem{}, apierror.Validation("需求行参数不合法",
			map[string][]string{"fulfillmentMethod": {"履约方式不合法"}})
	}
	if err := validateRemarks(after.Remarks); err != nil {
		return DemandItem{}, err
	}
	projection, err := deriveItemProjection(ctx, tx, after.MaterialID, after.UnitID, after.Qty)
	if err != nil {
		return DemandItem{}, err
	}
	after.BaseQty = projection.baseQty
	after.MaterialCode, after.MaterialName = projection.materialCode, projection.materialName
	after.MaterialSpec, after.UnitName = projection.materialSpec, projection.unitName
	if err := validateSalesSource(ctx, tx, after.SalesOrderItemID,
		parent.CompanyID); err != nil {
		return DemandItem{}, err
	}
	changes := changed(demandItemSnapshot(before), demandItemSnapshot(after))
	if len(changes) > 0 {
		_, err = tx.Exec(ctx, `UPDATE mfg_demand_item SET idx=$2,material_id=$3,
			unit_id=$4,qty=$5,base_qty=$6,need_date=$7,fulfillment_method=$8,
			sales_order_item_id=$9,material_code=$10,material_name=$11,
			material_spec=$12,unit_name=$13,remarks=$14,
			updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
			id, after.Idx, after.MaterialID, after.UnitID, after.Qty, after.BaseQty,
			pgconv.NullableDate(after.NeedDate), after.FulfillmentMethod, after.SalesOrderItemID,
			after.MaterialCode, after.MaterialName, pgconv.Text(after.MaterialSpec),
			after.UnitName, pgconv.Text(after.Remarks))
		if err != nil {
			return DemandItem{}, writeError("更新需求行失败", err)
		}
		if err := writeAudit(ctx, tx, actor, "mfg_demand_item", id,
			fmt.Sprintf("%d", after.Idx), "update", "update", after.CompanyID,
			changes); err != nil {
			return DemandItem{}, err
		}
	}
	result, err := queryDemandItem(ctx, tx, id, false)
	if err != nil {
		return DemandItem{}, internal("读取更新后需求行失败", err)
	}
	if err := commit(ctx, tx, "更新需求行失败"); err != nil {
		return DemandItem{}, err
	}
	return result, nil
}

func (s *Service) DeleteDemandItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "mfg.demand", "update"); err != nil {
		return err
	}
	tx, err := begin(ctx, s.pool, "删除需求行失败")
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var demandID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT demand_id FROM mfg_demand_item WHERE id=$1`,
		id).Scan(&demandID); err != nil {
		return notFound("需求行")
	}
	parent, err := queryDemand(ctx, tx, demandID, true)
	if err != nil {
		return rowLockedMessage("履约需求单", err)
	}
	if err := requireCompany(actor, parent.CompanyID); err != nil {
		return err
	}
	if parent.Status != DemandStatusDraft {
		return conflict("仅草稿履约需求单可编辑需求行")
	}
	item, err := queryDemandItem(ctx, tx, id, true)
	if err != nil {
		return rowLockedMessage("需求行", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_demand_item WHERE id=$1`, id); err != nil {
		return writeError("删除需求行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_demand_item", id,
		fmt.Sprintf("%d", item.Idx), "destroy", "destroy", item.CompanyID,
		destroyed(demandItemSnapshot(item))); err != nil {
		return err
	}
	return commit(ctx, tx, "删除需求行失败")
}

func (s *Service) ConfirmDemand(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (Demand, error) {
	if err := require(actor, "mfg.demand", "confirm"); err != nil {
		return Demand{}, err
	}
	tx, err := begin(ctx, s.pool, "确认履约需求单失败")
	if err != nil {
		return Demand{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryDemand(ctx, tx, id, true)
	if err != nil {
		return Demand{}, rowLockedMessage("履约需求单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Demand{}, err
	}
	if before.Status != DemandStatusDraft {
		return Demand{}, conflict("仅草稿履约需求单可确认")
	}
	var itemCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mfg_demand_item WHERE demand_id=$1`,
		id).Scan(&itemCount); err != nil {
		return Demand{}, internal("检查需求行失败", err)
	}
	if itemCount == 0 {
		return Demand{}, conflict("确认前必须至少填写一行需求行")
	}
	groups := map[uuid.UUID]decimal.Decimal{}
	rows, err := tx.Query(ctx, `SELECT sales_order_item_id,base_qty
		FROM mfg_demand_item WHERE demand_id=$1 AND sales_order_item_id IS NOT NULL`, id)
	if err != nil {
		return Demand{}, internal("读取销售占用来源失败", err)
	}
	for rows.Next() {
		var salesID uuid.UUID
		var qty decimal.Decimal
		if err := rows.Scan(&salesID, &qty); err != nil {
			rows.Close()
			return Demand{}, internal("读取销售占用来源失败", err)
		}
		groups[salesID] = groups[salesID].Add(qty)
	}
	rows.Close()
	for _, salesID := range sortedUUIDs(groups) {
		var ordered, occupied decimal.Decimal
		var sourceCompany uuid.UUID
		var status string
		err := tx.QueryRow(ctx, `SELECT i.base_qty,i.company_id,o.status
			FROM sal_order_item i JOIN sal_order o ON o.id=i.order_id
			WHERE i.id=$1 FOR UPDATE OF i`, salesID).Scan(&ordered, &sourceCompany, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return Demand{}, conflict("销售订单条目不存在")
		}
		if err != nil {
			return Demand{}, internal("锁定销售订单条目失败", err)
		}
		if sourceCompany != before.CompanyID {
			return Demand{}, conflict("销售订单条目不属于本公司")
		}
		if status != "audited" {
			return Demand{}, conflict("仅已审核未关闭的销售订单条目可纳入")
		}
		err = tx.QueryRow(ctx, `SELECT coalesce(sum(i.base_qty),0)
			FROM mfg_demand_item i JOIN mfg_demand d ON d.id=i.demand_id
			WHERE i.sales_order_item_id=$1 AND i.demand_id<>$2 AND d.status='confirmed'`,
			salesID, id).Scan(&occupied)
		if err != nil {
			return Demand{}, internal("计算销售订单已占用数量失败", err)
		}
		if occupied.Add(groups[salesID]).GreaterThan(ordered) {
			return Demand{}, conflict(fmt.Sprintf(
				"超出销售订单可占用数量(已占用%s,剩余%s,本单%s)",
				occupied, ordered.Sub(occupied), groups[salesID],
			))
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE mfg_demand SET status='confirmed',
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id); err != nil {
		return Demand{}, writeError("确认履约需求单失败", err)
	}
	after := before
	after.Status = DemandStatusConfirmed
	if err := writeAudit(ctx, tx, actor, "mfg_demand", id, after.DemandNo,
		"update", "confirm", after.CompanyID,
		changed(demandSnapshot(before), demandSnapshot(after))); err != nil {
		return Demand{}, err
	}
	if err := commit(ctx, tx, "确认履约需求单失败"); err != nil {
		return Demand{}, err
	}
	return s.GetDemand(ctx, actor, id)
}

func (s *Service) CloseDemand(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (Demand, error) {
	return s.transitionDemand(ctx, actor, id, "close", DemandStatusConfirmed,
		DemandStatusClosed, "仅已确认履约需求单可关闭")
}

func (s *Service) VoidDemand(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (Demand, error) {
	if err := require(actor, "mfg.demand", "void"); err != nil {
		return Demand{}, err
	}
	tx, err := begin(ctx, s.pool, "作废履约需求单失败")
	if err != nil {
		return Demand{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryDemand(ctx, tx, id, true)
	if err != nil {
		return Demand{}, rowLockedMessage("履约需求单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Demand{}, err
	}
	if before.Status != DemandStatusConfirmed {
		return Demand{}, conflict("仅已确认履约需求单可作废;草稿请直接删除")
	}
	// Purchase-order audit locks the referenced demand item while changing its
	// ordered projection. Lock every line first so a concurrently auditing
	// downstream order becomes visible before the active-order check.
	rows, err := tx.Query(ctx, `SELECT id FROM mfg_demand_item
		WHERE demand_id=$1 ORDER BY id FOR UPDATE`, id)
	if err != nil {
		return Demand{}, internal("锁定需求行失败", err)
	}
	for rows.Next() {
		var itemID uuid.UUID
		if err := rows.Scan(&itemID); err != nil {
			rows.Close()
			return Demand{}, internal("锁定需求行失败", err)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Demand{}, internal("锁定需求行失败", err)
	}
	var activeWork, activePurchase bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mfg_work_order
		WHERE demand_id=$1 AND status<>'voided')`, id).Scan(&activeWork); err != nil {
		return Demand{}, internal("检查生产工单失败", err)
	}
	if activeWork {
		return Demand{}, conflict("存在未作废生产工单,不可作废需求单")
	}
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM pur_order_item oi JOIN pur_order o ON o.id=oi.order_id
		JOIN mfg_demand_item i ON i.id=oi.demand_line_id
		WHERE i.demand_id=$1 AND o.status IN ('audited','closed')
	)`, id).Scan(&activePurchase); err != nil {
		return Demand{}, internal("检查采购/委外订单失败", err)
	}
	if activePurchase {
		return Demand{}, conflict("存在已审核未作废采购/委外订单,不可作废需求单")
	}
	if _, err := tx.Exec(ctx, `UPDATE mfg_demand SET status='voided',
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id); err != nil {
		return Demand{}, writeError("作废履约需求单失败", err)
	}
	after := before
	after.Status = DemandStatusVoided
	if err := writeAudit(ctx, tx, actor, "mfg_demand", id, after.DemandNo,
		"update", "void", after.CompanyID,
		changed(demandSnapshot(before), demandSnapshot(after))); err != nil {
		return Demand{}, err
	}
	if err := commit(ctx, tx, "作废履约需求单失败"); err != nil {
		return Demand{}, err
	}
	return after, nil
}

func (s *Service) transitionDemand(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, action string,
	from, to DemandStatus, message string,
) (Demand, error) {
	if err := require(actor, "mfg.demand", action); err != nil {
		return Demand{}, err
	}
	tx, err := begin(ctx, s.pool, action+"履约需求单失败")
	if err != nil {
		return Demand{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryDemand(ctx, tx, id, true)
	if err != nil {
		return Demand{}, rowLockedMessage("履约需求单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Demand{}, err
	}
	if before.Status != from {
		return Demand{}, conflict(message)
	}
	if _, err := tx.Exec(ctx, `UPDATE mfg_demand SET status=$2,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, to); err != nil {
		return Demand{}, writeError(action+"履约需求单失败", err)
	}
	after := before
	after.Status = to
	if err := writeAudit(ctx, tx, actor, "mfg_demand", id, after.DemandNo,
		"update", action, after.CompanyID,
		changed(demandSnapshot(before), demandSnapshot(after))); err != nil {
		return Demand{}, err
	}
	if err := commit(ctx, tx, action+"履约需求单失败"); err != nil {
		return Demand{}, err
	}
	return after, nil
}

func (s *Service) CompleteDemandItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (DemandItem, error) {
	if err := require(actor, "mfg.demand", "update"); err != nil {
		return DemandItem{}, err
	}
	tx, err := begin(ctx, s.pool, "完成需求行失败")
	if err != nil {
		return DemandItem{}, err
	}
	defer tx.Rollback(ctx)
	var demandID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT demand_id FROM mfg_demand_item WHERE id=$1`,
		id).Scan(&demandID); err != nil {
		return DemandItem{}, notFound("需求行")
	}
	parent, err := queryDemand(ctx, tx, demandID, true)
	if err != nil {
		return DemandItem{}, rowLockedMessage("履约需求单", err)
	}
	before, err := queryDemandItem(ctx, tx, id, true)
	if err != nil {
		return DemandItem{}, rowLockedMessage("需求行", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return DemandItem{}, err
	}
	switch {
	case parent.Status != DemandStatusConfirmed:
		return DemandItem{}, conflict("仅已确认需求单上的行可点完成")
	case before.Status != DemandItemPending:
		return DemandItem{}, conflict("仅待安排的行可点完成")
	case before.FulfillmentMethod == FulfillmentMake:
		return DemandItem{}, conflict("自制行不能直接点完成,须经生产入库完工")
	case before.OrderedQty.GreaterThan(decimal.Zero):
		return DemandItem{}, conflict("已下单的行不可手工点完成,须等入库回写")
	}
	if _, err := tx.Exec(ctx, `UPDATE mfg_demand_item SET status='completed',
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id); err != nil {
		return DemandItem{}, writeError("完成需求行失败", err)
	}
	after := before
	after.Status = DemandItemCompleted
	if err := writeAudit(ctx, tx, actor, "mfg_demand_item", id,
		fmt.Sprintf("%d", after.Idx), "update", "complete", after.CompanyID,
		changed(demandItemSnapshot(before), demandItemSnapshot(after))); err != nil {
		return DemandItem{}, err
	}
	if err := commit(ctx, tx, "完成需求行失败"); err != nil {
		return DemandItem{}, err
	}
	return after, nil
}

func (s *Service) ChangeFulfillment(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, method FulfillmentMethod,
) (DemandItem, error) {
	if err := require(actor, "mfg.demand", "update"); err != nil {
		return DemandItem{}, err
	}
	if !validFulfillmentMethod(method) {
		return DemandItem{}, apierror.Validation("需求行参数不合法",
			map[string][]string{"fulfillmentMethod": {"履约方式不合法"}})
	}
	tx, err := begin(ctx, s.pool, "修改履约方式失败")
	if err != nil {
		return DemandItem{}, err
	}
	defer tx.Rollback(ctx)
	var demandID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT demand_id FROM mfg_demand_item WHERE id=$1`,
		id).Scan(&demandID); err != nil {
		return DemandItem{}, notFound("需求行")
	}
	parent, err := queryDemand(ctx, tx, demandID, true)
	if err != nil {
		return DemandItem{}, rowLockedMessage("履约需求单", err)
	}
	before, err := queryDemandItem(ctx, tx, id, true)
	if err != nil {
		return DemandItem{}, rowLockedMessage("需求行", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return DemandItem{}, err
	}
	if parent.Status != DemandStatusConfirmed {
		return DemandItem{}, conflict("仅已确认需求单上的行可改履约方式")
	}
	if before.Status == DemandItemCompleted {
		return DemandItem{}, conflict("已完成行不可改履约方式")
	}
	var activeWork, activePurchase bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mfg_work_order
		WHERE demand_item_id=$1 AND status<>'voided')`, id).Scan(&activeWork); err != nil {
		return DemandItem{}, internal("检查生产工单失败", err)
	}
	if activeWork {
		return DemandItem{}, conflict("存在未作废生产工单,不可改履约方式")
	}
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM pur_order_item oi JOIN pur_order o ON o.id=oi.order_id
		WHERE oi.demand_line_id=$1 AND o.status IN ('audited','closed')
	)`, id).Scan(&activePurchase); err != nil {
		return DemandItem{}, internal("检查采购/委外订单失败", err)
	}
	if activePurchase {
		return DemandItem{}, conflict("存在已审核未作废采购/委外订单条目,不可改履约方式")
	}
	status := before.Status
	if status == DemandItemScheduled {
		status = DemandItemPending
	}
	if _, err := tx.Exec(ctx, `UPDATE mfg_demand_item SET fulfillment_method=$2,
		status=$3,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, method, status); err != nil {
		return DemandItem{}, writeError("修改履约方式失败", err)
	}
	after := before
	after.FulfillmentMethod, after.Status = method, status
	if err := writeAudit(ctx, tx, actor, "mfg_demand_item", id,
		fmt.Sprintf("%d", after.Idx), "update", "change_fulfillment",
		after.CompanyID, changed(demandItemSnapshot(before), demandItemSnapshot(after))); err != nil {
		return DemandItem{}, err
	}
	if err := commit(ctx, tx, "修改履约方式失败"); err != nil {
		return DemandItem{}, err
	}
	return after, nil
}

// SetDemandItemStatusInTx is the projection seam for work-order execution.
// The caller owns tx and must already hold the related work-order lock.
func SetDemandItemStatusInTx(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, status DemandItemStatus,
) error {
	if status != DemandItemPending && status != DemandItemScheduled &&
		status != DemandItemCompleted {
		return apierror.Validation("需求行状态不合法",
			map[string][]string{"status": {"未知状态"}})
	}
	tag, err := tx.Exec(ctx, `UPDATE mfg_demand_item SET status=$2,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, status)
	if err != nil {
		return internal("更新需求行状态失败", err)
	}
	if tag.RowsAffected() != 1 {
		return notFound("需求行")
	}
	return nil
}

// AdjustDemandOrderedInTx maintains the purchase-order projection.
func AdjustDemandOrderedInTx(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, delta decimal.Decimal,
) error {
	var current decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT ordered_qty FROM mfg_demand_item
		WHERE id=$1 FOR UPDATE`, id).Scan(&current); err != nil {
		return rowLockedMessage("需求行", err)
	}
	if current.Add(delta).IsNegative() {
		return conflict("已下单数量不能为负")
	}
	_, err := tx.Exec(ctx, `UPDATE mfg_demand_item SET ordered_qty=ordered_qty+$2,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, delta)
	if err != nil {
		return writeError("更新需求已下单投影失败", err)
	}
	return nil
}

// AdjustDemandReceivedInTx maintains the purchase-receipt projection and
// completes/reopens non-production demand lines at their base quantity.
func AdjustDemandReceivedInTx(
	ctx context.Context, tx pgx.Tx, id uuid.UUID, delta decimal.Decimal,
) error {
	var current, baseQty decimal.Decimal
	if err := tx.QueryRow(ctx, `SELECT received_qty,base_qty FROM mfg_demand_item
		WHERE id=$1 FOR UPDATE`, id).Scan(&current, &baseQty); err != nil {
		return rowLockedMessage("需求行", err)
	}
	next := current.Add(delta)
	if next.IsNegative() {
		return conflict("已收数量不能为负")
	}
	status := DemandItemPending
	if !next.LessThan(baseQty) {
		status = DemandItemCompleted
	}
	_, err := tx.Exec(ctx, `UPDATE mfg_demand_item SET received_qty=$2,status=$3,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, next, status)
	if err != nil {
		return writeError("更新需求已收投影失败", err)
	}
	return nil
}

func (s *Service) SalesOccupancies(
	ctx context.Context, actor *authz.Actor, ids []uuid.UUID,
) ([]SalesOccupancy, error) {
	if err := require(actor, "mfg.demand", "read"); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []SalesOccupancy{}, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT i.id,i.base_qty,
		coalesce(sum(di.base_qty) FILTER (WHERE d.status='confirmed'),0)
		FROM sal_order_item i
		LEFT JOIN mfg_demand_item di ON di.sales_order_item_id=i.id
		LEFT JOIN mfg_demand d ON d.id=di.demand_id
		WHERE i.id=ANY($1::uuid[])
		GROUP BY i.id,i.base_qty ORDER BY i.id`, ids)
	if err != nil {
		return nil, internal("查询销售占用失败", err)
	}
	defer rows.Close()
	result := []SalesOccupancy{}
	for rows.Next() {
		var item SalesOccupancy
		if err := rows.Scan(&item.SalesOrderItemID, &item.OrderedBaseQty,
			&item.OccupiedBaseQty); err != nil {
			return nil, internal("读取销售占用失败", err)
		}
		item.RemainingBaseQty = item.OrderedBaseQty.Sub(item.OccupiedBaseQty)
		result = append(result, item)
	}
	return result, rows.Err()
}

var _ = time.Time{}
