package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/finance/banking"
	"github.com/z1coyan/synie/server/internal/domain/finance/documents"
)

func financeBankingList(body listBody) banking.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return banking.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func financeDocumentsList(body listBody) documents.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return documents.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

// decodeFinanceJSON preserves the set of keys that appeared in a PATCH body,
// so an explicit JSON null remains distinguishable from an omitted field.
func decodeFinanceJSON(
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

func financeDate(value *openapi_types.Date) *string {
	if value == nil {
		return nil
	}
	formatted := value.Time.Format(time.DateOnly)
	return &formatted
}

func financeItemsJSON(items *[]map[string]interface{}) (string, error) {
	if items == nil {
		return "[]", nil
	}
	encoded, err := json.Marshal(*items)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func financeInvoiceResponse(item documents.VatInvoice) (map[string]any, error) {
	encoded, err := json.Marshal(item)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, err
	}
	var items []map[string]any
	if err := json.Unmarshal([]byte(item.Items), &items); err != nil {
		return nil, err
	}
	result["items"] = items
	return result, nil
}
