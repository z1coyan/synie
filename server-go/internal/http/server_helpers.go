package httpapi

// 本文件是 HTTP 包唯一的共享 helpers 落脚点:
// 列表请求体(listBody/listParts)、可空更新解析、decimal 解析、日期指针转换
// 以及列表端点的泛型 queryList 流程助手。新 helper 一律放这里,
// 不要再散落到各领域 handler 文件。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/optional"
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

// decodePatchJSON 解码 PATCH 请求体并返回出现过的键集合,
// 使显式 JSON null 与省略字段保持可区分。这是 HTTP 层唯一的
// 「双次解码 + 字段集合」入口, 配合 optionalField 使用。
func decodePatchJSON(
	w http.ResponseWriter,
	r *http.Request,
	target any,
) (map[string]json.RawMessage, error) {
	var raw json.RawMessage
	if err := decodeJSON(w, r, &raw); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("请求体只能包含一个 JSON 对象")
		}
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	return fields, nil
}

// optionalField 依据 PATCH 字段出现集合构造三态 Optional[T]:
// 键缺席 = 未设置; 键存在但值为 JSON null = 置 null (value 已为 nil)。
func optionalField[T any](
	fields map[string]json.RawMessage,
	key string,
	value *T,
) optional.Optional[T] {
	_, set := fields[key]
	return optional.Optional[T]{Set: set, Value: value}
}

// optionalEnumField 是 optionalField 的枚举变体: 把 *E (枚举字符串) 转为 Optional[string]。
func optionalEnumField[E ~string](
	fields map[string]json.RawMessage,
	key string,
	value *E,
) optional.Optional[string] {
	if value == nil {
		return optionalField[string](fields, key, nil)
	}
	converted := string(*value)
	return optionalField(fields, key, &converted)
}

// optionalDecimalField 是 optionalField 的 decimal 变体: 值以十进制字符串传输。
func optionalDecimalField(
	fields map[string]json.RawMessage,
	key string,
	value *string,
	resource string,
) (optional.Optional[decimal.Decimal], error) {
	_, set := fields[key]
	if !set || value == nil {
		return optional.Optional[decimal.Decimal]{Set: set}, nil
	}
	parsed, err := decimalInput(*value, resource, key)
	if err != nil {
		return optional.Optional[decimal.Decimal]{}, err
	}
	return optional.Optional[decimal.Decimal]{Set: true, Value: &parsed}, nil
}

// optionalUpdate 解析单个 json.RawMessage 形式的可空 PATCH 字段:
// raw 为 nil (键缺席) = 未设置; "null" = 置 null; 其余解码为新值。
func optionalUpdate[T any](raw json.RawMessage) (optional.Optional[T], error) {
	if raw == nil {
		return optional.Optional[T]{}, nil
	}
	var value *T
	if err := json.Unmarshal(raw, &value); err != nil {
		return optional.Optional[T]{}, err
	}
	return optional.Optional[T]{Set: true, Value: value}, nil
}

// optionalDateUpdate 是 optionalUpdate 的日期变体: 值必须是 YYYY-MM-DD 或 null。
func optionalDateUpdate(raw json.RawMessage) (optional.Optional[time.Time], error) {
	if raw == nil {
		return optional.Optional[time.Time]{}, nil
	}
	var value *openapi_types.Date
	if err := json.Unmarshal(raw, &value); err != nil {
		return optional.Optional[time.Time]{}, err
	}
	if value == nil {
		return optional.Optional[time.Time]{Set: true}, nil
	}
	date := value.Time
	return optional.Optional[time.Time]{Set: true, Value: &date}, nil
}

// optionalDecimalUpdate 是 optionalUpdate 的 decimal 变体: 值必须是十进制数字字符串或 null。
func optionalDecimalUpdate(
	raw json.RawMessage,
	resource string,
	field string,
) (optional.Optional[decimal.Decimal], error) {
	if raw == nil {
		return optional.Optional[decimal.Decimal]{}, nil
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil {
		return optional.Optional[decimal.Decimal]{}, apierror.Validation(resource+"参数不合法", map[string][]string{
			field: {"必须是十进制数字字符串或 null"},
		})
	}
	if value == nil {
		return optional.Optional[decimal.Decimal]{Set: true}, nil
	}
	parsed, err := decimalInput(*value, resource, field)
	if err != nil {
		return optional.Optional[decimal.Decimal]{}, err
	}
	return optional.Optional[decimal.Decimal]{Set: true, Value: &parsed}, nil
}

// doublePtr 把三态 Optional[T] 转回 **T, 仅用于仍声明 **T 输入的
// platform 包 (settings/files/printing 等) 边界, 不得用于新代码。
func doublePtr[T any](value optional.Optional[T]) **T {
	if !value.Set {
		return nil
	}
	return &value.Value
}

func nullableStringError(resource, field string) error {
	return apierror.Validation(resource+"参数不合法", map[string][]string{
		field: {"必须是字符串或 null"},
	})
}

func nullableUUIDError(resource, field string) error {
	return apierror.Validation(resource+"参数不合法", map[string][]string{
		field: {"必须是 UUID 或 null"},
	})
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

func datePointer(value *openapi_types.Date) *time.Time {
	if value == nil {
		return nil
	}
	result := value.Time
	return &result
}
