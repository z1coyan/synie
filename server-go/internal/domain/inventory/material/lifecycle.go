package material

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Material, error) {
	normalized, err := normalizeCreate(input)
	if err != nil {
		return Material{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "创建物料失败", err)
	}
	defer tx.Rollback(ctx)
	if err := validateRelations(ctx, tx, normalized); err != nil {
		return Material{}, err
	}
	if s.numberer == nil {
		return Material{}, apierror.New(apierror.CodeConflict, "未配置启用的编号规则")
	}
	code, err := s.numberer.NextInTx(ctx, tx, numbering.NextInput{
		Resource: "inv.material",
		Values: map[string]any{
			"name": normalized.Name, "spec": normalized.Spec,
			"customer_part_no":     normalized.CustomerPartNo,
			"is_customer_material": normalized.IsCustomerMaterial,
			"active":               normalized.Active,
			"category_id":          normalized.CategoryID,
			"default_unit_id":      normalized.DefaultUnitID,
			"customer_id":          normalized.CustomerID,
		},
	})
	if err != nil {
		return Material{}, err
	}
	code = strings.TrimSpace(code)
	if code == "" || utf8.RuneCountInString(code) > 64 {
		return Material{}, apierror.Validation("物料参数不合法", map[string][]string{"code": {"自动编号不能为空且最多 64 个字符"}})
	}
	row, err := dbgen.New(tx).CreateMaterial(ctx, dbgen.CreateMaterialParams{
		Code: code, Name: normalized.Name, Spec: pgconv.Text(normalized.Spec),
		CustomerPartNo: pgconv.Text(normalized.CustomerPartNo), Active: normalized.Active,
		CategoryID: normalized.CategoryID, DefaultUnitID: normalized.DefaultUnitID,
		IsCustomerMaterial: normalized.IsCustomerMaterial, CustomerID: normalized.CustomerID,
	})
	if err != nil {
		return Material{}, writeError("创建物料失败", err)
	}
	item, err := getMaterial(ctx, tx, row.ID)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取新物料失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material", RecordID: item.ID, RecordLabel: item.Name,
		ActionType: "create", ActionName: "create", Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "创建物料失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, writeError("创建物料失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Material, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "更新物料失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).LockMaterial(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Material{}, apierror.New(apierror.CodeNotFound, "物料不存在")
	}
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取物料失败", err)
	}
	before, err := getMaterial(ctx, tx, id)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取物料失败", err)
	}
	after := before
	if input.Name != nil {
		after.Name = *input.Name
	}
	if input.Spec.Set {
		after.Spec = input.Spec.Value
	}
	if input.CustomerPartNo.Set {
		after.CustomerPartNo = input.CustomerPartNo.Value
	}
	if input.IsCustomerMaterial != nil {
		after.IsCustomerMaterial = *input.IsCustomerMaterial
	}
	if input.Active != nil {
		after.Active = *input.Active
	}
	if input.CategoryID != nil {
		after.CategoryID = *input.CategoryID
	}
	if input.DefaultUnitID != nil {
		after.DefaultUnitID = *input.DefaultUnitID
	}
	if input.CustomerID.Set {
		after.CustomerID = input.CustomerID.Value
	}
	normalized, err := normalizeCreate(CreateInput{
		Name: after.Name, Spec: after.Spec, CustomerPartNo: after.CustomerPartNo,
		IsCustomerMaterial: &after.IsCustomerMaterial, Active: &after.Active,
		CategoryID: after.CategoryID, DefaultUnitID: after.DefaultUnitID, CustomerID: after.CustomerID,
	})
	if err != nil {
		return Material{}, err
	}
	after.Name, after.Spec, after.CustomerPartNo = normalized.Name, normalized.Spec, normalized.CustomerPartNo
	after.IsCustomerMaterial, after.Active = normalized.IsCustomerMaterial, normalized.Active
	after.CategoryID, after.DefaultUnitID, after.CustomerID = normalized.CategoryID, normalized.DefaultUnitID, normalized.CustomerID
	if err := validateRelations(ctx, tx, normalized); err != nil {
		return Material{}, err
	}
	queries := dbgen.New(tx)
	if after.DefaultUnitID != row.DefaultUnitID {
		hasUnits, checkErr := queries.MaterialHasUnits(ctx, id)
		if checkErr != nil {
			return Material{}, apierror.Wrap(apierror.CodeInternal, "检查单位转换行失败", checkErr)
		}
		if hasUnits {
			return Material{}, apierror.Validation("物料参数不合法", map[string][]string{
				"defaultUnitId": {"存在单位转换行,不能修改默认单位,请先删除转换行"},
			})
		}
		hasStock, checkErr := queries.MaterialHasStockEntries(ctx, id)
		if checkErr != nil {
			return Material{}, apierror.Wrap(apierror.CodeInternal, "检查库存分录失败", checkErr)
		}
		if hasStock {
			return Material{}, apierror.Validation("物料参数不合法", map[string][]string{
				"defaultUnitId": {"物料已有库存分录,默认单位不可修改"},
			})
		}
	}
	if after.IsCustomerMaterial != row.IsCustomerMaterial || !sameUUID(after.CustomerID, row.CustomerID) {
		referenced, checkErr := queries.MaterialHasSalesReferences(ctx, id)
		if checkErr != nil {
			return Material{}, apierror.Wrap(apierror.CodeInternal, "检查销售引用失败", checkErr)
		}
		if referenced {
			return Material{}, apierror.New(apierror.CodeConflict, "物料已被报价或订单引用,不能修改客户约束")
		}
	}
	changes := audit.Diff(snapshot(before), snapshot(after), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Material{}, apierror.Wrap(apierror.CodeInternal, "更新物料失败", err)
		}
		return before, nil
	}
	if _, err := queries.UpdateMaterial(ctx, dbgen.UpdateMaterialParams{
		ID: id, Name: after.Name, Spec: pgconv.Text(after.Spec), CustomerPartNo: pgconv.Text(after.CustomerPartNo),
		Active: after.Active, CategoryID: after.CategoryID, DefaultUnitID: after.DefaultUnitID,
		IsCustomerMaterial: after.IsCustomerMaterial, CustomerID: after.CustomerID,
	}); err != nil {
		return Material{}, writeError("更新物料失败", err)
	}
	updated, err := getMaterial(ctx, tx, id)
	if err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "读取已更新物料失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material", RecordID: id, RecordLabel: updated.Name,
		ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return Material{}, apierror.Wrap(apierror.CodeInternal, "更新物料失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, writeError("更新物料失败", err)
	}
	return updated, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除物料失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).LockMaterial(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "物料不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取物料失败", err)
	}
	hasStock, err := dbgen.New(tx).MaterialHasStockEntries(ctx, id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查库存分录失败", err)
	}
	if hasStock {
		return apierror.New(apierror.CodeConflict, "物料已有库存分录,不能删除")
	}
	if err := dbgen.New(tx).DeleteMaterial(ctx, id); err != nil {
		return writeError("删除物料失败", err)
	}
	item := fromRow(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_material", RecordID: id, RecordLabel: item.Name,
		ActionType: "destroy", ActionName: "destroy", Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除物料失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除物料失败", err)
	}
	return nil
}

