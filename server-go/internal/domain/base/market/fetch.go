package market

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/settings"
)

type LastQuote struct {
	Price    decimal.Decimal
	AsOfDate *string
}

type SettlementQuote struct {
	Price         decimal.Decimal
	DeliveryMonth string
	OpenInterest  int64
}

type LastPriceClient interface {
	FetchLast(context.Context, string) (LastQuote, error)
}

type SettlementPriceClient interface {
	FetchSettlement(context.Context, string, time.Time) (SettlementQuote, error)
}

type RefreshItem struct {
	InstrumentID uuid.UUID  `json:"instrumentId"`
	Code         string     `json:"code"`
	Kind         string     `json:"kind"`
	Status       string     `json:"status"`
	Message      *string    `json:"message"`
	PricePointID *uuid.UUID `json:"pricePointId"`
}

type RefreshResult struct {
	Items []RefreshItem `json:"items"`
	Count int           `json:"count"`
}

func (s *Service) Refresh(ctx context.Context, actor *authz.Actor, instrumentID *uuid.UUID) (RefreshResult, error) {
	client := &PublicMarketClient{HTTPClient: &http.Client{Timeout: 15 * time.Second}}
	return s.RefreshWithClients(ctx, actor, instrumentID, time.Now().UTC().Truncate(time.Second), client, client)
}

func (s *Service) RefreshWithClients(
	ctx context.Context,
	actor *authz.Actor,
	instrumentID *uuid.UUID,
	now time.Time,
	lastClient LastPriceClient,
	settlementClient SettlementPriceClient,
) (RefreshResult, error) {
	instruments, err := s.fetchableInstruments(ctx, instrumentID)
	if err != nil {
		return RefreshResult{}, err
	}
	setting, err := settings.NewService(s.pool).GetSystem(ctx)
	if err != nil {
		return RefreshResult{}, err
	}
	trySettlement := setting.MarketFetchSettlementEnabled && pastSettlementWindow(now)
	items := make([]RefreshItem, 0, len(instruments)*2)
	for _, instrument := range instruments {
		items = append(items, s.fetchLast(ctx, actor, instrument, now, lastClient))
		if trySettlement {
			items = append(items, s.fetchSettlement(ctx, actor, instrument, now, settlementClient))
		}
	}
	result := RefreshResult{Items: items, Count: len(items)}
	s.recordRefreshSummary(ctx, actor, "手动刷新", items)
	return result, nil
}

// RefreshLasts 供定时调度拉取全部启用拉取品种的最新价(与手动刷新共用 fetchLast 路径)。
func (s *Service) RefreshLasts(ctx context.Context, actor *authz.Actor, now time.Time) (RefreshResult, error) {
	client := &PublicMarketClient{HTTPClient: &http.Client{Timeout: 15 * time.Second}}
	return s.RefreshLastsWithClient(ctx, actor, nil, now, client)
}

func (s *Service) RefreshLastsWithClient(
	ctx context.Context,
	actor *authz.Actor,
	instrumentID *uuid.UUID,
	now time.Time,
	lastClient LastPriceClient,
) (RefreshResult, error) {
	instruments, err := s.fetchableInstruments(ctx, instrumentID)
	if err != nil {
		return RefreshResult{}, err
	}
	items := make([]RefreshItem, 0, len(instruments))
	for _, instrument := range instruments {
		items = append(items, s.fetchLast(ctx, actor, instrument, now, lastClient))
	}
	result := RefreshResult{Items: items, Count: len(items)}
	if len(items) > 0 {
		s.recordRefreshSummary(ctx, actor, "定时最新价", items)
	}
	return result, nil
}

// RefreshSettlements 供定时调度补拉全部启用拉取品种的结算价(与手动刷新共用 fetchSettlement 路径)。
func (s *Service) RefreshSettlements(ctx context.Context, actor *authz.Actor, now time.Time) (RefreshResult, error) {
	client := &PublicMarketClient{HTTPClient: &http.Client{Timeout: 15 * time.Second}}
	return s.RefreshSettlementsWithClient(ctx, actor, nil, now, client)
}

