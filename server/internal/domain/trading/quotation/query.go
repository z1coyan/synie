package quotation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type scanner interface {
	Scan(...any) error
}

type quotationRow struct {
	ID            uuid.UUID
	QuotationNo   string
	QuotationDate pgtype.Date
	ValidUntil    pgtype.Date
	PartyType     string
	PartyID       uuid.UUID
	Terms         pgtype.Text
	Remarks       pgtype.Text
	Status        string
	AuditedAt     pgtype.Timestamp
	InsertedAt    pgtype.Timestamp
	UpdatedAt     pgtype.Timestamp
	CompanyID     uuid.UUID
	CurrencyID    uuid.UUID
	CreatedByID   *uuid.UUID
	AuditedByID   *uuid.UUID
	CompanyName   string
	CurrencyCode  string
	CurrencyName  string
	CreatedByName pgtype.Text
	AuditedByName pgtype.Text
}

type itemRow struct {
	ID               uuid.UUID
	Idx              int64
	PricingMode      string
	Price            pgtype.Numeric
	TaxRate          decimal.Decimal
	MaterialCode     string
	MaterialName     string
	MaterialSpec     pgtype.Text
	CustomerPartNo   pgtype.Text
	UnitName         string
	Remarks          pgtype.Text
	InsertedAt       pgtype.Timestamp
	UpdatedAt        pgtype.Timestamp
	QuotationID      uuid.UUID
	CompanyID        uuid.UUID
	MaterialID       uuid.UUID
	UnitID           uuid.UUID
	TierCount        int64
	QuotationDate    pgtype.Date
	ValidUntil       pgtype.Date
	Status           string
	PartyType        string
	PartyID          uuid.UUID
	CurrencyCode     string
	QuotationNo      string
	CompanyName      string
	MaterialLiveName string
	UnitLiveName     string
}

type tierRow struct {
	ID          uuid.UUID
	MinQty      decimal.Decimal
	Price       decimal.Decimal
	InsertedAt  pgtype.Timestamp
	UpdatedAt   pgtype.Timestamp
	ItemID      uuid.UUID
	CompanyID   uuid.UUID
	CompanyName string
}

func quotationSelect(spec sideSpec) string {
	return `SELECT q.id,q.quotation_no,q.quotation_date,q.valid_until,q.party_type,q.party_id,
		q.terms,q.remarks,q.status,q.audited_at,q.inserted_at,q.updated_at,q.company_id,
		q.currency_id,q.created_by_id,q.audited_by_id,c.name AS company_name,
		cur.iso_code AS currency_code,cur.name AS currency_name,
		creator.name AS created_by_name,auditor.name AS audited_by_name
	FROM ` + spec.headTable + ` q
	JOIN bas_company c ON c.id=q.company_id
	JOIN bas_currency cur ON cur.id=q.currency_id
	LEFT JOIN sys_user creator ON creator.id=q.created_by_id
	LEFT JOIN sys_user auditor ON auditor.id=q.audited_by_id`
}

func itemSource(spec sideSpec) string {
	return ` FROM (
		SELECT i.id,i.idx,i.pricing_mode,i.price,i.tax_rate,i.material_code,i.material_name,
		  i.material_spec,i.customer_part_no,i.unit_name,i.remarks,i.inserted_at,i.updated_at,
		  i.quotation_id,i.company_id,i.material_id,i.unit_id,
		  (SELECT count(*) FROM ` + spec.tierTable + ` t WHERE t.item_id=i.id)::bigint AS tier_count,
		  q.quotation_date,q.valid_until,q.status AS quotation_status,q.party_type,q.party_id,
		  cur.iso_code AS currency_code,q.currency_id,q.quotation_no,c.name AS company_name,
		  m.name AS material_live_name,u.name AS unit_live_name
		FROM ` + spec.itemTable + ` i
		JOIN ` + spec.headTable + ` q ON q.id=i.quotation_id
		JOIN bas_company c ON c.id=i.company_id
		JOIN bas_currency cur ON cur.id=q.currency_id
		JOIN inv_material m ON m.id=i.material_id
		JOIN bas_unit u ON u.id=i.unit_id
	) quotation_items`
}

func tierSource(spec sideSpec) string {
	return ` FROM (
		SELECT t.id,t.min_qty,t.price,t.inserted_at,t.updated_at,t.item_id,t.company_id,
		  c.name AS company_name
		FROM ` + spec.tierTable + ` t
		JOIN bas_company c ON c.id=t.company_id
	) quotation_tiers`
}

