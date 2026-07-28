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
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type scanner interface {
	Scan(...any) error
}

type orderRow struct {
	ID             uuid.UUID
	OrderNo        string
	OrderDate      pgtype.Date
	OrderType      string
	IsOutsourced   bool
	PartyType      string
	PartyID        uuid.UUID
	ExchangeRate   decimal.Decimal
	Terms          pgtype.Text
	Remarks        pgtype.Text
	Status         string
	AuditedAt      pgtype.Timestamp
	InsertedAt     pgtype.Timestamp
	UpdatedAt      pgtype.Timestamp
	CompanyID      uuid.UUID
	CurrencyID     uuid.UUID
	CreatedByID    *uuid.UUID
	AuditedByID    *uuid.UUID
	GrossTotal     decimal.Decimal
	BaseGrossTotal decimal.Decimal
	CompanyName    string
	CurrencyCode   string
	CurrencyName   string
	CreatedByName  pgtype.Text
	AuditedByName  pgtype.Text
}

type itemRow struct {
	ID                uuid.UUID
	Idx               int64
	Qty               decimal.Decimal
	BaseQty           decimal.Decimal
	ProjectionQty     decimal.Decimal
	Price             decimal.Decimal
	Amount            decimal.Decimal
	BasePrice         decimal.Decimal
	BaseAmount        decimal.Decimal
	TaxRate           decimal.Decimal
	MaterialCode      string
	MaterialName      string
	MaterialSpec      pgtype.Text
	CustomerPartNo    pgtype.Text
	UnitName          string
	Remarks           pgtype.Text
	DemandDate        pgtype.Date
	InsertedAt        pgtype.Timestamp
	UpdatedAt         pgtype.Timestamp
	OrderID           uuid.UUID
	CompanyID         uuid.UUID
	MaterialID        uuid.UUID
	UnitID            uuid.UUID
	QuotationItemID   *uuid.UUID
	PricingMode       pgtype.Text
	BOMID             *uuid.UUID
	BOMCode           pgtype.Text
	BOMPlanName       pgtype.Text
	DemandLineID      *uuid.UUID
	DemandNo          pgtype.Text
	OrderDate         pgtype.Date
	OrderStatus       string
	OrderIsOutsourced bool
	PartyType         string
	PartyID           uuid.UUID
	CurrencyCode      string
	OrderNo           string
	CompanyName       string
	MaterialLiveName  string
	UnitLiveName      string
}

type materialRow struct {
	ID                uuid.UUID
	Quantity          decimal.Decimal
	IssuedQty         decimal.Decimal
	Remarks           pgtype.Text
	InsertedAt        pgtype.Timestamp
	UpdatedAt         pgtype.Timestamp
	OrderItemID       uuid.UUID
	CompanyID         uuid.UUID
	MaterialID        uuid.UUID
	MaterialCode      string
	MaterialName      string
	MaterialSpec      pgtype.Text
	UnitID            uuid.UUID
	UnitName          string
	OrderNo           string
	OrderStatus       string
	OrderIsOutsourced bool
	PartyType         string
	PartyID           uuid.UUID
}

type byproductRow struct {
	ID           uuid.UUID
	Quantity     decimal.Decimal
	Remarks      pgtype.Text
	InsertedAt   pgtype.Timestamp
	UpdatedAt    pgtype.Timestamp
	OrderItemID  uuid.UUID
	CompanyID    uuid.UUID
	MaterialID   uuid.UUID
	MaterialCode string
	MaterialName string
	MaterialSpec pgtype.Text
	UnitID       uuid.UUID
	UnitName     string
}