func (s *Service) RefreshSettlementsWithClient(
	ctx context.Context,
	actor *authz.Actor,
	instrumentID *uuid.UUID,
	now time.Time,
	settlementClient SettlementPriceClient,
) (RefreshResult, error) {
	instruments, err := s.fetchableInstruments(ctx, instrumentID)
	if err != nil {
		return RefreshResult{}, err
	}
	items := make([]RefreshItem, 0, len(instruments))
	for _, instrument := range instruments {
		items = append(items, s.fetchSettlement(ctx, actor, instrument, now, settlementClient))
	}
	result := RefreshResult{Items: items, Count: len(items)}
	if len(items) > 0 {
		s.recordRefreshSummary(ctx, actor, "定时结算价", items)
	}
	return result, nil
}

func (s *Service) fetchableInstruments(ctx context.Context, id *uuid.UUID) ([]Instrument, error) {
	query := `SELECT id,code,name,source_type,default_price_kind,active,fetch_enabled,
		external_last_code,external_product_group,note,currency_id,unit_id,inserted_at,updated_at
		FROM bas_market_instrument WHERE active=true AND fetch_enabled=true`
	args := []any{}
	if id != nil {
		query += " AND id=$1"
		args = append(args, *id)
	}
	query += " ORDER BY code"
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Instrument, 0)
	for rows.Next() {
		var x Instrument
		var sourceType, priceKind string
		var externalLast, externalGroup, note nullableText
		if err = rows.Scan(&x.ID, &x.Code, &x.Name, &sourceType, &priceKind, &x.Active, &x.FetchEnabled,
			&externalLast, &externalGroup, &note, &x.CurrencyID, &x.UnitID, &x.InsertedAt, &x.UpdatedAt); err != nil {
			return nil, err
		}
		x.SourceType, x.DefaultPriceKind = strings.ToUpper(sourceType), strings.ToUpper(priceKind)
		x.ExternalLastCode, x.ExternalProductGroup, x.Note = externalLast.ptr(), externalGroup.ptr(), note.ptr()
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Service) fetchLast(ctx context.Context, actor *authz.Actor, instrument Instrument, now time.Time, client LastPriceClient) RefreshItem {
	if instrument.ExternalLastCode == nil || strings.TrimSpace(*instrument.ExternalLastCode) == "" {
		return refreshItem(instrument, "last", "error", "未配置外部最新价代码", nil)
	}
	observedAt := now.UTC().Truncate(time.Minute)
	if s.hasActivePoint(ctx, instrument.ID, observedAt, "last") {
		return refreshItem(instrument, "last", "skipped", "本分钟已有最新价", nil)
	}
	code := strings.TrimSpace(*instrument.ExternalLastCode)
	quote, err := client.FetchLast(ctx, code)
	if err != nil {
		return refreshItem(instrument, "last", "error", compactError(err), nil)
	}
	note := "sina " + code
	if quote.AsOfDate != nil && *quote.AsOfDate != "" {
		note += " @" + *quote.AsOfDate
	}
	source, kind := "FETCH", "LAST"
	point, err := s.CreatePricePoint(ctx, actor, PricePointCreate{
		InstrumentID: instrument.ID, ObservedAt: observedAt, Price: quote.Price,
		PriceKind: &kind, Source: &source, Note: &note,
	})
	if err != nil {
		return refreshItem(instrument, "last", "error", compactError(err), nil)
	}
	return refreshItem(instrument, "last", "ok", "", &point.ID)
}

