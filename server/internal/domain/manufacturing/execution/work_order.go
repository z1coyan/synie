package execution

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

func workOrderSnapshot(item WorkOrder) map[string]any {
	return snapshot(map[string]any{
		"work_order_no": item.WorkOrderNo, "qty": item.Qty,
		"base_qty": item.BaseQty, "received_base_qty": item.ReceivedBaseQty,
		"need_date": item.NeedDate, "material_code": item.MaterialCode,
		"material_name": item.MaterialName, "material_spec": item.MaterialSpec,
		"unit_name": item.UnitName, "status": item.Status,
		"company_id": item.CompanyID, "demand_id": item.DemandID,
		"demand_item_id": item.DemandItemID, "material_id": item.MaterialID,
		"unit_id": item.UnitID, "created_by_id": item.CreatedByID,
	})
}

func (s *Service) CreateWorkOrder(
	ctx context.Context, actor *authz.Actor, input CreateWorkOrderInput,
) (WorkOrder, error) {
	if err := require(actor, "mfg.work_order", "create"); err != nil {
		return WorkOrder{}, err
	}
	tx, err := begin(ctx, s.pool, "创建生产工单失败")
	if err != nil {
		return WorkOrder{}, err
	}
	defer tx.Rollback(ctx)
	var demandID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT demand_id FROM mfg_demand_item WHERE id=$1`,
		input.DemandItemID).Scan(&demandID); errors.Is(err, pgx.ErrNoRows) {
		return WorkOrder{}, notFound("需求行")
	} else if err != nil {
		return WorkOrder{}, internal("读取需求行失败", err)
	}
	parent, err := queryDemand(ctx, tx, demandID, true)
	if err != nil {
		return WorkOrder{}, rowLockedMessage("履约需求单", err)
	}
	item, err := queryDemandItem(ctx, tx, input.DemandItemID, true)
	if err != nil {
		return WorkOrder{}, rowLockedMessage("需求行", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return WorkOrder{}, err
	}
	switch {
	case parent.Status != DemandStatusConfirmed:
		return WorkOrder{}, conflict("仅已确认需求单的行可生成工单")
	case item.FulfillmentMethod != FulfillmentMake:
		return WorkOrder{}, conflict("仅自制行可生成生产工单")
	case item.Status == DemandItemCompleted:
		return WorkOrder{}, conflict("已完成的需求行不可生成工单")
	}
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mfg_work_order
		WHERE demand_item_id=$1 AND status<>'voided')`, item.ID).Scan(&active); err != nil {
		return WorkOrder{}, internal("检查已有生产工单失败", err)
	}
	if active {
		return WorkOrder{}, conflict("该需求行已有未作废生产工单")
	}
	needDate := todayUTC()
	if item.NeedDate != nil {
		needDate = *item.NeedDate
	}
	no := ""
	if input.WorkOrderNo != nil {
		no = strings.TrimSpace(*input.WorkOrderNo)
	}
	if no == "" {
		no, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "mfg.work_order",
			Values: map[string]any{
				"company_id": item.CompanyID, "need_date": needDate,
			},
		})
		if err != nil {
			return WorkOrder{}, err
		}
	}
	if err := validateNo(no, "workOrderNo"); err != nil {
		return WorkOrder{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO mfg_work_order (
		work_order_no,qty,base_qty,received_base_qty,need_date,material_code,
		material_name,material_spec,unit_name,status,company_id,demand_id,
		demand_item_id,material_id,unit_id,created_by_id
	) VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,'in_progress',$9,$10,$11,$12,$13,$14)
	RETURNING id`,
		no, item.Qty, item.BaseQty, nullableDate(item.NeedDate), item.MaterialCode,
		item.MaterialName, text(item.MaterialSpec), item.UnitName, item.CompanyID,
		item.DemandID, item.ID, item.MaterialID, item.UnitID, actorID(actor),
	).Scan(&id)
	if err != nil {
		return WorkOrder{}, writeError("创建生产工单失败", err)
	}
	if err := SetDemandItemStatusInTx(ctx, tx, item.ID, DemandItemScheduled); err != nil {
		return WorkOrder{}, err
	}
	result, err := queryWorkOrder(ctx, tx, id, false)
	if err != nil {
		return WorkOrder{}, internal("读取新建生产工单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_work_order", id, result.WorkOrderNo,
		"create", "create", result.CompanyID, created(workOrderSnapshot(result))); err != nil {
		return WorkOrder{}, err
	}
	if err := commit(ctx, tx, "创建生产工单失败"); err != nil {
		return WorkOrder{}, err
	}
	return result, nil
}

func (s *Service) UpdateWorkOrder(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateWorkOrderInput,
) (WorkOrder, error) {
	if err := require(actor, "mfg.work_order", "update"); err != nil {
		return WorkOrder{}, err
	}
	no := strings.TrimSpace(input.WorkOrderNo)
	if err := validateNo(no, "workOrderNo"); err != nil {
		return WorkOrder{}, err
	}
	tx, err := begin(ctx, s.pool, "更新生产工单失败")
	if err != nil {
		return WorkOrder{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryWorkOrder(ctx, tx, id, true)
	if err != nil {
		return WorkOrder{}, rowLockedMessage("生产工单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return WorkOrder{}, err
	}
	if before.Status != WorkOrderInProgress {
		return WorkOrder{}, conflict("仅进行中的生产工单可修改")
	}
	after := before
	after.WorkOrderNo = no
	changes := changed(workOrderSnapshot(before), workOrderSnapshot(after))
	if len(changes) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE mfg_work_order SET work_order_no=$2,
			updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, no); err != nil {
			return WorkOrder{}, writeError("更新生产工单失败", err)
		}
		if err := writeAudit(ctx, tx, actor, "mfg_work_order", id, no,
			"update", "update", after.CompanyID, changes); err != nil {
			return WorkOrder{}, err
		}
	}
	if err := commit(ctx, tx, "更新生产工单失败"); err != nil {
		return WorkOrder{}, err
	}
	return after, nil
}

func (s *Service) DeleteWorkOrder(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	if err := require(actor, "mfg.work_order", "delete"); err != nil {
		return err
	}
	tx, err := begin(ctx, s.pool, "删除生产工单失败")
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	item, err := queryWorkOrder(ctx, tx, id, true)
	if err != nil {
		return rowLockedMessage("生产工单", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return err
	}
	if item.Status != WorkOrderInProgress && item.Status != WorkOrderVoided {
		return conflict("仅进行中的生产工单可删除")
	}
	activeOutput, err := hasAuditedOutput(ctx, tx, id)
	if err != nil {
		return err
	}
	if activeOutput {
		return conflict("存在已审核生产入库,不可删除工单")
	}
	if item.Status == WorkOrderInProgress {
		if err := SetDemandItemStatusInTx(ctx, tx, item.DemandItemID,
			DemandItemPending); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_work_order WHERE id=$1`, id); err != nil {
		return writeError("删除生产工单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_work_order", id, item.WorkOrderNo,
		"destroy", "destroy", item.CompanyID, destroyed(workOrderSnapshot(item))); err != nil {
		return err
	}
	return commit(ctx, tx, "删除生产工单失败")
}