func orderSelect(spec sideSpec) string {
	isOutsourced := "false"
	if spec.side == SidePurchase {
		isOutsourced = "o.is_outsourced"
	}
	return `SELECT o.id,o.order_no,o.order_date,o.order_type,` + isOutsourced + ` AS is_outsourced,
		o.party_type,o.party_id,o.exchange_rate,o.terms,o.remarks,o.status,o.audited_at,
		o.inserted_at,o.updated_at,o.company_id,o.currency_id,o.created_by_id,o.audited_by_id,
		COALESCE((SELECT sum(i.amount) FROM ` + spec.itemTable + ` i WHERE i.order_id=o.id),0) AS gross_total,
		COALESCE((SELECT sum(i.base_amount) FROM ` + spec.itemTable + ` i WHERE i.order_id=o.id),0) AS base_gross_total,
		c.name AS company_name,cur.iso_code AS currency_code,cur.name AS currency_name,
		creator.name AS created_by_name,auditor.name AS audited_by_name
		FROM ` + spec.headTable + ` o
		JOIN bas_company c ON c.id=o.company_id
		JOIN bas_currency cur ON cur.id=o.currency_id
		LEFT JOIN sys_user creator ON creator.id=o.created_by_id
		LEFT JOIN sys_user auditor ON auditor.id=o.audited_by_id`
}

func orderSource(spec sideSpec) string {
	return ` FROM (` + orderSelect(spec) + `) orders`
}

func itemSource(spec sideSpec) string {
	projection, projectionAlias := "i.shipped_qty", "shipped_qty"
	bom, bomCode, bomPlanName := "NULL::uuid", "NULL::text", "NULL::text"
	demandLine, demandNo, demandDate, outsourced := "NULL::uuid", "NULL::text", "NULL::date", "false"
	extraJoins := ""
	if spec.side == SidePurchase {
		projection, projectionAlias = "i.received_qty", "received_qty"
		bom, bomCode, bomPlanName = "i.bom_id", "b.code", "b.plan_name"
		demandLine, demandNo, demandDate, outsourced =
			"i.demand_line_id", "d.demand_no", "i.demand_date", "o.is_outsourced"
		extraJoins = ` LEFT JOIN mfg_bom b ON b.id=i.bom_id
		LEFT JOIN mfg_demand_item di ON di.id=i.demand_line_id
		LEFT JOIN mfg_demand d ON d.id=di.demand_id`
	}
	return ` FROM (
		SELECT i.id,i.idx,i.qty,i.base_qty,` + projection + ` AS projection_qty,
		  ` + projection + ` AS ` + projectionAlias + `,
		  i.price,i.amount,i.base_price,i.base_amount,i.tax_rate,i.material_code,i.material_name,
		  i.material_spec,i.customer_part_no,i.unit_name,i.remarks,` + demandDate + ` AS demand_date,
		  i.inserted_at,i.updated_at,i.order_id,i.company_id,i.material_id,i.unit_id,
		  i.quotation_item_id,qi.pricing_mode,` + bom + ` AS bom_id,` + bomCode + ` AS bom_code,
		  ` + bomPlanName + ` AS bom_plan_name,` + demandLine + ` AS demand_line_id,
		  ` + demandNo + ` AS demand_no,
		  o.order_date,o.status AS order_status,` + outsourced + ` AS order_is_outsourced,
		  o.party_type,o.party_id,cur.iso_code AS currency_code,o.currency_id,o.order_no,
		  c.name AS company_name,m.name AS material_live_name,u.name AS unit_live_name,
		  (i.base_qty-` + projection + `) AS remaining_base_qty
		FROM ` + spec.itemTable + ` i
		JOIN ` + spec.headTable + ` o ON o.id=i.order_id
		JOIN bas_company c ON c.id=i.company_id
		JOIN bas_currency cur ON cur.id=o.currency_id
		JOIN inv_material m ON m.id=i.material_id
		JOIN bas_unit u ON u.id=i.unit_id
		LEFT JOIN ` + quotationItemTable(spec.side) + ` qi ON qi.id=i.quotation_item_id
		` + extraJoins + `
	) order_items`
}