func (s *Service) fetchSettlement(ctx context.Context, actor *authz.Actor, instrument Instrument, now time.Time, client SettlementPriceClient) RefreshItem {
	if instrument.ExternalProductGroup == nil || strings.TrimSpace(*instrument.ExternalProductGroup) == "" {
		return refreshItem(instrument, "settlement", "error", "未配置外部品种组", nil)
	}
	shanghai := now.UTC().Add(8 * time.Hour)
	tradeDate := time.Date(shanghai.Year(), shanghai.Month(), shanghai.Day(), 0, 0, 0, 0, time.UTC)
	observedAt := time.Date(tradeDate.Year(), tradeDate.Month(), tradeDate.Day(), 7, 0, 0, 0, time.UTC)
	if s.hasActivePoint(ctx, instrument.ID, observedAt, "settlement") {
		return refreshItem(instrument, "settlement", "skipped", "当日结算价已存在", nil)
	}
	group := strings.TrimSpace(*instrument.ExternalProductGroup)
	quote, err := client.FetchSettlement(ctx, group, tradeDate)
	if err != nil {
		if err == ErrNotAvailable {
			return refreshItem(instrument, "settlement", "skipped", "日数据尚未发布或非交易日", nil)
		}
		return refreshItem(instrument, "settlement", "error", compactError(err), nil)
	}
	note := fmt.Sprintf("shfe %s%s main OI=%d", group, quote.DeliveryMonth, quote.OpenInterest)
	source, kind := "FETCH", "SETTLEMENT"
	point, err := s.CreatePricePoint(ctx, actor, PricePointCreate{
		InstrumentID: instrument.ID, ObservedAt: observedAt, Price: quote.Price,
		PriceKind: &kind, Source: &source, Note: &note,
	})
	if err != nil {
		return refreshItem(instrument, "settlement", "error", compactError(err), nil)
	}
	return refreshItem(instrument, "settlement", "ok", "", &point.ID)
}

func (s *Service) hasActivePoint(ctx context.Context, instrumentID uuid.UUID, observedAt time.Time, kind string) bool {
	var exists bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_market_price_point
		WHERE instrument_id=$1 AND observed_at=$2 AND price_kind=$3 AND is_voided=false)`,
		instrumentID, observedAt.UTC(), kind).Scan(&exists)
	return err == nil && exists
}

func (s *Service) recordRefreshSummary(ctx context.Context, actor *authz.Actor, label string, items []RefreshItem) {
	okCount, skippedCount, errorCount := 0, 0, 0
	var hint string
	for _, item := range items {
		switch item.Status {
		case "ok":
			okCount++
		case "skipped":
			skippedCount++
		case "error":
			errorCount++
			if hint == "" && item.Message != nil {
				hint = fmt.Sprintf(" 失败例 %s:%s", item.Code, *item.Message)
			}
		}
	}
	summary := fmt.Sprintf("%s: 成功%d 跳过%d 失败%d%s", label, okCount, skippedCount, errorCount, hint)
	_ = settings.NewService(s.pool).RecordMarketFetch(ctx, actor, summary)
}

func refreshItem(instrument Instrument, kind, status, message string, pointID *uuid.UUID) RefreshItem {
	var messagePtr *string
	if message != "" {
		messagePtr = &message
	}
	return RefreshItem{
		InstrumentID: instrument.ID, Code: instrument.Code, Kind: kind, Status: status,
		Message: messagePtr, PricePointID: pointID,
	}
}

func compactError(err error) string {
	value := strings.Join(strings.Fields(err.Error()), " ")
	runes := []rune(value)
	if len(runes) > 200 {
		value = string(runes[:200])
	}
	return value
}

func pastSettlementWindow(now time.Time) bool {
	shanghai := now.UTC().Add(8 * time.Hour)
	return shanghai.Hour()*60+shanghai.Minute() >= 15*60+30
}

var ErrNotAvailable = fmt.Errorf("not available")

type PublicMarketClient struct{ HTTPClient *http.Client }

func (c *PublicMarketClient) client() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 15 * time.Second}
}

func (c *PublicMarketClient) FetchLast(ctx context.Context, code string) (LastQuote, error) {
	symbol := strings.TrimSpace(code)
	if !strings.HasPrefix(symbol, "nf_") {
		symbol = "nf_" + symbol
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://hq.sinajs.cn/list="+url.QueryEscape(symbol), nil)
	if err != nil {
		return LastQuote{}, err
	}
	request.Header.Set("User-Agent", "Mozilla/5.0")
	request.Header.Set("Referer", "https://finance.sina.com.cn")
	response, err := c.client().Do(request)
	if err != nil {
		return LastQuote{}, fmt.Errorf("新浪行情网络错误:%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return LastQuote{}, fmt.Errorf("新浪行情 HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return LastQuote{}, err
	}
	pattern := regexp.MustCompile(`hq_str_` + regexp.QuoteMeta(symbol) + `="([^"]*)"`)
	match := pattern.FindSubmatch(body)
	if len(match) != 2 || len(match[1]) == 0 {
		return LastQuote{}, fmt.Errorf("新浪行情无数据(%s)", symbol)
	}
	parts := strings.Split(string(match[1]), ",")
	if len(parts) <= 8 {
		return LastQuote{}, fmt.Errorf("新浪行情缺少最新价")
	}
	price, err := decimal.NewFromString(strings.TrimSpace(parts[8]))
	if err != nil || !price.IsPositive() {
		return LastQuote{}, fmt.Errorf("新浪最新价无效")
	}
	var asOf *string
	if len(parts) > 17 && strings.TrimSpace(parts[17]) != "" {
		value := strings.TrimSpace(parts[17])
		asOf = &value
	}
	return LastQuote{Price: price, AsOfDate: asOf}, nil
}

