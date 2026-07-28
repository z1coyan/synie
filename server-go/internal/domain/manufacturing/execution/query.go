package execution

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const demandColumns = `id,demand_no,demand_date,remarks,status,company_id,
	created_by_id,inserted_at,updated_at`

const demandItemColumns = `id,demand_id,company_id,idx,material_id,unit_id,qty,base_qty,
	ordered_qty,received_qty,need_date,fulfillment_method,status,sales_order_item_id,
	material_code,material_name,material_spec,unit_name,remarks,inserted_at,updated_at`

const workOrderColumns = `id,work_order_no,qty,base_qty,received_base_qty,need_date,
	material_code,material_name,material_spec,unit_name,status,company_id,demand_id,
	demand_item_id,material_id,unit_id,created_by_id,inserted_at,updated_at`

const outputColumns = `id,output_no,output_date,remarks,status,audited_at,company_id,
	warehouse_id,created_by_id,audited_by_id,inserted_at,updated_at`

const outputItemColumns = `id,output_id,company_id,idx,work_order_id,material_id,unit_id,
	warehouse_id,qty,base_qty,material_code,material_name,material_spec,unit_name,remarks,
	inserted_at,updated_at`

type scanner interface {
	Scan(...any) error
}

func scanDemand(row scanner) (Demand, error) {
	var item Demand
	var demandDate pgtype.Date
	var remarks pgtype.Text
	var createdBy pgtype.UUID
	err := row.Scan(
		&item.ID, &item.DemandNo, &demandDate, &remarks, &item.Status,
		&item.CompanyID, &createdBy, &item.InsertedAt, &item.UpdatedAt,
	)
	item.DemandDate = demandDate.Time
	item.Remarks = pgconv.TextPtr(remarks)
	item.CreatedByID = uuidPtr(createdBy)
	return item, err
}

func scanDemandItem(row scanner) (DemandItem, error) {
	var item DemandItem
	var needDate pgtype.Date
	var salesOrderItem pgtype.UUID
	var materialSpec, remarks pgtype.Text
	err := row.Scan(
		&item.ID, &item.DemandID, &item.CompanyID, &item.Idx, &item.MaterialID,
		&item.UnitID, &item.Qty, &item.BaseQty, &item.OrderedQty, &item.ReceivedQty,
		&needDate, &item.FulfillmentMethod, &item.Status, &salesOrderItem,
		&item.MaterialCode, &item.MaterialName, &materialSpec, &item.UnitName, &remarks,
		&item.InsertedAt, &item.UpdatedAt,
	)
	item.NeedDate = datePtr(needDate)
	item.SalesOrderItemID = uuidPtr(salesOrderItem)
	item.MaterialSpec = pgconv.TextPtr(materialSpec)
	item.Remarks = pgconv.TextPtr(remarks)
	item.Ordered = item.OrderedQty.GreaterThan(decimal.Zero) && item.Status != DemandItemCompleted
	item.RemainingOrderable = item.BaseQty.Sub(item.OrderedQty)
	return item, err
}

func scanWorkOrder(row scanner) (WorkOrder, error) {
	var item WorkOrder
	var needDate pgtype.Date
	var materialSpec pgtype.Text
	var createdBy pgtype.UUID
	err := row.Scan(
		&item.ID, &item.WorkOrderNo, &item.Qty, &item.BaseQty,
		&item.ReceivedBaseQty, &needDate, &item.MaterialCode, &item.MaterialName,
		&materialSpec, &item.UnitName, &item.Status, &item.CompanyID, &item.DemandID,
		&item.DemandItemID, &item.MaterialID, &item.UnitID, &createdBy,
		&item.InsertedAt, &item.UpdatedAt,
	)
	item.NeedDate = datePtr(needDate)
	item.MaterialSpec = pgconv.TextPtr(materialSpec)
	item.CreatedByID = uuidPtr(createdBy)
	item.RemainingBaseQty = item.BaseQty.Sub(item.ReceivedBaseQty)
	return item, err
}

