package master

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func (s *Service) CreateTemplateItem(ctx context.Context, actor *authz.Actor,
	templateID uuid.UUID, input RouteItemInput) (TemplateItem, error) {
	if err := requireChild(actor, templatePermission, "create"); err != nil {
		return TemplateItem{}, err
	}
	input, err := normalizeRoute(input)
	if err != nil {
		return TemplateItem{}, err
	}
	if templateID == uuid.Nil {
		return TemplateItem{}, apierror.Validation("工艺模板行参数不合法",
			map[string][]string{"templateId": {"必填"}})
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TemplateItem{}, internal("创建工艺模板行失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockExists(ctx, tx, "mfg_process_template", templateID, "工艺模板不存在"); err != nil {
		return TemplateItem{}, err
	}
	item, err := scanTemplateItem(tx.QueryRow(ctx, `INSERT INTO mfg_process_template_item(
		template_id,operation_id,seq,requirement,is_outsourced)
		VALUES($1,$2,$3,$4,$5)
		RETURNING id,seq,requirement,is_outsourced,inserted_at,updated_at,template_id,operation_id`,
		templateID, input.OperationID, input.Seq, input.Requirement, input.IsOutsourced))
	if err != nil {
		return TemplateItem{}, referenceError("创建工艺模板行失败", "工序或工艺模板不存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_process_template_item", item.ID, formatID(item.ID),
		"create", "create", templateItemSnapshot(item), nil); err != nil {
		return TemplateItem{}, internal("创建工艺模板行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return TemplateItem{}, internal("创建工艺模板行失败", err)
	}
	return item, nil
}

func (s *Service) GetTemplateItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) (TemplateItem, error) {
	if err := requireChild(actor, templatePermission, "read"); err != nil {
		return TemplateItem{}, err
	}
	item, err := scanTemplateItem(s.pool.QueryRow(ctx, templateItemSelect+` WHERE id=$1`, id))
	return item, readError(err, "工艺模板行不存在", "读取工艺模板行失败")
}

func (s *Service) ListTemplateItems(ctx context.Context, actor *authz.Actor,
	templateID *uuid.UUID, query ListQuery) (ListResult[TemplateItem], error) {
	if err := requireChild(actor, templatePermission, "read"); err != nil {
		return ListResult[TemplateItem]{}, err
	}
	return listChildren(ctx, s, query, TemplateItemResourceMeta(), templateItemSelect,
		"template_id", templateID, `"seq","id"`, scanTemplateItem)
}

func (s *Service) UpdateTemplateItem(ctx context.Context, actor *authz.Actor,
	id uuid.UUID, input RouteItemInput) (TemplateItem, error) {
	if err := requireChild(actor, templatePermission, "update"); err != nil {
		return TemplateItem{}, err
	}
	input, err := normalizeRoute(input)
	if err != nil {
		return TemplateItem{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TemplateItem{}, internal("更新工艺模板行失败", err)
	}
	defer tx.Rollback(ctx)
	var templateID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT template_id FROM mfg_process_template_item WHERE id=$1`, id).Scan(&templateID)
	if err != nil {
		return TemplateItem{}, readError(err, "工艺模板行不存在", "读取工艺模板行失败")
	}
	if err := lockExists(ctx, tx, "mfg_process_template", templateID, "工艺模板不存在"); err != nil {
		return TemplateItem{}, err
	}
	before, err := scanTemplateItem(tx.QueryRow(ctx, templateItemSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return TemplateItem{}, readError(err, "工艺模板行不存在", "读取工艺模板行失败")
	}
	after, err := scanTemplateItem(tx.QueryRow(ctx, `UPDATE mfg_process_template_item SET
		operation_id=$2,seq=$3,requirement=$4,is_outsourced=$5,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1
		RETURNING id,seq,requirement,is_outsourced,inserted_at,updated_at,template_id,operation_id`,
		id, input.OperationID, input.Seq, input.Requirement, input.IsOutsourced))
	if err != nil {
		return TemplateItem{}, referenceError("更新工艺模板行失败", "工序不存在", err)
	}
	if err := writeAudit(ctx, tx, actor, "mfg_process_template_item", id, formatID(id),
		"update", "update", templateItemSnapshot(after), templateItemSnapshot(before)); err != nil {
		return TemplateItem{}, internal("更新工艺模板行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return TemplateItem{}, internal("更新工艺模板行失败", err)
	}
	return after, nil
}

func (s *Service) DeleteTemplateItem(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := requireChild(actor, templatePermission, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return internal("删除工艺模板行失败", err)
	}
	defer tx.Rollback(ctx)
	var templateID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT template_id FROM mfg_process_template_item WHERE id=$1`, id).Scan(&templateID)
	if err != nil {
		return readError(err, "工艺模板行不存在", "读取工艺模板行失败")
	}
	if err := lockExists(ctx, tx, "mfg_process_template", templateID, "工艺模板不存在"); err != nil {
		return err
	}
	item, err := scanTemplateItem(tx.QueryRow(ctx, templateItemSelect+` WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return readError(err, "工艺模板行不存在", "读取工艺模板行失败")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM mfg_process_template_item WHERE id=$1`, id); err != nil {
		return internal("删除工艺模板行失败", err)
	}
	if err := writeDestroyAudit(ctx, tx, actor, "mfg_process_template_item", id,
		formatID(id), templateItemSnapshot(item)); err != nil {
		return internal("删除工艺模板行失败", err)
	}
	return commit(ctx, tx, "删除工艺模板行失败")
}

const templateItemSelect = `SELECT id,seq,requirement,is_outsourced,inserted_at,updated_at,
	template_id,operation_id FROM mfg_process_template_item`

func scanTemplateItem(row scanner) (TemplateItem, error) {
	var item TemplateItem
	err := row.Scan(&item.ID, &item.Seq, &item.Requirement, &item.IsOutsourced,
		&item.InsertedAt, &item.UpdatedAt, &item.TemplateID, &item.OperationID)
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	return item, err
}

func templateItemSnapshot(item TemplateItem) map[string]any {
	return map[string]any{
		"seq": item.Seq, "requirement": item.Requirement, "is_outsourced": item.IsOutsourced,
		"template_id": item.TemplateID, "operation_id": item.OperationID,
	}
}

type scanFunc[T any] func(scanner) (T, error)

func listChildren[T any](ctx context.Context, s *Service, query ListQuery, resource meta.ResourceMeta, selectSQL,
	parentColumn string, parentID *uuid.UUID, order string, scan scanFunc[T]) (ListResult[T], error) {
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return ListResult[T]{}, apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	built, err := filterbuild.Build(resource, filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ListResult[T]{}, err
	}
	where, args := built.Where, append([]any(nil), built.Args...)
	if parentID != nil {
		conjunction := " WHERE "
		if where != "" {
			conjunction = " AND "
		}
		where += conjunction + `"` + parentColumn + `"` + fmt.Sprintf("=$%d", len(args)+1)
		args = append(args, *parentID)
	}
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY ` + order
	} else {
		orderBy += `,"id"`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ListResult[T]{}, internal("查询制造主数据行失败", err)
	}
	defer tx.Rollback(ctx)
	var out ListResult[T]
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+resource.Table+where, args...).Scan(&out.Count); err != nil {
		return out, internal("统计制造主数据行失败", err)
	}
	args = append(args, query.Limit, query.Offset)
	limitAt := len(args) - 1
	rows, err := tx.Query(ctx, selectSQL+where+orderBy+
		fmt.Sprintf(` LIMIT $%d OFFSET $%d`, limitAt, limitAt+1), args...)
	if err != nil {
		return out, internal("查询制造主数据行失败", err)
	}
	defer rows.Close()
	out.Results = make([]T, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scan(rows)
		if scanErr != nil {
			return out, internal("读取制造主数据行失败", scanErr)
		}
		out.Results = append(out.Results, item)
	}
	if err := rows.Err(); err != nil {
		return out, internal("遍历制造主数据行失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return out, internal("完成制造主数据行查询失败", err)
	}
	return out, nil
}

func lockExists(ctx context.Context, tx pgx.Tx, table string, id uuid.UUID, notFound string) error {
	var found uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM `+table+` WHERE id=$1 FOR UPDATE`, id).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, notFound)
	}
	if err != nil {
		return internal("锁定制造主数据失败", err)
	}
	return nil
}