func (s *Service) VoidWorkOrder(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (WorkOrder, error) {
	if err := require(actor, "mfg.work_order", "void"); err != nil {
		return WorkOrder{}, err
	}
	tx, err := begin(ctx, s.pool, "作废生产工单失败")
	if err != nil {
		return WorkOrder{}, err
	}
	defer tx.Rollback(ctx)
	before, err := queryWorkOrder(ctx, tx, id, true)
	if err != nil {
		return WorkOrder{}, rowLockedMessage("生产工单", err)
	}
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return WorkOrder{}, err
	}
	if before.Status != WorkOrderInProgress {
		return WorkOrder{}, conflict("仅进行中的生产工单可作废")
	}
	activeOutput, err := hasAuditedOutput(ctx, tx, id)
	if err != nil {
		return WorkOrder{}, err
	}
	if activeOutput {
		return WorkOrder{}, conflict("存在已审核生产入库,不可作废工单")
	}
	if _, err := tx.Exec(ctx, `UPDATE mfg_work_order SET status='voided',
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id); err != nil {
		return WorkOrder{}, writeError("作废生产工单失败", err)
	}
	if err := SetDemandItemStatusInTx(ctx, tx, before.DemandItemID,
		DemandItemPending); err != nil {
		return WorkOrder{}, err
	}
	after := before
	after.Status = WorkOrderVoided
	if err := writeAudit(ctx, tx, actor, "mfg_work_order", id, after.WorkOrderNo,
		"update", "void", after.CompanyID,
		changed(workOrderSnapshot(before), workOrderSnapshot(after))); err != nil {
		return WorkOrder{}, err
	}
	if err := commit(ctx, tx, "作废生产工单失败"); err != nil {
		return WorkOrder{}, err
	}
	return after, nil
}

func hasAuditedOutput(ctx context.Context, tx pgx.Tx, workOrderID uuid.UUID) (bool, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM mfg_output_item i JOIN mfg_output o ON o.id=i.output_id
		WHERE i.work_order_id=$1 AND o.status='audited'
	)`, workOrderID).Scan(&exists); err != nil {
		return false, internal("检查已审核生产入库失败", err)
	}
	return exists, nil
}