type normalizedInput struct {
	Name               string
	Spec               *string
	CustomerPartNo     *string
	IsCustomerMaterial bool
	Active             bool
	CategoryID         uuid.UUID
	DefaultUnitID      uuid.UUID
	CustomerID         *uuid.UUID
}

func normalizeCreate(input CreateInput) (normalizedInput, error) {
	result := normalizedInput{
		Name: strings.TrimSpace(input.Name), Spec: normalizeText(input.Spec),
		CustomerPartNo: normalizeText(input.CustomerPartNo),
		CategoryID:     input.CategoryID, DefaultUnitID: input.DefaultUnitID, CustomerID: input.CustomerID,
		Active: true,
	}
	if input.IsCustomerMaterial != nil {
		result.IsCustomerMaterial = *input.IsCustomerMaterial
	}
	if input.Active != nil {
		result.Active = *input.Active
	}
	if !result.IsCustomerMaterial {
		result.CustomerID, result.CustomerPartNo = nil, nil
	}
	fields := map[string][]string{}
	if result.Name == "" || utf8.RuneCountInString(result.Name) > 128 {
		fields["name"] = []string{"不能为空且最多 128 个字符"}
	}
	if result.Spec != nil && utf8.RuneCountInString(*result.Spec) > 128 {
		fields["spec"] = []string{"最多 128 个字符"}
	}
	if result.CustomerPartNo != nil && utf8.RuneCountInString(*result.CustomerPartNo) > 64 {
		fields["customerPartNo"] = []string{"最多 64 个字符"}
	}
	if result.CategoryID == uuid.Nil {
		fields["categoryId"] = []string{"不能为空"}
	}
	if result.DefaultUnitID == uuid.Nil {
		fields["defaultUnitId"] = []string{"不能为空"}
	}
	if result.IsCustomerMaterial && result.CustomerID == nil {
		fields["customerId"] = []string{"客户物料必须选择客户"}
	}
	if len(fields) > 0 {
		return normalizedInput{}, apierror.Validation("物料参数不合法", fields)
	}
	return result, nil
}

