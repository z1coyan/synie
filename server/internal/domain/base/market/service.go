package market

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/listexec"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/dberr"
)

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) GetInstrument(ctx context.Context, id uuid.UUID) (Instrument, error) {
	r, err := dbgen.New(s.pool).GetMarketInstrument(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Instrument{}, apierror.New(apierror.CodeNotFound, "行情品种不存在")
	}
	if err != nil {
		return Instrument{}, apierror.Wrap(apierror.CodeInternal, "读取行情品种失败", err)
	}
	return instrumentFromFields(r.ID, r.Code, r.Name, r.SourceType, r.DefaultPriceKind,
		r.Active, r.FetchEnabled, r.ExternalLastCode, r.ExternalProductGroup, r.Note,
		r.CurrencyID, r.UnitID, r.InsertedAt, r.UpdatedAt), nil
}

func (s *Service) ListInstruments(ctx context.Context, query ListQuery) (InstrumentList, error) {
	result, err := listexec.List(ctx, listexec.Spec[Instrument]{
		Pool: s.pool, Resource: InstrumentResourceMeta(), Label: "行情品种",
		Source: ` FROM bas_market_instrument`,
		Select: `SELECT id,code,name,source_type,default_price_kind,active,fetch_enabled,
external_last_code,external_product_group,note,currency_id,unit_id,inserted_at,updated_at`,
		DefaultOrder: ` ORDER BY "code","id"`,
		Tiebreaker:   `, "id"`,
		RawTail:      true,
		Scan: func(rows pgx.Rows) (Instrument, error) {
			var x Instrument
			var sourceType, priceKind string
			var externalLast, externalGroup, note pgtype.Text
			if err := rows.Scan(&x.ID, &x.Code, &x.Name, &sourceType, &priceKind, &x.Active, &x.FetchEnabled,
				&externalLast, &externalGroup, &note, &x.CurrencyID, &x.UnitID, &x.InsertedAt, &x.UpdatedAt); err != nil {
				return Instrument{}, err
			}
			x.SourceType, x.DefaultPriceKind = strings.ToUpper(sourceType), strings.ToUpper(priceKind)
			x.ExternalLastCode, x.ExternalProductGroup, x.Note = pgconv.TextPtr(externalLast), pgconv.TextPtr(externalGroup), pgconv.TextPtr(note)
			x.InsertedAt, x.UpdatedAt = x.InsertedAt.UTC(), x.UpdatedAt.UTC()
			return x, nil
		},
	}, listQuery(query))
	if err != nil {
		return InstrumentList{}, err
	}
	return InstrumentList{Count: result.Count, Results: result.Results}, nil
}