func scanOutput(row scanner) (Output, error) {
	var item Output
	var outputDate pgtype.Date
	var remarks pgtype.Text
	var auditedAt pgtype.Timestamp
	var warehouse, createdBy, auditedBy pgtype.UUID
	err := row.Scan(
		&item.ID, &item.OutputNo, &outputDate, &remarks, &item.Status,
		&auditedAt, &item.CompanyID, &warehouse, &createdBy, &auditedBy,
		&item.InsertedAt, &item.UpdatedAt,
	)
	item.OutputDate = outputDate.Time
	item.Remarks = pgconv.TextPtr(remarks)
	item.AuditedAt = pgconv.OptionalTime(auditedAt)
	item.WarehouseID = uuidPtr(warehouse)
	item.CreatedByID = uuidPtr(createdBy)
	item.AuditedByID = uuidPtr(auditedBy)
	return item, err
}

func scanOutputItem(row scanner) (OutputItem, error) {
	var item OutputItem
	var materialSpec, remarks pgtype.Text
	err := row.Scan(
		&item.ID, &item.OutputID, &item.CompanyID, &item.Idx, &item.WorkOrderID,
		&item.MaterialID, &item.UnitID, &item.WarehouseID, &item.Qty, &item.BaseQty,
		&item.MaterialCode, &item.MaterialName, &materialSpec, &item.UnitName,
		&remarks, &item.InsertedAt, &item.UpdatedAt,
	)
	item.MaterialSpec = pgconv.TextPtr(materialSpec)
	item.Remarks = pgconv.TextPtr(remarks)
	return item, err
}

func queryDemand(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id uuid.UUID, lock bool) (Demand, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	return scanDemand(db.QueryRow(ctx,
		`SELECT `+demandColumns+` FROM mfg_demand WHERE id=$1`+suffix, id))
}

func queryDemandItem(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id uuid.UUID, lock bool) (DemandItem, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	return scanDemandItem(db.QueryRow(ctx,
		`SELECT `+demandItemColumns+` FROM mfg_demand_item WHERE id=$1`+suffix, id))
}

func queryWorkOrder(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id uuid.UUID, lock bool) (WorkOrder, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	return scanWorkOrder(db.QueryRow(ctx,
		`SELECT `+workOrderColumns+` FROM mfg_work_order WHERE id=$1`+suffix, id))
}

func queryOutput(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id uuid.UUID, lock bool) (Output, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	return scanOutput(db.QueryRow(ctx,
		`SELECT `+outputColumns+` FROM mfg_output WHERE id=$1`+suffix, id))
}

func queryOutputItem(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id uuid.UUID, lock bool) (OutputItem, error) {
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	return scanOutputItem(db.QueryRow(ctx,
		`SELECT `+outputItemColumns+` FROM mfg_output_item WHERE id=$1`+suffix, id))
}

func scopedListWhere(
	actor *authz.Actor,
	explicit *uuid.UUID,
	where string,
	args []any,
) (string, []any, error) {
	args = append([]any(nil), args...)
	if explicit != nil {
		if err := requireCompany(actor, *explicit); err != nil {
			return "", nil, err
		}
		clause := fmt.Sprintf(`"company_id"=$%d`, len(args)+1)
		if where == "" {
			where = " WHERE " + clause
		} else {
			where += " AND " + clause
		}
		return where, append(args, *explicit), nil
	}
	where, args = filterbuild.ApplyCompanyFilter(actor, where, args, "company_id")
	return where, args, nil
}

