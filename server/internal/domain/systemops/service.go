package systemops

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const (
	auditColumns = `id,inserted_at,resource,record_id,record_label,action_type,
		action_name,actor_id,actor_name,company_id,changes`

	todoDetailColumns = `todo.id,todo.type,todo.source_type,todo.source_id,todo.source_no,
		todo.party_type,todo.party_id,
		CASE todo.party_type
		  WHEN 'customer' THEN COALESCE((SELECT c.name FROM sal_customers c WHERE c.id=todo.party_id),'')
		  WHEN 'supplier' THEN COALESCE((SELECT s.name FROM pur_supplier s WHERE s.id=todo.party_id),'')
		  ELSE ''
		END AS party_name,
		todo.amount,todo.status,todo.closed_reason,todo.source_changed_at,todo.closed_at,
		todo.inserted_at,todo.updated_at,todo.company_id,company.id,company.name,company.short_name,
		todo.created_by_id,created_by.id,created_by.username,created_by.name,
		CASE todo.source_type
		  WHEN 'sales.reconciliation' THEN EXISTS(
		    SELECT 1 FROM acc_vat_invoice invoice
		    WHERE invoice.sal_reconciliation_id=todo.source_id AND invoice.status='draft')
		  WHEN 'purchase.reconciliation' THEN EXISTS(
		    SELECT 1 FROM acc_vat_invoice invoice
		    WHERE invoice.pur_reconciliation_id=todo.source_id AND invoice.status='draft')
		  ELSE false
		END AS draft_invoice_linked,
		state.read_at,state.dismissed_at,
		(state.dismissed_at IS NOT NULL AND state.reset_basis_at IS NOT NULL
		 AND state.reset_basis_at=todo.source_changed_at) AS dismissed`
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) QueryAuditLogs(ctx context.Context, actor *authz.Actor, query ListQuery) (AuditLogList, error) {
	if err := requirePermission(actor, "sys.audit_log:read", "无权限查看操作日志"); err != nil {
		return AuditLogList{}, err
	}
	if query.Limit == 0 {
		query.Limit = 50
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return AuditLogList{}, invalidPagination()
	}
	built, err := filterbuild.Build(AuditLogResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return AuditLogList{}, err
	}
	built.Where, built.Args = addCompanyScope(built.Where, built.Args, actor, true)
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "inserted_at" DESC, "id" DESC`
	} else {
		order += `, "id" DESC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return AuditLogList{}, apierror.Wrap(apierror.CodeInternal, "查询操作日志失败", err)
	}
	defer tx.Rollback(ctx)
	var result AuditLogList
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM sys_audit_log`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计操作日志失败", err)
	}
	args := append([]any(nil), built.Args...)
	n := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT `+auditColumns+` FROM sys_audit_log`+built.Where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", n, n+1), args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询操作日志失败", err)
	}
	defer rows.Close()
	result.Results = make([]AuditLog, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanAuditLog(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取操作日志结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err = rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "读取操作日志结果失败", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "完成操作日志查询失败", err)
	}
	return result, nil
}

func (s *Service) ListAuditLogs(ctx context.Context, actor *authz.Actor, query ListQuery) (AuditLogList, error) {
	return s.QueryAuditLogs(ctx, actor, query)
}

