package stockdoc

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stock"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

type Numberer interface {
	NextInTx(context.Context, pgx.Tx, numbering.NextInput) (string, error)
}

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

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Doc, error) {
	if err := require(actor, "read"); err != nil {
		return Doc{}, err
	}
	row, err := dbgen.New(s.pool).GetStockDoc(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Doc{}, apierror.New(apierror.CodeNotFound, "手工出入库单不存在")
	}
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "读取手工出入库单失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Doc{}, apierror.New(apierror.CodeNotFound, "手工出入库单不存在")
	}
	return docFromRow(row), nil
}

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ListResult{}, err
	}
	result, err := listexec.List(ctx, listexec.Spec[Doc]{
		Pool: s.pool, Resource: ResourceMeta(), Label: "手工出入库单", Actor: actor,
		Source: ` FROM inv_stock_doc`,
		Select: `SELECT id,doc_no,direction,doc_date,summary,remarks,status,audited_at,
inserted_at,updated_at,company_id,warehouse_id,created_by_id,audited_by_id`,
		DefaultOrder: ` ORDER BY "doc_no" ASC, "id" ASC`,
		Tiebreaker:   `, "id" ASC`,
		Scan: func(rows pgx.Rows) (Doc, error) {
			return scanDoc(rows)
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

func (s *Service) Create(ctx context.Context, actor *authz.Actor, input CreateInput) (Doc, error) {
	if err := require(actor, "create"); err != nil {
		return Doc{}, err
	}
	if err := validateCreate(actor, &input); err != nil {
		return Doc{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "创建手工出入库单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	if err := validateWarehouse(ctx, q, input.CompanyID, input.WarehouseID); err != nil {
		return Doc{}, err
	}
	docDate := todayUTC()
	if input.DocDate != nil {
		docDate = *input.DocDate
	}
	docNo := ""
	if input.DocNo != nil {
		docNo = strings.TrimSpace(*input.DocNo)
	}
	if docNo == "" {
		docNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "inv.stock_doc",
			Values: map[string]any{
				"company_id": input.CompanyID,
				"doc_date":   docDate,
				"direction":  string(input.Direction),
			},
		})
		if err != nil {
			return Doc{}, err
		}
	}
	if utf8.RuneCountInString(docNo) > 32 {
		return Doc{}, apierror.Validation("手工出入库单参数不合法", map[string][]string{
			"docNo": {"最多 32 个字符"},
		})
	}
	var createdByID *uuid.UUID
	if actor != nil && actor.UserID != uuid.Nil {
		createdByID = &actor.UserID
	}
	row, err := q.CreateStockDoc(ctx, dbgen.CreateStockDocParams{
		DocNo: docNo, Direction: dbDirection(input.Direction), DocDate: pgconv.Date(docDate),
		Summary: pgconv.Text(input.Summary), Remarks: pgconv.Text(input.Remarks),
		CompanyID: input.CompanyID, WarehouseID: input.WarehouseID,
		CreatedByID: createdByID,
	})
	if err != nil {
		return Doc{}, writeError("创建手工出入库单失败", err)
	}
	item := docFromRow(row)
	if err := writeAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(docSnapshot(item), auditedFields)); err != nil {
		return Doc{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Doc{}, writeError("创建手工出入库单失败", err)
	}
	return item, nil
}

func (s *Service) Update(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input UpdateInput,
) (Doc, error) {
	if err := require(actor, "update"); err != nil {
		return Doc{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "更新手工出入库单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	locked, err := q.LockStockDoc(ctx, id)
	if err := lockDocError(err, "更新手工出入库单失败"); err != nil {
		return Doc{}, err
	}
	before := docFromRow(locked)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Doc{}, err
	}
	if before.Status != StatusDraft {
		return Doc{}, draftError()
	}
	after := before
	if input.DocNo != nil {
		after.DocNo = strings.TrimSpace(*input.DocNo)
	}
	if input.Direction != nil && *input.Direction != before.Direction {
		return Doc{}, apierror.Validation("手工出入库单参数不合法", map[string][]string{
			"direction": {"出入库方向不可变更"},
		})
	}
	if input.DocDate != nil {
		after.DocDate = *input.DocDate
	}
	if input.Summary != nil {
		after.Summary = *input.Summary
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if input.WarehouseID != nil {
		after.WarehouseID = *input.WarehouseID
	}
	if err := validateMutable(after); err != nil {
		return Doc{}, err
	}
	if err := validateWarehouse(ctx, q, after.CompanyID, after.WarehouseID); err != nil {
		return Doc{}, err
	}
	changes := audit.Diff(docSnapshot(before), docSnapshot(after), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Doc{}, apierror.Wrap(apierror.CodeInternal, "更新手工出入库单失败", err)
		}
		return before, nil
	}
	row, err := q.UpdateStockDoc(ctx, dbgen.UpdateStockDocParams{
		ID: id, DocNo: after.DocNo, DocDate: pgconv.Date(after.DocDate),
		Summary: pgconv.Text(after.Summary), Remarks: pgconv.Text(after.Remarks),
		WarehouseID: after.WarehouseID,
	})
	if err != nil {
		return Doc{}, writeError("更新手工出入库单失败", err)
	}
	item := docFromRow(row)
	if err := writeAudit(ctx, tx, actor, item, "update", "update", changes); err != nil {
		return Doc{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Doc{}, writeError("更新手工出入库单失败", err)
	}
	return item, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除手工出入库单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockDoc(ctx, id)
	if err := lockDocError(err, "删除手工出入库单失败"); err != nil {
		return err
	}
	item := docFromRow(row)
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return err
	}
	if item.Status != StatusDraft {
		return draftError()
	}
	if _, err := q.DeleteStockDoc(ctx, id); err != nil {
		return writeError("删除手工出入库单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, item, "destroy", "destroy",
		audit.Destroyed(docSnapshot(item), auditedFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除手工出入库单失败", err)
	}
	return nil
}

func (s *Service) Audit(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Doc, error) {
	if err := require(actor, "audit"); err != nil {
		return Doc{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "审核手工出入库单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockDoc(ctx, id)
	if err := lockDocError(err, "审核手工出入库单失败"); err != nil {
		return Doc{}, err
	}
	before := docFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Doc{}, err
	}
	if before.Status != StatusDraft {
		return Doc{}, apierror.New(apierror.CodeConflict, "仅草稿手工出入库单可审核")
	}
	items, err := q.ListStockDocItems(ctx, id)
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "读取手工出入库单行失败", err)
	}
	if len(items) == 0 {
		return Doc{}, apierror.New(apierror.CodeConflict, "审核前必须至少填写一行单据行")
	}
	lines := make([]stock.Line, 0, len(items))
	for _, item := range items {
		quantity := item.BaseQty
		if before.Direction == DirectionOut {
			quantity = quantity.Neg()
		}
		lines = append(lines, stock.Line{
			WarehouseID: before.WarehouseID, MaterialID: item.MaterialID,
			Quantity: quantity, Remarks: before.Summary,
		})
	}
	if err := stock.Post(ctx, tx, stock.Voucher{
		Type: "inv.stock_doc", ID: before.ID, No: before.DocNo,
		CompanyID: before.CompanyID, PostingDate: before.DocDate,
	}, lines); err != nil {
		return Doc{}, err
	}
	now := time.Now().UTC()
	var auditedByID *uuid.UUID
	if actor != nil && actor.UserID != uuid.Nil {
		auditedByID = &actor.UserID
	}
	updated, err := q.AuditStockDoc(ctx, dbgen.AuditStockDocParams{
		ID: id, AuditedAt: pgconv.Timestamp(now), AuditedByID: auditedByID,
	})
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "更新手工出入库单审核状态失败", err)
	}
	after := docFromRow(updated)
	if err := writeAudit(ctx, tx, actor, after, "update", "audit",
		audit.Diff(docSnapshot(before), docSnapshot(after), auditedFields)); err != nil {
		return Doc{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Doc{}, writeError("审核手工出入库单失败", err)
	}
	return after, nil
}

func (s *Service) Void(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Doc, error) {
	if err := require(actor, "void"); err != nil {
		return Doc{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "作废手工出入库单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockDoc(ctx, id)
	if err := lockDocError(err, "作废手工出入库单失败"); err != nil {
		return Doc{}, err
	}
	before := docFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Doc{}, err
	}
	if before.Status != StatusAudited {
		return Doc{}, apierror.New(apierror.CodeConflict, "仅已审核手工出入库单可作废")
	}
	if err := stock.Cancel(ctx, tx, stock.VoucherRef{Type: "inv.stock_doc", ID: id}, time.Now().UTC()); err != nil {
		return Doc{}, err
	}
	updated, err := q.VoidStockDoc(ctx, id)
	if err != nil {
		return Doc{}, apierror.Wrap(apierror.CodeInternal, "更新手工出入库单作废状态失败", err)
	}
	after := docFromRow(updated)
	if err := writeAudit(ctx, tx, actor, after, "update", "void",
		audit.Diff(docSnapshot(before), docSnapshot(after), auditedFields)); err != nil {
		return Doc{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Doc{}, writeError("作废手工出入库单失败", err)
	}
	return after, nil
}

func validateCreate(actor *authz.Actor, input *CreateInput) error {
	if !actor.CanAccessCompany(input.CompanyID) {
		return apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	fields := map[string][]string{}
	if input.Direction != DirectionIn && input.Direction != DirectionOut {
		fields["direction"] = []string{"必须是 IN 或 OUT"}
	}
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if input.WarehouseID == uuid.Nil {
		fields["warehouseId"] = []string{"必填"}
	}
	if input.DocNo != nil && utf8.RuneCountInString(strings.TrimSpace(*input.DocNo)) > 32 {
		fields["docNo"] = []string{"最多 32 个字符"}
	}
	validateOptionalText(fields, "summary", input.Summary, 512)
	validateOptionalText(fields, "remarks", input.Remarks, 512)
	if len(fields) > 0 {
		return apierror.Validation("手工出入库单参数不合法", fields)
	}
	return nil
}

func validateMutable(doc Doc) error {
	fields := map[string][]string{}
	if strings.TrimSpace(doc.DocNo) == "" || utf8.RuneCountInString(doc.DocNo) > 32 {
		fields["docNo"] = []string{"不能为空且最多 32 个字符"}
	}
	if doc.DocDate.IsZero() {
		fields["docDate"] = []string{"必填"}
	}
	validateOptionalText(fields, "summary", doc.Summary, 512)
	validateOptionalText(fields, "remarks", doc.Remarks, 512)
	if len(fields) > 0 {
		return apierror.Validation("手工出入库单参数不合法", fields)
	}
	return nil
}

func validateWarehouse(
	ctx context.Context,
	q *dbgen.Queries,
	companyID uuid.UUID,
	warehouseID uuid.UUID,
) error {
	row, err := q.GetWarehouse(ctx, warehouseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation("手工出入库单参数不合法", map[string][]string{
			"warehouseId": {"仓库不存在"},
		})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	switch {
	case row.CompanyID != companyID:
		return apierror.Validation("手工出入库单参数不合法", map[string][]string{
			"warehouseId": {"仓库不属于本公司"},
		})
	case !row.IsLeaf:
		return apierror.Validation("手工出入库单参数不合法", map[string][]string{
			"warehouseId": {"只有叶子仓库才能发生库存"},
		})
	case !row.Active:
		return apierror.Validation("手工出入库单参数不合法", map[string][]string{
			"warehouseId": {"仓库已停用"},
		})
	}
	return nil
}

func require(actor *authz.Actor, action string) error {
	if actor == nil || !actor.HasPermission("inv.stock_doc:"+action) {
		return apierror.New(apierror.CodeForbidden, "无权执行手工出入库单操作")
	}
	return nil
}

func requireCompany(actor *authz.Actor, companyID uuid.UUID) error {
	if actor == nil || !actor.CanAccessCompany(companyID) {
		return apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	return nil
}

func draftError() error {
	return apierror.New(apierror.CodeConflict, "仅草稿手工出入库单可修改或删除")
}

func lockDocError(err error, message string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "手工出入库单不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, message, err)
	}
	return nil
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Message: "单据编号已存在"},
}

func writeError(message string, err error) error {
	return dberr.MapWrite(err, message, writeMappings...)
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	item Doc,
	actionType string,
	actionName string,
	changes map[string]audit.Change,
) error {
	companyID := item.CompanyID
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_stock_doc", RecordID: item.ID, RecordLabel: item.DocNo,
		ActionType: actionType, ActionName: actionName, CompanyID: &companyID,
		Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入手工出入库单审计失败", err)
	}
	return nil
}

func docSnapshot(item Doc) map[string]any {
	return map[string]any{
		"doc_no": item.DocNo, "direction": item.Direction, "doc_date": item.DocDate,
		"summary": item.Summary, "remarks": item.Remarks, "status": item.Status,
		"audited_at": item.AuditedAt, "company_id": item.CompanyID,
		"warehouse_id": item.WarehouseID, "created_by_id": item.CreatedByID,
		"audited_by_id": item.AuditedByID,
	}
}

func docFromRow(row dbgen.InvStockDoc) Doc {
	return Doc{
		ID: row.ID, DocNo: row.DocNo, Direction: Direction(strings.ToUpper(row.Direction)),
		DocDate: row.DocDate.Time, Summary: pgconv.TextPtr(row.Summary),
		Remarks: pgconv.TextPtr(row.Remarks), Status: Status(strings.ToUpper(row.Status)),
		AuditedAt:  pgconv.OptionalTime(row.AuditedAt),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		CompanyID: row.CompanyID, WarehouseID: row.WarehouseID,
		CreatedByID: row.CreatedByID, AuditedByID: row.AuditedByID,
	}
}

type scanner interface{ Scan(...any) error }

func scanDoc(row scanner) (Doc, error) {
	var raw dbgen.InvStockDoc
	err := row.Scan(
		&raw.ID, &raw.DocNo, &raw.Direction, &raw.DocDate, &raw.Summary, &raw.Remarks,
		&raw.Status, &raw.AuditedAt, &raw.InsertedAt, &raw.UpdatedAt,
		&raw.CompanyID, &raw.WarehouseID, &raw.CreatedByID, &raw.AuditedByID,
	)
	if err != nil {
		return Doc{}, err
	}
	return docFromRow(raw), nil
}

func dbDirection(value Direction) string { return strings.ToLower(string(value)) }

func todayUTC() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

func validateOptionalText(
	fields map[string][]string,
	name string,
	value *string,
	max int,
) {
	if value != nil && utf8.RuneCountInString(*value) > max {
		fields[name] = []string{fmt.Sprintf("最多 %d 个字符", max)}
	}
}