func scanQuotationRow(row scanner) (quotationRow, error) {
	var result quotationRow
	err := row.Scan(
		&result.ID, &result.QuotationNo, &result.QuotationDate, &result.ValidUntil,
		&result.PartyType, &result.PartyID, &result.Terms, &result.Remarks,
		&result.Status, &result.AuditedAt, &result.InsertedAt, &result.UpdatedAt,
		&result.CompanyID, &result.CurrencyID, &result.CreatedByID, &result.AuditedByID,
		&result.CompanyName, &result.CurrencyCode, &result.CurrencyName,
		&result.CreatedByName, &result.AuditedByName,
	)
	return result, err
}

func scanItemRow(row scanner) (itemRow, error) {
	var result itemRow
	err := row.Scan(
		&result.ID, &result.Idx, &result.PricingMode, &result.Price, &result.TaxRate,
		&result.MaterialCode, &result.MaterialName, &result.MaterialSpec,
		&result.CustomerPartNo, &result.UnitName, &result.Remarks, &result.InsertedAt,
		&result.UpdatedAt, &result.QuotationID, &result.CompanyID, &result.MaterialID,
		&result.UnitID, &result.TierCount, &result.QuotationDate, &result.ValidUntil,
		&result.Status, &result.PartyType, &result.PartyID, &result.CurrencyCode,
		&result.QuotationNo, &result.CompanyName, &result.MaterialLiveName, &result.UnitLiveName,
	)
	return result, err
}

func scanTierRow(row scanner) (tierRow, error) {
	var result tierRow
	err := row.Scan(
		&result.ID, &result.MinQty, &result.Price, &result.InsertedAt,
		&result.UpdatedAt, &result.ItemID, &result.CompanyID, &result.CompanyName,
	)
	return result, err
}

