package reconciliation

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) GetHead(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return Head{}, err
	}
	item, err := queryHead(ctx, s.pool, spec, id, false)
	if err != nil {
		return Head{}, err
	}
	if err := requireCompany(actor, item.CompanyID, spec.label); err != nil {
		return Head{}, err
	}
	return item, nil
}

func (s *Service) ListHeads(
	ctx context.Context, actor *authz.Actor, side Side, query ListQuery,
) (HeadList, error) {
	spec, err := specFor(side)
	if err != nil {
		return HeadList{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return HeadList{}, err
	}
	if err := validatePage(&query); err != nil {
		return HeadList{}, err
	}
	built, err := filterbuild.Build(HeadResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return HeadList{}, err
	}
	where, args := scopedWhere(actor, built.Where, append([]any(nil), built.Args...))
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "inserted_at" DESC,"id" DESC`
	} else {
		orderBy += `,"id" DESC`
	}
	source := headListSource(spec)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return HeadList{}, apierror.Wrap(apierror.CodeInternal, "查询"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	var result HeadList
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)`+source+where, args...).
		Scan(&result.Count); err != nil {
		return HeadList{}, apierror.Wrap(apierror.CodeInternal, "统计"+spec.label+"失败", err)
	}
	limitAt := len(args) + 1
	args = append(args, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, headListSelect()+source+where+orderBy+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), args...)
	if err != nil {
		return HeadList{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.label+"失败", err)
	}
	defer rows.Close()
	for rows.Next() {
		item, scanErr := scanHead(rows)
		if scanErr != nil {
			return HeadList{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.label+"失败", scanErr)
		}
		result.Results = append(result.Results, item)
	}
	if err := rows.Err(); err != nil {
		return HeadList{}, apierror.Wrap(apierror.CodeInternal, "读取"+spec.label+"失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return HeadList{}, apierror.Wrap(apierror.CodeInternal, "完成"+spec.label+"查询失败", err)
	}
	return result, nil
}

func scopedWhere(actor *authz.Actor, where string, args []any) (string, []any) {
	return filterbuild.ApplyCompanyFilter(actor, where, args, "company_id")
}

func headListSelect() string {
	return `SELECT id,reconciliation_no,reconciliation_type,party_type,party_id,
		posting_date,remarks,status,inserted_at,updated_at,company_id,
		debit_account_id,credit_account_id,created_by_id,gross_total,base_gross_total`
}

func headListSource(spec sideSpec) string {
	return ` FROM (SELECT h.id,h.reconciliation_no,h.reconciliation_type,h.party_type,
		h.party_id,h.posting_date,h.remarks,h.status,h.inserted_at,h.updated_at,
		h.company_id,h.debit_account_id,h.credit_account_id,h.created_by_id,
		COALESCE(SUM(i.amount),0) AS gross_total,
		COALESCE(SUM(i.base_amount),0) AS base_gross_total
		FROM ` + spec.table + ` h LEFT JOIN ` + spec.itemTable +
		` i ON i.reconciliation_id=h.id GROUP BY h.id) reconciliations`
}

func (s *Service) UpdateHead(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID, input UpdateHeadInput,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "update"); err != nil {
		return Head{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "更新"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockHead(ctx, tx, actor, spec, id)
	if err != nil {
		return Head{}, err
	}
	if before.Status != StatusDraft {
		return Head{}, apierror.New(apierror.CodeConflict, "仅草稿"+spec.label+"可修改")
	}
	after := before
	if input.No != nil {
		after.No = strings.TrimSpace(*input.No)
	}
	if input.Kind != nil && *input.Kind != before.Kind {
		return Head{}, apierror.New(apierror.CodeConflict, "对账类型不可变更")
	}
	partyChanged := false
	if input.PartyType != nil {
		after.PartyType = strings.ToLower(strings.TrimSpace(*input.PartyType))
		partyChanged = after.PartyType != before.PartyType
	}
	if input.PartyID != nil {
		after.PartyID = *input.PartyID
		partyChanged = partyChanged || after.PartyID != before.PartyID
	}
	if input.DebitAccountID != nil {
		after.DebitAccountID = *input.DebitAccountID
	}
	if input.CreditAccountID != nil {
		after.CreditAccountID = *input.CreditAccountID
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	if partyChanged {
		var has bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM `+spec.itemTable+
			` WHERE reconciliation_id=$1)`, id).Scan(&has); err != nil {
			return Head{}, apierror.Wrap(apierror.CodeInternal, "检查对账条目失败", err)
		}
		if has {
			return Head{}, apierror.New(apierror.CodeConflict, "请先删除对账条目")
		}
	}
	createShape := CreateHeadInput{
		CompanyID: after.CompanyID, No: &after.No, Kind: after.Kind,
		PartyType: after.PartyType, PartyID: after.PartyID,
		DebitAccountID: after.DebitAccountID, CreditAccountID: after.CreditAccountID,
		Remarks: after.Remarks,
	}
	if err := validateHeadShape(spec, createShape); err != nil {
		return Head{}, err
	}
	if err := validateReferences(ctx, tx, spec, after.CompanyID, after.PartyType,
		after.PartyID, after.DebitAccountID, after.CreditAccountID); err != nil {
		return Head{}, err
	}
	changes := audit.Diff(headSnapshot(before), headSnapshot(after), headAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Head{}, writeError("更新"+spec.label+"失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.table+` SET reconciliation_no=$2,
		party_type=$3,party_id=$4,debit_account_id=$5,credit_account_id=$6,
		remarks=$7,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.No, after.PartyType, after.PartyID, after.DebitAccountID,
		after.CreditAccountID, pgconv.OptionalText(after.Remarks))
	if err != nil {
		return Head{}, writeError("更新"+spec.label+"失败", err)
	}
	result, err := queryHead(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, err
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: spec.table, RecordID: id, RecordLabel: result.No,
		ActionType: "update", ActionName: "update", CompanyID: &result.CompanyID,
		Changes: changes,
	}); err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "更新"+spec.label+"失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Head{}, writeError("更新"+spec.label+"失败", err)
	}
	return result, nil
}

func (s *Service) DeleteHead(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) error {
	spec, err := specFor(side)
	if err != nil {
		return err
	}
	if err := require(actor, spec, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除"+spec.label+"失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockHead(ctx, tx, actor, spec, id)
	if err != nil {
		return err
	}
	if before.Status != StatusDraft {
		return apierror.New(apierror.CodeConflict, "仅草稿"+spec.label+"可删除")
	}
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: spec.table, RecordID: id, RecordLabel: before.No,
		ActionType: "destroy", ActionName: "destroy", CompanyID: &before.CompanyID,
		Changes: audit.Destroyed(headSnapshot(before), headAuditFields),
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除"+spec.label+"失败", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.table+` WHERE id=$1`, id); err != nil {
		return writeError("删除"+spec.label+"失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除"+spec.label+"失败", err)
	}
	return nil
}

func lockHead(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, spec sideSpec, id uuid.UUID,
) (Head, error) {
	var companyID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT company_id FROM `+spec.table+` WHERE id=$1 FOR UPDATE`, id).
		Scan(&companyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Head{}, apierror.New(apierror.CodeNotFound, spec.label+"不存在")
	}
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "锁定"+spec.label+"失败", err)
	}
	if err := requireCompany(actor, companyID, spec.label); err != nil {
		return Head{}, err
	}
	return queryHead(ctx, tx, spec, id, false)
}