func (s *Service) GetDemand(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (Demand, error) {
	if err := require(actor, "mfg.demand", "read"); err != nil {
		return Demand{}, err
	}
	item, err := queryDemand(ctx, s.pool, id, false)
	if err != nil {
		if err == pgx.ErrNoRows {
			return Demand{}, notFound("履约需求单")
		}
		return Demand{}, internal("读取履约需求单失败", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return Demand{}, err
	}
	return item, nil
}

func (s *Service) ListDemands(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (DemandList, error) {
	if err := require(actor, "mfg.demand", "read"); err != nil {
		return DemandList{}, err
	}
	if err := validateList(&query); err != nil {
		return DemandList{}, err
	}
	built, err := filterbuild.Build(DemandResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return DemandList{}, err
	}
	where, args, err := scopedListWhere(actor, query.CompanyID, built.Where, built.Args)
	if err != nil {
		return DemandList{}, err
	}
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "inserted_at" DESC,"id" DESC`
	} else {
		orderBy += `,"id" DESC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return DemandList{}, internal("查询履约需求单失败", err)
	}
	defer tx.Rollback(ctx)
	var result DemandList
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mfg_demand`+where, args...).
		Scan(&result.Count); err != nil {
		return DemandList{}, internal("统计履约需求单失败", err)
	}
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT `+demandColumns+` FROM mfg_demand`+
		where+orderBy+fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return DemandList{}, internal("查询履约需求单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Demand, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanDemand(rows)
		if scanErr != nil {
			return DemandList{}, internal("读取履约需求单失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return DemandList{}, internal("遍历履约需求单失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return DemandList{}, internal("完成履约需求单查询失败", err)
	}
	return result, nil
}

func (s *Service) GetDemandItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (DemandItem, error) {
	if err := require(actor, "mfg.demand", "read"); err != nil {
		return DemandItem{}, err
	}
	item, err := queryDemandItem(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return DemandItem{}, notFound("需求行")
	}
	if err != nil {
		return DemandItem{}, internal("读取需求行失败", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return DemandItem{}, err
	}
	return item, nil
}

func (s *Service) ListDemandItems(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (DemandItemList, error) {
	if err := require(actor, "mfg.demand", "read"); err != nil {
		return DemandItemList{}, err
	}
	if err := validateList(&query); err != nil {
		return DemandItemList{}, err
	}
	built, err := filterbuild.Build(DemandItemResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return DemandItemList{}, err
	}
	where, args, err := scopedListWhere(actor, query.CompanyID, built.Where, built.Args)
	if err != nil {
		return DemandItemList{}, err
	}
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "idx" ASC,"id" ASC`
	} else {
		orderBy += `,"id" ASC`
	}
	source := ` FROM (SELECT i.*,
		(i.ordered_qty>0 AND i.status<>'completed') AS ordered,
		(i.base_qty-i.ordered_qty) AS remaining_orderable_qty
		FROM mfg_demand_item i) demand_items`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return DemandItemList{}, internal("查询履约需求行失败", err)
	}
	defer tx.Rollback(ctx)
	var result DemandItemList
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).
		Scan(&result.Count); err != nil {
		return DemandItemList{}, internal("统计履约需求行失败", err)
	}
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT `+demandItemColumns+source+where+orderBy+
		fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return DemandItemList{}, internal("查询履约需求行失败", err)
	}
	defer rows.Close()
	result.Results = make([]DemandItem, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanDemandItem(rows)
		if scanErr != nil {
			return DemandItemList{}, internal("读取履约需求行失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return DemandItemList{}, internal("遍历履约需求行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return DemandItemList{}, internal("完成履约需求行查询失败", err)
	}
	return result, nil
}

func (s *Service) GetWorkOrder(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (WorkOrder, error) {
	if err := require(actor, "mfg.work_order", "read"); err != nil {
		return WorkOrder{}, err
	}
	item, err := queryWorkOrder(ctx, s.pool, id, false)
	if err != nil {
		if err == pgx.ErrNoRows {
			return WorkOrder{}, notFound("生产工单")
		}
		return WorkOrder{}, internal("读取生产工单失败", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return WorkOrder{}, err
	}
	return item, nil
}

func (s *Service) ListWorkOrders(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (WorkOrderList, error) {
	if err := require(actor, "mfg.work_order", "read"); err != nil {
		return WorkOrderList{}, err
	}
	if err := validateList(&query); err != nil {
		return WorkOrderList{}, err
	}
	built, err := filterbuild.Build(WorkOrderResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return WorkOrderList{}, err
	}
	where, args, err := scopedListWhere(actor, query.CompanyID, built.Where, built.Args)
	if err != nil {
		return WorkOrderList{}, err
	}
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "inserted_at" DESC,"id" DESC`
	} else {
		orderBy += `,"id" DESC`
	}
	source := ` FROM (SELECT w.*,
		(w.base_qty-w.received_base_qty) AS remaining_base_qty
		FROM mfg_work_order w) work_orders`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return WorkOrderList{}, internal("查询生产工单失败", err)
	}
	defer tx.Rollback(ctx)
	var result WorkOrderList
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).
		Scan(&result.Count); err != nil {
		return WorkOrderList{}, internal("统计生产工单失败", err)
	}
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT `+workOrderColumns+source+where+orderBy+
		fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return WorkOrderList{}, internal("查询生产工单失败", err)
	}
	defer rows.Close()
	result.Results = make([]WorkOrder, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanWorkOrder(rows)
		if scanErr != nil {
			return WorkOrderList{}, internal("读取生产工单失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return WorkOrderList{}, internal("遍历生产工单失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkOrderList{}, internal("完成生产工单查询失败", err)
	}
	return result, nil
}

func (s *Service) GetOutput(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (Output, error) {
	if err := require(actor, "mfg.output", "read"); err != nil {
		return Output{}, err
	}
	item, err := queryOutput(ctx, s.pool, id, false)
	if err != nil {
		if err == pgx.ErrNoRows {
			return Output{}, notFound("生产入库单")
		}
		return Output{}, internal("读取生产入库单失败", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return Output{}, err
	}
	return item, nil
}

func (s *Service) ListOutputs(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (OutputList, error) {
	if err := require(actor, "mfg.output", "read"); err != nil {
		return OutputList{}, err
	}
	if err := validateList(&query); err != nil {
		return OutputList{}, err
	}
	built, err := filterbuild.Build(OutputResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return OutputList{}, err
	}
	where, args, err := scopedListWhere(actor, query.CompanyID, built.Where, built.Args)
	if err != nil {
		return OutputList{}, err
	}
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "inserted_at" DESC,"id" DESC`
	} else {
		orderBy += `,"id" DESC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return OutputList{}, internal("查询生产入库单失败", err)
	}
	defer tx.Rollback(ctx)
	var result OutputList
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mfg_output`+where, args...).
		Scan(&result.Count); err != nil {
		return OutputList{}, internal("统计生产入库单失败", err)
	}
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT `+outputColumns+` FROM mfg_output`+
		where+orderBy+fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return OutputList{}, internal("查询生产入库单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Output, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanOutput(rows)
		if scanErr != nil {
			return OutputList{}, internal("读取生产入库单失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return OutputList{}, internal("遍历生产入库单失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return OutputList{}, internal("完成生产入库单查询失败", err)
	}
	return result, nil
}

func (s *Service) GetOutputItem(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (OutputItem, error) {
	if err := require(actor, "mfg.output", "read"); err != nil {
		return OutputItem{}, err
	}
	item, err := queryOutputItem(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return OutputItem{}, notFound("生产入库行")
	}
	if err != nil {
		return OutputItem{}, internal("读取生产入库行失败", err)
	}
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return OutputItem{}, err
	}
	return item, nil
}

func (s *Service) ListOutputItems(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (OutputItemList, error) {
	if err := require(actor, "mfg.output", "read"); err != nil {
		return OutputItemList{}, err
	}
	if err := validateList(&query); err != nil {
		return OutputItemList{}, err
	}
	built, err := filterbuild.Build(OutputItemResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return OutputItemList{}, err
	}
	where, args, err := scopedListWhere(actor, query.CompanyID, built.Where, built.Args)
	if err != nil {
		return OutputItemList{}, err
	}
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "idx" ASC,"id" ASC`
	} else {
		orderBy += `,"id" ASC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return OutputItemList{}, internal("查询生产入库行失败", err)
	}
	defer tx.Rollback(ctx)
	var result OutputItemList
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mfg_output_item`+where, args...).
		Scan(&result.Count); err != nil {
		return OutputItemList{}, internal("统计生产入库行失败", err)
	}
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT `+outputItemColumns+` FROM mfg_output_item`+
		where+orderBy+fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return OutputItemList{}, internal("查询生产入库行失败", err)
	}
	defer rows.Close()
	result.Results = make([]OutputItem, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanOutputItem(rows)
		if scanErr != nil {
			return OutputItemList{}, internal("读取生产入库行失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return OutputItemList{}, apierror.Wrap(apierror.CodeInternal, "遍历生产入库行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return OutputItemList{}, internal("完成生产入库行查询失败", err)
	}
	return result, nil
}
