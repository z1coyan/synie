package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/base/market"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

type marketListBody struct {
	Limit  *int                       `json:"limit,omitempty"`
	Offset *int                       `json:"offset,omitempty"`
	Search *string                    `json:"search,omitempty"`
	Sort   *gen.Sort                  `json:"sort,omitempty"`
	Filter map[string]json.RawMessage `json:"filter,omitempty"`
}

type marketInstrumentCreateBody struct {
	Code, Name, SourceType, DefaultPriceKind string
	Active, FetchEnabled                     *bool
	ExternalLastCode, ExternalProductGroup   *string
	Note                                     *string
	CurrencyID, UnitID                       uuid.UUID
}

type marketInstrumentUpdateBody struct {
	Name, DefaultPriceKind                 *string
	Active, FetchEnabled                   *bool
	ExternalLastCode, ExternalProductGroup json.RawMessage
	Note                                   json.RawMessage
}

type marketPointCreateBody struct {
	ObservedAt   time.Time `json:"observedAt"`
	Price        string    `json:"price"`
	PriceKind    *string   `json:"priceKind,omitempty"`
	Note         *string   `json:"note,omitempty"`
	InstrumentID uuid.UUID `json:"instrumentId"`
}

type marketSeriesBody struct {
	InstrumentIDs []uuid.UUID `json:"instrumentIds"`
	PriceKind     string      `json:"priceKind"`
	From          time.Time   `json:"from"`
	To            time.Time   `json:"to"`
}

type marketRefreshBody struct {
	InstrumentID *uuid.UUID `json:"instrumentId,omitempty"`
}

func (s *Server) QueryBasMarketInstruments(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "base.market_instrument:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body marketListBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := market.NewService(s.pool).ListInstruments(r.Context(), marketQuery(body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]any, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, instrumentDTO(item))
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"count": result.Count, "results": items})
}

func (s *Server) GetBasMarketInstrument(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "base.market_instrument:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := market.NewService(s.pool).GetInstrument(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, instrumentDTO(item))
}

