package master

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

// Service is the module interface. Number allocation, anchor immutability,
// reference rules, child permissions, snapshots, audit and row locking stay
// behind this seam.
type Service struct {
	pool     *pgxpool.Pool
	numberer Numberer
}

func NewService(pool *pgxpool.Pool, numberers ...Numberer) *Service {
	var numberer Numberer = numbering.NewService(pool)
	if len(numberers) > 0 && numberers[0] != nil {
		numberer = numberers[0]
	}
	return &Service{pool: pool, numberer: numberer}
}

func (s *Service) CreateOperation(ctx context.Context, actor *authz.Actor, input HeadCreateInput) (Operation, error) {
	if err := require(actor, operationPermission, "create"); err != nil {
		return Operation{}, err
	}
	code, name, note, err := normalizeHead(input.Code, input.Name, input.Note, "工序")
	if err != nil {
		return Operation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Operation{}, internal("创建工序失败", err)
	}
	defer tx.Rollback(ctx)
	if code == "" {
		code, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{Resource: operationPermission})
		if err != nil {
			return Operation{}, err
		}
	}
	item, err := scanOperation(tx.QueryRow(ctx, `INSERT INTO mfg_operation(code,name,note)
		VALUES($1,$2,$3) RETURNING id,code,name,note,inserted_at,updated_at`, code, name, note))
	if err != nil {
		return Operation{}, writeError("创建工序失败", "工序编号已存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_operation", item.ID, item.Code,
		"create", "create", operationSnapshot(item), nil); err != nil {
		return Operation{}, internal("创建工序失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Operation{}, writeError("创建工序失败", "工序编号已存在", err)
	}
	return item, nil
}

func (s *Service) GetOperation(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Operation, error) {
	if err := require(actor, operationPermission, "read"); err != nil {
		return Operation{}, err
	}
	item, err := scanOperation(s.pool.QueryRow(ctx, operationSelect+` WHERE id=$1`, id))
	return item, readError(err, "工序不存在", "读取工序失败")
}

func (s *Service) ListOperations(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[Operation], error) {
	if err := require(actor, operationPermission, "read"); err != nil {
		return ListResult[Operation]{}, err
	}
	out := ListResult[Operation]{Results: make([]Operation, 0)}
	err := s.list(ctx, query, OperationResourceMeta(), operationSelect, `"code","id"`, func(rows pgx.Rows) error {
		item, err := scanOperation(rows)
		out.Results = append(out.Results, item)
		return err
	}, &out.Count)
	return out, err
}

func (s *Service) UpdateOperation(ctx context.Context, actor *authz.Actor, id uuid.UUID, input HeadUpdateInput) (Operation, error) {
	if err := require(actor, operationPermission, "update"); err != nil {
		return Operation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Operation{}, internal("更新工序失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := scanOperation(tx.QueryRow(ctx, operationSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return Operation{}, readError(err, "工序不存在", "读取工序失败")
	}
	name, note := before.Name, before.Note
	if input.Name != nil {
		name = *input.Name
	}
	if input.Note.Set {
		note = input.Note.Value
	}
	_, name, note, err = normalizeHead(before.Code, name, note, "工序")
	if err != nil {
		return Operation{}, err
	}
	after, err := scanOperation(tx.QueryRow(ctx, `UPDATE mfg_operation SET name=$2,note=$3,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1
		RETURNING id,code,name,note,inserted_at,updated_at`, id, name, note))
	if err != nil {
		return Operation{}, writeError("更新工序失败", "工序编号已存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_operation", id, after.Code,
		"update", "update", operationSnapshot(after), operationSnapshot(before)); err != nil {
		return Operation{}, internal("更新工序失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Operation{}, internal("更新工序失败", err)
	}
	return after, nil
}

func (s *Service) DeleteOperation(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, operationPermission, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return internal("删除工序失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := scanOperation(tx.QueryRow(ctx, operationSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return readError(err, "工序不存在", "读取工序失败")
	}
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM mfg_bom_route WHERE operation_id=$1
		UNION ALL SELECT 1 FROM mfg_process_template_item WHERE operation_id=$1
	)`, id).Scan(&referenced); err != nil {
		return internal("检查工序引用失败", err)
	}
	if referenced {
		return apierror.New(apierror.CodeConflict, "工序已被工艺路线或工艺模板引用,不能删除")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_operation WHERE id=$1`, id); err != nil {
		return referenceError("删除工序失败", "工序已被工艺路线或工艺模板引用,不能删除", err)
	}
	if err := writeDestroyAudit(ctx, tx, actor, "mfg_operation", item.ID, item.Code, operationSnapshot(item)); err != nil {
		return internal("删除工序失败", err)
	}
	return commit(ctx, tx, "删除工序失败")
}

func (s *Service) CreateTemplate(ctx context.Context, actor *authz.Actor, input HeadCreateInput) (ProcessTemplate, error) {
	if err := require(actor, templatePermission, "create"); err != nil {
		return ProcessTemplate{}, err
	}
	code, name, note, err := normalizeHead(input.Code, input.Name, input.Note, "工艺模板")
	if err != nil {
		return ProcessTemplate{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ProcessTemplate{}, internal("创建工艺模板失败", err)
	}
	defer tx.Rollback(ctx)
	if code == "" {
		code, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{Resource: templatePermission})
		if err != nil {
			return ProcessTemplate{}, err
		}
	}
	item, err := scanTemplate(tx.QueryRow(ctx, `INSERT INTO mfg_process_template(code,name,note)
		VALUES($1,$2,$3) RETURNING id,code,name,note,inserted_at,updated_at`, code, name, note))
	if err != nil {
		return ProcessTemplate{}, writeError("创建工艺模板失败", "工艺模板编号已存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_process_template", item.ID, item.Code,
		"create", "create", templateSnapshot(item), nil); err != nil {
		return ProcessTemplate{}, internal("创建工艺模板失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ProcessTemplate{}, writeError("创建工艺模板失败", "工艺模板编号已存在", err)
	}
	return item, nil
}

func (s *Service) GetTemplate(ctx context.Context, actor *authz.Actor, id uuid.UUID) (ProcessTemplate, error) {
	if err := require(actor, templatePermission, "read"); err != nil {
		return ProcessTemplate{}, err
	}
	item, err := scanTemplate(s.pool.QueryRow(ctx, templateSelect+` WHERE id=$1`, id))
	return item, readError(err, "工艺模板不存在", "读取工艺模板失败")
}

func (s *Service) ListTemplates(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[ProcessTemplate], error) {
	if err := require(actor, templatePermission, "read"); err != nil {
		return ListResult[ProcessTemplate]{}, err
	}
	out := ListResult[ProcessTemplate]{Results: make([]ProcessTemplate, 0)}
	err := s.list(ctx, query, TemplateResourceMeta(), templateSelect, `"code","id"`, func(rows pgx.Rows) error {
		item, err := scanTemplate(rows)
		out.Results = append(out.Results, item)
		return err
	}, &out.Count)
	return out, err
}

func (s *Service) UpdateTemplate(ctx context.Context, actor *authz.Actor, id uuid.UUID, input HeadUpdateInput) (ProcessTemplate, error) {
	if err := require(actor, templatePermission, "update"); err != nil {
		return ProcessTemplate{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ProcessTemplate{}, internal("更新工艺模板失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := scanTemplate(tx.QueryRow(ctx, templateSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return ProcessTemplate{}, readError(err, "工艺模板不存在", "读取工艺模板失败")
	}
	name, note := before.Name, before.Note
	if input.Name != nil {
		name = *input.Name
	}
	if input.Note.Set {
		note = input.Note.Value
	}
	_, name, note, err = normalizeHead(before.Code, name, note, "工艺模板")
	if err != nil {
		return ProcessTemplate{}, err
	}
	after, err := scanTemplate(tx.QueryRow(ctx, `UPDATE mfg_process_template SET name=$2,note=$3,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1
		RETURNING id,code,name,note,inserted_at,updated_at`, id, name, note))
	if err != nil {
		return ProcessTemplate{}, writeError("更新工艺模板失败", "工艺模板编号已存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_process_template", id, after.Code,
		"update", "update", templateSnapshot(after), templateSnapshot(before)); err != nil {
		return ProcessTemplate{}, internal("更新工艺模板失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ProcessTemplate{}, internal("更新工艺模板失败", err)
	}
	return after, nil
}

func (s *Service) DeleteTemplate(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, templatePermission, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return internal("删除工艺模板失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := scanTemplate(tx.QueryRow(ctx, templateSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return readError(err, "工艺模板不存在", "读取工艺模板失败")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_process_template WHERE id=$1`, id); err != nil {
		return writeError("删除工艺模板失败", "工艺模板已被引用,不可删除", err)
	}
	if err := writeDestroyAudit(ctx, tx, actor, "mfg_process_template", id, item.Code, templateSnapshot(item)); err != nil {
		return internal("删除工艺模板失败", err)
	}
	return commit(ctx, tx, "删除工艺模板失败")
}

func (s *Service) CreateBOM(ctx context.Context, actor *authz.Actor, input BOMCreateInput) (BOM, error) {
	if err := require(actor, bomPermission, "create"); err != nil {
		return BOM{}, err
	}
	code, planName, note, err := normalizeBOM(input.Code, input.PlanName, input.Note, input.MaterialID)
	if err != nil {
		return BOM{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BOM{}, internal("创建BOM失败", err)
	}
	defer tx.Rollback(ctx)
	if err := ensureMaterial(ctx, tx, input.MaterialID); err != nil {
		return BOM{}, err
	}
	if code == "" {
		code, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: bomPermission, Values: map[string]any{"material_id": input.MaterialID},
		})
		if err != nil {
			return BOM{}, err
		}
	}
	item, err := scanBOM(tx.QueryRow(ctx, `INSERT INTO mfg_bom(code,plan_name,note,material_id)
		VALUES($1,$2,$3,$4) RETURNING id,code,plan_name,note,inserted_at,updated_at,material_id`,
		code, planName, note, input.MaterialID))
	if err != nil {
		return BOM{}, writeError("创建BOM失败", "BOM 编号已存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom", item.ID, item.Code,
		"create", "create", bomSnapshot(item), nil); err != nil {
		return BOM{}, internal("创建BOM失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BOM{}, writeError("创建BOM失败", "BOM 编号已存在", err)
	}
	return item, nil
}

func (s *Service) GetBOM(ctx context.Context, actor *authz.Actor, id uuid.UUID) (BOM, error) {
	if err := require(actor, bomPermission, "read"); err != nil {
		return BOM{}, err
	}
	item, err := scanBOM(s.pool.QueryRow(ctx, bomSelect+` WHERE id=$1`, id))
	return item, readError(err, "BOM不存在", "读取BOM失败")
}

func (s *Service) ListBOMs(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult[BOM], error) {
	if err := require(actor, bomPermission, "read"); err != nil {
		return ListResult[BOM]{}, err
	}
	out := ListResult[BOM]{Results: make([]BOM, 0)}
	err := s.list(ctx, query, BOMResourceMeta(), bomSelect, `"code","id"`, func(rows pgx.Rows) error {
		item, err := scanBOM(rows)
		out.Results = append(out.Results, item)
		return err
	}, &out.Count)
	return out, err
}

func (s *Service) UpdateBOM(ctx context.Context, actor *authz.Actor, id uuid.UUID, input BOMUpdateInput) (BOM, error) {
	if err := require(actor, bomPermission, "update"); err != nil {
		return BOM{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BOM{}, internal("更新BOM失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := scanBOM(tx.QueryRow(ctx, bomSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return BOM{}, readError(err, "BOM不存在", "读取BOM失败")
	}
	planName, note := before.PlanName, before.Note
	if input.PlanName.Set {
		planName = input.PlanName.Value
	}
	if input.Note.Set {
		note = input.Note.Value
	}
	_, planName, note, err = normalizeBOM(before.Code, planName, note, before.MaterialID)
	if err != nil {
		return BOM{}, err
	}
	after, err := scanBOM(tx.QueryRow(ctx, `UPDATE mfg_bom SET plan_name=$2,note=$3,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1
		RETURNING id,code,plan_name,note,inserted_at,updated_at,material_id`, id, planName, note))
	if err != nil {
		return BOM{}, writeError("更新BOM失败", "BOM 编号已存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_bom", id, after.Code,
		"update", "update", bomSnapshot(after), bomSnapshot(before)); err != nil {
		return BOM{}, internal("更新BOM失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return BOM{}, internal("更新BOM失败", err)
	}
	return after, nil
}

func (s *Service) DeleteBOM(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, bomPermission, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return internal("删除BOM失败", err)
	}
	defer tx.Rollback(ctx)
	item, err := scanBOM(tx.QueryRow(ctx, bomSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return readError(err, "BOM不存在", "读取BOM失败")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_bom WHERE id=$1`, id); err != nil {
		return referenceError("删除BOM失败", "BOM已被业务数据引用,不可删除", err)
	}
	if err := writeDestroyAudit(ctx, tx, actor, "mfg_bom", id, item.Code, bomSnapshot(item)); err != nil {
		return internal("删除BOM失败", err)
	}
	return commit(ctx, tx, "删除BOM失败")
}

const (
	operationSelect = `SELECT id,code,name,note,inserted_at,updated_at FROM mfg_operation`
	templateSelect  = `SELECT id,code,name,note,inserted_at,updated_at FROM mfg_process_template`
	bomSelect       = `SELECT id,code,plan_name,note,inserted_at,updated_at,material_id FROM mfg_bom`
)

type scanner interface{ Scan(...any) error }

func scanOperation(row scanner) (Operation, error) {
	var item Operation
	err := row.Scan(&item.ID, &item.Code, &item.Name, &item.Note, &item.InsertedAt, &item.UpdatedAt)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, err
}

func scanTemplate(row scanner) (ProcessTemplate, error) {
	var item ProcessTemplate
	err := row.Scan(&item.ID, &item.Code, &item.Name, &item.Note, &item.InsertedAt, &item.UpdatedAt)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, err
}

func scanBOM(row scanner) (BOM, error) {
	var item BOM
	err := row.Scan(&item.ID, &item.Code, &item.PlanName, &item.Note,
		&item.InsertedAt, &item.UpdatedAt, &item.MaterialID)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, err
}

func (s *Service) list(ctx context.Context, query ListQuery, resource meta.ResourceMeta,
	selectSQL, defaultOrder string,
	scan func(pgx.Rows) error, count *int64) error {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	built, err := filterbuild.Build(resource, filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return err
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY ` + defaultOrder
	} else {
		order += `,"id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return internal("查询制造主数据失败", err)
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+resource.Table+built.Where, built.Args...).Scan(count); err != nil {
		return internal("统计制造主数据失败", err)
	}
	args := append([]any(nil), built.Args...)
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, selectSQL+built.Where+order+
		fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return internal("查询制造主数据失败", err)
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return internal("读取制造主数据结果失败", err)
		}
	}
	if err := rows.Err(); err != nil {
		return internal("遍历制造主数据结果失败", err)
	}
	return commit(ctx, tx, "完成制造主数据查询失败")
}

func ensureMaterial(ctx context.Context, tx pgx.Tx, materialID uuid.UUID) error {
	var found uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM inv_material WHERE id=$1`, materialID).Scan(&found); errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation("BOM参数不合法", map[string][]string{"materialId": {"物料不存在"}})
	} else if err != nil {
		return internal("读取物料失败", err)
	}
	return nil
}

func ensureUnitAllowed(ctx context.Context, tx pgx.Tx, materialID, unitID uuid.UUID) error {
	if unitID == uuid.Nil {
		return apierror.Validation("BOM行参数不合法", map[string][]string{"unitId": {"必填"}})
	}
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM inv_material m WHERE m.id=$1 AND m.default_unit_id=$2
		UNION ALL SELECT 1 FROM inv_material_unit mu WHERE mu.material_id=$1 AND mu.unit_id=$2
	)`, materialID, unitID).Scan(&allowed)
	if err != nil {
		return internal("检查物料单位失败", err)
	}
	if !allowed {
		return apierror.Validation("BOM行参数不合法",
			map[string][]string{"unitId": {"单位必须是该物料默认单位或转换单位"}})
	}
	return nil
}

func operationSnapshot(item Operation) map[string]any {
	return map[string]any{"code": item.Code, "name": item.Name, "note": item.Note}
}

func templateSnapshot(item ProcessTemplate) map[string]any {
	return map[string]any{"code": item.Code, "name": item.Name, "note": item.Note}
}

func bomSnapshot(item BOM) map[string]any {
	return map[string]any{"code": item.Code, "plan_name": item.PlanName, "note": item.Note, "material_id": item.MaterialID}
}

func writeAudit(ctx context.Context, tx pgx.Tx, actor *authz.Actor, resource string,
	id uuid.UUID, label, actionType, actionName string, after, before map[string]any) error {
	fields := sortedKeys(after)
	changes := audit.Created(after, fields)
	if before != nil {
		changes = audit.Diff(before, after, fields)
		if len(changes) == 0 {
			return nil
		}
	}
	return audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: id, RecordLabel: label,
		ActionType: actionType, ActionName: actionName, Changes: changes,
	})
}

func writeDestroyAudit(ctx context.Context, tx pgx.Tx, actor *authz.Actor,
	resource string, id uuid.UUID, label string, before map[string]any) error {
	return audit.Write(ctx, tx, actor, audit.Entry{
		Resource: resource, RecordID: id, RecordLabel: label,
		ActionType: "destroy", ActionName: "destroy",
		Changes: audit.Destroyed(before, sortedKeys(before)),
	})
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	// Determinism is useful for tests even though the audit payload is JSON.
	sortStrings(keys)
	return keys
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func readError(err error, notFound, message string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, notFound)
	}
	return internal(message, err)
}

func writeError(message, duplicate string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, duplicate, err)
		case "23503":
			return apierror.Wrap(apierror.CodeConflict, "关联数据不存在或已被引用", err)
		}
	}
	return internal(message, err)
}

func referenceError(message, conflict string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return apierror.Wrap(apierror.CodeConflict, conflict, err)
	}
	return internal(message, err)
}

func internal(message string, err error) error {
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

func commit(ctx context.Context, tx pgx.Tx, message string) error {
	if err := tx.Commit(ctx); err != nil {
		return internal(message, err)
	}
	return nil
}

func decimalValue(value decimal.Decimal) string { return value.String() }

func formatID(id uuid.UUID) string { return id.String() }
