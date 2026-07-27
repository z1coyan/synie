package httpapi

import (
	"encoding/json"
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
