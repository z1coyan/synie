package quotation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
)

var quotationAuditFields = []string{
	"quotation_no", "quotation_date", "valid_until", "party_type", "party_id",
	"terms", "remarks", "status", "audited_at", "company_id", "currency_id",
	"created_by_id", "audited_by_id",
}

func (s *Service) CreateQuotation(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	input CreateQuotationInput,
) (Quotation, error) {
	spec, err := specFor(side)
	if err != nil {
		return Quotation{}, err
	}
	if err := require(actor, spec, "create"); err != nil {
		return Quotation{}, err
	}
	if !actor.CanAccessCompany(input.CompanyID) {
		return Quotation{}, apierror.New(apierror.CodeForbidden, "无权在该公司下操作数据")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "创建报价单失败", err)
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	company, err := q.GetTradingQuotationCompany(ctx, input.CompanyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Quotation{}, apierror.Validation("报价参数不合法", map[string][]string{"companyId": {"公司不存在"}})
	}
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "读取报价公司失败", err)
	}
	currencyID := company.BaseCurrencyID
	if input.CurrencyID != nil {
		currencyID = *input.CurrencyID
	}
	quotationDate := time.Now().UTC()
	if input.QuotationDate != nil {
		quotationDate = *input.QuotationDate
	}
	quotationNo := ""
	if input.QuotationNo != nil {
		quotationNo = strings.TrimSpace(*input.QuotationNo)
	}
	if quotationNo == "" {
		quotationNo, err = s.numberer.NextInTx(ctx, tx, numbering.NextInput{
			Resource: spec.prefix,
			Values: map[string]any{
				"company_id": input.CompanyID, "quotation_date": quotationDate,
				"valid_until": input.ValidUntil, "party_type": strings.ToLower(input.PartyType),
				"party_id": input.PartyID, "currency_id": currencyID,
			},
		})
		if err != nil {
			return Quotation{}, err
		}
	}
	partyType := strings.ToLower(strings.TrimSpace(input.PartyType))
	if err := validateQuotationShape(
		spec, quotationNo, date(quotationDate), date(input.ValidUntil), partyType,
		input.PartyID, input.CompanyID, currencyID, input.Remarks,
	); err != nil {
		return Quotation{}, err
	}
	if err := validateParty(ctx, q, partyType, input.PartyID); err != nil {
		return Quotation{}, err
	}
	var createdByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		createdByID = &actor.UserID
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO `+spec.headTable+` (
		quotation_no,quotation_date,valid_until,party_type,party_id,terms,remarks,
		company_id,currency_id,created_by_id
	) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
		quotationNo, date(quotationDate), date(input.ValidUntil), partyType, input.PartyID,
		text(input.Terms), text(input.Remarks), input.CompanyID, currencyID, createdByID,
	).Scan(&id)
	if err != nil {
		return Quotation{}, writeError("创建报价单失败", err)
	}
	row, err := scanQuotationRow(tx.QueryRow(ctx, quotationSelect(spec)+" WHERE q.id=$1", id))
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "读取新建报价单失败", err)
	}
	item := quotationFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.headAuditResource, id, quotationNo,
		"create", "create", item.CompanyID,
		audit.Created(quotationSnapshot(item), quotationAuditFields)); err != nil {
		return Quotation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Quotation{}, writeError("创建报价单失败", err)
	}
	return item, nil
}