func materialSource() string {
	return ` FROM (
		SELECT x.id,x.quantity,x.issued_qty,x.remarks,x.inserted_at,x.updated_at,
		  x.order_item_id,x.company_id,x.material_id,m.code AS material_code,
		  m.name AS material_name,m.spec AS material_spec,x.unit_id,u.name AS unit_name,
		  o.order_no,o.status AS order_status,
		  o.is_outsourced AS order_is_outsourced,o.party_type,o.party_id,
		  (x.quantity-x.issued_qty) AS remaining_issue_qty
		FROM pur_order_item_material x
		JOIN pur_order_item i ON i.id=x.order_item_id
		JOIN pur_order o ON o.id=i.order_id
		JOIN inv_material m ON m.id=x.material_id
		JOIN bas_unit u ON u.id=x.unit_id
	) order_materials`
}

func byproductSource() string {
	return ` FROM (
		SELECT x.id,x.quantity,x.remarks,x.inserted_at,x.updated_at,x.order_item_id,
		  x.company_id,x.material_id,m.code AS material_code,m.name AS material_name,
		  m.spec AS material_spec,x.unit_id,u.name AS unit_name
		FROM pur_order_item_byproduct x
		JOIN inv_material m ON m.id=x.material_id
		JOIN bas_unit u ON u.id=x.unit_id
	) order_byproducts`
}

func scanOrderRow(row scanner) (orderRow, error) {
	var result orderRow
	err := row.Scan(&result.ID, &result.OrderNo, &result.OrderDate, &result.OrderType,
		&result.IsOutsourced, &result.PartyType, &result.PartyID, &result.ExchangeRate,
		&result.Terms, &result.Remarks, &result.Status, &result.AuditedAt, &result.InsertedAt,
		&result.UpdatedAt, &result.CompanyID, &result.CurrencyID, &result.CreatedByID,
		&result.AuditedByID, &result.GrossTotal, &result.BaseGrossTotal, &result.CompanyName,
		&result.CurrencyCode, &result.CurrencyName, &result.CreatedByName, &result.AuditedByName)
	return result, err
}

func scanItemRow(row scanner) (itemRow, error) {
	var result itemRow
	err := row.Scan(&result.ID, &result.Idx, &result.Qty, &result.BaseQty,
		&result.ProjectionQty, &result.Price, &result.Amount, &result.BasePrice,
		&result.BaseAmount, &result.TaxRate, &result.MaterialCode, &result.MaterialName,
		&result.MaterialSpec, &result.CustomerPartNo, &result.UnitName, &result.Remarks,
		&result.DemandDate, &result.InsertedAt, &result.UpdatedAt, &result.OrderID,
		&result.CompanyID, &result.MaterialID, &result.UnitID, &result.QuotationItemID,
		&result.PricingMode, &result.BOMID, &result.BOMCode, &result.BOMPlanName,
		&result.DemandLineID, &result.DemandNo, &result.OrderDate, &result.OrderStatus,
		&result.OrderIsOutsourced, &result.PartyType, &result.PartyID, &result.CurrencyCode,
		&result.OrderNo, &result.CompanyName, &result.MaterialLiveName, &result.UnitLiveName)
	return result, err
}

func scanMaterialRow(row scanner) (materialRow, error) {
	var result materialRow
	err := row.Scan(&result.ID, &result.Quantity, &result.IssuedQty, &result.Remarks,
		&result.InsertedAt, &result.UpdatedAt, &result.OrderItemID, &result.CompanyID,
		&result.MaterialID, &result.MaterialCode, &result.MaterialName, &result.MaterialSpec,
		&result.UnitID, &result.UnitName, &result.OrderNo, &result.OrderStatus,
		&result.OrderIsOutsourced, &result.PartyType, &result.PartyID)
	return result, err
}