func (s *Service) GetAuditLog(ctx context.Context, actor *authz.Actor, id uuid.UUID) (AuditLog, error) {
	if err := requirePermission(actor, "sys.audit_log:read", "无权限查看操作日志"); err != nil {
		return AuditLog{}, err
	}
	where, args := addCompanyScope(` WHERE id=$1`, []any{id}, actor, true)
	item, err := scanAuditLog(s.pool.QueryRow(ctx, `SELECT `+auditColumns+` FROM sys_audit_log`+where, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return AuditLog{}, apierror.New(apierror.CodeNotFound, "操作日志不存在或无权访问")
	}
	if err != nil {
		return AuditLog{}, apierror.Wrap(apierror.CodeInternal, "读取操作日志失败", err)
	}
	return item, nil
}

func (s *Service) ListTodos(ctx context.Context, actor *authz.Actor, query TodoListQuery) (TodoList, error) {
	if err := requirePermission(actor, "acc.vat_invoice:create", "无权限查看待办"); err != nil {
		return TodoList{}, err
	}
	if query.Limit == 0 {
		query.Limit = 20
	}
	if query.Tab == "recent" {
		query.Limit = 8
	}
	if query.Limit < 1 || query.Limit > 200 || query.Offset < 0 {
		return TodoList{}, invalidPagination()
	}
	built, err := filterbuild.Build(todoQueryMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return TodoList{}, err
	}
	built.Where, built.Args = addCompanyScope(built.Where, built.Args, actor, false)
	switch query.Tab {
	case "active", "recent":
		built.Where, built.Args = addPredicate(built.Where, built.Args, `"status"=$%d`, TodoStatusActive)
	case "history":
		built.Where, built.Args = addPredicate(built.Where, built.Args, `"status"=$%d`, TodoStatusClosed)
	}
	if (query.Tab == "active" || query.Tab == "recent") && !query.IncludeDismissed {
		built.Where, built.Args = addPredicate(built.Where, built.Args, `NOT EXISTS (
			SELECT 1 FROM sys_todo_state dismissed_state
			WHERE dismissed_state.todo_id=sys_todo.id AND dismissed_state.user_id=$%d
			  AND dismissed_state.dismissed_at IS NOT NULL
			  AND dismissed_state.reset_basis_at=sys_todo.source_changed_at)`, actor.UserID)
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY todo.inserted_at DESC, todo.id DESC`
	} else {
		// The built order applies inside the CTE, where columns are unambiguous.
		order = strings.Replace(order, " ORDER BY ", " ORDER BY todo.", 1)
		order = strings.ReplaceAll(order, `, "`, `, todo."`)
		order += `, todo.id DESC`
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return TodoList{}, apierror.Wrap(apierror.CodeInternal, "查询待办失败", err)
	}
	defer tx.Rollback(ctx)
	var result TodoList
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM sys_todo`+built.Where, built.Args...).Scan(&result.Count); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "统计待办失败", err)
	}
	args := append([]any(nil), built.Args...)
	userArg := len(args) + 1
	args = append(args, actor.UserID)
	limitArg := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	sql := `WITH visible AS (SELECT * FROM sys_todo` + built.Where + `)
		SELECT ` + todoDetailColumns + `
		FROM visible todo
		JOIN bas_company company ON company.id=todo.company_id
		LEFT JOIN sys_user created_by ON created_by.id=todo.created_by_id
		LEFT JOIN sys_todo_state state ON state.todo_id=todo.id AND state.user_id=$` + fmt.Sprint(userArg) +
		order + fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitArg, limitArg+1)
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "查询待办失败", err)
	}
	defer rows.Close()
	result.Results = make([]Todo, 0, query.Limit)
	for rows.Next() {
		item, scanErr := scanTodo(rows)
		if scanErr != nil {
			return result, apierror.Wrap(apierror.CodeInternal, "读取待办结果失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err = rows.Err(); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "读取待办结果失败", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return result, apierror.Wrap(apierror.CodeInternal, "完成待办查询失败", err)
	}
	return result, nil
}

func (s *Service) MarkRead(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Todo, error) {
	return s.changeTodoState(ctx, actor, id, false)
}

func (s *Service) Dismiss(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Todo, error) {
	return s.changeTodoState(ctx, actor, id, true)
}

func (s *Service) MarkTodoRead(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Todo, error) {
	return s.MarkRead(ctx, actor, id)
}

func (s *Service) DismissTodo(ctx context.Context, actor *authz.Actor, id uuid.UUID) (Todo, error) {
	return s.Dismiss(ctx, actor, id)
}

func (s *Service) changeTodoState(ctx context.Context, actor *authz.Actor, id uuid.UUID, dismiss bool) (Todo, error) {
	if err := requirePermission(actor, "acc.vat_invoice:create", "无权限操作待办"); err != nil {
		return Todo{}, err
	}
	if actor.UserID == uuid.Nil {
		return Todo{}, apierror.New(apierror.CodeForbidden, "待办操作缺少用户身份")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Todo{}, apierror.Wrap(apierror.CodeInternal, "开始待办事务失败", err)
	}
	defer tx.Rollback(ctx)
	scope := filterbuild.ResolveCompanyScope(actor)
	var sourceChangedAt time.Time
	err = tx.QueryRow(ctx, `SELECT source_changed_at FROM sys_todo
		WHERE id=$1 AND ($2 OR company_id=ANY($3::uuid[])) FOR UPDATE`,
		id, scope.Bypass, scope.CompanyIDs).Scan(&sourceChangedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Todo{}, apierror.New(apierror.CodeNotFound, "待办不存在或无权访问")
	}
	if err != nil {
		return Todo{}, apierror.Wrap(apierror.CodeInternal, "锁定待办失败", err)
	}
	now := time.Now().UTC()
	state := TodoStateInput{TodoID: id, UserID: actor.UserID, ReadAt: &now}
	if dismiss {
		state.DismissedAt = &now
		sourceChangedAt = sourceChangedAt.UTC()
		state.ResetBasisAt = &sourceChangedAt
	}
	if err = UpsertTodoState(ctx, tx, state); err != nil {
		return Todo{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE sys_todo SET updated_at=$2 WHERE id=$1`, id, now); err != nil {
		return Todo{}, apierror.Wrap(apierror.CodeInternal, "更新待办时间失败", err)
	}
	item, err := queryTodoByID(ctx, tx, id, actor.UserID)
	if err != nil {
		return Todo{}, apierror.Wrap(apierror.CodeInternal, "读取待办失败", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return Todo{}, apierror.Wrap(apierror.CodeInternal, "提交待办事务失败", err)
	}
	return item, nil
}

func (s *Service) UnreadCount(ctx context.Context, actor *authz.Actor) (int64, error) {
	// 未读计数是只读语义:不再要求「创建发票」权限,改用发票 read 码
	if err := requirePermission(actor, "acc.vat_invoice:read", "无权限查看待办"); err != nil {
		return 0, err
	}
	scope := filterbuild.ResolveCompanyScope(actor)
	var count int64
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)::bigint
		FROM sys_todo todo
		LEFT JOIN sys_todo_state state ON state.todo_id=todo.id AND state.user_id=$1
		WHERE todo.status='active'
		  AND ($2 OR todo.company_id=ANY($3::uuid[]))
		  AND state.read_at IS NULL
		  AND NOT (state.dismissed_at IS NOT NULL AND state.reset_basis_at IS NOT NULL
		           AND state.reset_basis_at=todo.source_changed_at)
	`, actor.UserID, scope.Bypass, scope.CompanyIDs).Scan(&count)
	if err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "读取待办未读数失败", err)
	}
	return count, nil
}

