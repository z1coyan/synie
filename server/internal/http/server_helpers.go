package httpapi

// 本文件是 HTTP 包唯一的共享 helpers 落脚点:
// 列表请求体(listBody/listParts)、可空更新解析、decimal 解析、日期指针转换
// 以及列表端点的泛型 queryList 流程助手。新 helper 一律放这里,
// 不要再散落到各领域 handler 文件。

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type listBody struct {
	Limit  *int                       `json:"limit,omitempty"`
	Offset *int                       `json:"offset,omitempty"`
	Search *string                    `json:"search,omitempty"`
	Sort   *gen.Sort                  `json:"sort,omitempty"`
	Filter map[string]json.RawMessage `json:"filter,omitempty"`
}

func listParts(body listBody) (int, int, string, *filterbuild.Sort, map[string]json.RawMessage) {
	var limit, offset int
	var search string
	if body.Limit != nil {
		limit = *body.Limit
	}
	if body.Offset != nil {
		offset = *body.Offset
	}
	if body.Search != nil {
		search = *body.Search
	}
	var sort *filterbuild.Sort
	if body.Sort != nil {
		sort = &filterbuild.Sort{Column: body.Sort.Column, Direction: string(body.Sort.Direction)}
	}
	return limit, offset, search, sort, body.Filter
}

// queryList 收敛列表类端点的公共流程:校验权限 -> 解码 listBody -> 构造查询 ->
// 调用 service List -> 写响应。buildQuery 完成 listBody 到各领域 ListQuery 的映射,
// respond 完成领域结果到响应体的映射(透传、gen 列表或 count/results 包装)。
// Go 方法不允许带类型参数,因此它是接收 *Server 的包级泛型函数。
func queryList[Q any, R any](
	s *Server,
	w http.ResponseWriter,
	r *http.Request,
	permission string,
	buildQuery func(listBody) Q,
	list func(context.Context, *authz.Actor, Q) (R, error),
	respond func(R) any,
) {
	actor, err := actorWithPermission(r, permission)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	queryListAs(s, w, r, actor, buildQuery, list, respond)
}

// queryListAs 与 queryList 同流程,但 actor 已由路由门面鉴权后显式传入,不再重复鉴权。
func queryListAs[Q any, R any](
	s *Server,
	w http.ResponseWriter,
	r *http.Request,
	actor *authz.Actor,
	buildQuery func(listBody) Q,
	list func(context.Context, *authz.Actor, Q) (R, error),
	respond func(R) any,
) {
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	result, err := list(r.Context(), actor, buildQuery(body))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, respond(result))
}

// ignoreActor 适配不接收 actor 的领域 List 方法。
func ignoreActor[Q any, R any](
	list func(context.Context, Q) (R, error),
) func(context.Context, *authz.Actor, Q) (R, error) {
	return func(ctx context.Context, _ *authz.Actor, query Q) (R, error) {
		return list(ctx, query)
	}
}

// passthroughListResponse 用于领域结果已带 count/results JSON 形状的端点。
func passthroughListResponse[R any](result R) any {
	return result
}

// mapItems 把领域条目映射为响应 DTO;空结果保持非 nil,序列化为 [] 而非 null。
func mapItems[T any, D any](items []T, dto func(T) D) []D {
	out := make([]D, 0, len(items))
	for _, item := range items {
		out = append(out, dto(item))
	}
	return out
}

// countResultsResponse 组装 map 形状的 count/results 响应体。
func countResultsResponse[C any, D any](count C, results []D) any {
	return map[string]any{"count": count, "results": results}
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

func nullableStringError(resource, field string) error {
	return apierror.Validation(resource+"参数不合法", map[string][]string{
		field: {"必须是字符串或 null"},
	})
}

func nullableUUIDUpdate(raw json.RawMessage) (**uuid.UUID, error) {
	if raw == nil {
		return nil, nil
	}
	var value *uuid.UUID
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func nullableUUIDError(resource, field string) error {
	return apierror.Validation(resource+"参数不合法", map[string][]string{
		field: {"必须是 UUID 或 null"},
	})
}

func nullableDateUpdate(raw json.RawMessage) (**time.Time, error) {
	if raw == nil {
		return nil, nil
	}
	var value *openapi_types.Date
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	if value == nil {
		var result *time.Time
		return &result, nil
	}
	date := value.Time
	result := &date
	return &result, nil
}

func nullableDateError(resource, field string) error {
	return apierror.Validation(resource+"参数不合法", map[string][]string{
		field: {"必须是 YYYY-MM-DD 日期或 null"},
	})
}

func decimalInput(raw, resource, field string) (decimal.Decimal, error) {
	value, err := decimal.NewFromString(raw)
	if err != nil {
		return decimal.Decimal{}, apierror.Validation(resource+"参数不合法", map[string][]string{
			field: {"必须是十进制数字字符串"},
		})
	}
	return value, nil
}

func optionalDecimalInput(raw *string, resource, field string) (*decimal.Decimal, error) {
	if raw == nil {
		return nil, nil
	}
	value, err := decimalInput(*raw, resource, field)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func nullableDecimalUpdate(
	raw json.RawMessage,
	resource string,
	field string,
) (**decimal.Decimal, error) {
	if raw == nil {
		return nil, nil
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, apierror.Validation(resource+"参数不合法", map[string][]string{
			field: {"必须是十进制数字字符串或 null"},
		})
	}
	if value == nil {
		var result *decimal.Decimal
		return &result, nil
	}
	parsed, err := decimalInput(*value, resource, field)
	if err != nil {
		return nil, err
	}
	result := &parsed
	return &result, nil
}

func datePointer(value *openapi_types.Date) *time.Time {
	if value == nil {
		return nil
	}
	result := value.Time
	return &result
}

func openAPIDatePointer(value *openapi_types.Date) *time.Time {
	if value == nil {
		return nil
	}
	result := value.Time
	return &result
}