func scanByproductRow(row scanner) (byproductRow, error) {
	var result byproductRow
	err := row.Scan(&result.ID, &result.Quantity, &result.Remarks, &result.InsertedAt,
		&result.UpdatedAt, &result.OrderItemID, &result.CompanyID, &result.MaterialID,
		&result.MaterialCode, &result.MaterialName, &result.MaterialSpec, &result.UnitID, &result.UnitName)
	return result, err
}

func orderFromRow(row orderRow) Order {
	result := Order{
		ID: row.ID, OrderNo: row.OrderNo, OrderDate: dateValue(row.OrderDate),
		OrderType: OrderType(strings.ToUpper(row.OrderType)), IsOutsourced: row.IsOutsourced,
		PartyType: strings.ToUpper(row.PartyType), PartyID: row.PartyID,
		ExchangeRate: row.ExchangeRate, Terms: pgconv.TextPtr(row.Terms), Remarks: pgconv.TextPtr(row.Remarks),
		Status: Status(strings.ToUpper(row.Status)), AuditedAt: pgconv.OptionalTime(row.AuditedAt),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		CompanyID: row.CompanyID, CurrencyID: row.CurrencyID,
		CreatedByID: row.CreatedByID, AuditedByID: row.AuditedByID,
		GrossTotal: row.GrossTotal, BaseGrossTotal: row.BaseGrossTotal,
		Company:  NamedRef{ID: row.CompanyID, Name: row.CompanyName},
		Currency: CodeNamedRef{ID: row.CurrencyID, Code: row.CurrencyCode, Name: row.CurrencyName},
	}
	if row.CreatedByID != nil {
		result.CreatedBy = &NamedRef{ID: *row.CreatedByID, Name: row.CreatedByName.String}
	}
	if row.AuditedByID != nil {
		result.AuditedBy = &NamedRef{ID: *row.AuditedByID, Name: row.AuditedByName.String}
	}
	return result
}

func itemFromRow(side Side, row itemRow) Item {
	result := Item{
		ID: row.ID, Idx: row.Idx, Qty: row.Qty, BaseQty: row.BaseQty,
		Price: row.Price, Amount: row.Amount, BasePrice: row.BasePrice, BaseAmount: row.BaseAmount,
		TaxRate: row.TaxRate, MaterialCode: row.MaterialCode, MaterialName: row.MaterialName,
		MaterialSpec: pgconv.TextPtr(row.MaterialSpec), CustomerPartNo: pgconv.TextPtr(row.CustomerPartNo),
		UnitName: row.UnitName, Remarks: pgconv.TextPtr(row.Remarks), DemandDate: datePtr(row.DemandDate),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		OrderID: row.OrderID, CompanyID: row.CompanyID, MaterialID: row.MaterialID, UnitID: row.UnitID,
		QuotationItemID: row.QuotationItemID, BOMID: row.BOMID, DemandLineID: row.DemandLineID,
		PricingMode: upperTextPtr(row.PricingMode), BOMCode: pgconv.TextPtr(row.BOMCode),
		BOMPlanName: pgconv.TextPtr(row.BOMPlanName), DemandNo: pgconv.TextPtr(row.DemandNo),
		OrderNo: row.OrderNo, OrderDate: dateValue(row.OrderDate), OrderStatus: Status(strings.ToUpper(row.OrderStatus)),
		OrderIsOutsourced: row.OrderIsOutsourced, PartyType: strings.ToUpper(row.PartyType),
		PartyID: row.PartyID, CurrencyCode: row.CurrencyCode,
		RemainingBaseQty: row.BaseQty.Sub(row.ProjectionQty),
		Order:            OrderRef{ID: row.OrderID, OrderNo: row.OrderNo},
		Company:          NamedRef{ID: row.CompanyID, Name: row.CompanyName},
		Material:         CodeNamedRef{ID: row.MaterialID, Code: row.MaterialCode, Name: row.MaterialLiveName},
		Unit:             NamedRef{ID: row.UnitID, Name: row.UnitLiveName},
	}
	if side == SideSales {
		result.ShippedQty = row.ProjectionQty
	} else {
		result.ReceivedQty = row.ProjectionQty
	}
	return result
}

