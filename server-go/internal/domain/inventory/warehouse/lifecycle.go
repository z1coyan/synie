package warehouse

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
)

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Warehouse, error) {
	normalized, err := normalizeCreate(input)
	if err != nil {
		return Warehouse{}, err
	}
	if actor == nil || !actor.CanAccessCompany(normalized.CompanyID) {
		return Warehouse{}, apierror.New(apierror.CodeForbidden, "无权在该公司下操作数据")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "创建仓库失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockTree(ctx, tx, normalized.CompanyID); err != nil {
		return Warehouse{}, err
	}
	if err := validateRelations(ctx, tx, uuid.Nil, normalized); err != nil {
		return Warehouse{}, err
	}
	row, err := dbgen.New(tx).CreateWarehouse(ctx, dbgen.CreateWarehouseParams{
		Name: normalized.Name, IsLeaf: normalized.IsLeaf, Active: normalized.Active,
		IsOutsourced: normalized.IsOutsourced, AllowNegative: normalized.AllowNegative,
		CompanyID: normalized.CompanyID, ParentID: normalized.ParentID, AccountID: normalized.AccountID,
		PartyType: partyText(normalized.PartyType), PartyID: normalized.PartyID,
	})
	if err != nil {
		return Warehouse{}, writeError("创建仓库失败", err)
	}
	item, err := getWarehouse(ctx, tx, row.ID)
	if err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "读取新仓库失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_warehouse", RecordID: item.ID, RecordLabel: item.Name,
		CompanyID: &item.CompanyID, ActionType: "create", ActionName: "create",
		Changes: audit.Created(snapshot(item), auditedFields),
	}); err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "创建仓库失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Warehouse{}, writeError("创建仓库失败", err)
	}
	return item, nil
}

func (s *Service) Update(ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdateInput) (Warehouse, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "更新仓库失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).LockWarehouse(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Warehouse{}, apierror.New(apierror.CodeNotFound, "仓库不存在")
	}
	if err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	if actor == nil || !actor.CanAccessCompany(row.CompanyID) {
		// 公司隔离越权统一按「不存在」响应,避免通过 403/404 差异探测他公司数据
		return Warehouse{}, apierror.New(apierror.CodeNotFound, "仓库不存在")
	}
	if err := lockTree(ctx, tx, row.CompanyID); err != nil {
		return Warehouse{}, err
	}
	before, err := getWarehouse(ctx, tx, id)
	if err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	after := CreateInput{
		Name: row.Name, IsLeaf: &row.IsLeaf, Active: &row.Active,
		IsOutsourced: &row.IsOutsourced, AllowNegative: &row.AllowNegative,
		CompanyID: row.CompanyID, ParentID: row.ParentID, AccountID: row.AccountID,
		PartyType: textPointer(row.PartyType), PartyID: row.PartyID,
	}
	if input.Name != nil {
		after.Name = *input.Name
	}
	if input.IsLeaf != nil {
		after.IsLeaf = input.IsLeaf
	}
	if input.Active != nil {
		after.Active = input.Active
	}
	if input.IsOutsourced != nil {
		after.IsOutsourced = input.IsOutsourced
	}
	if input.AllowNegative != nil {
		after.AllowNegative = input.AllowNegative
	}
	if input.ParentID.Set {
		after.ParentID = input.ParentID.Value
	}
	if input.AccountID.Set {
		after.AccountID = input.AccountID.Value
	}
	if input.PartyType.Set {
		after.PartyType = input.PartyType.Value
	}
	if input.PartyID.Set {
		after.PartyID = input.PartyID.Value
	}
	normalized, err := normalizeCreate(after)
	if err != nil {
		return Warehouse{}, err
	}
	if err := validateRelations(ctx, tx, id, normalized); err != nil {
		return Warehouse{}, err
	}
	queries := dbgen.New(tx)
	if normalized.IsLeaf != row.IsLeaf {
		if normalized.IsLeaf {
			hasChildren, checkErr := queries.WarehouseHasChildren(ctx, &id)
			if checkErr != nil {
				return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "检查下级仓库失败", checkErr)
			}
			if hasChildren {
				return Warehouse{}, apierror.Validation("仓库参数不合法", map[string][]string{
					"isLeaf": {"存在下级仓库,不能改为叶子仓库"},
				})
			}
		} else {
			hasStock, checkErr := queries.WarehouseHasStockEntries(ctx, id)
			if checkErr != nil {
				return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "检查库存分录失败", checkErr)
			}
			if hasStock {
				return Warehouse{}, apierror.Validation("仓库参数不合法", map[string][]string{
					"isLeaf": {"仓库已有库存分录,不能改为非叶子"},
				})
			}
		}
	}
	next := before
	next.Name, next.IsLeaf, next.Active = normalized.Name, normalized.IsLeaf, normalized.Active
	next.IsOutsourced, next.AllowNegative = normalized.IsOutsourced, normalized.AllowNegative
	next.ParentID, next.AccountID = normalized.ParentID, normalized.AccountID
	next.PartyType, next.PartyID = normalized.PartyType, normalized.PartyID
	changes := audit.Diff(snapshot(before), snapshot(next), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "更新仓库失败", err)
		}
		return before, nil
	}
	if _, err := queries.UpdateWarehouse(ctx, dbgen.UpdateWarehouseParams{
		ID: id, Name: normalized.Name, IsLeaf: normalized.IsLeaf, Active: normalized.Active,
		IsOutsourced: normalized.IsOutsourced, AllowNegative: normalized.AllowNegative,
		ParentID: normalized.ParentID, AccountID: normalized.AccountID,
		PartyType: partyText(normalized.PartyType), PartyID: normalized.PartyID,
	}); err != nil {
		return Warehouse{}, writeError("更新仓库失败", err)
	}
	updated, err := getWarehouse(ctx, tx, id)
	if err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "读取已更新仓库失败", err)
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_warehouse", RecordID: id, RecordLabel: updated.Name,
		CompanyID: &updated.CompanyID, ActionType: "update", ActionName: "update", Changes: changes,
	}); err != nil {
		return Warehouse{}, apierror.Wrap(apierror.CodeInternal, "更新仓库失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Warehouse{}, writeError("更新仓库失败", err)
	}
	return updated, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除仓库失败", err)
	}
	defer tx.Rollback(ctx)
	row, err := dbgen.New(tx).LockWarehouse(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "仓库不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	if actor == nil || !actor.CanAccessCompany(row.CompanyID) {
		// 公司隔离越权统一按「不存在」响应,避免通过 403/404 差异探测他公司数据
		return apierror.New(apierror.CodeNotFound, "仓库不存在")
	}
	if err := lockTree(ctx, tx, row.CompanyID); err != nil {
		return err
	}
	queries := dbgen.New(tx)
	hasChildren, err := queries.WarehouseHasChildren(ctx, &id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查下级仓库失败", err)
	}
	if hasChildren {
		return apierror.New(apierror.CodeConflict, "存在下级仓库,不能删除")
	}
	hasStock, err := queries.WarehouseHasStockEntries(ctx, id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查库存分录失败", err)
	}
	if hasStock {
		return apierror.New(apierror.CodeConflict, "仓库已有库存分录,不能删除")
	}
	if err := queries.DeleteWarehouse(ctx, id); err != nil {
		return writeError("删除仓库失败", err)
	}
	item := fromRow(row)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_warehouse", RecordID: id, RecordLabel: item.Name,
		CompanyID: &item.CompanyID, ActionType: "destroy", ActionName: "destroy",
		Changes: audit.Destroyed(snapshot(item), auditedFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除仓库失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除仓库失败", err)
	}
	return nil
}