func (s *Service) UnreadTodoCount(ctx context.Context, actor *authz.Actor) (int64, error) {
	return s.UnreadCount(ctx, actor)
}

// OpenTodo writes inside the caller's transaction. The caller owns commit and
// rollback so the source-state change and materialized todo remain atomic.
func (s *Service) OpenTodo(ctx context.Context, tx pgx.Tx, input OpenTodoInput) (Todo, error) {
	if err := validateOpenTodo(input); err != nil {
		return Todo{}, err
	}
	if input.SourceChangedAt.IsZero() {
		input.SourceChangedAt = time.Now().UTC()
	} else {
		input.SourceChangedAt = input.SourceChangedAt.UTC()
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `
		INSERT INTO sys_todo(type,source_type,source_id,source_no,party_type,party_id,
			amount,status,source_changed_at,company_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10)
		RETURNING id
	`, input.Type, input.SourceType, input.SourceID, input.SourceNo, input.PartyType,
		input.PartyID, input.Amount, input.SourceChangedAt, input.CompanyID, input.CreatedByID).Scan(&id)
	if err != nil {
		return Todo{}, todoWriteError(err)
	}
	item, err := queryTodoByID(ctx, tx, id, uuid.Nil)
	if err != nil {
		return Todo{}, apierror.Wrap(apierror.CodeInternal, "读取新待办失败", err)
	}
	return item, nil
}