func normalizeText(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func validateRelations(ctx context.Context, tx pgx.Tx, input normalizedInput) error {
	var isLeaf, active bool
	err := tx.QueryRow(ctx, `SELECT is_leaf,active FROM inv_material_category WHERE id=$1`, input.CategoryID).
		Scan(&isLeaf, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation("物料参数不合法", map[string][]string{"categoryId": {"物料分类不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验物料分类失败", err)
	}
	if !isLeaf || !active {
		return apierror.Validation("物料参数不合法", map[string][]string{"categoryId": {"物料只能挂启用的叶子分类"}})
	}
	var unitExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_unit WHERE id=$1)`, input.DefaultUnitID).Scan(&unitExists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "校验默认单位失败", err)
	}
	if !unitExists {
		return apierror.Validation("物料参数不合法", map[string][]string{"defaultUnitId": {"默认单位不存在"}})
	}
	if input.CustomerID != nil {
		var customerExists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sal_customers WHERE id=$1)`, *input.CustomerID).Scan(&customerExists); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "校验客户失败", err)
		}
		if !customerExists {
			return apierror.Validation("物料参数不合法", map[string][]string{"customerId": {"客户不存在"}})
		}
	}
	return nil
}

func sameUUID(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func fromRow(row dbgen.InvMaterial) Material {
	return Material{
		ID: row.ID, Code: row.Code, Name: row.Name, Spec: textPointer(row.Spec),
		CustomerPartNo: textPointer(row.CustomerPartNo), IsCustomerMaterial: row.IsCustomerMaterial,
		Active: row.Active, InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		CategoryID: row.CategoryID, DefaultUnitID: row.DefaultUnitID, CustomerID: row.CustomerID,
	}
}

func textPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func snapshot(item Material) map[string]any {
	return map[string]any{
		"code": item.Code, "name": item.Name, "spec": item.Spec,
		"customer_part_no": item.CustomerPartNo, "is_customer_material": item.IsCustomerMaterial,
		"active": item.Active, "category_id": item.CategoryID,
		"default_unit_id": item.DefaultUnitID, "customer_id": item.CustomerID,
	}
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Constraint: "inv_material_unique_code_index", Message: "物料编号已存在"},
	{Code: "23505", Message: "物料唯一字段已存在"},
	{Code: "23514", Message: "客户物料必须挂客户,非客户物料不能挂客户", Validation: true},
	{Code: "23503", Message: "物料已被引用或关联记录不存在"},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}