func materialFromRow(row materialRow) Material {
	return Material{
		ID: row.ID, Quantity: row.Quantity, IssuedQty: row.IssuedQty,
		Remarks: pgconv.TextPtr(row.Remarks), InsertedAt: row.InsertedAt.Time.UTC(),
		UpdatedAt: row.UpdatedAt.Time.UTC(), OrderItemID: row.OrderItemID,
		CompanyID: row.CompanyID, MaterialID: row.MaterialID,
		MaterialCode: row.MaterialCode, MaterialName: row.MaterialName,
		MaterialSpec: pgconv.TextPtr(row.MaterialSpec), UnitID: row.UnitID, UnitName: row.UnitName,
		OrderNo: row.OrderNo, OrderStatus: Status(strings.ToUpper(row.OrderStatus)),
		OrderIsOutsourced: row.OrderIsOutsourced, PartyType: strings.ToUpper(row.PartyType),
		PartyID: row.PartyID, RemainingIssueQty: row.Quantity.Sub(row.IssuedQty),
	}
}

func byproductFromRow(row byproductRow) Byproduct {
	return Byproduct{
		ID: row.ID, Quantity: row.Quantity, Remarks: pgconv.TextPtr(row.Remarks),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		OrderItemID: row.OrderItemID, CompanyID: row.CompanyID,
		MaterialID: row.MaterialID, MaterialCode: row.MaterialCode,
		MaterialName: row.MaterialName, MaterialSpec: pgconv.TextPtr(row.MaterialSpec),
		UnitID: row.UnitID, UnitName: row.UnitName,
	}
}

