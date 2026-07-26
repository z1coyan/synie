package stockcount

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
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

func (s *Service) Get(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Count, error) {
	if err := require(actor, "read"); err != nil {
		return Count{}, err
	}
	row, err := dbgen.New(s.pool).GetStockCount(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Count{}, apierror.New(apierror.CodeNotFound, "库存盘点单不存在")
	}
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "读取库存盘点单失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Count{}, apierror.New(apierror.CodeNotFound, "库存盘点单不存在")
	}
	return countFromRow(row), nil
}

func (s *Service) List(ctx context.Context, actor *authz.Actor, query ListQuery) (ListResult, error) {
	if err := require(actor, "read"); err != nil {
		return ListResult{}, err
	}
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return ListResult{}, apierror.Validation("分页参数不合法", map[string][]string{
			"limit": {"必须在 1 到 200 之间"}, "offset": {"不能小于 0"},
		})
	}
	built, err := filterbuild.Build(ResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ListResult{}, err
	}
	where, args := built.Where, append([]any(nil), built.Args...)
	where, args, empty := filterbuild.AppendCompanyFilter(actor, where, args, "company_id")
	if empty {
		return ListResult{Results: []Count{}}, nil
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "doc_no" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	const source = ` FROM inv_stock_count`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询库存盘点单失败", err)
	}
	defer tx.Rollback(ctx)
	var result ListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "统计库存盘点单失败", err)
	}
	listArgs := append([]any(nil), args...)
	limitAt := len(listArgs) + 1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,doc_no,posting_date,summary,remarks,status,
		audited_at,snapshot_taken_at,inserted_at,updated_at,company_id,warehouse_id,
		created_by_id,audited_by_id`+source+where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), listArgs...)
	if err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "查询库存盘点单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Count, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanCount(rows)
		if scanErr != nil {
			return ListResult{}, apierror.Wrap(apierror.CodeInternal, "读取库存盘点单结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历库存盘点单结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, apierror.Wrap(apierror.CodeInternal, "完成库存盘点单查询失败", err)
	}
	return result, nil
}

func (s *Service) Create(
	ctx context.Context,
	actor *authz.Actor,
	input CreateInput,
) (Count, error) {
	if err := require(actor, "create"); err != nil {
		return Count{}, err
	}
	if err := validateCreate(actor, &input); err != nil {
		return Count{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "创建库存盘点单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	if err := validateWarehouse(ctx, q, input.CompanyID, input.WarehouseID); err != nil {
		return Count{}, err
	}
	postingDate := todayUTC()
	if input.PostingDate != nil {
		postingDate = *input.PostingDate
	}
	docNo := ""
	if input.DocNo != nil {
		docNo = strings.TrimSpace(*input.DocNo)
	}
	if docNo == "" {
		docNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: "inv.stock_count",
			Values: map[string]any{
				"company_id":   input.CompanyID,
				"posting_date": postingDate,
			},
		})
		if err != nil {
			return Count{}, err
		}
	}
	if utf8.RuneCountInString(docNo) > 32 {
		return Count{}, apierror.Validation("库存盘点单参数不合法", map[string][]string{
			"docNo": {"最多 32 个字符"},
		})
	}
	snapshotTakenAt := time.Now().UTC()
	var createdByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		createdByID = &actor.UserID
	}
	row, err := q.CreateStockCount(ctx, dbgen.CreateStockCountParams{
		DocNo: docNo, PostingDate: date(postingDate),
		Summary: text(input.Summary), Remarks: text(input.Remarks),
		SnapshotTakenAt: timestamp(snapshotTakenAt), CompanyID: input.CompanyID,
		WarehouseID: input.WarehouseID, CreatedByID: createdByID,
	})
	if err != nil {
		return Count{}, writeError("创建库存盘点单失败", err)
	}
	item := countFromRow(row)
	if err := writeAudit(ctx, tx, actor, item, "create", "create",
		audit.Created(countSnapshot(item), auditedFields)); err != nil {
		return Count{}, err
	}
	if input.LoadAll {
		projections, loadErr := q.ListStockCountLoadAllProjection(
			ctx,
			dbgen.ListStockCountLoadAllProjectionParams{
				CompanyID: input.CompanyID, WarehouseID: input.WarehouseID,
			},
		)
		if loadErr != nil {
			return Count{}, apierror.Wrap(apierror.CodeInternal, "读取库存盘点账面余额失败", loadErr)
		}
		for _, projection := range projections {
			if _, err := createLoadedItemInTx(ctx, tx, actor, item, projection); err != nil {
				return Count{}, err
			}
		}
	} else {
		for _, line := range input.Items {
			line.CountID = item.ID
			if _, err := createItemInTx(ctx, tx, actor, item, line); err != nil {
				return Count{}, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Count{}, writeError("创建库存盘点单失败", err)
	}
	return item, nil
}

func (s *Service) Update(
	ctx context.Context,
	actor *authz.Actor,
	id uuid.UUID,
	input UpdateInput,
) (Count, error) {
	if err := require(actor, "update"); err != nil {
		return Count{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Count{}, apierror.Wrap(apierror.CodeInternal, "更新库存盘点单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockCount(ctx, id)
	if err := lockCountError(err, "锁定库存盘点单失败"); err != nil {
		return Count{}, err
	}
	before := countFromRow(row)
	if err := requireCompany(actor, before.CompanyID); err != nil {
		return Count{}, err
	}
	if before.Status != StatusDraft {
		return Count{}, draftError()
	}
	after := before
	if input.DocNo != nil {
		after.DocNo = strings.TrimSpace(*input.DocNo)
	}
	if input.PostingDate != nil {
		after.PostingDate = *input.PostingDate
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
		return Count{}, err
	}
	if err := validateWarehouse(ctx, q, after.CompanyID, after.WarehouseID); err != nil {
		return Count{}, err
	}
	changes := audit.Diff(countSnapshot(before), countSnapshot(after), auditedFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Count{}, writeError("更新库存盘点单失败", err)
		}
		return before, nil
	}
	updated, err := q.UpdateStockCount(ctx, dbgen.UpdateStockCountParams{
		ID: id, DocNo: after.DocNo, PostingDate: date(after.PostingDate),
		Summary: text(after.Summary), Remarks: text(after.Remarks),
		WarehouseID: after.WarehouseID,
	})
	if err != nil {
		return Count{}, writeError("更新库存盘点单失败", err)
	}
	result := countFromRow(updated)
	if err := writeAudit(ctx, tx, actor, result, "update", "update", changes); err != nil {
		return Count{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Count{}, writeError("更新库存盘点单失败", err)
	}
	return result, nil
}

func (s *Service) Delete(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	if err := require(actor, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除库存盘点单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	row, err := q.LockStockCount(ctx, id)
	if err := lockCountError(err, "锁定库存盘点单失败"); err != nil {
		return err
	}
	item := countFromRow(row)
	if err := requireCompany(actor, item.CompanyID); err != nil {
		return err
	}
	if item.Status != StatusDraft {
		return draftError()
	}
	if _, err := q.DeleteStockCount(ctx, id); err != nil {
		return writeError("删除库存盘点单失败", err)
	}
	if err := writeAudit(ctx, tx, actor, item, "destroy", "destroy",
		audit.Destroyed(countSnapshot(item), auditedFields)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除库存盘点单失败", err)
	}
	return nil
}

func validateCreate(actor *authz.Actor, input *CreateInput) error {
	if !actor.CanAccessCompany(input.CompanyID) {
		return apierror.New(apierror.CodeForbidden, "无权操作该公司数据")
	}
	fields := map[string][]string{}
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"必填"}
	}
	if input.WarehouseID == uuid.Nil {
		fields["warehouseId"] = []string{"必填"}
	}
	if input.LoadAll && len(input.Items) > 0 {
		fields["items"] = []string{"不能与 loadAll 同时提供"}
	}
	if input.DocNo != nil && utf8.RuneCountInString(strings.TrimSpace(*input.DocNo)) > 32 {
		fields["docNo"] = []string{"最多 32 个字符"}
	}
	validateOptionalText(fields, "summary", input.Summary, 512)
	validateOptionalText(fields, "remarks", input.Remarks, 512)
	if len(fields) > 0 {
		return apierror.Validation("库存盘点单参数不合法", fields)
	}
	return nil
}

func validateMutable(item Count) error {
	fields := map[string][]string{}
	if strings.TrimSpace(item.DocNo) == "" || utf8.RuneCountInString(item.DocNo) > 32 {
		fields["docNo"] = []string{"不能为空且最多 32 个字符"}
	}
	if item.PostingDate.IsZero() {
		fields["postingDate"] = []string{"必填"}
	}
	validateOptionalText(fields, "summary", item.Summary, 512)
	validateOptionalText(fields, "remarks", item.Remarks, 512)
	if len(fields) > 0 {
		return apierror.Validation("库存盘点单参数不合法", fields)
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
		return apierror.Validation("库存盘点单参数不合法", map[string][]string{
			"warehouseId": {"仓库不存在"},
		})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	switch {
	case row.CompanyID != companyID:
		return apierror.Validation("库存盘点单参数不合法", map[string][]string{
			"warehouseId": {"仓库不属于本公司"},
		})
	case !row.IsLeaf:
		return apierror.Validation("库存盘点单参数不合法", map[string][]string{
			"warehouseId": {"只有叶子仓库才能发生库存"},
		})
	case !row.Active:
		return apierror.Validation("库存盘点单参数不合法", map[string][]string{
			"warehouseId": {"仓库已停用"},
		})
	}
	return nil
}

func require(actor *authz.Actor, action string) error {
	if actor == nil || !actor.HasPermission("inv.stock_count:"+action) {
		return apierror.New(apierror.CodeForbidden, "无权执行库存盘点单操作")
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
	return apierror.New(apierror.CodeConflict, "仅草稿库存盘点单可修改或删除")
}

func lockCountError(err error, message string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "库存盘点单不存在")
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, message, err)
	}
	return nil
}

func writeError(message string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505", "23503", "23514":
			return apierror.Wrap(apierror.CodeConflict, message, err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, message, err)
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *authz.Actor,
	item Count,
	actionType string,
	actionName string,
	changes map[string]audit.Change,
) error {
	companyID := item.CompanyID
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: "inv_stock_count", RecordID: item.ID, RecordLabel: item.DocNo,
		ActionType: actionType, ActionName: actionName, CompanyID: &companyID,
		Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入库存盘点单审计失败", err)
	}
	return nil
}

func countSnapshot(item Count) map[string]any {
	return map[string]any{
		"doc_no": item.DocNo, "posting_date": item.PostingDate,
		"summary": item.Summary, "remarks": item.Remarks, "status": item.Status,
		"audited_at": item.AuditedAt, "snapshot_taken_at": item.SnapshotTakenAt,
		"company_id": item.CompanyID, "warehouse_id": item.WarehouseID,
		"created_by_id": item.CreatedByID, "audited_by_id": item.AuditedByID,
	}
}

func countFromRow(row dbgen.InvStockCount) Count {
	return Count{
		ID: row.ID, DocNo: row.DocNo, PostingDate: row.PostingDate.Time,
		Summary: optionalText(row.Summary), Remarks: optionalText(row.Remarks),
		Status: statusFromDB(row.Status), AuditedAt: optionalTimestamp(row.AuditedAt),
		SnapshotTakenAt: row.SnapshotTakenAt.Time.UTC(),
		InsertedAt:      row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		CompanyID: row.CompanyID, WarehouseID: row.WarehouseID,
		CreatedByID: row.CreatedByID, AuditedByID: row.AuditedByID,
	}
}

type countScanner interface {
	Scan(...any) error
}

func scanCount(row countScanner) (Count, error) {
	var raw dbgen.InvStockCount
	err := row.Scan(
		&raw.ID, &raw.DocNo, &raw.PostingDate, &raw.Summary, &raw.Remarks,
		&raw.Status, &raw.AuditedAt, &raw.SnapshotTakenAt, &raw.InsertedAt,
		&raw.UpdatedAt, &raw.CompanyID, &raw.WarehouseID, &raw.CreatedByID,
		&raw.AuditedByID,
	)
	if err != nil {
		return Count{}, err
	}
	return countFromRow(raw), nil
}

func statusFromDB(value string) Status {
	return Status(strings.ToUpper(value))
}

func todayUTC() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

func validateOptionalText(fields map[string][]string, key string, value *string, max int) {
	if value != nil && utf8.RuneCountInString(*value) > max {
		fields[key] = []string{fmt.Sprintf("最多 %d 个字符", max)}
	}
}

func date(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value, Valid: true}
}

func timestamp(value time.Time) pgtype.Timestamp {
	return pgtype.Timestamp{Time: value.UTC(), Valid: true}
}

func text(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func optionalText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func optionalTimestamp(value pgtype.Timestamp) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}
