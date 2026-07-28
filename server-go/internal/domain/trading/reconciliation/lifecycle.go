package reconciliation

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/engines/gl"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func (s *Service) Confirm(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "confirm"); err != nil {
		return Head{}, err
	}
	return s.changeState(ctx, actor, spec, id, StatusDraft, StatusConfirmed,
		KindRegular, "confirm", func(tx pgx.Tx, before Head) error {
			if err := s.adjustProjection(ctx, tx, spec, before.ID, decimal.NewFromInt(1)); err != nil {
				return err
			}
			return openTodo(ctx, tx, spec, before, actorID(actor))
		})
}

func (s *Service) Unconfirm(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "unconfirm"); err != nil {
		return Head{}, err
	}
	return s.changeState(ctx, actor, spec, id, StatusConfirmed, StatusDraft,
		KindRegular, "unconfirm", func(tx pgx.Tx, before Head) error {
			var linked bool
			column := "sal_reconciliation_id"
			if spec.side == "purchase" {
				column = "pur_reconciliation_id"
			}
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM acc_vat_invoice
				WHERE `+column+`=$1)`, before.ID).Scan(&linked); err != nil {
				return apierror.Wrap(apierror.CodeInternal, "检查关联发票失败", err)
			}
			if linked {
				return apierror.New(apierror.CodeConflict, "已关联发票，不可撤回确认")
			}
			if err := s.adjustProjection(ctx, tx, spec, before.ID, decimal.NewFromInt(-1)); err != nil {
				return err
			}
			return closeTodos(ctx, tx, spec, before.ID, "unconfirm")
		})
}

func (s *Service) Audit(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID, input AuditInput,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "audit"); err != nil {
		return Head{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "结单审核失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockHead(ctx, tx, actor, spec, id)
	if err != nil {
		return Head{}, err
	}
	if before.Kind != KindGiftSample || before.Status != StatusDraft {
		return Head{}, apierror.New(apierror.CodeConflict, "仅草稿赠送/样品对账单可结单审核")
	}
	if err := requireItems(ctx, tx, spec, id); err != nil {
		return Head{}, err
	}
	if err := s.adjustProjection(ctx, tx, spec, id, decimal.NewFromInt(1)); err != nil {
		return Head{}, err
	}
	posting := input.PostingDate
	if posting == nil {
		today := time.Now().UTC()
		posting = &today
	}
	if before.BaseGrossTotal.GreaterThan(decimal.Zero) {
		if err := postGiftGL(ctx, tx, spec, before, *posting); err != nil {
			return Head{}, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE `+spec.table+` SET status='closed',
		posting_date=$2,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, date(posting))
	if err != nil {
		return Head{}, writeError("结单审核失败", err)
	}
	result, err := queryHead(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, err
	}
	if err := writeStateAudit(ctx, tx, actor, spec, before, result, "audit"); err != nil {
		return Head{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Head{}, writeError("结单审核失败", err)
	}
	return result, nil
}

func (s *Service) Void(
	ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	if err := require(actor, spec, "void"); err != nil {
		return Head{}, err
	}
	return s.changeState(ctx, actor, spec, id, StatusClosed, StatusVoided,
		KindGiftSample, "void", func(tx pgx.Tx, before Head) error {
			if err := gl.Cancel(ctx, tx, gl.VoucherRef{
				Type: spec.voucher, ID: before.ID,
			}); err != nil {
				return err
			}
			return s.adjustProjection(ctx, tx, spec, before.ID, decimal.NewFromInt(-1))
		})
}

type stateEffect func(pgx.Tx, Head) error

func (s *Service) changeState(
	ctx context.Context, actor *authz.Actor, spec sideSpec, id uuid.UUID,
	from, to Status, kind Kind, action string, effect stateEffect,
) (Head, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Head{}, apierror.Wrap(apierror.CodeInternal, "执行对账动作失败", err)
	}
	defer tx.Rollback(ctx)
	before, err := lockHead(ctx, tx, actor, spec, id)
	if err != nil {
		return Head{}, err
	}
	if before.Status != from || before.Kind != kind {
		return Head{}, apierror.New(apierror.CodeConflict, "对账单当前状态不允许执行该动作")
	}
	if to == StatusConfirmed || (to == StatusClosed && kind == KindGiftSample) {
		if err := requireItems(ctx, tx, spec, id); err != nil {
			return Head{}, err
		}
	}
	if err := effect(tx, before); err != nil {
		return Head{}, err
	}
	tag, err := tx.Exec(ctx, `UPDATE `+spec.table+` SET status=$2,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1 AND status=$3`, id, to, from)
	if err != nil {
		return Head{}, writeError("执行对账动作失败", err)
	}
	if tag.RowsAffected() != 1 {
		return Head{}, apierror.New(apierror.CodeConflict, "对账单已被并发处理")
	}
	result, err := queryHead(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, err
	}
	if err := writeStateAudit(ctx, tx, actor, spec, before, result, action); err != nil {
		return Head{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Head{}, writeError("执行对账动作失败", err)
	}
	return result, nil
}

func requireItems(ctx context.Context, tx pgx.Tx, spec sideSpec, id uuid.UUID) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM `+spec.itemTable+
		` WHERE reconciliation_id=$1)`, id).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "检查对账条目失败", err)
	}
	if !exists {
		return apierror.New(apierror.CodeConflict, "生效前必须至少填写一行对账条目")
	}
	return nil
}