func (s *Service) GetOrder(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Order, error) {
	spec, err := specFor(side)
	if err != nil {
		return Order{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return Order{}, err
	}
	row, err := scanOrderRow(s.pool.QueryRow(ctx, orderSelect(spec)+" WHERE o.id=$1", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, notFound(spec)
	}
	if err != nil {
		return Order{}, apierror.Wrap(apierror.CodeInternal, "读取订单失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Order{}, notFound(spec)
	}
	return orderFromRow(row), nil
}

func (s *Service) ListOrders(ctx context.Context, actor *authz.Actor, side Side, query ListQuery) (OrderListResult, error) {
	spec, err := specFor(side)
	if err != nil {
		return OrderListResult{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return OrderListResult{}, err
	}
	if err := pagination(&query); err != nil {
		return OrderListResult{}, err
	}
	built, err := filterbuild.Build(OrderResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search, Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return OrderListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "order_date" DESC, "order_no" ASC, "id" ASC`
	} else {
		orderBy += `, "id" ASC`
	}
	return listOrders(ctx, s.pool, spec, query, where, orderBy, args)
}

func listOrders(ctx context.Context, pool interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}, spec sideSpec, query ListQuery, where, orderBy string, args []any) (OrderListResult, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return OrderListResult{}, apierror.Wrap(apierror.CodeInternal, "查询订单失败", err)
	}
	defer tx.Rollback(ctx)
	source := orderSource(spec)
	var result OrderListResult
	if err := tx.QueryRow(ctx, "SELECT count(*)"+source+where, args...).Scan(&result.Count); err != nil {
		return OrderListResult{}, apierror.Wrap(apierror.CodeInternal, "统计订单失败", err)
	}
	listArgs, at := append([]any(nil), args...), len(args)+1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,order_no,order_date,order_type,is_outsourced,
		party_type,party_id,exchange_rate,terms,remarks,status,audited_at,inserted_at,updated_at,
		company_id,currency_id,created_by_id,audited_by_id,gross_total,base_gross_total,
		company_name,currency_code,currency_name,created_by_name,audited_by_name`+
		source+where+orderBy+fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return OrderListResult{}, apierror.Wrap(apierror.CodeInternal, "查询订单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Order, 0, query.Limit)
	for rows.Next() {
		row, scanErr := scanOrderRow(rows)
		if scanErr != nil {
			return OrderListResult{}, apierror.Wrap(apierror.CodeInternal, "读取订单结果失败", scanErr)
		}
		result.Results = append(result.Results, orderFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return OrderListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历订单结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return OrderListResult{}, apierror.Wrap(apierror.CodeInternal, "完成订单查询失败", err)
	}
	return result, nil
}

func (s *Service) GetItem(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Item, error) {
	spec, err := specFor(side)
	if err != nil {
		return Item{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return Item{}, err
	}
	row, err := queryItemByID(ctx, s.pool, spec, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, itemNotFound()
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取订单条目失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Item{}, itemNotFound()
	}
	return itemFromRow(side, row), nil
}

func (s *Service) ListItems(ctx context.Context, actor *authz.Actor, side Side, query ListQuery) (ItemListResult, error) {
	spec, err := specFor(side)
	if err != nil {
		return ItemListResult{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return ItemListResult{}, err
	}
	if err := pagination(&query); err != nil {
		return ItemListResult{}, err
	}
	built, err := filterbuild.Build(ItemResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search, Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return ItemListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "idx" ASC, "id" ASC`
	} else {
		orderBy += `, "id" ASC`
	}
	source := itemSource(spec)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询订单条目失败", err)
	}
	defer tx.Rollback(ctx)
	var result ItemListResult
	if err := tx.QueryRow(ctx, "SELECT count(*)"+source+where, args...).Scan(&result.Count); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "统计订单条目失败", err)
	}
	listArgs, at := append([]any(nil), args...), len(args)+1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,idx,qty,base_qty,projection_qty,price,amount,
		base_price,base_amount,tax_rate,material_code,material_name,material_spec,customer_part_no,
		unit_name,remarks,demand_date,inserted_at,updated_at,order_id,company_id,material_id,unit_id,
		quotation_item_id,pricing_mode,bom_id,bom_code,bom_plan_name,demand_line_id,demand_no,
		order_date,order_status,order_is_outsourced,
		party_type,party_id,currency_code,order_no,company_name,material_live_name,unit_live_name`+
		source+where+orderBy+fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询订单条目失败", err)
	}
	defer rows.Close()
	result.Results = make([]Item, 0, query.Limit)
	for rows.Next() {
		row, scanErr := scanItemRow(rows)
		if scanErr != nil {
			return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "读取订单条目结果失败", scanErr)
		}
		result.Results = append(result.Results, itemFromRow(side, row))
	}
	if err := rows.Err(); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历订单条目结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "完成订单条目查询失败", err)
	}
	return result, nil
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func queryItemByID(ctx context.Context, db rowQuerier, spec sideSpec, id uuid.UUID) (itemRow, error) {
	return scanItemRow(db.QueryRow(ctx, `SELECT id,idx,qty,base_qty,projection_qty,price,amount,
		base_price,base_amount,tax_rate,material_code,material_name,material_spec,customer_part_no,
		unit_name,remarks,demand_date,inserted_at,updated_at,order_id,company_id,material_id,unit_id,
		quotation_item_id,pricing_mode,bom_id,bom_code,bom_plan_name,demand_line_id,demand_no,
		order_date,order_status,order_is_outsourced,
		party_type,party_id,currency_code,order_no,company_name,material_live_name,unit_live_name`+
		itemSource(spec)+` WHERE id=$1`, id))
}

func upperTextPtr(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := strings.ToUpper(value.String)
	return &result
}

func dateValue(value pgtype.Date) time.Time {
	return value.Time.UTC()
}

func datePtr(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}

func quotationItemTable(side Side) string {
	if side == SidePurchase {
		return "pur_quotation_item"
	}
	return "sal_quotation_item"
}
