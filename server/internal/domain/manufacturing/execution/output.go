package execution

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

func outputSnapshot(item Output) map[string]any {
	return snapshot(map[string]any{
		"output_no": item.OutputNo, "output_date": item.OutputDate,
		"remarks": item.Remarks, "status": item.Status,
		"audited_at": item.AuditedAt, "company_id": item.CompanyID,
		"warehouse_id": item.WarehouseID, "created_by_id": item.CreatedByID,
		"audited_by_id": item.AuditedByID,
	})
}

func outputItemSnapshot(item OutputItem) map[string]any {
	return snapshot(map[string]any{
		"idx": item.Idx, "qty": item.Qty, "base_qty": item.BaseQty,
		"material_code": item.MaterialCode, "material_name": item.MaterialName,
		"material_spec": item.MaterialSpec, "unit_name": item.UnitName,
		"remarks": item.Remarks, "output_id": item.OutputID,
		"company_id": item.CompanyID, "work_order_id": item.WorkOrderID,
		"material_id": item.MaterialID, "unit_id": item.UnitID,
		"warehouse_id": item.WarehouseID,
	})
}

func validateWarehouse(
	ctx context.Context, tx pgx.Tx, warehouseID *uuid.UUID, companyID uuid.UUID,
) error {
	if warehouseID == nil {
		return nil
	}
	var actualCompany uuid.UUID
	var isLeaf, active bool
	err := tx.QueryRow(ctx, `SELECT company_id,is_leaf,active FROM inv_warehouse
		WHERE id=$1`, *warehouseID).Scan(&actualCompany, &isLeaf, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation("生产入库仓库不合法",
			map[string][]string{"warehouseId": {"仓库不存在"}})
	}
	if err != nil {
		return internal("校验生产入库仓库失败", err)
	}
	switch {
	case actualCompany != companyID:
		return apierror.Validation("生产入库仓库不合法",
			map[string][]string{"warehouseId": {"仓库不属于本公司"}})
	case !isLeaf:
		return apierror.Validation("生产入库仓库不合法",
			map[string][]string{"warehouseId": {"仅叶子仓可入库"}})
	case !active:
		return apierror.Validation("生产入库仓库不合法",
			map[string][]string{"warehouseId": {"仓库已停用"}})
	}
	return nil
}