func (s *Service) SeedDefaults(ctx context.Context, actor *authz.Actor, companyID uuid.UUID) (int, error) {
	if actor == nil || !actor.CanAccessCompany(companyID) {
		return 0, apierror.New(apierror.CodeForbidden, "无权在该公司下操作数据")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "初始化默认仓库失败", err)
	}
	defer tx.Rollback(ctx)
	var code string
	if err := tx.QueryRow(ctx, `SELECT code FROM bas_company WHERE id=$1`, companyID).Scan(&code); errors.Is(err, pgx.ErrNoRows) {
		return 0, apierror.Validation("初始化默认仓库参数不合法", map[string][]string{"companyId": {"公司不存在"}})
	} else if err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "读取公司失败", err)
	}
	count, err := SeedCompanyDefaults(ctx, tx, actor, companyID, code)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "初始化默认仓库失败", err)
	}
	return count, nil
}

type normalizedInput struct {
	Name          string
	IsLeaf        bool
	Active        bool
	IsOutsourced  bool
	PartyType     *string
	PartyID       *uuid.UUID
	AllowNegative bool
	CompanyID     uuid.UUID
	ParentID      *uuid.UUID
	AccountID     *uuid.UUID
}

func normalizeCreate(input CreateInput) (normalizedInput, error) {
	result := normalizedInput{
		Name: strings.TrimSpace(input.Name), IsLeaf: true, Active: true,
		CompanyID: input.CompanyID, ParentID: input.ParentID, AccountID: input.AccountID,
		PartyID: input.PartyID,
	}
	if input.IsLeaf != nil {
		result.IsLeaf = *input.IsLeaf
	}
	if input.Active != nil {
		result.Active = *input.Active
	}
	if input.IsOutsourced != nil {
		result.IsOutsourced = *input.IsOutsourced
	}
	if input.AllowNegative != nil {
		result.AllowNegative = *input.AllowNegative
	}
	if input.PartyType != nil {
		value := strings.ToUpper(strings.TrimSpace(*input.PartyType))
		if value != "" {
			result.PartyType = &value
		}
	}
	fields := map[string][]string{}
	if result.Name == "" || utf8.RuneCountInString(result.Name) > 128 {
		fields["name"] = []string{"不能为空且最多 128 个字符"}
	}
	if result.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"不能为空"}
	}
	if result.IsOutsourced && (result.PartyType == nil || result.PartyID == nil) {
		fields["partyId"] = []string{"外协仓必须绑定协作方"}
	}
	if !result.IsOutsourced && (result.PartyType != nil || result.PartyID != nil) {
		fields["partyId"] = []string{"非外协仓不能绑定协作方"}
	}
	if result.PartyType != nil && *result.PartyType != "SUPPLIER" && *result.PartyType != "COMPANY" {
		fields["partyType"] = []string{"协作方类型只能为供应商或内部公司"}
	}
	if len(fields) > 0 {
		return normalizedInput{}, apierror.Validation("仓库参数不合法", fields)
	}
	return result, nil
}