func (s *Service) CreateInstrument(ctx context.Context, actor *authz.Actor, in InstrumentCreate) (Instrument, error) {
	code, name, sourceType, priceKind, err := normalizeInstrument(in.Code, in.Name, in.SourceType, in.DefaultPriceKind)
	if err != nil {
		return Instrument{}, err
	}
	if err = validateOptionalLengths(in.ExternalLastCode, 32, "externalLastCode",
		in.ExternalProductGroup, 16, "externalProductGroup", in.Note, 255, "note"); err != nil {
		return Instrument{}, err
	}
	missing := map[string][]string{}
	if in.CurrencyID == uuid.Nil {
		missing["currencyId"] = []string{"不能为空"}
	}
	if in.UnitID == uuid.Nil {
		missing["unitId"] = []string{"不能为空"}
	}
	if len(missing) > 0 {
		return Instrument{}, apierror.Validation("行情品种参数不合法", missing)
	}
	active, fetchEnabled := true, false
	if in.Active != nil {
		active = *in.Active
	}
	if in.FetchEnabled != nil {
		fetchEnabled = *in.FetchEnabled
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Instrument{}, err
	}
	defer tx.Rollback(ctx)
	r, err := dbgen.New(tx).CreateMarketInstrument(ctx, dbgen.CreateMarketInstrumentParams{
		Code: code, Name: name, SourceType: sourceType, DefaultPriceKind: priceKind,
		Active: active, FetchEnabled: fetchEnabled, ExternalLastCode: pgconv.Text(in.ExternalLastCode),
		ExternalProductGroup: pgconv.Text(in.ExternalProductGroup), Note: pgconv.Text(in.Note),
		CurrencyID: in.CurrencyID, UnitID: in.UnitID,
	})
	if err != nil {
		return Instrument{}, marketWriteError(err)
	}
	x := instrumentFromFields(r.ID, r.Code, r.Name, r.SourceType, r.DefaultPriceKind,
		r.Active, r.FetchEnabled, r.ExternalLastCode, r.ExternalProductGroup, r.Note,
		r.CurrencyID, r.UnitID, r.InsertedAt, r.UpdatedAt)
	if err = audit.Write(ctx, tx, actor, audit.Entry{Resource: "bas_market_instrument", RecordID: x.ID,
		RecordLabel: x.Name, ActionType: "create", ActionName: "create",
		Changes: audit.Created(instrumentSnapshot(x), instrumentAuditFields)}); err != nil {
		return Instrument{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Instrument{}, marketWriteError(err)
	}
	return x, nil
}

func (s *Service) UpdateInstrument(ctx context.Context, actor *authz.Actor, id uuid.UUID, in InstrumentUpdate) (Instrument, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Instrument{}, err
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	r, err := q.LockMarketInstrument(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Instrument{}, apierror.New(apierror.CodeNotFound, "行情品种不存在")
	}
	if err != nil {
		return Instrument{}, err
	}
	before := instrumentFromFields(r.ID, r.Code, r.Name, r.SourceType, r.DefaultPriceKind,
		r.Active, r.FetchEnabled, r.ExternalLastCode, r.ExternalProductGroup, r.Note,
		r.CurrencyID, r.UnitID, r.InsertedAt, r.UpdatedAt)
	name, kind, active, fetchEnabled := r.Name, r.DefaultPriceKind, r.Active, r.FetchEnabled
	externalLast, externalGroup, note := pgconv.TextPtr(r.ExternalLastCode), pgconv.TextPtr(r.ExternalProductGroup), pgconv.TextPtr(r.Note)
	if in.Name != nil {
		name = strings.TrimSpace(*in.Name)
	}
	if in.DefaultPriceKind != nil {
		kind = strings.ToLower(strings.TrimSpace(*in.DefaultPriceKind))
	}
	if in.Active != nil {
		active = *in.Active
	}
	if in.FetchEnabled != nil {
		fetchEnabled = *in.FetchEnabled
	}
	if in.ExternalLastCode != nil {
		externalLast = *in.ExternalLastCode
	}
	if in.ExternalProductGroup != nil {
		externalGroup = *in.ExternalProductGroup
	}
	if in.Note != nil {
		note = *in.Note
	}
	if name == "" || utf8.RuneCountInString(name) > 64 || !validPriceKind(kind) {
		return Instrument{}, apierror.Validation("行情品种参数不合法", map[string][]string{"name": {"不能为空且最多 64 个字符"}, "defaultPriceKind": {"仅支持 SETTLEMENT/AVERAGE/LAST"}})
	}
	if err = validateOptionalLengths(externalLast, 32, "externalLastCode",
		externalGroup, 16, "externalProductGroup", note, 255, "note"); err != nil {
		return Instrument{}, err
	}
	u, err := q.UpdateMarketInstrument(ctx, dbgen.UpdateMarketInstrumentParams{
		ID: id, Name: name, DefaultPriceKind: kind, Active: active, FetchEnabled: fetchEnabled,
		ExternalLastCode: pgconv.Text(externalLast), ExternalProductGroup: pgconv.Text(externalGroup), Note: pgconv.Text(note),
	})
	if err != nil {
		return Instrument{}, marketWriteError(err)
	}
	x := instrumentFromFields(u.ID, u.Code, u.Name, u.SourceType, u.DefaultPriceKind,
		u.Active, u.FetchEnabled, u.ExternalLastCode, u.ExternalProductGroup, u.Note,
		u.CurrencyID, u.UnitID, u.InsertedAt, u.UpdatedAt)
	changes := audit.Diff(instrumentSnapshot(before), instrumentSnapshot(x), instrumentAuditFields)
	if len(changes) > 0 {
		if err = audit.Write(ctx, tx, actor, audit.Entry{Resource: "bas_market_instrument", RecordID: x.ID,
			RecordLabel: x.Name, ActionType: "update", ActionName: "update", Changes: changes}); err != nil {
			return Instrument{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Instrument{}, marketWriteError(err)
	}
	return x, nil
}

func (s *Service) DeleteInstrument(ctx context.Context, actor *authz.Actor, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	r, err := q.LockMarketInstrument(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.New(apierror.CodeNotFound, "行情品种不存在")
	}
	if err != nil {
		return err
	}
	x := instrumentFromFields(r.ID, r.Code, r.Name, r.SourceType, r.DefaultPriceKind,
		r.Active, r.FetchEnabled, r.ExternalLastCode, r.ExternalProductGroup, r.Note,
		r.CurrencyID, r.UnitID, r.InsertedAt, r.UpdatedAt)
	var hasPoints bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM bas_market_price_point WHERE instrument_id=$1)", id).Scan(&hasPoints); err != nil {
		return err
	}
	if hasPoints {
		return apierror.New(apierror.CodeConflict, "品种下已有行情价点,请停用而非删除")
	}
	if _, err = q.DeleteMarketInstrument(ctx, id); err != nil {
		return marketWriteError(err)
	}
	if err = audit.Write(ctx, tx, actor, audit.Entry{Resource: "bas_market_instrument", RecordID: x.ID,
		RecordLabel: x.Name, ActionType: "destroy", ActionName: "destroy",
		Changes: audit.Destroyed(instrumentSnapshot(x), instrumentAuditFields)}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return marketWriteError(err)
	}
	return nil
}

func (s *Service) GetPricePoint(ctx context.Context, id uuid.UUID) (PricePoint, error) {
	r, err := dbgen.New(s.pool).GetMarketPricePoint(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return PricePoint{}, apierror.New(apierror.CodeNotFound, "行情价点不存在")
	}
	if err != nil {
		return PricePoint{}, apierror.Wrap(apierror.CodeInternal, "读取行情价点失败", err)
	}
	return pointFromFields(r.ID, r.ObservedAt, r.Price, r.PriceKind, r.Source, r.IsVoided,
		r.Note, r.InstrumentID, r.CurrencyID, r.UnitID, r.InsertedAt, r.UpdatedAt), nil
}

func (s *Service) ListPricePoints(ctx context.Context, query ListQuery) (PricePointList, error) {
	result, err := listexec.List(ctx, listexec.Spec[PricePoint]{
		Pool: s.pool, Resource: PricePointResourceMeta(), Label: "行情价点",
		Source: ` FROM bas_market_price_point`,
		Select: `SELECT id,observed_at,price,price_kind,source,is_voided,note,
instrument_id,currency_id,unit_id,inserted_at,updated_at`,
		DefaultOrder: ` ORDER BY "observed_at" DESC,"id"`,
		Tiebreaker:   `, "id"`,
		RawTail:      true,
		Scan: func(rows pgx.Rows) (PricePoint, error) {
			var x PricePoint
			var priceKind, source string
			var note pgtype.Text
			if err := rows.Scan(&x.ID, &x.ObservedAt, &x.Price, &priceKind, &source, &x.IsVoided, &note,
				&x.InstrumentID, &x.CurrencyID, &x.UnitID, &x.InsertedAt, &x.UpdatedAt); err != nil {
				return PricePoint{}, err
			}
			x.PriceKind, x.Source, x.Note = strings.ToUpper(priceKind), strings.ToUpper(source), pgconv.TextPtr(note)
			x.ObservedAt, x.InsertedAt, x.UpdatedAt = x.ObservedAt.UTC(), x.InsertedAt.UTC(), x.UpdatedAt.UTC()
			return x, nil
		},
	}, listQuery(query))
	if err != nil {
		return PricePointList{}, err
	}
	return PricePointList{Count: result.Count, Results: result.Results}, nil
}

func listQuery(query ListQuery) listexec.Query {
	return listexec.Query{Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter}
}

func (s *Service) CreatePricePoint(ctx context.Context, actor *authz.Actor, in PricePointCreate) (PricePoint, error) {
	missing := map[string][]string{}
	if in.ObservedAt.IsZero() {
		missing["observedAt"] = []string{"不能为空"}
	}
	if in.InstrumentID == uuid.Nil {
		missing["instrumentId"] = []string{"不能为空"}
	}
	if len(missing) > 0 {
		return PricePoint{}, apierror.Validation("行情价点参数不合法", missing)
	}
	if !in.Price.IsPositive() {
		return PricePoint{}, apierror.Validation("价格必须大于 0", map[string][]string{"price": {"必须大于 0"}})
	}
	source := "manual"
	if in.Source != nil {
		source = strings.ToLower(strings.TrimSpace(*in.Source))
	}
	if source != "manual" && source != "fetch" {
		return PricePoint{}, apierror.Validation("行情价点参数不合法", map[string][]string{"source": {"仅支持 MANUAL/FETCH"}})
	}
	if err := validateOptionalLengths(in.Note, 255, "note"); err != nil {
		return PricePoint{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricePoint{}, err
	}
	defer tx.Rollback(ctx)
	var currencyID, unitID uuid.UUID
	var defaultKind string
	if err = tx.QueryRow(ctx, `SELECT currency_id,unit_id,default_price_kind
		FROM bas_market_instrument WHERE id=$1`, in.InstrumentID).Scan(&currencyID, &unitID, &defaultKind); errors.Is(err, pgx.ErrNoRows) {
		return PricePoint{}, apierror.Validation("行情品种不存在", map[string][]string{"instrumentId": {"行情品种不存在"}})
	} else if err != nil {
		return PricePoint{}, err
	}
	kind := defaultKind
	if in.PriceKind != nil {
		kind = strings.ToLower(strings.TrimSpace(*in.PriceKind))
	}
	if !validPriceKind(kind) {
		return PricePoint{}, apierror.Validation("行情价点参数不合法", map[string][]string{"priceKind": {"仅支持 SETTLEMENT/AVERAGE/LAST"}})
	}
	r, err := dbgen.New(tx).CreateMarketPricePoint(ctx, dbgen.CreateMarketPricePointParams{
		ObservedAt: pgtype.Timestamp{Time: in.ObservedAt.UTC(), Valid: true}, Price: in.Price,
		PriceKind: kind, Source: source, Note: pgconv.Text(in.Note), InstrumentID: in.InstrumentID,
		CurrencyID: currencyID, UnitID: unitID,
	})
	if err != nil {
		return PricePoint{}, marketWriteError(err)
	}
	x := pointFromFields(r.ID, r.ObservedAt, r.Price, r.PriceKind, r.Source, r.IsVoided,
		r.Note, r.InstrumentID, r.CurrencyID, r.UnitID, r.InsertedAt, r.UpdatedAt)
	if err = audit.Write(ctx, tx, actor, audit.Entry{Resource: "bas_market_price_point", RecordID: x.ID,
		ActionType: "create", ActionName: "create", Changes: audit.Created(pointSnapshot(x), pricePointAuditFields)}); err != nil {
		return PricePoint{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricePoint{}, marketWriteError(err)
	}
	return x, nil
}

func (s *Service) VoidPricePoint(ctx context.Context, actor *authz.Actor, id uuid.UUID) (PricePoint, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricePoint{}, err
	}
	defer tx.Rollback(ctx)
	q := dbgen.New(tx)
	r, err := q.LockMarketPricePoint(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return PricePoint{}, apierror.New(apierror.CodeNotFound, "行情价点不存在")
	}
	if err != nil {
		return PricePoint{}, err
	}
	before := pointFromFields(r.ID, r.ObservedAt, r.Price, r.PriceKind, r.Source, r.IsVoided,
		r.Note, r.InstrumentID, r.CurrencyID, r.UnitID, r.InsertedAt, r.UpdatedAt)
	if before.IsVoided {
		return PricePoint{}, apierror.Validation("价点已作废", map[string][]string{"isVoided": {"价点已作废"}})
	}
	u, err := q.VoidMarketPricePoint(ctx, id)
	if err != nil {
		return PricePoint{}, marketWriteError(err)
	}
	x := pointFromFields(u.ID, u.ObservedAt, u.Price, u.PriceKind, u.Source, u.IsVoided,
		u.Note, u.InstrumentID, u.CurrencyID, u.UnitID, u.InsertedAt, u.UpdatedAt)
	changes := audit.Diff(pointSnapshot(before), pointSnapshot(x), pricePointAuditFields)
	if err = audit.Write(ctx, tx, actor, audit.Entry{Resource: "bas_market_price_point", RecordID: x.ID,
		ActionType: "update", ActionName: "void", Changes: changes}); err != nil {
		return PricePoint{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricePoint{}, marketWriteError(err)
	}
	return x, nil
}

func (s *Service) ChartInstruments(ctx context.Context) ([]ChartInstrument, error) {
	rows, err := s.pool.Query(ctx, `SELECT i.id,i.code,i.name,i.currency_id,i.unit_id,c.iso_code,u.name,i.default_price_kind
		FROM bas_market_instrument i
		LEFT JOIN bas_currency c ON c.id=i.currency_id
		LEFT JOIN bas_unit u ON u.id=i.unit_id
		WHERE i.active=true ORDER BY i.code`)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取行情图品种失败", err)
	}
	defer rows.Close()
	out := make([]ChartInstrument, 0)
	for rows.Next() {
		var x ChartInstrument
		if err = rows.Scan(&x.ID, &x.Code, &x.Name, &x.CurrencyID, &x.UnitID,
			&x.CurrencyCode, &x.UnitName, &x.DefaultPriceKind); err != nil {
			return nil, err
		}
		x.InstrumentID = x.ID
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Service) PriceSeries(ctx context.Context, ids []uuid.UUID, priceKind string, from, to time.Time) (PriceSeries, error) {
	unique := make([]uuid.UUID, 0, len(ids))
	seen := map[uuid.UUID]struct{}{}
	for _, id := range ids {
		if id == uuid.Nil {
			continue
		}
		if _, ok := seen[id]; !ok {
			seen[id] = struct{}{}
			unique = append(unique, id)
		}
	}
	kind := strings.ToLower(strings.TrimSpace(priceKind))
	if !validPriceKind(kind) {
		return PriceSeries{}, apierror.Validation("参数无效", map[string][]string{"priceKind": {"仅支持 SETTLEMENT/AVERAGE/LAST"}})
	}
	missing := map[string][]string{}
	if from.IsZero() {
		missing["from"] = []string{"不能为空"}
	}
	if to.IsZero() {
		missing["to"] = []string{"不能为空"}
	}
	if len(missing) > 0 {
		return PriceSeries{}, apierror.Validation("行情序列参数不合法", missing)
	}
	if len(unique) > 6 {
		return PriceSeries{}, apierror.Validation("最多同时对比 6 个品种", map[string][]string{"instrumentIds": {"最多同时对比 6 个品种"}})
	}
	if from.After(to) {
		return PriceSeries{}, apierror.Validation("结束时间不能早于开始时间", map[string][]string{"to": {"结束时间不能早于开始时间"}})
	}
	result := PriceSeries{PriceKind: kind, From: from.UTC(), To: to.UTC(), Series: []InstrumentSeries{}}
	if len(unique) == 0 {
		return result, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT i.id,i.code,i.name,i.currency_id,i.unit_id,c.iso_code,u.name,i.default_price_kind
		FROM bas_market_instrument i
		LEFT JOIN bas_currency c ON c.id=i.currency_id
		LEFT JOIN bas_unit u ON u.id=i.unit_id
		WHERE i.id=ANY($1)`, unique)
	if err != nil {
		return PriceSeries{}, err
	}
	found := map[uuid.UUID]ChartInstrument{}
	for rows.Next() {
		var x ChartInstrument
		if err = rows.Scan(&x.ID, &x.Code, &x.Name, &x.CurrencyID, &x.UnitID,
			&x.CurrencyCode, &x.UnitName, &x.DefaultPriceKind); err != nil {
			rows.Close()
			return PriceSeries{}, err
		}
		x.InstrumentID = x.ID
		found[x.ID] = x
	}
	rows.Close()
	if len(found) != len(unique) {
		return PriceSeries{}, apierror.Validation("部分行情品种不存在", map[string][]string{"instrumentIds": {"部分行情品种不存在"}})
	}
	first := found[unique[0]]
	for _, id := range unique[1:] {
		x := found[id]
		if x.CurrencyID != first.CurrencyID || x.UnitID != first.UnitID {
			return PriceSeries{}, apierror.Validation("勾选品种必须同一币种与计量单位,无法同图对比",
				map[string][]string{"instrumentIds": {"勾选品种必须同一币种与计量单位"}})
		}
	}
	points, err := s.pool.Query(ctx, `SELECT instrument_id,observed_at,price
		FROM bas_market_price_point
		WHERE instrument_id=ANY($1) AND price_kind=$2 AND is_voided=false
		  AND observed_at >= $3 AND observed_at <= $4
		ORDER BY observed_at`, unique, kind, from.UTC(), to.UTC())
	if err != nil {
		return PriceSeries{}, err
	}
	byID := map[uuid.UUID][]SeriesPoint{}
	for points.Next() {
		var id uuid.UUID
		var point SeriesPoint
		if err = points.Scan(&id, &point.ObservedAt, &point.Price); err != nil {
			points.Close()
			return PriceSeries{}, err
		}
		point.ObservedAt = point.ObservedAt.UTC()
		byID[id] = append(byID[id], point)
	}
	points.Close()
	for _, id := range unique {
		result.Series = append(result.Series, InstrumentSeries{ChartInstrument: found[id], Points: append([]SeriesPoint{}, byID[id]...)})
	}
	return result, nil
}

func normalizeInstrument(code, name, sourceType, priceKind string) (string, string, string, string, error) {
	code, name = strings.TrimSpace(code), strings.TrimSpace(name)
	sourceType, priceKind = strings.ToLower(strings.TrimSpace(sourceType)), strings.ToLower(strings.TrimSpace(priceKind))
	fields := map[string][]string{}
	if code == "" || utf8.RuneCountInString(code) > 32 {
		fields["code"] = []string{"不能为空且最多 32 个字符"}
	}
	if name == "" || utf8.RuneCountInString(name) > 64 {
		fields["name"] = []string{"不能为空且最多 64 个字符"}
	}
	if sourceType != "exchange" && sourceType != "spot_index" && sourceType != "other" {
		fields["sourceType"] = []string{"仅支持 EXCHANGE/SPOT_INDEX/OTHER"}
	}
	if !validPriceKind(priceKind) {
		fields["defaultPriceKind"] = []string{"仅支持 SETTLEMENT/AVERAGE/LAST"}
	}
	if len(fields) > 0 {
		return "", "", "", "", apierror.Validation("行情品种参数不合法", fields)
	}
	return code, name, sourceType, priceKind, nil
}

func validPriceKind(value string) bool {
	return value == "settlement" || value == "average" || value == "last"
}

func validateOptionalLengths(values ...any) error {
	fields := map[string][]string{}
	for i := 0; i < len(values); i += 3 {
		value, _ := values[i].(*string)
		max := values[i+1].(int)
		field := values[i+2].(string)
		if value != nil && utf8.RuneCountInString(*value) > max {
			fields[field] = []string{fmt.Sprintf("不能超过 %d 个字符", max)}
		}
	}
	if len(fields) > 0 {
		return apierror.Validation("行情参数不合法", fields)
	}
	return nil
}

func instrumentFromFields(id uuid.UUID, code, name, sourceType, priceKind string,
	active, fetchEnabled bool, externalLast, externalGroup, note pgtype.Text,
	currencyID, unitID uuid.UUID, insertedAt, updatedAt pgtype.Timestamp,
) Instrument {
	return Instrument{
		ID: id, Code: code, Name: name, SourceType: strings.ToUpper(sourceType),
		DefaultPriceKind: strings.ToUpper(priceKind), Active: active, FetchEnabled: fetchEnabled,
		ExternalLastCode: pgconv.TextPtr(externalLast), ExternalProductGroup: pgconv.TextPtr(externalGroup), Note: pgconv.TextPtr(note),
		CurrencyID: currencyID, UnitID: unitID, InsertedAt: insertedAt.Time.UTC(), UpdatedAt: updatedAt.Time.UTC(),
	}
}

func pointFromFields(id uuid.UUID, observedAt pgtype.Timestamp, price decimal.Decimal,
	priceKind, source string, isVoided bool, note pgtype.Text,
	instrumentID, currencyID, unitID uuid.UUID, insertedAt, updatedAt pgtype.Timestamp,
) PricePoint {
	return PricePoint{
		ID: id, ObservedAt: observedAt.Time.UTC(), Price: price, PriceKind: strings.ToUpper(priceKind),
		Source: strings.ToUpper(source), IsVoided: isVoided, Note: pgconv.TextPtr(note),
		InstrumentID: instrumentID, CurrencyID: currencyID, UnitID: unitID,
		InsertedAt: insertedAt.Time.UTC(), UpdatedAt: updatedAt.Time.UTC(),
	}
}

func instrumentSnapshot(x Instrument) map[string]any {
	return map[string]any{
		"code": x.Code, "name": x.Name, "source_type": strings.ToLower(x.SourceType),
		"default_price_kind": strings.ToLower(x.DefaultPriceKind), "active": x.Active,
		"fetch_enabled": x.FetchEnabled, "external_last_code": stringValue(x.ExternalLastCode),
		"external_product_group": stringValue(x.ExternalProductGroup), "note": stringValue(x.Note),
		"currency_id": x.CurrencyID, "unit_id": x.UnitID,
	}
}

func pointSnapshot(x PricePoint) map[string]any {
	return map[string]any{
		"observed_at": x.ObservedAt.Format(time.RFC3339), "price": x.Price.String(),
		"price_kind": strings.ToLower(x.PriceKind), "source": strings.ToLower(x.Source),
		"is_voided": x.IsVoided, "note": stringValue(x.Note), "instrument_id": x.InstrumentID,
		"currency_id": x.CurrencyID, "unit_id": x.UnitID,
	}
}

func stringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

var writeMappings = []dberr.Mapping{
	{Code: "23505", Constraint: "market_instrument_unique_code", Message: "行情品种编码已存在"},
	{Code: "23505", Constraint: "market_price_point_unique_active_point", Message: "该品种、观测时刻与价类的有效价点已存在"},
	{Code: "23503", Message: "关联的币种、计量单位或行情品种不存在"},
}

func marketWriteError(err error) error {
	return dberr.MapWrite(err, "保存行情数据失败", writeMappings...)
}
