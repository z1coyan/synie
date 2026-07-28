package order

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type demandOrderGroup struct {
	baseQty    decimal.Decimal
	firstIdx   int64
	companyID  uuid.UUID
	materialID uuid.UUID
	consistent bool
}

func verifyAndAdjustDemand(
	ctx context.Context, tx pgx.Tx, parent orderRow, orderID uuid.UUID,
	direction decimal.Decimal, verify bool,
) error {
	rows, err := tx.Query(ctx, `SELECT demand_line_id,idx,base_qty,company_id,material_id
		FROM pur_order_item WHERE order_id=$1 AND demand_line_id IS NOT NULL`, orderID)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取订单需求来源失败", err)
	}
	groups := map[uuid.UUID]demandOrderGroup{}
	for rows.Next() {
		var lineID, companyID, materialID uuid.UUID
		var idx int64
		var baseQty decimal.Decimal
		if err := rows.Scan(&lineID, &idx, &baseQty, &companyID, &materialID); err != nil {
			rows.Close()
			return apierror.Wrap(apierror.CodeInternal, "读取订单需求来源失败", err)
		}
		group, exists := groups[lineID]
		if !exists {
			group = demandOrderGroup{firstIdx: idx, companyID: companyID, materialID: materialID, consistent: true}
		}
		group.baseQty = group.baseQty.Add(baseQty)
		if companyID != group.companyID || materialID != group.materialID {
			group.consistent = false
		}
		if idx < group.firstIdx {
			group.firstIdx = idx
		}
		groups[lineID] = group
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取订单需求来源失败", err)
	}
	if len(groups) == 0 {
		return nil
	}
	ratio := decimal.Zero
	if verify {
		if err := tx.QueryRow(ctx, `SELECT demand_overorder_ratio FROM sal_setting LIMIT 1`).Scan(&ratio); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取需求超下单比例失败", err)
		}
	}
	expectedMethod := "buy"
	if parent.IsOutsourced {
		expectedMethod = "outsource"
	}
	for _, lineID := range sortedUUIDs(groups) {
		group := groups[lineID]
		var (
			demandStatus, itemStatus, method string
			baseQty, orderedQty              decimal.Decimal
			companyID, materialID            uuid.UUID
		)
		err := tx.QueryRow(ctx, `SELECT d.status,i.status,i.fulfillment_method,i.base_qty,
			i.ordered_qty,i.company_id,i.material_id
			FROM mfg_demand_item i JOIN mfg_demand d ON d.id=i.demand_id
			WHERE i.id=$1 FOR UPDATE OF i`, lineID).Scan(
			&demandStatus, &itemStatus, &method, &baseQty, &orderedQty, &companyID, &materialID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierror.New(apierror.CodeConflict,
				fmt.Sprintf("第%d行:来源履约需求行不存在", group.firstIdx))
		}
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "锁定来源履约需求行失败", err)
		}
		if verify {
			var reason string
			switch {
			case demandStatus != "confirmed":
				reason = "来源需求单须为已确认未关闭未作废"
			case itemStatus == "completed":
				reason = "来源需求行已完成"
			case method != expectedMethod:
				reason = "来源需求行履约方式与订单委外标记不匹配"
			case !group.consistent || group.materialID != materialID:
				reason = "来源需求行物料与订单条目不一致"
			case group.companyID != companyID || companyID != parent.CompanyID:
				reason = "来源需求行公司与订单条目不一致"
			case orderedQty.Add(group.baseQty).GreaterThan(baseQty.Mul(decimal.NewFromInt(1).Add(ratio))):
				reason = "超出需求可下单数量"
			}
			if reason != "" {
				return apierror.New(apierror.CodeConflict,
					fmt.Sprintf("第%d行:%s", group.firstIdx, reason))
			}
		}
		delta := group.baseQty.Mul(direction)
		if orderedQty.Add(delta).IsNegative() {
			return apierror.New(apierror.CodeConflict, "需求已下单投影不能为负")
		}
		if _, err := tx.Exec(ctx, `UPDATE mfg_demand_item SET ordered_qty=ordered_qty+$2,
			updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`, lineID, delta); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "更新需求已下单投影失败", err)
		}
	}
	return nil
}