func (c *PublicMarketClient) FetchSettlement(ctx context.Context, group string, tradeDate time.Time) (SettlementQuote, error) {
	endpoint := fmt.Sprintf("https://www.shfe.com.cn/data/tradedata/future/dailydata/kx%s.dat", tradeDate.Format("20060102"))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return SettlementQuote{}, err
	}
	request.Header.Set("User-Agent", "Mozilla/5.0")
	request.Header.Set("Referer", "https://www.shfe.com.cn/")
	response, err := c.client().Do(request)
	if err != nil {
		return SettlementQuote{}, fmt.Errorf("上期所日数据网络错误:%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return SettlementQuote{}, ErrNotAvailable
	}
	if response.StatusCode != http.StatusOK {
		return SettlementQuote{}, fmt.Errorf("上期所日数据 HTTP %d", response.StatusCode)
	}
	var payload map[string]any
	if err = json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&payload); err != nil {
		return SettlementQuote{}, fmt.Errorf("上期所日数据 JSON 解析失败")
	}
	rows, _ := payload["o_curinstrument"].([]any)
	group = strings.ToLower(strings.TrimSpace(group))
	var best SettlementQuote
	found := false
	for _, raw := range rows {
		row, _ := raw.(map[string]any)
		product := strings.ToLower(stringField(row, "PRODUCTGROUPID"))
		if product == "" {
			product = strings.ToLower(stringField(row, "PRODUCTID"))
		}
		month := stringField(row, "DELIVERYMONTH")
		price, priceErr := decimal.NewFromString(stringField(row, "SETTLEMENTPRICE"))
		if product != group || month == "" || priceErr != nil || !price.IsPositive() {
			continue
		}
		openInterest := intField(row, "OPENINTEREST")
		if !found || openInterest > best.OpenInterest {
			best = SettlementQuote{Price: price, DeliveryMonth: month, OpenInterest: openInterest}
			found = true
		}
	}
	if !found {
		return SettlementQuote{}, fmt.Errorf("上期所日数据无品种组 %s 的合约", group)
	}
	return best, nil
}

func stringField(row map[string]any, key string) string {
	value := row[key]
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func intField(row map[string]any, key string) int64 {
	value, _ := strconv.ParseInt(strings.ReplaceAll(stringField(row, key), ",", ""), 10, 64)
	return value
}

type nullableText struct {
	String string
	Valid  bool
}

func (n *nullableText) ScanText(value nullableText) error {
	n.String, n.Valid = value.String, value.Valid
	return nil
}

func (n nullableText) ptr() *string {
	if !n.Valid {
		return nil
	}
	value := n.String
	return &value
}

var _ pgx.Row