func (s *Service) CreateOutput(
	ctx context.Context, actor *authz.Actor, input CreateOutputInput,
) (Output, error) {
	if err := require(actor, "mfg.output", "create"); err != nil {
		return Output{}, err
	}
	if err := requireCompany(actor, input.CompanyID); err != nil {
		return Output{}, err
	}
	if input.CompanyID == uuid.Nil {
		return Output{}, apierror.Validation("生产入库单参数不合法",
			map[string][]string{"companyId": {"必填"}})
	}
	if err := validateRemarks(input.Remarks); err != nil {
		return Output{}, err
	}
	tx, err := begin(ctx, s.pool, "创建生产入库单失败")
	if err != nil {
		return Output{}, err
	}
	defer tx.Rollback(ctx)
	if err := validateWarehouse(ctx, tx, input.WarehouseID, input.CompanyID); err != nil {
		return Output{}, err
	}
	outputDate := todayUTC()
	if input.OutputDate != nil {
		outputDate = *input.OutputDate
	}
	no := ""
	if input.OutputNo != nil {
		no = strings.TrimSpace(*input.OutputNo)
	}
	if no == "" {
		no, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "mfg.output",
			Values: map[string]any{
				"company_id": input.CompanyID, "output_date": outputDate,
			},
		})
		if err != nil {
			return Output{}, err
		}
	}
	if err := validateNo(no, "outputNo"); err != nil {
		return Output{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO mfg_output (
		output_no,output_date,remarks,status,company_id,warehouse_id,created_by_id
	) VALUES ($1,$2,$3,'draft',$4,$5,$6) RETURNING id`,
		no, date(outputDate), text(input.Remarks), input.CompanyID,
		input.WarehouseID, actorID(actor),
	).Scan(&id)
	if err != nil {
		return Output{}, writeError("创建生产入库单失败", err)
	}
	result, err := queryOutput(ctx, tx, id, false)
	if err != nil {
		return Output{}, internal("读取新建生产入库单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_output", id, result.OutputNo,
		"create", "create", result.CompanyID, created(outputSnapshot(result))); err != nil {
		return Output{}, err
	}
	if err := commit(ctx, tx, "创建生产入库单失败"); err != nil {
		return Output{}, err
	}
	return result, nil
}

func (s *Service) UpdateOutput(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateOutputInput,
) (Output, error) {
	if err := require(actor, "mfg.output", "update"); err != nil {
		return Output{}, err
	}
	tx, err := begin(ctx, s.pool, "更新生产入库单失败")
	if err != nil {
		return Output{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryOutput(ctx, tx, id, true)
	if err != nil {
		return Output{}, rowLockedMessage("生产入库单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Output{}, err
	}
	if before.Status != OutputStatusDraft {
		return Output{}, conflict("仅草稿生产入库单可修改或删除")
	}
	after := before
	if input.OutputNo != nil {
		after.OutputNo = strings.TrimSpace(*input.OutputNo)
	}
	if input.OutputDate != nil {
		after.OutputDate = *input.OutputDate
	}
	if input.WarehouseID != nil {
		after.WarehouseID = *input.WarehouseID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if err := validateNo(after.OutputNo, "outputNo"); err != nil {
		return Output{}, err
	}
	if err := validateRemarks(after.Remarks); err != nil {
		return Output{}, err
	}
	if err := validateWarehouse(ctx, tx, after.WarehouseID, after.CompanyID); err != nil {
		return Output{}, err
	}
	changes := changed(outputSnapshot(before), outputSnapshot(after))
	if len(changes) > 0 {
		_, err = tx.Exec(ctx, `UPDATE mfg_output SET output_no=$2,output_date=$3,
			warehouse_id=$4,remarks=$5,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
			id, after.OutputNo, date(after.OutputDate), after.WarehouseID,
			text(after.Remarks))
		if err != nil {
			return Output{}, writeError("更新生产入库单失败", err)
		}
		if err := writeAudit(ctx, tx, actor, "mfg_output", id, after.OutputNo,
			"update", "update", after.CompanyID, changes); err != nil {
			return Output{}, err
		}
	}
	if err := commit(ctx, tx, "更新生产入库单失败"); err != nil {
		return Output{}, err
	}
	return after, nil
}