func (s *Service) ListDemandPool(
	ctx context.Context, actor *authz.Actor, query DemandPoolQuery,
) ([]DemandPoolItem, error) {
	if err := requirePurchase(actor, "read"); err != nil {
		return nil, err
	}
	if query.CompanyID == uuid.Nil {
		return nil, apierror.Validation("需求池参数不合法",
			map[string][]string{"companyId": {"必填"}})
	}
	if !actor.CanAccessCompany(query.CompanyID) {
		return nil, apierror.New(apierror.CodeForbidden, "无权读取该公司数据")
	}
	if query.Limit == 0 {
		query.Limit = 200
	}
	if query.Limit < 1 || query.Limit > 200 {
		return nil, apierror.Validation("需求池参数不合法",
			map[string][]string{"limit": {"必须在 1 到 200 之间"}})
	}
	method := "buy"
	if query.IsOutsourced {
		method = "outsource"
	}
	rows, err := s.pool.Query(ctx, `SELECT i.id,i.demand_id,d.demand_no,i.idx,i.need_date,
		i.company_id,i.material_id,i.unit_id,i.material_code,i.material_name,i.material_spec,
		i.unit_name,i.base_qty,i.ordered_qty,(i.base_qty-i.ordered_qty) AS remaining_base_qty,
		CASE WHEN i.unit_id=m.default_unit_id THEN i.base_qty-i.ordered_qty
		     ELSE (i.base_qty-i.ordered_qty)*mu.factor END AS suggested_qty
		FROM mfg_demand_item i
		JOIN mfg_demand d ON d.id=i.demand_id
		JOIN inv_material m ON m.id=i.material_id
		LEFT JOIN inv_material_unit mu ON mu.material_id=i.material_id AND mu.unit_id=i.unit_id
		WHERE i.company_id=$1 AND d.status='confirmed' AND i.status<>'completed'
		  AND i.fulfillment_method=$2 AND i.ordered_qty<i.base_qty
		ORDER BY i.need_date ASC NULLS LAST,i.inserted_at ASC,i.id ASC LIMIT $3`,
		query.CompanyID, method, query.Limit)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "查询履约需求行池失败", err)
	}
	defer rows.Close()
	result := make([]DemandPoolItem, 0, query.Limit)
	for rows.Next() {
		var item DemandPoolItem
		var needDate pgtype.Date
		var materialSpec pgtype.Text
		if err := rows.Scan(&item.ID, &item.DemandID, &item.DemandNo, &item.Idx, &needDate,
			&item.CompanyID, &item.MaterialID, &item.UnitID, &item.MaterialCode,
			&item.MaterialName, &materialSpec, &item.UnitName, &item.BaseQty,
			&item.OrderedQty, &item.RemainingBaseQty, &item.SuggestedQty); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取履约需求行池失败", err)
		}
		item.NeedDate, item.MaterialSpec = datePtr(needDate), pgconv.TextPtr(materialSpec)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "遍历履约需求行池失败", err)
	}
	return result, nil
}