type projection struct {
	id         uuid.UUID
	delta      decimal.Decimal
	outsourced bool
	idx        int64
}

func (s *Service) adjustProjection(
	ctx context.Context, tx pgx.Tx, spec sideSpec, id uuid.UUID, direction decimal.Decimal,
) error {
	query := `SELECT delivery_item_id,SUM(base_qty),false,MIN(idx)
		FROM sal_reconciliation_item WHERE reconciliation_id=$1
		GROUP BY delivery_item_id`
	if spec.side == "purchase" {
		query = `SELECT COALESCE(receipt_item_id,outsourced_receipt_item_id),
			SUM(base_qty),(outsourced_receipt_item_id IS NOT NULL),MIN(idx)
			FROM pur_reconciliation_item WHERE reconciliation_id=$1
			GROUP BY receipt_item_id,outsourced_receipt_item_id`
	}
	rows, err := tx.Query(ctx, query, id)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取对账投影失败", err)
	}
	var values []projection
	for rows.Next() {
		var value projection
		if err := rows.Scan(&value.id, &value.delta, &value.outsourced, &value.idx); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取对账投影失败", err)
		}
		value.delta = value.delta.Mul(direction)
		values = append(values, value)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取对账投影失败", err)
	}
	sort.Slice(values, func(i, j int) bool { return values[i].id.String() < values[j].id.String() })
	for _, value := range values {
		if value.outsourced {
			var receiptID uuid.UUID
			if err := tx.QueryRow(ctx, `SELECT receipt_id FROM pur_outsourced_receipt_item
				WHERE id=$1`, value.id).Scan(&receiptID); err != nil {
				return apierror.Wrap(apierror.CodeInternal, "读取委外对账父单失败", err)
			}
			var status string
			if err := tx.QueryRow(ctx, `SELECT status FROM pur_outsourced_receipt
				WHERE id=$1 FOR UPDATE`, receiptID).Scan(&status); err != nil {
				return apierror.Wrap(apierror.CodeInternal, "锁定委外对账父单失败", err)
			}
			if status != "audited" {
				return apierror.New(apierror.CodeConflict, "仅已审核委外入库行可对账")
			}
			var baseQty, current decimal.Decimal
			if err := tx.QueryRow(ctx, `SELECT base_qty,reconciled_qty
				FROM pur_outsourced_receipt_item WHERE id=$1 FOR UPDATE`, value.id).
				Scan(&baseQty, &current); err != nil {
				return apierror.Wrap(apierror.CodeInternal, "锁定委外对账投影失败", err)
			}
			next := current.Add(value.delta)
			if next.IsNegative() || next.GreaterThan(baseQty) {
				return apierror.New(apierror.CodeConflict, "超出剩余可对账量")
			}
			if err := s.outsourced.AdjustReconciledQty(ctx, tx,
				outsourced.AdjustReconciledQtyInput{
					ReceiptItemID: value.id, Delta: value.delta,
				}); err != nil {
				return err
			}
			continue
		}
		table := "sal_delivery_item"
		parentTable, parentFK := "sal_delivery", "delivery_id"
		if spec.side == "purchase" {
			table, parentTable, parentFK = "pur_receipt_item", "pur_receipt", "receipt_id"
		}
		var parentStatus string
		if err := tx.QueryRow(ctx, `SELECT h.status FROM `+table+` i
			JOIN `+parentTable+` h ON h.id=i.`+parentFK+`
			WHERE i.id=$1 FOR UPDATE OF h,i`, value.id).Scan(&parentStatus); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return apierror.New(apierror.CodeConflict, "对账来源条目不存在")
			}
			return apierror.Wrap(apierror.CodeInternal, "锁定对账来源失败", err)
		}
		if parentStatus != "audited" {
			return apierror.New(apierror.CodeConflict, "仅已审核且未作废来源条目可对账")
		}
		tag, err := tx.Exec(ctx, `UPDATE `+table+` SET reconciled_qty=reconciled_qty+$2,
			updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1
			AND reconciled_qty+$2>=0 AND reconciled_qty+$2<=base_qty`, value.id, value.delta)
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "更新对账投影失败", err)
		}
		if tag.RowsAffected() != 1 {
			return apierror.New(apierror.CodeConflict,
				"第"+decimal.NewFromInt(value.idx).String()+"行超出剩余可对账量")
		}
	}
	return nil
}

