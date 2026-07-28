package materialcategory

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
)

const categorySource = ` FROM (
	SELECT c.id,c.code,c.name,c.is_leaf,c.active,c.inserted_at,c.updated_at,c.parent_id,
	       p.name AS parent_name,
	       EXISTS(SELECT 1 FROM inv_material_category child WHERE child.parent_id=c.id) AS has_children
	FROM inv_material_category c
	LEFT JOIN inv_material_category p ON p.id=c.parent_id
) material_category`

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(ctx context.Context, id uuid.UUID) (MaterialCategory, error) {
	item, err := scanCategory(s.pool.QueryRow(ctx, `SELECT id,code,name,is_leaf,active,inserted_at,updated_at,
		parent_id,parent_name,has_children`+categorySource+` WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return MaterialCategory{}, apierror.New(apierror.CodeNotFound, "物料分类不存在")
	}
	if err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "读取物料分类失败", err)
	}
	return item, nil
}

func (s *Service) List(ctx context.Context, query ListQuery) (ListResult, error) {
	result, err := listexec.List(ctx, listexec.Spec[MaterialCategory]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "物料分类",
		Source: categorySource,
		Select: `SELECT id,code,name,is_leaf,active,inserted_at,updated_at,
parent_id,parent_name,has_children`,
		DefaultOrder: ` ORDER BY code ASC,id ASC`,
		Tiebreaker:   `,id ASC`,
		Scan: func(rows pgx.Rows) (MaterialCategory, error) {
			return scanCategory(rows)
		},
	}, listQuery(query))
	if err != nil {
		return ListResult{}, err
	}
	return ListResult{Count: result.Count, Results: result.Results}, nil
}

func listQuery(query ListQuery) listexec.Query {
	return listexec.Query{Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter}
}

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (MaterialCategory, error) {
	code, name := strings.TrimSpace(input.Code), strings.TrimSpace(input.Name)
	if err := validateNames(code, name); err != nil {
		return MaterialCategory{}, err
	}
	isLeaf, active := true, true
	if input.IsLeaf != nil {
		isLeaf = *input.IsLeaf
	}
	if input.Active != nil {
		active = *input.Active
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "创建物料分类失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockTree(ctx, tx); err != nil {
		return MaterialCategory{}, err
	}
	if err := validateParent(ctx, tx, uuid.Nil, input.ParentID); err != nil {
		return MaterialCategory{}, err
	}
	row, err := dbgen.New(tx).CreateMaterialCategory(ctx, dbgen.CreateMaterialCategoryParams{
		Code: code, Name: name, IsLeaf: isLeaf, Active: active, ParentID: input.ParentID,
	})
	if err != nil {
		return MaterialCategory{}, writeError("创建物料分类失败", err)
	}
	item, err := getCategory(ctx, tx, row.ID)
	if err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "读取新物料分类失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material_category", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "create", ActionName: "create", Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "创建物料分类失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return MaterialCategory{}, writeError("创建物料分类失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (MaterialCategory, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "更新物料分类失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockTree(ctx, tx); err != nil {
		return MaterialCategory{}, err
	}
	row, err := dbgen.New(tx).LockMaterialCategory(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return MaterialCategory{}, apierror.New(apierror.CodeNotFound, "物料分类不存在")
	}
	if err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "读取物料分类失败", err)
	}
	before, err := getCategory(ctx, tx, id)
	if err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "读取物料分类失败", err)
	}
	code, name, isLeaf, active, parentID := row.Code, row.Name, row.IsLeaf, row.Active, row.ParentID
	if input.Code != nil {
		code = *input.Code
	}
	if input.Name != nil {
		name = *input.Name
	}
	if input.IsLeaf != nil {
		isLeaf = *input.IsLeaf
	}
	if input.Active != nil {
		active = *input.Active
	}
	if input.ParentID.Set {
		parentID = input.ParentID.Value
	}
	code, name = strings.TrimSpace(code), strings.TrimSpace(name)
	if err := validateNames(code, name); err != nil {
		return MaterialCategory{}, err
	}
	if err := validateParent(ctx, tx, id, parentID); err != nil {
		return MaterialCategory{}, err
	}
	queries := dbgen.New(tx)
	if isLeaf != row.IsLeaf {
		if isLeaf {
			hasChildren, checkErr := queries.MaterialCategoryHasChildren(ctx, &id)
			if checkErr != nil {
				return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "检查下级分类失败", checkErr)
			}
			if hasChildren {
				return MaterialCategory{}, apierror.Validation("物料分类参数不合法", map[string][]string{"isLeaf": {"存在下级分类,不能改为叶子分类"}})
			}
		} else {
			hasMaterials, checkErr := queries.MaterialCategoryHasMaterials(ctx, id)
			if checkErr != nil {
				return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "检查分类物料失败", checkErr)
			}
			if hasMaterials {
				return MaterialCategory{}, apierror.Validation("物料分类参数不合法", map[string][]string{"isLeaf": {"分类下存在物料,不能改为非叶子分类"}})
			}
		}
	}
	after := before
	after.Code, after.Name, after.IsLeaf, after.Active, after.ParentID = code, name, isLeaf, active, parentID
	changes := audit.Diff(snapshot(before), snapshot(after), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "更新物料分类失败", err)
		}
		return before, nil
	}
	if _, err := queries.UpdateMaterialCategory(ctx, dbgen.UpdateMaterialCategoryParams{
		ID: id, Code: code, Name: name, IsLeaf: isLeaf, Active: active, ParentID: parentID,
	}); err != nil {
		return MaterialCategory{}, writeError("更新物料分类失败", err)
	}
	updated, err := getCategory(ctx, tx, id)
	if err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "读取已更新物料分类失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material_category", RecordID: id, RecordLabel: updated.Name,
		ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return MaterialCategory{}, apierror.Wrap(apierror.CodeInternal, "更新物料分类失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return MaterialCategory{}, writeError("更新物料分类失败", err)
	}
	return updated, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除物料分类失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockTree(ctx, tx); err != nil {
		return err
	}
	row, err := dbgen.New(tx).LockMaterialCategory(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "物料分类不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取物料分类失败", err)
	}
	queries := dbgen.New(tx)
	hasChildren, err := queries.MaterialCategoryHasChildren(ctx, &id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查下级分类失败", err)
	}
	if hasChildren {
		return apierror.New(apierror.CodeConflict, "存在下级分类,不能删除")
	}
	hasMaterials, err := queries.MaterialCategoryHasMaterials(ctx, id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查分类物料失败", err)
	}
	if hasMaterials {
		return apierror.New(apierror.CodeConflict, "分类下存在物料,不能删除")
	}
	if err := queries.DeleteMaterialCategory(ctx, id); err != nil {
		return writeError("删除物料分类失败", err)
	}
	item := fromRow(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material_category", RecordID: id, RecordLabel: item.Name,
		ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除物料分类失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除物料分类失败", err)
	}
	return nil
}

func validateNames(code, name string) error {
	fields := map[string][]string{}
	if code == "" || utf8.RuneCountInString(code) > 32 {
		fields["code"] = []string{"不能为空且最多 32 个字符"}
	}
	if name == "" || utf8.RuneCountInString(name) > 128 {
		fields["name"] = []string{"不能为空且最多 128 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("物料分类参数不合法", fields)
	}
	return nil
}

func lockTree(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('inv_material_category',0))`); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定物料分类树失败", err)
	}
	return nil
}