func (s *Service) PreviewBOM(
	ctx context.Context, actor *authz.Actor, bomID uuid.UUID, qty decimal.Decimal,
) (BOMPreview, error) {
	if err := requirePurchase(actor, "read"); err != nil {
		return BOMPreview{}, err
	}
	if bomID == uuid.Nil || !qty.GreaterThan(decimal.Zero) {
		return BOMPreview{}, apierror.Validation("BOM 代入参数不合法",
			map[string][]string{"bomId": {"必填"}, "qty": {"必须大于 0"}})
	}
	result := BOMPreview{Materials: []BOMPreviewLine{}, Byproducts: []BOMPreviewLine{}}
	rows, err := s.pool.Query(ctx, `SELECT x.material_id,m.code,m.name,x.unit_id,u.name,
		x.quantity*(1+coalesce(x.loss_rate,0))*$2,x.note
		FROM mfg_bom_component x
		JOIN inv_material m ON m.id=x.material_id
		JOIN bas_unit u ON u.id=x.unit_id
		WHERE x.bom_id=$1 ORDER BY x.inserted_at,x.id`, bomID, qty)
	if err != nil {
		return BOMPreview{}, apierror.Wrap(apierror.CodeInternal, "展开 BOM 发料清单失败", err)
	}
	for rows.Next() {
		var item BOMPreviewLine
		var remarks pgtype.Text
		if err := rows.Scan(&item.MaterialID, &item.MaterialCode, &item.MaterialName,
			&item.UnitID, &item.UnitName, &item.Quantity, &remarks); err != nil {
			rows.Close()
			return BOMPreview{}, apierror.Wrap(apierror.CodeInternal, "读取 BOM 发料清单失败", err)
		}
		item.Remarks = pgconv.TextPtr(remarks)
		result.Materials = append(result.Materials, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return BOMPreview{}, apierror.Wrap(apierror.CodeInternal, "遍历 BOM 发料清单失败", err)
	}
	rows, err = s.pool.Query(ctx, `SELECT x.material_id,m.code,m.name,x.unit_id,u.name,
		x.quantity*$2,x.note
		FROM mfg_bom_byproduct x
		JOIN inv_material m ON m.id=x.material_id
		JOIN bas_unit u ON u.id=x.unit_id
		WHERE x.bom_id=$1 ORDER BY x.inserted_at,x.id`, bomID, qty)
	if err != nil {
		return BOMPreview{}, apierror.Wrap(apierror.CodeInternal, "展开 BOM 副产物清单失败", err)
	}
	defer rows.Close()
	for rows.Next() {
		var item BOMPreviewLine
		var remarks pgtype.Text
		if err := rows.Scan(&item.MaterialID, &item.MaterialCode, &item.MaterialName,
			&item.UnitID, &item.UnitName, &item.Quantity, &remarks); err != nil {
			return BOMPreview{}, apierror.Wrap(apierror.CodeInternal, "读取 BOM 副产物清单失败", err)
		}
		item.Remarks = pgconv.TextPtr(remarks)
		result.Byproducts = append(result.Byproducts, item)
	}
	if err := rows.Err(); err != nil {
		return BOMPreview{}, apierror.Wrap(apierror.CodeInternal, "遍历 BOM 副产物清单失败", err)
	}
	return result, nil
}

func (s *Service) ListOrderFlow(
	ctx context.Context, actor *authz.Actor, side Side, orderID uuid.UUID,
) ([]FlowItem, error) {
	spec, err := specFor(side)
	if err != nil {
		return nil, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return nil, err
	}
	order, err := s.GetOrder(ctx, actor, side, orderID)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT flow_type,voucher_no,voucher_date,status,company_id,
		order_id,order_item_id,material_code,material_name,material_spec,customer_part_no,
		unit_name,qty FROM scm_order_flow_item WHERE order_id=$1 AND company_id=$2
		ORDER BY voucher_date DESC,voucher_no,id`, orderID, order.CompanyID)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "查询订单收发货历史失败", err)
	}
	defer rows.Close()
	result := []FlowItem{}
	for rows.Next() {
		var item FlowItem
		var docDate pgtype.Date
		var materialSpec, customerPartNo pgtype.Text
		if err := rows.Scan(&item.FlowType, &item.DocumentNo, &docDate, &item.Status,
			&item.CompanyID, &item.OrderID, &item.OrderItemID, &item.MaterialCode,
			&item.MaterialName, &materialSpec, &customerPartNo, &item.UnitName, &item.Quantity); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取订单收发货历史失败", err)
		}
		item.DocumentDate = dateValue(docDate)
		item.MaterialSpec, item.CustomerPartNo = pgconv.TextPtr(materialSpec), pgconv.TextPtr(customerPartNo)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "遍历订单收发货历史失败", err)
	}
	return result, nil
}

func normalizedMethod(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func utcDate(value time.Time) time.Time {
	return value.UTC().Truncate(24 * time.Hour)
}