func validateRelations(ctx context.Context, tx pgx.Tx, id uuid.UUID, input normalizedInput) error {
	if input.ParentID != nil {
		if id != uuid.Nil && *input.ParentID == id {
			return apierror.Validation("仓库参数不合法", map[string][]string{"parentId": {"上级仓库不能选择自身"}})
		}
		var companyID uuid.UUID
		var isLeaf bool
		err := tx.QueryRow(ctx, `SELECT company_id,is_leaf FROM inv_warehouse WHERE id=$1`, *input.ParentID).
			Scan(&companyID, &isLeaf)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierror.Validation("仓库参数不合法", map[string][]string{"parentId": {"上级仓库不存在"}})
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "校验上级仓库失败", err)
		}
		if companyID != input.CompanyID {
			return apierror.Validation("仓库参数不合法", map[string][]string{"parentId": {"上级仓库不属于本公司"}})
		}
		if isLeaf {
			return apierror.Validation("仓库参数不合法", map[string][]string{"parentId": {"上级仓库是叶子仓库,不能挂子仓库"}})
		}
	}
	if input.AccountID != nil {
		var companyID uuid.UUID
		var isGroup bool
		var currencyID *uuid.UUID
		err := tx.QueryRow(ctx, `SELECT company_id,is_group,currency_id FROM bas_account WHERE id=$1`, *input.AccountID).
			Scan(&companyID, &isGroup, &currencyID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierror.Validation("仓库参数不合法", map[string][]string{"accountId": {"关联科目不存在"}})
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "校验关联科目失败", err)
		}
		switch {
		case companyID != input.CompanyID:
			return apierror.Validation("仓库参数不合法", map[string][]string{"accountId": {"关联科目不属于本公司"}})
		case isGroup:
			return apierror.Validation("仓库参数不合法", map[string][]string{"accountId": {"汇总科目不能作为关联科目"}})
		case currencyID != nil:
			return apierror.Validation("仓库参数不合法", map[string][]string{"accountId": {"外币科目不能作为关联科目"}})
		}
	}
	if input.PartyType != nil && input.PartyID != nil {
		table := "pur_supplier"
		if *input.PartyType == "COMPANY" {
			table = "bas_company"
			if *input.PartyID == input.CompanyID {
				return apierror.Validation("仓库参数不合法", map[string][]string{"partyId": {"协作方不能是本公司"}})
			}
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM `+table+` WHERE id=$1)`, *input.PartyID).Scan(&exists); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "校验协作方失败", err)
		}
		if !exists {
			return apierror.Validation("仓库参数不合法", map[string][]string{"partyId": {"协作方不存在"}})
		}
	}
	return nil
}

func lockTree(ctx context.Context, tx pgx.Tx, companyID uuid.UUID) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, companyID); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定仓库树失败", err)
	}
	return nil
}

func partyText(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: strings.ToLower(*value), Valid: true}
}

func textPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := strings.ToUpper(value.String)
	return &result
}

func fromRow(row dbgen.InvWarehouse) Warehouse {
	return Warehouse{
		ID: row.ID, Name: row.Name, IsLeaf: row.IsLeaf, Active: row.Active,
		IsOutsourced: row.IsOutsourced, PartyType: textPointer(row.PartyType), PartyID: row.PartyID,
		AllowNegative: row.AllowNegative, InsertedAt: row.InsertedAt.Time.UTC(),
		UpdatedAt: row.UpdatedAt.Time.UTC(), CompanyID: row.CompanyID,
		ParentID: row.ParentID, AccountID: row.AccountID,
	}
}

func snapshot(item Warehouse) map[string]any {
	return map[string]any{
		"name": item.Name, "is_leaf": item.IsLeaf, "active": item.Active,
		"is_outsourced": item.IsOutsourced, "party_type": lowerText(item.PartyType),
		"party_id": item.PartyID, "allow_negative": item.AllowNegative,
		"company_id": item.CompanyID, "parent_id": item.ParentID, "account_id": item.AccountID,
	}
}

func lowerText(value *string) *string {
	if value == nil {
		return nil
	}
	result := strings.ToLower(*value)
	return &result
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Constraint: "inv_warehouse_unique_name_per_company_index", Message: "仓库名称已存在"},
	{Code: "23505", Message: "仓库唯一字段已存在"},
	{Code: "23514", Message: "协作方类型与协作方必须同时填写", Validation: true},
	{Code: "23503", Message: "仓库已被引用或关联记录不存在"},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}