func (s *Server) CreateBasMarketInstrument(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.market_instrument:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body marketInstrumentCreateBody
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := market.NewService(s.pool).CreateInstrument(r.Context(), actor, market.InstrumentCreate{
		Code: body.Code, Name: body.Name, SourceType: body.SourceType,
		DefaultPriceKind: body.DefaultPriceKind, Active: body.Active, FetchEnabled: body.FetchEnabled,
		ExternalLastCode: body.ExternalLastCode, ExternalProductGroup: body.ExternalProductGroup,
		Note: body.Note, CurrencyID: body.CurrencyID, UnitID: body.UnitID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, instrumentDTO(item))
}

func (s *Server) UpdateBasMarketInstrument(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.market_instrument:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body marketInstrumentUpdateBody
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	externalLast, err := nullableStringUpdate(body.ExternalLastCode)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	externalGroup, err := nullableStringUpdate(body.ExternalProductGroup)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	note, err := nullableStringUpdate(body.Note)
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := market.NewService(s.pool).UpdateInstrument(r.Context(), actor, id, market.InstrumentUpdate{
		Name: body.Name, DefaultPriceKind: body.DefaultPriceKind, Active: body.Active,
		FetchEnabled: body.FetchEnabled, ExternalLastCode: externalLast,
		ExternalProductGroup: externalGroup, Note: note,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, instrumentDTO(item))
}

func (s *Server) DeleteBasMarketInstrument(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.market_instrument:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = market.NewService(s.pool).DeleteInstrument(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QueryBasMarketPricePoints(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "base.market_price:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body marketListBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := market.NewService(s.pool).ListPricePoints(r.Context(), marketQuery(body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]any, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, pricePointDTO(item))
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"count": result.Count, "results": items})
}

func (s *Server) GetBasMarketPricePoint(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "base.market_price:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := market.NewService(s.pool).GetPricePoint(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, pricePointDTO(item))
}

func (s *Server) CreateBasMarketPricePoint(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.market_price:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body marketPointCreateBody
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	price, parseErr := decimal.NewFromString(strings.TrimSpace(body.Price))
	if parseErr != nil {
		s.writeError(w, r, apierror.Validation("价格格式不合法", map[string][]string{"price": {"必须是十进制字符串"}}))
		return
	}
	manual := "MANUAL"
	item, err := market.NewService(s.pool).CreatePricePoint(r.Context(), actor, market.PricePointCreate{
		ObservedAt: body.ObservedAt, Price: price, PriceKind: body.PriceKind,
		Source: &manual, Note: body.Note, InstrumentID: body.InstrumentID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, pricePointDTO(item))
}

func (s *Server) VoidBasMarketPricePoint(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.market_price:void")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := market.NewService(s.pool).VoidPricePoint(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, pricePointDTO(item))
}

func (s *Server) GetBasMarketChartInstruments(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "base.market_price:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	items, err := market.NewService(s.pool).ChartInstruments(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, items)
}

func (s *Server) GetBasMarketPriceSeries(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "base.market_price:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body marketSeriesBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := market.NewService(s.pool).PriceSeries(r.Context(), body.InstrumentIDs, body.PriceKind, body.From, body.To)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, priceSeriesDTO(result))
}

func (s *Server) RefreshBasMarketPricePoints(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.market_price:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body marketRefreshBody
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := market.NewService(s.pool).Refresh(r.Context(), actor, body.InstrumentID)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, result)
}

func marketQuery(body marketListBody) market.ListQuery {
	query := market.ListQuery{Filter: body.Filter}
	if body.Limit != nil {
		query.Limit = *body.Limit
	}
	if body.Offset != nil {
		query.Offset = *body.Offset
	}
	if body.Search != nil {
		query.Search = *body.Search
	}
	if body.Sort != nil {
		query.Sort = &filterbuild.Sort{Column: body.Sort.Column, Direction: string(body.Sort.Direction)}
	}
	return query
}

func nullableStringUpdate(raw json.RawMessage) (**string, error) {
	if raw == nil {
		return nil, nil
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func instrumentDTO(item market.Instrument) map[string]any {
	return map[string]any{
		"id": item.ID, "code": item.Code, "name": item.Name, "sourceType": item.SourceType,
		"defaultPriceKind": item.DefaultPriceKind, "active": item.Active, "fetchEnabled": item.FetchEnabled,
		"externalLastCode": item.ExternalLastCode, "externalProductGroup": item.ExternalProductGroup,
		"note": item.Note, "currencyId": item.CurrencyID, "unitId": item.UnitID,
		"insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
	}
}

func pricePointDTO(item market.PricePoint) map[string]any {
	return map[string]any{
		"id": item.ID, "observedAt": item.ObservedAt, "price": item.Price.String(),
		"priceKind": item.PriceKind, "source": item.Source, "isVoided": item.IsVoided,
		"note": item.Note, "instrumentId": item.InstrumentID, "currencyId": item.CurrencyID,
		"unitId": item.UnitID, "insertedAt": item.InsertedAt, "updatedAt": item.UpdatedAt,
	}
}

func priceSeriesDTO(result market.PriceSeries) map[string]any {
	series := make([]any, 0, len(result.Series))
	for _, item := range result.Series {
		points := make([]any, 0, len(item.Points))
		for _, point := range item.Points {
			points = append(points, map[string]any{"observedAt": point.ObservedAt, "price": point.Price.String()})
		}
		series = append(series, map[string]any{
			"id": item.ID, "instrumentId": item.InstrumentID, "code": item.Code, "name": item.Name,
			"currencyId": item.CurrencyID, "unitId": item.UnitID, "currencyCode": item.CurrencyCode,
			"unitName": item.UnitName, "defaultPriceKind": item.DefaultPriceKind, "points": points,
		})
	}
	return map[string]any{"priceKind": result.PriceKind, "from": result.From, "to": result.To, "series": series}
}