func (s *Service) UpdateQuotation(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	id uuid.UUID,
	input UpdateQuotationInput,
) (Quotation, error) {
	spec, err := specFor(side)
	if err != nil {
		return Quotation{}, err
	}
	if err := require(actor, spec, "update"); err != nil {
		return Quotation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "更新报价单失败", err)
	}
	defer tx.Rollback(ctx)
	locked, err := lockDraftQuotation(ctx, tx, spec, actor, id, "")
	if err != nil {
		return Quotation{}, err
	}
	before := quotationFromRow(locked)
	after := before
	if input.QuotationNo != nil {
		after.QuotationNo = strings.TrimSpace(*input.QuotationNo)
	}
	if input.QuotationDate != nil {
		after.QuotationDate = *input.QuotationDate
	}
	if input.ValidUntil != nil {
		after.ValidUntil = *input.ValidUntil
	}
	if input.PartyType != nil {
		after.PartyType = strings.ToUpper(strings.TrimSpace(*input.PartyType))
	}
	if input.PartyID != nil {
		after.PartyID = *input.PartyID
	}
	if input.CurrencyID != nil {
		after.CurrencyID = *input.CurrencyID
	}
	if input.Terms != nil {
		after.Terms = *input.Terms
	}
	if input.Remarks != nil {
		after.Remarks = *input.Remarks
	}
	headChanged := strings.ToLower(after.PartyType) != locked.PartyType ||
		after.PartyID != locked.PartyID || after.CurrencyID != locked.CurrencyID
	if headChanged {
		var hasItems bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM `+spec.itemTable+
			` WHERE quotation_id=$1)`, id).Scan(&hasItems); err != nil {
			return Quotation{}, apierror.Wrap(apierror.CodeInternal, "检查报价条目失败", err)
		}
		if hasItems {
			return Quotation{}, apierror.New(apierror.CodeConflict, "请先删除报价条目")
		}
	}
	if err := validateQuotationShape(
		spec, after.QuotationNo, date(after.QuotationDate), date(after.ValidUntil),
		strings.ToLower(after.PartyType), after.PartyID, after.CompanyID,
		after.CurrencyID, after.Remarks,
	); err != nil {
		return Quotation{}, err
	}
	if err := validateParty(ctx, dbgen.New(tx), after.PartyType, after.PartyID); err != nil {
		return Quotation{}, err
	}
	changes := audit.Diff(quotationSnapshot(before), quotationSnapshot(after), quotationAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return Quotation{}, writeError("更新报价单失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.headTable+` SET
		quotation_no=$2,quotation_date=$3,valid_until=$4,party_type=$5,party_id=$6,
		currency_id=$7,terms=$8,remarks=$9,updated_at=(now() AT TIME ZONE 'utc')
		WHERE id=$1`,
		id, after.QuotationNo, date(after.QuotationDate), date(after.ValidUntil),
		strings.ToLower(after.PartyType), after.PartyID, after.CurrencyID,
		text(after.Terms), text(after.Remarks),
	)
	if err != nil {
		return Quotation{}, writeError("更新报价单失败", err)
	}
	row, err := scanQuotationRow(tx.QueryRow(ctx, quotationSelect(spec)+" WHERE q.id=$1", id))
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "读取更新后报价单失败", err)
	}
	item := quotationFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.headAuditResource, id, item.QuotationNo,
		"update", "update", item.CompanyID, changes); err != nil {
		return Quotation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Quotation{}, writeError("更新报价单失败", err)
	}
	return item, nil
}

func (s *Service) DeleteQuotation(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) error {
	spec, err := specFor(side)
	if err != nil {
		return err
	}
	if err := require(actor, spec, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除报价单失败", err)
	}
	defer tx.Rollback(ctx)
	locked, err := lockDraftQuotation(ctx, tx, spec, actor, id, "")
	if err != nil {
		return err
	}
	item := quotationFromRow(locked)
	if err := writeAudit(ctx, tx, actor, spec.headAuditResource, id, item.QuotationNo,
		"destroy", "destroy", item.CompanyID,
		audit.Destroyed(quotationSnapshot(item), quotationAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+spec.headTable+` WHERE id=$1`, id); err != nil {
		return writeError("删除报价单失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError("删除报价单失败", err)
	}
	return nil
}

func (s *Service) AuditQuotation(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	id uuid.UUID,
) (Quotation, error) {
	spec, err := specFor(side)
	if err != nil {
		return Quotation{}, err
	}
	if err := require(actor, spec, "audit"); err != nil {
		return Quotation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "审核报价单失败", err)
	}
	defer tx.Rollback(ctx)
	locked, err := lockQuotation(ctx, tx, spec, actor, id)
	if err != nil {
		return Quotation{}, err
	}
	if locked.Status != "draft" {
		return Quotation{}, apierror.New(apierror.CodeConflict, "仅草稿报价单可审核")
	}
	var itemCount int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+spec.itemTable+
		` WHERE quotation_id=$1`, id).Scan(&itemCount); err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "检查报价条目失败", err)
	}
	if itemCount == 0 {
		return Quotation{}, apierror.New(apierror.CodeConflict, "审核前必须至少填写一行条目")
	}
	var missingTier bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM `+spec.itemTable+` i
		WHERE i.quotation_id=$1 AND i.pricing_mode='qty_tiered'
		  AND NOT EXISTS(SELECT 1 FROM `+spec.tierTable+` t WHERE t.item_id=i.id)
	)`, id).Scan(&missingTier); err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "检查报价价格档失败", err)
	}
	if missingTier {
		return Quotation{}, apierror.New(apierror.CodeConflict, "数量梯度条目必须至少填写一个价格档")
	}
	before := quotationFromRow(locked)
	now := time.Now().UTC()
	var auditedByID *uuid.UUID
	if actor.UserID != uuid.Nil {
		auditedByID = &actor.UserID
	}
	if _, err := tx.Exec(ctx, `UPDATE `+spec.headTable+` SET status='audited',
		audited_at=$2,audited_by_id=$3,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, pgtype.Timestamp{Time: now, Valid: true}, auditedByID); err != nil {
		return Quotation{}, writeError("审核报价单失败", err)
	}
	row, err := scanQuotationRow(tx.QueryRow(ctx, quotationSelect(spec)+" WHERE q.id=$1", id))
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "读取审核后报价单失败", err)
	}
	item := quotationFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.headAuditResource, id, item.QuotationNo,
		"update", "audit", item.CompanyID,
		audit.Diff(quotationSnapshot(before), quotationSnapshot(item), quotationAuditFields)); err != nil {
		return Quotation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Quotation{}, writeError("审核报价单失败", err)
	}
	return item, nil
}

func (s *Service) VoidQuotation(
	ctx context.Context,
	actor *authz.Actor,
	side Side,
	id uuid.UUID,
) (Quotation, error) {
	spec, err := specFor(side)
	if err != nil {
		return Quotation{}, err
	}
	if err := require(actor, spec, "void"); err != nil {
		return Quotation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "作废报价单失败", err)
	}
	defer tx.Rollback(ctx)
	locked, err := lockQuotation(ctx, tx, spec, actor, id)
	if err != nil {
		return Quotation{}, err
	}
	if locked.Status != "audited" {
		return Quotation{}, apierror.New(apierror.CodeConflict, "仅已审核报价单可作废")
	}
	before := quotationFromRow(locked)
	if _, err := tx.Exec(ctx, `UPDATE `+spec.headTable+` SET status='voided',
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id); err != nil {
		return Quotation{}, writeError("作废报价单失败", err)
	}
	row, err := scanQuotationRow(tx.QueryRow(ctx, quotationSelect(spec)+" WHERE q.id=$1", id))
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "读取作废后报价单失败", err)
	}
	item := quotationFromRow(row)
	if err := writeAudit(ctx, tx, actor, spec.headAuditResource, id, item.QuotationNo,
		"update", "void", item.CompanyID,
		audit.Diff(quotationSnapshot(before), quotationSnapshot(item), quotationAuditFields)); err != nil {
		return Quotation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Quotation{}, writeError("作废报价单失败", err)
	}
	return item, nil
}

func quotationSnapshot(item Quotation) map[string]any {
	return map[string]any{
		"quotation_no": item.QuotationNo, "quotation_date": item.QuotationDate,
		"valid_until": item.ValidUntil, "party_type": strings.ToLower(item.PartyType),
		"party_id": item.PartyID, "terms": item.Terms, "remarks": item.Remarks,
		"status": strings.ToLower(string(item.Status)), "audited_at": item.AuditedAt,
		"company_id": item.CompanyID, "currency_id": item.CurrencyID,
		"created_by_id": item.CreatedByID, "audited_by_id": item.AuditedByID,
	}
}

func rawQuotationByID(ctx context.Context, tx pgx.Tx, spec sideSpec, id uuid.UUID) (Quotation, error) {
	row, err := scanQuotationRow(tx.QueryRow(ctx, quotationSelect(spec)+" WHERE q.id=$1", id))
	if err != nil {
		return Quotation{}, fmt.Errorf("read quotation: %w", err)
	}
	return quotationFromRow(row), nil
}