func (s *Service) DeleteOutput(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "mfg.output", "delete"); err != nil {
		return err
	}
	tx, err := begin(ctx, s.pool, "删除生产入库单失败")
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	item, err := queryOutput(ctx, tx, id, true)
	if err != nil {
		return rowLockedMessage("生产入库单", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return err
	}
	if item.Status != OutputStatusDraft {
		return conflict("仅草稿生产入库单可修改或删除")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_output WHERE id=$1`, id); err != nil {
		return writeError("删除生产入库单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_output", id, item.OutputNo,
		"destroy", "destroy", item.CompanyID, destroyed(outputSnapshot(item))); err != nil {
		return err
	}
	return commit(ctx, tx, "删除生产入库单失败")
}

func (s *Service) CreateOutputItem(
	ctx context.Context, actor *authz.Actor, input CreateOutputItemInput,
) (OutputItem, error) {
	if err := require(actor, "mfg.output", "create"); err != nil {
		return OutputItem{}, err
	}
	if err := validateRemarks(input.Remarks); err != nil {
		return OutputItem{}, err
	}
	tx, err := begin(ctx, s.pool, "创建生产入库行失败")
	if err != nil {
		return OutputItem{}, err
	}
	defer tx.Rollback(ctx)
	parent, err := queryOutput(ctx, tx, input.OutputID, true)
	if err != nil {
		return OutputItem{}, rowLockedMessage("生产入库单", err)
	}
	if err := requireCompany(actor, parent.CompanyID); err != nil {
		return OutputItem{}, err
	}
	if parent.Status != OutputStatusDraft {
		return OutputItem{}, conflict("仅草稿生产入库单可编辑单据行")
	}
	workOrder, err := queryWorkOrder(ctx, tx, input.WorkOrderID, false)
	if err != nil {
		return OutputItem{}, notFound("生产工单")
	}
	if workOrder.Status == WorkOrderVoided {
		return OutputItem{}, conflict("生产工单已作废")
	}
	if workOrder.CompanyID != parent.CompanyID {
		return OutputItem{}, conflict("生产工单不属于本公司")
	}
	if err := validateWarehouse(ctx, tx, &input.WarehouseID, parent.CompanyID); err != nil {
		return OutputItem{}, err
	}
	projection, err := deriveItemProjection(ctx, tx, workOrder.MaterialID,
		input.UnitID, input.Qty)
	if err != nil {
		return OutputItem{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO mfg_output_item (
		output_id,company_id,idx,work_order_id,material_id,unit_id,warehouse_id,
		qty,base_qty,material_code,material_name,material_spec,unit_name,remarks
	) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
		parent.ID, parent.CompanyID, input.Idx, input.WorkOrderID,
		workOrder.MaterialID, input.UnitID, input.WarehouseID, input.Qty,
		projection.baseQty, workOrder.MaterialCode, workOrder.MaterialName,
		text(workOrder.MaterialSpec), projection.unitName, text(input.Remarks),
	).Scan(&id)
	if err != nil {
		return OutputItem{}, writeError("创建生产入库行失败", err)
	}
	result, err := queryOutputItem(ctx, tx, id, false)
	if err != nil {
		return OutputItem{}, internal("读取新建生产入库行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_output_item", id,
		fmt.Sprintf("%d", result.Idx), "create", "create", result.CompanyID,
		created(outputItemSnapshot(result))); err != nil {
		return OutputItem{}, err
	}
	if err := commit(ctx, tx, "创建生产入库行失败"); err != nil {
		return OutputItem{}, err
	}
	return result, nil
}

func (s *Service) UpdateOutputItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateOutputItemInput,
) (OutputItem, error) {
	if err := require(actor, "mfg.output", "update"); err != nil {
		return OutputItem{}, err
	}
	tx, err := begin(ctx, s.pool, "更新生产入库行失败")
	if err != nil {
		return OutputItem{}, err
	}
	defer tx.Rollback(ctx)
	var outputID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT output_id FROM mfg_output_item WHERE id=$1`,
		id).Scan(&outputID); err != nil {
		return OutputItem{}, notFound("生产入库行")
	}
	parent, err := queryOutput(ctx, tx, outputID, true)
	if err != nil {
		return OutputItem{}, rowLockedMessage("生产入库单", err)
	}
	if err := requireCompany(actor, parent.CompanyID); err != nil {
		return OutputItem{}, err
	}
	if parent.Status != OutputStatusDraft {
		return OutputItem{}, conflict("仅草稿生产入库单可编辑单据行")
	}
	before, err := queryOutputItem(ctx, tx, id, true)
	if err != nil {
		return OutputItem{}, rowLockedMessage("生产入库行", err)
	}
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.WorkOrderID != nil {
		after.WorkOrderID = *input.WorkOrderID
	}
	if input.UnitID != nil {
		after.UnitID = *input.UnitID
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.WarehouseID != nil {
		after.WarehouseID = *input.WarehouseID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if err := validateRemarks(after.Remarks); err != nil {
		return OutputItem{}, err
	}
	workOrder, err := queryWorkOrder(ctx, tx, after.WorkOrderID, false)
	if err != nil {
		return OutputItem{}, notFound("生产工单")
	}
	if workOrder.Status == WorkOrderVoided {
		return OutputItem{}, conflict("生产工单已作废")
	}
	if workOrder.CompanyID != parent.CompanyID {
		return OutputItem{}, conflict("生产工单不属于本公司")
	}
	if err := validateWarehouse(ctx, tx, &after.WarehouseID, parent.CompanyID); err != nil {
		return OutputItem{}, err
	}
	projection, err := deriveItemProjection(ctx, tx, workOrder.MaterialID,
		after.UnitID, after.Qty)
	if err != nil {
		return OutputItem{}, err
	}
	after.BaseQty = projection.baseQty
	after.MaterialID = workOrder.MaterialID
	after.MaterialCode, after.MaterialName = workOrder.MaterialCode, workOrder.MaterialName
	after.MaterialSpec, after.UnitName = workOrder.MaterialSpec, projection.unitName
	changes := changed(outputItemSnapshot(before), outputItemSnapshot(after))
	if len(changes) > 0 {
		_, err = tx.Exec(ctx, `UPDATE mfg_output_item SET idx=$2,work_order_id=$3,
			material_id=$4,unit_id=$5,warehouse_id=$6,qty=$7,base_qty=$8,
			material_code=$9,material_name=$10,material_spec=$11,unit_name=$12,
			remarks=$13,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
			id, after.Idx, after.WorkOrderID, after.MaterialID, after.UnitID,
			after.WarehouseID, after.Qty, after.BaseQty, after.MaterialCode,
			after.MaterialName, text(after.MaterialSpec), after.UnitName,
			text(after.Remarks))
		if err != nil {
			return OutputItem{}, writeError("更新生产入库行失败", err)
		}
		if err := writeAudit(ctx, tx, actor, "mfg_output_item", id,
			fmt.Sprintf("%d", after.Idx), "update", "update", after.CompanyID,
			changes); err != nil {
			return OutputItem{}, err
		}
	}
	if err := commit(ctx, tx, "更新生产入库行失败"); err != nil {
		return OutputItem{}, err
	}
	return after, nil
}

func (s *Service) DeleteOutputItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "mfg.output", "update"); err != nil {
		return err
	}
	tx, err := begin(ctx, s.pool, "删除生产入库行失败")
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var outputID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT output_id FROM mfg_output_item WHERE id=$1`,
		id).Scan(&outputID); err != nil {
		return notFound("生产入库行")
	}
	parent, err := queryOutput(ctx, tx, outputID, true)
	if err != nil {
		return rowLockedMessage("生产入库单", err)
	}
	if err := requireCompany(actor, parent.CompanyID); err != nil {
		return err
	}
	if parent.Status != OutputStatusDraft {
		return conflict("仅草稿生产入库单可编辑单据行")
	}
	item, err := queryOutputItem(ctx, tx, id, true)
	if err != nil {
		return rowLockedMessage("生产入库行", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_output_item WHERE id=$1`, id); err != nil {
		return writeError("删除生产入库行失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_output_item", id,
		fmt.Sprintf("%d", item.Idx), "destroy", "destroy", item.CompanyID,
		destroyed(outputItemSnapshot(item))); err != nil {
		return err
	}
	return commit(ctx, tx, "删除生产入库行失败")
}

func loadOutputItemsForUpdate(
	ctx context.Context, tx pgx.Tx, outputID uuid.UUID,
) ([]OutputItem, error) {
	rows, err := tx.Query(ctx, `SELECT `+outputItemColumns+
		` FROM mfg_output_item WHERE output_id=$1 ORDER BY idx,id FOR UPDATE`, outputID)
	if err != nil {
		return nil, internal("锁定生产入库行失败", err)
	}
	defer rows.Close()
	result := []OutputItem{}
	for rows.Next() {
		item, scanErr := scanOutputItem(rows)
		if scanErr != nil {
			return nil, internal("读取生产入库行失败", scanErr)
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

type lockedWorkOrder struct {
	item WorkOrder
	add  decimal.Decimal
}

func lockOutputWorkOrders(
	ctx context.Context, tx pgx.Tx, items []OutputItem,
) (map[uuid.UUID]lockedWorkOrder, error) {
	quantities := map[uuid.UUID]decimal.Decimal{}
	firstIdx := map[uuid.UUID]int64{}
	for _, item := range items {
		quantities[item.WorkOrderID] = quantities[item.WorkOrderID].Add(item.BaseQty)
		if _, ok := firstIdx[item.WorkOrderID]; !ok {
			firstIdx[item.WorkOrderID] = item.Idx
		}
	}
	result := make(map[uuid.UUID]lockedWorkOrder, len(quantities))
	for _, id := range sortedUUIDs(quantities) {
		item, err := queryWorkOrder(ctx, tx, id, true)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, wrapLine(firstIdx[id], "生产工单不存在")
		}
		if err != nil {
			return nil, internal("锁定生产工单失败", err)
		}
		result[id] = lockedWorkOrder{item: item, add: quantities[id]}
	}
	return result, nil
}

func outputRatio(ctx context.Context, tx pgx.Tx) (decimal.Decimal, error) {
	var ratio decimal.Decimal
	err := tx.QueryRow(ctx, `SELECT coalesce(
		(SELECT output_overreceive_ratio FROM mfg_setting ORDER BY inserted_at,id LIMIT 1),0
	)`).Scan(&ratio)
	if err != nil {
		return decimal.Zero, internal("读取生产入库超入比例失败", err)
	}
	return ratio, nil
}

func checkOutput(
	ctx context.Context,
	tx pgx.Tx,
	output Output,
	items []OutputItem,
	orders map[uuid.UUID]lockedWorkOrder,
) error {
	if len(items) == 0 {
		return conflict("审核前必须至少填写一行入库条目")
	}
	ratio, err := outputRatio(ctx, tx)
	if err != nil {
		return err
	}
	for _, item := range items {
		order := orders[item.WorkOrderID].item
		switch {
		case order.Status == WorkOrderVoided:
			return wrapLine(item.Idx, "生产工单已作废,不可入库")
		case order.CompanyID != output.CompanyID:
			return wrapLine(item.Idx, "生产工单不属于本公司")
		case order.MaterialID != item.MaterialID:
			return wrapLine(item.Idx, "物料与生产工单不一致")
		}
		if err := validateWarehouse(ctx, tx, &item.WarehouseID, output.CompanyID); err != nil {
			return wrapLine(item.Idx, err.Error())
		}
	}
	ids := make([]uuid.UUID, 0, len(orders))
	for id := range orders {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	for _, id := range ids {
		group := orders[id]
		maxAllowed := group.item.BaseQty.Mul(decimal.NewFromInt(1).Add(ratio))
		after := group.item.ReceivedBaseQty.Add(group.add)
		if after.GreaterThan(maxAllowed) {
			return conflict(fmt.Sprintf(
				"超出生产入库容差(已入%s+本单%s > 工单%s×(1+%s))",
				group.item.ReceivedBaseQty, group.add, group.item.BaseQty, ratio,
			))
		}
	}
	return nil
}

func stockLines(items []OutputItem, outputRemarks *string) []stock.Line {
	lines := make([]stock.Line, 0, len(items))
	for _, item := range items {
		remarks := item.Remarks
		if remarks == nil {
			remarks = outputRemarks
		}
		lines = append(lines, stock.Line{
			WarehouseID: item.WarehouseID, MaterialID: item.MaterialID,
			Quantity: item.BaseQty, Remarks: remarks,
		})
	}
	return lines
}

func updateWorkOrderProjection(
	ctx context.Context,
	tx pgx.Tx,
	orders map[uuid.UUID]lockedWorkOrder,
	direction decimal.Decimal,
) error {
	for _, id := range sortedUUIDs(func() map[uuid.UUID]decimal.Decimal {
		values := make(map[uuid.UUID]decimal.Decimal, len(orders))
		for key, value := range orders {
			values[key] = value.add
		}
		return values
	}()) {
		order := orders[id].item
		next := order.ReceivedBaseQty.Add(orders[id].add.Mul(direction))
		if next.IsNegative() {
			return conflict("生产工单已入数量不能为负")
		}
		orderStatus := WorkOrderInProgress
		itemStatus := DemandItemScheduled
		if !next.LessThan(order.BaseQty) {
			orderStatus = WorkOrderCompleted
			itemStatus = DemandItemCompleted
		}
		if _, err := tx.Exec(ctx, `UPDATE mfg_work_order SET received_base_qty=$2,
			status=$3,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
			id, next, orderStatus); err != nil {
			return writeError("更新生产工单已入投影失败", err)
		}
		if err := SetDemandItemStatusInTx(ctx, tx, order.DemandItemID, itemStatus); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) AuditOutput(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (Output, error) {
	if err := require(actor, "mfg.output", "audit"); err != nil {
		return Output{}, err
	}
	tx, err := begin(ctx, s.pool, "审核生产入库单失败")
	if err != nil {
		return Output{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryOutput(ctx, tx, id, true)
	if err != nil {
		return Output{}, rowLockedMessage("生产入库单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Output{}, err
	}
	if before.Status != OutputStatusDraft {
		return Output{}, conflict("仅草稿生产入库单可审核")
	}
	items, err := loadOutputItemsForUpdate(ctx, tx, id)
	if err != nil {
		return Output{}, err
	}
	orders, err := lockOutputWorkOrders(ctx, tx, items)
	if err != nil {
		return Output{}, err
	}
	if err := checkOutput(ctx, tx, before, items, orders); err != nil {
		return Output{}, err
	}
	if err := stock.Post(ctx, tx, stock.Voucher{
		Type: "mfg.output", ID: before.ID, No: before.OutputNo,
		CompanyID: before.CompanyID, PostingDate: before.OutputDate,
	}, stockLines(items, before.Remarks)); err != nil {
		return Output{}, err
	}
	if err := updateWorkOrderProjection(ctx, tx, orders, decimal.NewFromInt(1)); err != nil {
		return Output{}, err
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `UPDATE mfg_output SET status='audited',
		audited_at=$2,audited_by_id=$3,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1`, id, now, actorID(actor)); err != nil {
		return Output{}, writeError("审核生产入库单失败", err)
	}
	after := before
	after.Status, after.AuditedAt, after.AuditedByID = OutputStatusAudited, &now, actorID(actor)
	if err := writeAudit(ctx, tx, actor, "mfg_output", id, after.OutputNo,
		"update", "audit", after.CompanyID,
		changed(outputSnapshot(before), outputSnapshot(after))); err != nil {
		return Output{}, err
	}
	if err := commit(ctx, tx, "审核生产入库单失败"); err != nil {
		return Output{}, err
	}
	return after, nil
}

func (s *Service) VoidOutput(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (Output, error) {
	if err := require(actor, "mfg.output", "void"); err != nil {
		return Output{}, err
	}
	tx, err := begin(ctx, s.pool, "作废生产入库单失败")
	if err != nil {
		return Output{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryOutput(ctx, tx, id, true)
	if err != nil {
		return Output{}, rowLockedMessage("生产入库单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Output{}, err
	}
	if before.Status != OutputStatusAudited {
		return Output{}, conflict("仅已审核生产入库单可作废")
	}
	items, err := loadOutputItemsForUpdate(ctx, tx, id)
	if err != nil {
		return Output{}, err
	}
	orders, err := lockOutputWorkOrders(ctx, tx, items)
	if err != nil {
		return Output{}, err
	}
	// Both audit and void lock output -> items -> sorted work orders -> sorted
	// stock balance keys, so concurrent lifecycle actions cannot deadlock.
	if err := stock.Cancel(ctx, tx, stock.VoucherRef{
		Type: "mfg.output", ID: before.ID,
	}, time.Now().UTC()); err != nil {
		return Output{}, err
	}
	if err := updateWorkOrderProjection(ctx, tx, orders, decimal.NewFromInt(-1)); err != nil {
		return Output{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE mfg_output SET status='voided',
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id); err != nil {
		return Output{}, writeError("作废生产入库单失败", err)
	}
	after := before
	after.Status = OutputStatusVoided
	if err := writeAudit(ctx, tx, actor, "mfg_output", id, after.OutputNo,
		"update", "void", after.CompanyID,
		changed(outputSnapshot(before), outputSnapshot(after))); err != nil {
		return Output{}, err
	}
	if err := commit(ctx, tx, "作废生产入库单失败"); err != nil {
		return Output{}, err
	}
	return after, nil
}
