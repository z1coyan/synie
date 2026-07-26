package master

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) CreateBOMComponent(ctx context.Context, actor *authz.Actor,
	input ComponentInput) (BOMComponent, error) {
	if err := requireChild(actor, bomPermission, "create"); err != nil {
		return BOMComponent{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BOMComponent{}, internal("创建BOM配料行失败", err)
	}
	defer tx.Rollback(ctx)
	bom, err := lockBOM(ctx, tx, input.BOMID)
	if err != nil {
		return BOMComponent{}, err
	}
	if err := validateLine(bom.MaterialID, input.MaterialID, input.Quantity, input.LossRate); err != nil {
		return BOMComponent{}, err
	}
	if err := ensureUnitAllowed(ctx, tx, input.MaterialID, input.UnitID); err != nil {
		return BOMComponent{}, err
	}
	note := trimOptional(input.Note)
	item, err := scanComponent(tx.QueryRow(ctx, `INSERT INTO mfg_bom_component(
		bom_id,material_id,unit_id,quantity,loss_rate,note)
		VALUES($1,$2,$3,$4,$5,$6)
		RETURNING id,quantity,loss_rate,note,inserted_at,updated_at,bom_id,material_id,unit_id`,
		input.BOMID, input.MaterialID, input.UnitID, input.Quantity, input.LossRate, note))
	if err != nil {
		return BOMComponent{}, referenceError("创建BOM配料行失败", "BOM、物料或单位不存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom_component", item.ID, formatID(item.ID),
		"create", "create", componentSnapshot(item), nil); err != nil {
		return BOMComponent{}, internal("创建BOM配料行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BOMComponent{}, internal("创建BOM配料行失败", err)
	}
	return item, nil
}

func (s *Service) GetBOMComponent(ctx context.Context, actor *authz.Actor, id uuid.UUID) (BOMComponent, error) {
	if err := requireChild(actor, bomPermission, "read"); err != nil {
		return BOMComponent{}, err
	}
	item, err := scanComponent(s.pool.QueryRow(ctx, componentSelect+` WHERE id=$1`, id))
	return item, readError(err, "BOM配料行不存在", "读取BOM配料行失败")
}

func (s *Service) ListBOMComponents(ctx context.Context, actor *authz.Actor,
	bomID *uuid.UUID, query ListQuery) (ListResult[BOMComponent], error) {
	if err := requireChild(actor, bomPermission, "read"); err != nil {
		return ListResult[BOMComponent]{}, err
	}
	return listChildren(ctx, s, query, ComponentResourceMeta(), componentSelect,
		"bom_id", bomID, `"inserted_at","id"`, scanComponent)
}

func (s *Service) UpdateBOMComponent(ctx context.Context, actor *authz.Actor,
	id uuid.UUID, input ComponentInput) (BOMComponent, error) {
	if err := requireChild(actor, bomPermission, "update"); err != nil {
		return BOMComponent{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BOMComponent{}, internal("更新BOM配料行失败", err)
	}
	defer tx.Rollback(ctx)
	bomID, err := childParentID(ctx, tx, "mfg_bom_component", "bom_id", id, "BOM配料行不存在")
	if err != nil {
		return BOMComponent{}, err
	}
	bom, err := lockBOM(ctx, tx, bomID)
	if err != nil {
		return BOMComponent{}, err
	}
	before, err := scanComponent(tx.QueryRow(ctx, componentSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return BOMComponent{}, readError(err, "BOM配料行不存在", "读取BOM配料行失败")
	}
	if err := rejectAnchor(before.BOMID, input.BOMID, "bomId", "创建后不可换BOM"); err != nil {
		return BOMComponent{}, err
	}
	if err := validateLine(bom.MaterialID, input.MaterialID, input.Quantity, input.LossRate); err != nil {
		return BOMComponent{}, err
	}
	if err := ensureUnitAllowed(ctx, tx, input.MaterialID, input.UnitID); err != nil {
		return BOMComponent{}, err
	}
	after, err := scanComponent(tx.QueryRow(ctx, `UPDATE mfg_bom_component SET
		material_id=$2,unit_id=$3,quantity=$4,loss_rate=$5,note=$6,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1
		RETURNING id,quantity,loss_rate,note,inserted_at,updated_at,bom_id,material_id,unit_id`,
		id, input.MaterialID, input.UnitID, input.Quantity, input.LossRate, trimOptional(input.Note)))
	if err != nil {
		return BOMComponent{}, referenceError("更新BOM配料行失败", "物料或单位不存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom_component", id, formatID(id),
		"update", "update", componentSnapshot(after), componentSnapshot(before)); err != nil {
		return BOMComponent{}, internal("更新BOM配料行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BOMComponent{}, internal("更新BOM配料行失败", err)
	}
	return after, nil
}

func (s *Service) DeleteBOMComponent(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requireChild(actor, bomPermission, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return internal("删除BOM配料行失败", err)
	}
	defer tx.Rollback(ctx)
	bomID, err := childParentID(ctx, tx, "mfg_bom_component", "bom_id", id, "BOM配料行不存在")
	if err != nil {
		return err
	}
	if _, err := lockBOM(ctx, tx, bomID); err != nil {
		return err
	}
	item, err := scanComponent(tx.QueryRow(ctx, componentSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return readError(err, "BOM配料行不存在", "读取BOM配料行失败")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_bom_component WHERE id=$1`, id); err != nil {
		return internal("删除BOM配料行失败", err)
	}
	if err := writeDestroyAudit(ctx, tx, actor, "mfg_bom_component", id,
		formatID(id), componentSnapshot(item)); err != nil {
		return internal("删除BOM配料行失败", err)
	}
	return commit(ctx, tx, "删除BOM配料行失败")
}

func (s *Service) CreateBOMRoute(ctx context.Context, actor *authz.Actor,
	bomID uuid.UUID, input RouteItemInput) (BOMRoute, error) {
	if err := requireChild(actor, bomPermission, "create"); err != nil {
		return BOMRoute{}, err
	}
	input, err := normalizeRoute(input)
	if err != nil {
		return BOMRoute{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BOMRoute{}, internal("创建BOM工艺路线行失败", err)
	}
	defer tx.Rollback(ctx)
	if _, err := lockBOM(ctx, tx, bomID); err != nil {
		return BOMRoute{}, err
	}
	item, err := insertBOMRoute(ctx, tx, bomID, input)
	if err != nil {
		return BOMRoute{}, err
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom_route", item.ID, formatID(item.ID),
		"create", "create", routeSnapshot(item), nil); err != nil {
		return BOMRoute{}, internal("创建BOM工艺路线行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BOMRoute{}, internal("创建BOM工艺路线行失败", err)
	}
	return item, nil
}

func (s *Service) GetBOMRoute(ctx context.Context, actor *authz.Actor, id uuid.UUID) (BOMRoute, error) {
	if err := requireChild(actor, bomPermission, "read"); err != nil {
		return BOMRoute{}, err
	}
	item, err := scanBOMRoute(s.pool.QueryRow(ctx, routeSelect+` WHERE id=$1`, id))
	return item, readError(err, "BOM工艺路线行不存在", "读取BOM工艺路线行失败")
}

func (s *Service) ListBOMRoutes(ctx context.Context, actor *authz.Actor,
	bomID *uuid.UUID, query ListQuery) (ListResult[BOMRoute], error) {
	if err := requireChild(actor, bomPermission, "read"); err != nil {
		return ListResult[BOMRoute]{}, err
	}
	return listChildren(ctx, s, query, RouteResourceMeta(), routeSelect,
		"bom_id", bomID, `"seq","id"`, scanBOMRoute)
}

func (s *Service) UpdateBOMRoute(ctx context.Context, actor *authz.Actor,
	id uuid.UUID, input RouteItemInput) (BOMRoute, error) {
	if err := requireChild(actor, bomPermission, "update"); err != nil {
		return BOMRoute{}, err
	}
	input, err := normalizeRoute(input)
	if err != nil {
		return BOMRoute{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BOMRoute{}, internal("更新BOM工艺路线行失败", err)
	}
	defer tx.Rollback(ctx)
	bomID, err := childParentID(ctx, tx, "mfg_bom_route", "bom_id", id, "BOM工艺路线行不存在")
	if err != nil {
		return BOMRoute{}, err
	}
	if _, err := lockBOM(ctx, tx, bomID); err != nil {
		return BOMRoute{}, err
	}
	before, err := scanBOMRoute(tx.QueryRow(ctx, routeSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return BOMRoute{}, readError(err, "BOM工艺路线行不存在", "读取BOM工艺路线行失败")
	}
	after, err := scanBOMRoute(tx.QueryRow(ctx, `UPDATE mfg_bom_route SET operation_id=$2,
		seq=$3,requirement=$4,is_outsourced=$5,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1
		RETURNING id,seq,requirement,is_outsourced,inserted_at,updated_at,bom_id,operation_id`,
		id, input.OperationID, input.Seq, input.Requirement, input.IsOutsourced))
	if err != nil {
		return BOMRoute{}, referenceError("更新BOM工艺路线行失败", "工序不存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom_route", id, formatID(id),
		"update", "update", routeSnapshot(after), routeSnapshot(before)); err != nil {
		return BOMRoute{}, internal("更新BOM工艺路线行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BOMRoute{}, internal("更新BOM工艺路线行失败", err)
	}
	return after, nil
}

func (s *Service) DeleteBOMRoute(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requireChild(actor, bomPermission, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return internal("删除BOM工艺路线行失败", err)
	}
	defer tx.Rollback(ctx)
	bomID, err := childParentID(ctx, tx, "mfg_bom_route", "bom_id", id, "BOM工艺路线行不存在")
	if err != nil {
		return err
	}
	if _, err := lockBOM(ctx, tx, bomID); err != nil {
		return err
	}
	item, err := scanBOMRoute(tx.QueryRow(ctx, routeSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return readError(err, "BOM工艺路线行不存在", "读取BOM工艺路线行失败")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_bom_route WHERE id=$1`, id); err != nil {
		return internal("删除BOM工艺路线行失败", err)
	}
	if err := writeDestroyAudit(ctx, tx, actor, "mfg_bom_route", id,
		formatID(id), routeSnapshot(item)); err != nil {
		return internal("删除BOM工艺路线行失败", err)
	}
	return commit(ctx, tx, "删除BOM工艺路线行失败")
}

func (s *Service) CreateBOMByproduct(ctx context.Context, actor *authz.Actor,
	input ByproductInput) (BOMByproduct, error) {
	if err := requireChild(actor, bomPermission, "create"); err != nil {
		return BOMByproduct{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BOMByproduct{}, internal("创建BOM副产品行失败", err)
	}
	defer tx.Rollback(ctx)
	bom, err := lockBOM(ctx, tx, input.BOMID)
	if err != nil {
		return BOMByproduct{}, err
	}
	if err := validateLine(bom.MaterialID, input.MaterialID, input.Quantity, nil); err != nil {
		return BOMByproduct{}, err
	}
	if err := ensureUnitAllowed(ctx, tx, input.MaterialID, input.UnitID); err != nil {
		return BOMByproduct{}, err
	}
	item, err := scanByproduct(tx.QueryRow(ctx, `INSERT INTO mfg_bom_byproduct(
		bom_id,material_id,unit_id,quantity,note) VALUES($1,$2,$3,$4,$5)
		RETURNING id,quantity,note,inserted_at,updated_at,bom_id,material_id,unit_id`,
		input.BOMID, input.MaterialID, input.UnitID, input.Quantity, trimOptional(input.Note)))
	if err != nil {
		return BOMByproduct{}, referenceError("创建BOM副产品行失败", "BOM、物料或单位不存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom_byproduct", item.ID, formatID(item.ID),
		"create", "create", byproductSnapshot(item), nil); err != nil {
		return BOMByproduct{}, internal("创建BOM副产品行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BOMByproduct{}, internal("创建BOM副产品行失败", err)
	}
	return item, nil
}

func (s *Service) GetBOMByproduct(ctx context.Context, actor *authz.Actor, id uuid.UUID) (BOMByproduct, error) {
	if err := requireChild(actor, bomPermission, "read"); err != nil {
		return BOMByproduct{}, err
	}
	item, err := scanByproduct(s.pool.QueryRow(ctx, byproductSelect+` WHERE id=$1`, id))
	return item, readError(err, "BOM副产品行不存在", "读取BOM副产品行失败")
}

func (s *Service) ListBOMByproducts(ctx context.Context, actor *authz.Actor,
	bomID *uuid.UUID, query ListQuery) (ListResult[BOMByproduct], error) {
	if err := requireChild(actor, bomPermission, "read"); err != nil {
		return ListResult[BOMByproduct]{}, err
	}
	return listChildren(ctx, s, query, ByproductResourceMeta(), byproductSelect,
		"bom_id", bomID, `"inserted_at","id"`, scanByproduct)
}

func (s *Service) UpdateBOMByproduct(ctx context.Context, actor *authz.Actor,
	id uuid.UUID, input ByproductInput) (BOMByproduct, error) {
	if err := requireChild(actor, bomPermission, "update"); err != nil {
		return BOMByproduct{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BOMByproduct{}, internal("更新BOM副产品行失败", err)
	}
	defer tx.Rollback(ctx)
	bomID, err := childParentID(ctx, tx, "mfg_bom_byproduct", "bom_id", id, "BOM副产品行不存在")
	if err != nil {
		return BOMByproduct{}, err
	}
	bom, err := lockBOM(ctx, tx, bomID)
	if err != nil {
		return BOMByproduct{}, err
	}
	before, err := scanByproduct(tx.QueryRow(ctx, byproductSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return BOMByproduct{}, readError(err, "BOM副产品行不存在", "读取BOM副产品行失败")
	}
	if err := rejectAnchor(before.BOMID, input.BOMID, "bomId", "创建后不可换BOM"); err != nil {
		return BOMByproduct{}, err
	}
	if err := validateLine(bom.MaterialID, input.MaterialID, input.Quantity, nil); err != nil {
		return BOMByproduct{}, err
	}
	if err := ensureUnitAllowed(ctx, tx, input.MaterialID, input.UnitID); err != nil {
		return BOMByproduct{}, err
	}
	after, err := scanByproduct(tx.QueryRow(ctx, `UPDATE mfg_bom_byproduct SET
		material_id=$2,unit_id=$3,quantity=$4,note=$5,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1 RETURNING id,quantity,note,inserted_at,updated_at,bom_id,material_id,unit_id`,
		id, input.MaterialID, input.UnitID, input.Quantity, trimOptional(input.Note)))
	if err != nil {
		return BOMByproduct{}, referenceError("更新BOM副产品行失败", "物料或单位不存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom_byproduct", id, formatID(id),
		"update", "update", byproductSnapshot(after), byproductSnapshot(before)); err != nil {
		return BOMByproduct{}, internal("更新BOM副产品行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BOMByproduct{}, internal("更新BOM副产品行失败", err)
	}
	return after, nil
}

func (s *Service) DeleteBOMByproduct(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requireChild(actor, bomPermission, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return internal("删除BOM副产品行失败", err)
	}
	defer tx.Rollback(ctx)
	bomID, err := childParentID(ctx, tx, "mfg_bom_byproduct", "bom_id", id, "BOM副产品行不存在")
	if err != nil {
		return err
	}
	if _, err := lockBOM(ctx, tx, bomID); err != nil {
		return err
	}
	item, err := scanByproduct(tx.QueryRow(ctx, byproductSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return readError(err, "BOM副产品行不存在", "读取BOM副产品行失败")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_bom_byproduct WHERE id=$1`, id); err != nil {
		return internal("删除BOM副产品行失败", err)
	}
	if err := writeDestroyAudit(ctx, tx, actor, "mfg_bom_byproduct", id,
		formatID(id), byproductSnapshot(item)); err != nil {
		return internal("删除BOM副产品行失败", err)
	}
	return commit(ctx, tx, "删除BOM副产品行失败")
}

// ApplyRouteTemplate serializes all writers through the BOM and template
// heads. The route-empty precondition and value-copy happen in one
// transaction, so two concurrent applies cannot mix templates.
func (s *Service) ApplyRouteTemplate(ctx context.Context, actor *authz.Actor,
	bomID, templateID uuid.UUID) ([]BOMRoute, error) {
	if err := require(actor, bomPermission, "update"); err != nil {
		return nil, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, internal("从工艺模板带入失败", err)
	}
	defer tx.Rollback(ctx)
	bom, err := lockBOM(ctx, tx, bomID)
	if err != nil {
		return nil, err
	}
	if err := lockExists(ctx, tx, "mfg_process_template", templateID, "工艺模板不存在"); err != nil {
		return nil, err
	}
	var routeCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM mfg_bom_route WHERE bom_id=$1`, bomID).Scan(&routeCount); err != nil {
		return nil, internal("检查BOM工艺路线失败", err)
	}
	if routeCount != 0 {
		return nil, apierror.New(apierror.CodeConflict, "已有工艺路线,不能从模板带入")
	}
	rows, err := tx.Query(ctx, templateItemSelect+` WHERE template_id=$1 ORDER BY seq,id`, templateID)
	if err != nil {
		return nil, internal("读取工艺模板行失败", err)
	}
	items := make([]TemplateItem, 0)
	for rows.Next() {
		item, scanErr := scanTemplateItem(rows)
		if scanErr != nil {
			rows.Close()
			return nil, internal("读取工艺模板行失败", scanErr)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, internal("读取工艺模板行失败", err)
	}
	rows.Close()
	snapshots := snapshotRoutes(bomID, items)
	result := make([]BOMRoute, 0, len(snapshots))
	for _, snapshot := range snapshots {
		item, insertErr := insertBOMRoute(ctx, tx, bomID, RouteItemInput{
			OperationID: snapshot.OperationID, Seq: snapshot.Seq,
			Requirement: snapshot.Requirement, IsOutsourced: snapshot.IsOutsourced,
		})
		if insertErr != nil {
			return nil, insertErr
		}
		if err := writeAudit(ctx, tx, actor, "mfg_bom_route", item.ID, formatID(item.ID),
			"create", "create", routeSnapshot(item), nil); err != nil {
			return nil, internal("从工艺模板带入失败", err)
		}
		result = append(result, item)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom", bom.ID, bom.Code,
		"update", "apply_route_template",
		map[string]any{"template_id": templateID}, map[string]any{"template_id": nil}); err != nil {
		return nil, internal("从工艺模板带入失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "40001" {
			return nil, apierror.Wrap(apierror.CodeConflict, "BOM工艺路线已被并发修改,请刷新后重试", err)
		}
		return nil, internal("从工艺模板带入失败", err)
	}
	return result, nil
}

func insertBOMRoute(ctx context.Context, tx pgx.Tx, bomID uuid.UUID,
	input RouteItemInput) (BOMRoute, error) {
	item, err := scanBOMRoute(tx.QueryRow(ctx, `INSERT INTO mfg_bom_route(
		bom_id,operation_id,seq,requirement,is_outsourced) VALUES($1,$2,$3,$4,$5)
		RETURNING id,seq,requirement,is_outsourced,inserted_at,updated_at,bom_id,operation_id`,
		bomID, input.OperationID, input.Seq, input.Requirement, input.IsOutsourced))
	if err != nil {
		return BOMRoute{}, referenceError("创建BOM工艺路线行失败", "BOM或工序不存在", err)
	}
	return item, nil
}

func lockBOM(ctx context.Context, tx pgx.Tx, id uuid.UUID) (BOM, error) {
	if id == uuid.Nil {
		return BOM{}, apierror.Validation("BOM行参数不合法",
			map[string][]string{"bomId": {"必填"}})
	}
	item, err := scanBOM(tx.QueryRow(ctx, bomSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return BOM{}, readError(err, "BOM不存在", "读取BOM失败")
	}
	return item, nil
}

func childParentID(ctx context.Context, tx pgx.Tx, table, column string,
	id uuid.UUID, notFound string) (uuid.UUID, error) {
	var parentID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT `+column+` FROM `+table+` WHERE id=$1`, id).Scan(&parentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, apierror.New(apierror.CodeNotFound, notFound)
	}
	if err != nil {
		return uuid.Nil, internal("读取制造主数据行失败", err)
	}
	return parentID, nil
}

const (
	componentSelect = `SELECT id,quantity,loss_rate,note,inserted_at,updated_at,
		bom_id,material_id,unit_id FROM mfg_bom_component`
	routeSelect = `SELECT id,seq,requirement,is_outsourced,inserted_at,updated_at,
		bom_id,operation_id FROM mfg_bom_route`
	byproductSelect = `SELECT id,quantity,note,inserted_at,updated_at,
		bom_id,material_id,unit_id FROM mfg_bom_byproduct`
)

func scanComponent(row scanner) (BOMComponent, error) {
	var item BOMComponent
	err := row.Scan(&item.ID, &item.Quantity, &item.LossRate, &item.Note,
		&item.InsertedAt, &item.UpdatedAt, &item.BOMID, &item.MaterialID, &item.UnitID)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, err
}

func scanBOMRoute(row scanner) (BOMRoute, error) {
	var item BOMRoute
	err := row.Scan(&item.ID, &item.Seq, &item.Requirement, &item.IsOutsourced,
		&item.InsertedAt, &item.UpdatedAt, &item.BOMID, &item.OperationID)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, err
}

func scanByproduct(row scanner) (BOMByproduct, error) {
	var item BOMByproduct
	err := row.Scan(&item.ID, &item.Quantity, &item.Note, &item.InsertedAt,
		&item.UpdatedAt, &item.BOMID, &item.MaterialID, &item.UnitID)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, err
}

func componentSnapshot(item BOMComponent) map[string]any {
	var loss any
	if item.LossRate != nil {
		loss = decimalValue(*item.LossRate)
	}
	return map[string]any{
		"quantity": decimalValue(item.Quantity), "loss_rate": loss, "note": item.Note,
		"bom_id": item.BOMID, "material_id": item.MaterialID, "unit_id": item.UnitID,
	}
}

func routeSnapshot(item BOMRoute) map[string]any {
	return map[string]any{
		"seq": item.Seq, "requirement": item.Requirement, "is_outsourced": item.IsOutsourced,
		"bom_id": item.BOMID, "operation_id": item.OperationID,
	}
}

func byproductSnapshot(item BOMByproduct) map[string]any {
	return map[string]any{
		"quantity": decimalValue(item.Quantity), "note": item.Note,
		"bom_id": item.BOMID, "material_id": item.MaterialID, "unit_id": item.UnitID,
	}
}

// Apply quantities are exposed here so order snapshot consumers don't need to
// reimplement BOM loss semantics.
func ComponentApplyQuantity(component BOMComponent, orderQuantity decimal.Decimal) decimal.Decimal {
	loss := decimal.Zero
	if component.LossRate != nil {
		loss = *component.LossRate
	}
	return component.Quantity.Mul(decimal.NewFromInt(1).Add(loss)).Mul(orderQuantity)
}

func ByproductApplyQuantity(byproduct BOMByproduct, orderQuantity decimal.Decimal) decimal.Decimal {
	return byproduct.Quantity.Mul(orderQuantity)
}