func postGiftGL(
	ctx context.Context, tx pgx.Tx, spec sideSpec, head Head, posting time.Time,
) error {
	var debitCurrency, creditCurrency *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT
		(SELECT currency_id FROM bas_account WHERE id=$1),
		(SELECT currency_id FROM bas_account WHERE id=$2)`,
		head.DebitAccountID, head.CreditAccountID).
		Scan(&debitCurrency, &creditCurrency); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取对账科目币种失败", err)
	}
	debitPartyType, creditPartyType := (*string)(nil), (*string)(nil)
	debitPartyID, creditPartyID := (*uuid.UUID)(nil), (*uuid.UUID)(nil)
	if spec.side == "sales" {
		creditPartyType, creditPartyID = &head.PartyType, &head.PartyID
	} else {
		debitPartyType, debitPartyID = &head.PartyType, &head.PartyID
	}
	return gl.Post(ctx, tx, gl.Voucher{
		Type: spec.voucher, ID: head.ID, No: head.No,
		CompanyID: head.CompanyID, PostingDate: posting,
	}, []gl.Entry{
		{
			AccountID: head.DebitAccountID, CurrencyID: debitCurrency,
			Debit: head.BaseGrossTotal, Credit: decimal.Zero,
			PartyType: debitPartyType, PartyID: debitPartyID,
		},
		{
			AccountID: head.CreditAccountID, CurrencyID: creditCurrency,
			Debit: decimal.Zero, Credit: head.BaseGrossTotal,
			PartyType: creditPartyType, PartyID: creditPartyID,
		},
	})
}

func openTodo(
	ctx context.Context, tx pgx.Tx, spec sideSpec, head Head, userID *uuid.UUID,
) error {
	_, err := tx.Exec(ctx, `INSERT INTO sys_todo(type,source_type,source_id,source_no,
		party_type,party_id,amount,status,source_changed_at,company_id,created_by_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,'active',(now() AT TIME ZONE 'utc'),$8,$9)`,
		spec.todoType, spec.voucher, head.ID, head.No, head.PartyType, head.PartyID,
		head.BaseGrossTotal, head.CompanyID, userID)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "创建开票待办失败", err)
	}
	return nil
}

func closeTodos(
	ctx context.Context, tx pgx.Tx, spec sideSpec, id uuid.UUID, reason string,
) error {
	_, err := tx.Exec(ctx, `UPDATE sys_todo SET status='closed',closed_reason=$3,
		closed_at=(now() AT TIME ZONE 'utc'),updated_at=(now() AT TIME ZONE 'utc')
		WHERE source_type=$1 AND source_id=$2 AND status='active'`, spec.voucher, id, reason)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "关闭开票待办失败", err)
	}
	return nil
}

func writeStateAudit(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, spec sideSpec,
	before, after Head, action string,
) error {
	changes := audit.Diff(headSnapshot(before), headSnapshot(after), headAuditFields)
	if err := audit.Write(ctx, tx, actor, audit.Entry{
		Resource: spec.table, RecordID: after.ID, RecordLabel: after.No,
		ActionType: "update", ActionName: action, CompanyID: &after.CompanyID,
		Changes: changes,
	}); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入对账动作审计失败", err)
	}
	return nil
}

// CloseFromInvoice is an internal seam for the invoice aggregate. The caller
// owns tx so invoice facts, the one-to-one link, status and todo close commit
// atomically.
func (s *Service) CloseFromInvoice(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, side Side, id uuid.UUID,
) (Head, error) {
	return s.invoiceState(ctx, tx, actor, side, id, StatusConfirmed, StatusClosed,
		"close_from_invoice", func(spec sideSpec, head Head) error {
			return closeTodos(ctx, tx, spec, head.ID, "invoice_audit")
		})
}

// ReopenFromInvoice is the inverse invoice seam used after void/red invoice.
// The old closed todo remains history; reopening creates a new active todo.
func (s *Service) ReopenFromInvoice(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, side Side, id uuid.UUID,
) (Head, error) {
	return s.invoiceState(ctx, tx, actor, side, id, StatusClosed, StatusConfirmed,
		"reopen_from_invoice", func(spec sideSpec, head Head) error {
			return openTodo(ctx, tx, spec, head, nil)
		})
}

func (s *Service) invoiceState(
	ctx context.Context, tx pgx.Tx, actor *authz.Actor, side Side, id uuid.UUID,
	from, to Status, action string, effect func(sideSpec, Head) error,
) (Head, error) {
	spec, err := specFor(side)
	if err != nil {
		return Head{}, err
	}
	var status Status
	var kind Kind
	if err := tx.QueryRow(ctx, `SELECT status,reconciliation_type FROM `+spec.table+
		` WHERE id=$1 FOR UPDATE`, id).Scan(&status, &kind); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Head{}, apierror.New(apierror.CodeNotFound, spec.label+"不存在")
		}
		return Head{}, apierror.Wrap(apierror.CodeInternal, "锁定"+spec.label+"失败", err)
	}
	if status != from || kind != KindRegular {
		return Head{}, apierror.New(apierror.CodeConflict, "常规对账单状态不允许发票联动")
	}
	before, err := queryHead(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, err
	}
	if err := effect(spec, before); err != nil {
		return Head{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE `+spec.table+` SET status=$2,
		updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, id, to); err != nil {
		return Head{}, writeError("更新发票关联对账状态失败", err)
	}
	after, err := queryHead(ctx, tx, spec, id, false)
	if err != nil {
		return Head{}, err
	}
	if err := writeStateAudit(ctx, tx, actor, spec, before, after, action); err != nil {
		return Head{}, err
	}
	return after, nil
}