// CloseTodos closes every active row for a source inside the caller's
// transaction. Normally the partial unique index means this is zero or one row.
func (s *Service) CloseTodos(ctx context.Context, tx pgx.Tx, sourceType string, sourceID uuid.UUID, reason string) ([]Todo, error) {
	if !validSourceType(sourceType) || sourceID == uuid.Nil || !validClosedReason(reason) {
		return nil, apierror.Validation("关闭待办参数不合法", map[string][]string{
			"source": {"源单类型、ID及关闭原因必须有效"},
		})
	}
	now := time.Now().UTC()
	rows, err := tx.Query(ctx, `UPDATE sys_todo
		SET status='closed',closed_reason=$3,closed_at=$4,updated_at=$4
		WHERE source_type=$1 AND source_id=$2 AND status='active'
		RETURNING id`, sourceType, sourceID, reason, now)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "关闭待办失败", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, apierror.Wrap(apierror.CodeInternal, "读取关闭待办结果失败", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取关闭待办结果失败", err)
	}
	result := make([]Todo, 0, len(ids))
	for _, id := range ids {
		item, queryErr := queryTodoByID(ctx, tx, id, uuid.Nil)
		if queryErr != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取关闭待办失败", queryErr)
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *Service) OpenSalesReconciliationTodo(ctx context.Context, tx pgx.Tx, input OpenTodoInput) (Todo, error) {
	input.Type, input.SourceType = TodoTypeIssueInvoice, SourceSalesReconciliation
	return s.OpenTodo(ctx, tx, input)
}

func (s *Service) OpenPurchaseReconciliationTodo(ctx context.Context, tx pgx.Tx, input OpenTodoInput) (Todo, error) {
	input.Type, input.SourceType = TodoTypeReceiveInvoice, SourcePurchaseReconciliation
	return s.OpenTodo(ctx, tx, input)
}

func (s *Service) CloseSalesReconciliationTodos(ctx context.Context, tx pgx.Tx, sourceID uuid.UUID, reason string) ([]Todo, error) {
	return s.CloseTodos(ctx, tx, SourceSalesReconciliation, sourceID, reason)
}

func (s *Service) ClosePurchaseReconciliationTodos(ctx context.Context, tx pgx.Tx, sourceID uuid.UUID, reason string) ([]Todo, error) {
	return s.CloseTodos(ctx, tx, SourcePurchaseReconciliation, sourceID, reason)
}

func UpsertTodoState(ctx context.Context, tx pgx.Tx, input TodoStateInput) error {
	if input.TodoID == uuid.Nil || input.UserID == uuid.Nil {
		return apierror.Validation("待办痕迹参数不合法", map[string][]string{
			"todoId": {"todoId 与 userId 必填"},
		})
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO sys_todo_state(todo_id,user_id,read_at,dismissed_at,reset_basis_at)
		VALUES($1,$2,$3,$4,$5)
		ON CONFLICT(todo_id,user_id) DO UPDATE SET
		  read_at=COALESCE(EXCLUDED.read_at,sys_todo_state.read_at),
		  dismissed_at=COALESCE(EXCLUDED.dismissed_at,sys_todo_state.dismissed_at),
		  reset_basis_at=COALESCE(EXCLUDED.reset_basis_at,sys_todo_state.reset_basis_at),
		  updated_at=(now() AT TIME ZONE 'utc')
	`, input.TodoID, input.UserID, input.ReadAt, input.DismissedAt, input.ResetBasisAt)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "保存待办痕迹失败", err)
	}
	return nil
}

func (s *Service) UpsertTodoState(ctx context.Context, tx pgx.Tx, input TodoStateInput) error {
	return UpsertTodoState(ctx, tx, input)
}

func (s *Service) StateUpsert(ctx context.Context, tx pgx.Tx, input TodoStateInput) error {
	return UpsertTodoState(ctx, tx, input)
}

func queryTodoByID(ctx context.Context, tx pgx.Tx, id, userID uuid.UUID) (Todo, error) {
	return scanTodo(tx.QueryRow(ctx, `SELECT `+todoDetailColumns+`
		FROM sys_todo todo
		JOIN bas_company company ON company.id=todo.company_id
		LEFT JOIN sys_user created_by ON created_by.id=todo.created_by_id
		LEFT JOIN sys_todo_state state ON state.todo_id=todo.id AND state.user_id=$2
		WHERE todo.id=$1`, id, userID))
}

type rowScanner interface{ Scan(dest ...any) error }

func scanAuditLog(row rowScanner) (AuditLog, error) {
	var item AuditLog
	err := row.Scan(&item.ID, &item.InsertedAt, &item.Resource, &item.RecordID,
		&item.RecordLabel, &item.ActionType, &item.ActionName, &item.ActorID,
		&item.ActorName, &item.CompanyID, &item.Changes)
	item.InsertedAt = item.InsertedAt.UTC()
	return item, err
}

func scanTodo(row rowScanner) (Todo, error) {
	var item Todo
	var createdByID *uuid.UUID
	var createdByUsername, createdByName *string
	err := row.Scan(&item.ID, &item.Type, &item.SourceType, &item.SourceID, &item.SourceNo,
		&item.PartyType, &item.PartyID, &item.PartyName, &item.Amount, &item.Status,
		&item.ClosedReason, &item.SourceChangedAt, &item.ClosedAt, &item.InsertedAt,
		&item.UpdatedAt, &item.CompanyID, &item.Company.ID, &item.Company.Name,
		&item.Company.ShortName, &item.CreatedByID, &createdByID, &createdByUsername,
		&createdByName, &item.DraftInvoiceLinked,
		&item.MyReadAt, &item.MyDismissedAt, &item.Dismissed)
	if err != nil {
		return Todo{}, err
	}
	item.SourceChangedAt = item.SourceChangedAt.UTC()
	item.InsertedAt, item.UpdatedAt = item.InsertedAt.UTC(), item.UpdatedAt.UTC()
	item.Type = strings.ToUpper(item.Type)
	item.PartyType = strings.ToUpper(item.PartyType)
	item.Status = strings.ToUpper(item.Status)
	if item.ClosedReason != nil {
		value := strings.ToUpper(*item.ClosedReason)
		item.ClosedReason = &value
	}
	if createdByID != nil && createdByUsername != nil {
		item.CreatedBy = &TodoUser{ID: *createdByID, Username: *createdByUsername, Name: createdByName}
	}
	utcTimePtr(item.ClosedAt)
	utcTimePtr(item.MyReadAt)
	utcTimePtr(item.MyDismissedAt)
	return item, nil
}

func utcTimePtr(value *time.Time) {
	if value != nil {
		*value = value.UTC()
	}
}

func addCompanyScope(where string, args []any, actor *authz.Actor, allowGlobal bool) (string, []any) {
	scope := filterbuild.ResolveCompanyScope(actor)
	if scope.Bypass {
		return where, args
	}
	if allowGlobal {
		if scope.Empty {
			return addPredicate(where, args, `"company_id" IS NULL`)
		}
		return addPredicate(where, args, `("company_id" IS NULL OR "company_id"=ANY($%d::uuid[]))`, scope.CompanyIDs)
	}
	if scope.Empty {
		return addPredicate(where, args, `false`)
	}
	return addPredicate(where, args, `"company_id"=ANY($%d::uuid[])`, scope.CompanyIDs)
}

func addPredicate(where string, args []any, format string, values ...any) (string, []any) {
	clause := format
	for _, value := range values {
		args = append(args, value)
		clause = fmt.Sprintf(clause, len(args))
	}
	if where == "" {
		return " WHERE " + clause, args
	}
	return where + " AND " + clause, args
}

func requirePermission(actor *authz.Actor, permission, message string) error {
	if actor == nil || !actor.HasPermission(permission) {
		return apierror.New(apierror.CodeForbidden, message)
	}
	return nil
}

func invalidPagination() error {
	return apierror.Validation("分页参数不合法", map[string][]string{
		"limit": {"必须在 1 到 200 之间且 offset 不能为负数"},
	})
}

func validateOpenTodo(input OpenTodoInput) error {
	fields := map[string][]string{}
	if input.Type != TodoTypeIssueInvoice && input.Type != TodoTypeReceiveInvoice {
		fields["type"] = []string{"仅支持 issue_invoice/receive_invoice"}
	}
	if !validSourceType(input.SourceType) {
		fields["sourceType"] = []string{"源单类型不合法"}
	}
	if input.SourceID == uuid.Nil {
		fields["sourceId"] = []string{"不能为空"}
	}
	if input.CompanyID == uuid.Nil {
		fields["companyId"] = []string{"不能为空"}
	}
	if input.PartyID == uuid.Nil || (input.PartyType != "customer" && input.PartyType != "supplier") {
		fields["partyId"] = []string{"对手类型及ID必须有效"}
	}
	if strings.TrimSpace(input.SourceNo) == "" || len([]rune(input.SourceNo)) > 64 {
		fields["sourceNo"] = []string{"不能为空且最多 64 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation("新建待办参数不合法", fields)
	}
	return nil
}

func validSourceType(value string) bool {
	return value == SourceSalesReconciliation || value == SourcePurchaseReconciliation
}

func validClosedReason(value string) bool {
	return value == TodoClosedByUnconfirm || value == TodoClosedByInvoiceAudit
}

func todoWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apierror.Wrap(apierror.CodeConflict, "源单已有活跃待办", err)
		case "23503":
			return apierror.Wrap(apierror.CodeValidation, "待办引用不存在", err)
		}
	}
	return apierror.Wrap(apierror.CodeInternal, "保存待办失败", err)
}