func quotationFromRow(row quotationRow) Quotation {
	result := Quotation{
		ID: row.ID, QuotationNo: row.QuotationNo,
		QuotationDate: dateValue(row.QuotationDate), ValidUntil: dateValue(row.ValidUntil),
		PartyType: strings.ToUpper(row.PartyType), PartyID: row.PartyID,
		Terms: textPtr(row.Terms), Remarks: textPtr(row.Remarks),
		Status: Status(strings.ToUpper(row.Status)), AuditedAt: timestampPtr(row.AuditedAt),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		CompanyID: row.CompanyID, CurrencyID: row.CurrencyID,
		CreatedByID: row.CreatedByID, AuditedByID: row.AuditedByID,
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

func itemFromRow(row itemRow) Item {
	return Item{
		ID: row.ID, Idx: row.Idx, PricingMode: PricingMode(strings.ToUpper(row.PricingMode)),
		Price: decimalPtr(row.Price), TaxRate: row.TaxRate,
		MaterialCode: row.MaterialCode, MaterialName: row.MaterialName,
		MaterialSpec: textPtr(row.MaterialSpec), CustomerPartNo: textPtr(row.CustomerPartNo),
		UnitName: row.UnitName, Remarks: textPtr(row.Remarks),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		QuotationID: row.QuotationID, CompanyID: row.CompanyID,
		MaterialID: row.MaterialID, UnitID: row.UnitID, TierCount: row.TierCount,
		QuotationDate: dateValue(row.QuotationDate), ValidUntil: dateValue(row.ValidUntil),
		QuotationStatus: Status(strings.ToUpper(row.Status)),
		PartyType:       strings.ToUpper(row.PartyType), PartyID: row.PartyID,
		CurrencyCode: row.CurrencyCode,
		Quotation:    QuotationRef{ID: row.QuotationID, QuotationNo: row.QuotationNo},
		Company:      NamedRef{ID: row.CompanyID, Name: row.CompanyName},
		Material:     CodeNamedRef{ID: row.MaterialID, Code: row.MaterialCode, Name: row.MaterialLiveName},
		Unit:         NamedRef{ID: row.UnitID, Name: row.UnitLiveName},
	}
}

func tierFromRow(row tierRow) Tier {
	return Tier{
		ID: row.ID, MinQty: row.MinQty, Price: row.Price,
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
		ItemID: row.ItemID, CompanyID: row.CompanyID,
		Company: NamedRef{ID: row.CompanyID, Name: row.CompanyName},
	}
}

func (s *Service) GetQuotation(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Quotation, error) {
	spec, err := specFor(side)
	if err != nil {
		return Quotation{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return Quotation{}, err
	}
	row, err := scanQuotationRow(s.pool.QueryRow(ctx, quotationSelect(spec)+" WHERE q.id=$1", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Quotation{}, notFound(spec)
	}
	if err != nil {
		return Quotation{}, apierror.Wrap(apierror.CodeInternal, "读取报价单失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Quotation{}, notFound(spec)
	}
	return quotationFromRow(row), nil
}

func (s *Service) ListQuotations(ctx context.Context, actor *authz.Actor, side Side, query ListQuery) (QuotationListResult, error) {
	spec, err := specFor(side)
	if err != nil {
		return QuotationListResult{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return QuotationListResult{}, err
	}
	if err := pagination(&query); err != nil {
		return QuotationListResult{}, err
	}
	built, err := filterbuild.Build(QuotationResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return QuotationListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "quotation_date" DESC, "quotation_no" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	source := ` FROM (` + quotationSelect(spec) + `) quotations`
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return QuotationListResult{}, apierror.Wrap(apierror.CodeInternal, "查询报价单失败", err)
	}
	defer tx.Rollback(ctx)
	var result QuotationListResult
	if err := tx.QueryRow(ctx, "SELECT count(*)"+source+where, args...).Scan(&result.Count); err != nil {
		return QuotationListResult{}, apierror.Wrap(apierror.CodeInternal, "统计报价单失败", err)
	}
	listArgs, at := append([]any(nil), args...), len(args)+1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,quotation_no,quotation_date,valid_until,party_type,
		party_id,terms,remarks,status,audited_at,inserted_at,updated_at,company_id,
		currency_id,created_by_id,audited_by_id,company_name,currency_code,currency_name,
		created_by_name,audited_by_name`+
		source+where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return QuotationListResult{}, apierror.Wrap(apierror.CodeInternal, "查询报价单失败", err)
	}
	defer rows.Close()
	result.Results = make([]Quotation, 0, query.Limit)
	for rows.Next() {
		row, scanErr := scanQuotationRow(rows)
		if scanErr != nil {
			return QuotationListResult{}, apierror.Wrap(apierror.CodeInternal, "读取报价单结果失败", scanErr)
		}
		result.Results = append(result.Results, quotationFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return QuotationListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历报价单结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return QuotationListResult{}, apierror.Wrap(apierror.CodeInternal, "完成报价单查询失败", err)
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
	row, err := scanItemRow(s.pool.QueryRow(ctx, `SELECT id,idx,pricing_mode,price,tax_rate,
		material_code,material_name,material_spec,customer_part_no,unit_name,remarks,
		inserted_at,updated_at,quotation_id,company_id,material_id,unit_id,tier_count,
		quotation_date,valid_until,quotation_status,party_type,party_id,currency_code,
		quotation_no,company_name,material_live_name,unit_live_name`+
		itemSource(spec)+` WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, itemNotFound()
	}
	if err != nil {
		return Item{}, apierror.Wrap(apierror.CodeInternal, "读取报价条目失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Item{}, itemNotFound()
	}
	return itemFromRow(row), nil
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
	ordinaryFilter, currencyIDs, err := splitItemCurrencyFilter(query.Filter)
	if err != nil {
		return ItemListResult{}, err
	}
	built, err := filterbuild.Build(ItemResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: ordinaryFilter,
	})
	if err != nil {
		return ItemListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	if len(currencyIDs) > 0 {
		at := len(args) + 1
		clause := fmt.Sprintf(`"currency_id" = ANY($%d::uuid[])`, at)
		if where == "" {
			where = " WHERE " + clause
		} else {
			where += " AND " + clause
		}
		args = append(args, currencyIDs)
	}
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "idx" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	source := itemSource(spec)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询报价条目失败", err)
	}
	defer tx.Rollback(ctx)
	var result ItemListResult
	if err := tx.QueryRow(ctx, "SELECT count(*)"+source+where, args...).Scan(&result.Count); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "统计报价条目失败", err)
	}
	listArgs, at := append([]any(nil), args...), len(args)+1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,idx,pricing_mode,price,tax_rate,material_code,
		material_name,material_spec,customer_part_no,unit_name,remarks,inserted_at,
		updated_at,quotation_id,company_id,material_id,unit_id,tier_count,quotation_date,
		valid_until,quotation_status,party_type,party_id,currency_code,quotation_no,
		company_name,material_live_name,unit_live_name`+
		source+where+order+fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "查询报价条目失败", err)
	}
	defer rows.Close()
	result.Results = make([]Item, 0, query.Limit)
	for rows.Next() {
		row, scanErr := scanItemRow(rows)
		if scanErr != nil {
			return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "读取报价条目结果失败", scanErr)
		}
		result.Results = append(result.Results, itemFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历报价条目结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ItemListResult{}, apierror.Wrap(apierror.CodeInternal, "完成报价条目查询失败", err)
	}
	return result, nil
}

func splitItemCurrencyFilter(filter map[string]json.RawMessage) (map[string]json.RawMessage, []uuid.UUID, error) {
	if len(filter) == 0 {
		return filter, nil, nil
	}
	raw, ok := filter["currencyId"]
	if !ok {
		return filter, nil, nil
	}
	var value struct {
		Kind   string   `json:"kind"`
		Op     string   `json:"op,omitempty"`
		Values []string `json:"values,omitempty"`
	}
	if err := json.Unmarshal(raw, &value); err != nil || value.Kind != "fk" ||
		(value.Op != "" && value.Op != "in") {
		return nil, nil, apierror.Validation("筛选条件不合法",
			map[string][]string{"currencyId": {"外键筛选格式错误"}})
	}
	ids := make([]uuid.UUID, 0, len(value.Values))
	for _, rawID := range value.Values {
		id, err := uuid.Parse(rawID)
		if err != nil {
			return nil, nil, apierror.Validation("筛选条件不合法",
				map[string][]string{"currencyId": {"必须是 UUID"}})
		}
		ids = append(ids, id)
	}
	ordinary := make(map[string]json.RawMessage, len(filter)-1)
	for key, item := range filter {
		if key != "currencyId" {
			ordinary[key] = item
		}
	}
	return ordinary, ids, nil
}

func (s *Service) GetTier(ctx context.Context, actor *authz.Actor, side Side, id uuid.UUID) (Tier, error) {
	spec, err := specFor(side)
	if err != nil {
		return Tier{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return Tier{}, err
	}
	row, err := scanTierRow(s.pool.QueryRow(ctx, `SELECT id,min_qty,price,inserted_at,
		updated_at,item_id,company_id,company_name`+tierSource(spec)+` WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Tier{}, tierNotFound()
	}
	if err != nil {
		return Tier{}, apierror.Wrap(apierror.CodeInternal, "读取报价价格档失败", err)
	}
	if !actor.CanAccessCompany(row.CompanyID) {
		return Tier{}, tierNotFound()
	}
	return tierFromRow(row), nil
}

func (s *Service) ListTiers(ctx context.Context, actor *authz.Actor, side Side, query ListQuery) (TierListResult, error) {
	spec, err := specFor(side)
	if err != nil {
		return TierListResult{}, err
	}
	if err := require(actor, spec, "read"); err != nil {
		return TierListResult{}, err
	}
	if err := pagination(&query); err != nil {
		return TierListResult{}, err
	}
	built, err := filterbuild.Build(TierResourceMeta(side), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return TierListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, built.Args)
	order := built.OrderBy
	if order == "" {
		order = ` ORDER BY "min_qty" ASC, "id" ASC`
	} else {
		order += `, "id" ASC`
	}
	source := tierSource(spec)
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return TierListResult{}, apierror.Wrap(apierror.CodeInternal, "查询报价价格档失败", err)
	}
	defer tx.Rollback(ctx)
	var result TierListResult
	if err := tx.QueryRow(ctx, "SELECT count(*)"+source+where, args...).Scan(&result.Count); err != nil {
		return TierListResult{}, apierror.Wrap(apierror.CodeInternal, "统计报价价格档失败", err)
	}
	listArgs, at := append([]any(nil), args...), len(args)+1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, `SELECT id,min_qty,price,inserted_at,updated_at,item_id,
		company_id,company_name`+source+where+order+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", at, at+1), listArgs...)
	if err != nil {
		return TierListResult{}, apierror.Wrap(apierror.CodeInternal, "查询报价价格档失败", err)
	}
	defer rows.Close()
	result.Results = make([]Tier, 0, query.Limit)
	for rows.Next() {
		row, scanErr := scanTierRow(rows)
		if scanErr != nil {
			return TierListResult{}, apierror.Wrap(apierror.CodeInternal, "读取报价价格档结果失败", scanErr)
		}
		result.Results = append(result.Results, tierFromRow(row))
	}
	if err := rows.Err(); err != nil {
		return TierListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历报价价格档结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return TierListResult{}, apierror.Wrap(apierror.CodeInternal, "完成报价价格档查询失败", err)
	}
	return result, nil
}