func validateParent(ctx context.Context, tx pgx.Tx, id uuid.UUID, parentID *uuid.UUID) error {
	if parentID == nil {
		return nil
	}
	if id != uuid.Nil && *parentID == id {
		return apierror.Validation("物料分类参数不合法", map[string][]string{"parentId": {"上级分类不能选择自身"}})
	}
	var isLeaf bool
	err := tx.QueryRow(ctx, `SELECT is_leaf FROM inv_material_category WHERE id=$1`, *parentID).Scan(&isLeaf)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation("物料分类参数不合法", map[string][]string{"parentId": {"上级分类不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验上级分类失败", err)
	}
	if isLeaf {
		return apierror.Validation("物料分类参数不合法", map[string][]string{"parentId": {"上级分类是叶子分类,不能挂子分类"}})
	}
	return nil
}

func getCategory(ctx context.Context, tx pgx.Tx, id uuid.UUID) (MaterialCategory, error) {
	return scanCategory(tx.QueryRow(ctx, `SELECT id,code,name,is_leaf,active,inserted_at,updated_at,
		parent_id,parent_name,has_children`+categorySource+` WHERE id=$1`, id))
}

type scanner interface{ Scan(...any) error }

func scanCategory(row scanner) (MaterialCategory, error) {
	var item MaterialCategory
	var parentName *string
	err := row.Scan(&item.ID, &item.Code, &item.Name, &item.IsLeaf, &item.Active,
		&item.InsertedAt, &item.UpdatedAt, &item.ParentID, &parentName, &item.HasChildren)
	if err != nil {
		return MaterialCategory{}, err
	}
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	if item.ParentID != nil && parentName != nil {
		item.Parent = &Reference{ID: *item.ParentID, Name: *parentName}
	}
	return item, nil
}

func fromRow(row dbgen.InvMaterialCategory) MaterialCategory {
	return MaterialCategory{
		ID: row.ID, Code: row.Code, Name: row.Name, IsLeaf: row.IsLeaf, Active: row.Active,
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(), ParentID: row.ParentID,
	}
}

func snapshot(item MaterialCategory) map[string]any {
	return map[string]any{
		"code": item.Code, "name": item.Name, "is_leaf": item.IsLeaf,
		"active": item.Active, "parent_id": item.ParentID,
	}
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Constraint: "inv_material_category_unique_code_index", Message: "分类编号已存在"},
	{Code: "23505", Message: "物料分类唯一字段已存在"},
	{Code: "23503", Message: "物料分类已被引用,不能删除或关联记录不存在"},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}
