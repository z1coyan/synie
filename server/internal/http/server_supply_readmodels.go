package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/z1coyan/synie/server/internal/domain/sales/companyaccountdefault"
	"github.com/z1coyan/synie/server/internal/domain/scm/orderflow"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

func companyAccountDefaultListQuery(body listBody) companyaccountdefault.ListQuery {
	limit, offset, _, sort, filter := listParts(body)
	return companyaccountdefault.ListQuery{Limit: limit, Offset: offset, Sort: sort, Filter: filter}
}

func (s *Server) QuerySalesCompanyAccountDefaults(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "sales.setting:read", companyAccountDefaultListQuery,
		s.CompanyAccountDefaults.List,
		func(result companyaccountdefault.ListResult) any {
			return gen.CompanyAccountDefaultsList{
				Count: result.Count, Results: mapItems(result.Results, companyAccountDefaultDTO),
			}
		})
}

func (s *Server) GetSalesCompanyAccountDefault(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, err := actorWithPermission(r, "sales.setting:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.CompanyAccountDefaults.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, companyAccountDefaultDTO(item))
}

func (s *Server) CreateSalesCompanyAccountDefault(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sales.setting:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.CompanyAccountDefaultsCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.CompanyAccountDefaults.Create(r.Context(), actor,
		companyaccountdefault.CreateInput{
			CompanyID:               body.CompanyId,
			DeliveryDebitAccountID:  body.DeliveryDebitAccountId,
			DeliveryCreditAccountID: body.DeliveryCreditAccountId,
			ReceiptDebitAccountID:   body.ReceiptDebitAccountId,
			ReceiptCreditAccountID:  body.ReceiptCreditAccountId,
		})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, companyAccountDefaultDTO(item))
}

type companyAccountDefaultUpdateBody struct {
	DeliveryDebitAccountID  json.RawMessage `json:"deliveryDebitAccountId,omitempty"`
	DeliveryCreditAccountID json.RawMessage `json:"deliveryCreditAccountId,omitempty"`
	ReceiptDebitAccountID   json.RawMessage `json:"receiptDebitAccountId,omitempty"`
	ReceiptCreditAccountID  json.RawMessage `json:"receiptCreditAccountId,omitempty"`
}

func (s *Server) UpdateSalesCompanyAccountDefault(
	w http.ResponseWriter,
	r *http.Request,
	id gen.ID,
) {
	actor, err := actorWithPermission(r, "sales.setting:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body companyAccountDefaultUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input, err := companyAccountDefaultUpdateInput(body)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.CompanyAccountDefaults.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, companyAccountDefaultDTO(item))
}

func companyAccountDefaultUpdateInput(
	body companyAccountDefaultUpdateBody,
) (companyaccountdefault.UpdateInput, error) {
	var input companyaccountdefault.UpdateInput
	for _, field := range []struct {
		name string
		raw  json.RawMessage
		out  *companyaccountdefault.OptionalUUID
	}{
		{"deliveryDebitAccountId", body.DeliveryDebitAccountID, &input.DeliveryDebitAccountID},
		{"deliveryCreditAccountId", body.DeliveryCreditAccountID, &input.DeliveryCreditAccountID},
		{"receiptDebitAccountId", body.ReceiptDebitAccountID, &input.ReceiptDebitAccountID},
		{"receiptCreditAccountId", body.ReceiptCreditAccountID, &input.ReceiptCreditAccountID},
	} {
		value, err := nullableUUIDUpdate(field.raw)
		if err != nil {
			return companyaccountdefault.UpdateInput{}, nullableUUIDError("公司默认过账科目", field.name)
		}
		if value != nil {
			*field.out = companyaccountdefault.OptionalUUID{Set: true, Value: *value}
		}
	}
	return input, nil
}

func companyAccountDefaultDTO(
	item companyaccountdefault.CompanyAccountDefault,
) gen.CompanyAccountDefaults {
	return gen.CompanyAccountDefaults{
		Id: item.ID, CompanyId: item.CompanyID,
		DeliveryDebitAccountId:  item.DeliveryDebitAccountID,
		DeliveryCreditAccountId: item.DeliveryCreditAccountID,
		ReceiptDebitAccountId:   item.ReceiptDebitAccountID,
		ReceiptCreditAccountId:  item.ReceiptCreditAccountID,
		InsertedAt:              item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
}

func (s *Server) QueryScmOrderFlowItems(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithAnyPermission(r,
		"purchase.receipt:read",
		"purchase.outsourced_issue:read",
		"purchase.outsourced_receipt:read",
		"sales.delivery:read",
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body listBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	orderID, orderItemID, err := takeOrderFlowAnchors(body.Filter)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	limit, offset, search, sort, filter := listParts(body)
	result, err := s.OrderFlowItems.List(r.Context(), actor, orderflow.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
		OrderID: orderID, OrderItemID: orderItemID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.ScmOrderFlowItem, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, orderFlowItemDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.ScmOrderFlowItemList{
		Count: result.Count, Results: items,
	})
}

func (s *Server) GetScmOrderFlowItem(
	w http.ResponseWriter,
	r *http.Request,
	id string,
) {
	actor, err := actorWithAnyPermission(r,
		"purchase.receipt:read",
		"purchase.outsourced_issue:read",
		"purchase.outsourced_receipt:read",
		"sales.delivery:read",
	)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.OrderFlowItems.Get(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, orderFlowItemDTO(item))
}

func takeOrderFlowAnchors(
	filter map[string]json.RawMessage,
) (*uuid.UUID, *uuid.UUID, error) {
	orderID, err := takeOrderFlowAnchor(filter, "orderId")
	if err != nil {
		return nil, nil, err
	}
	orderItemID, err := takeOrderFlowAnchor(filter, "orderItemId")
	if err != nil {
		return nil, nil, err
	}
	return orderID, orderItemID, nil
}

func takeOrderFlowAnchor(
	filter map[string]json.RawMessage,
	field string,
) (*uuid.UUID, error) {
	raw, exists := filter[field]
	if !exists {
		return nil, nil
	}
	var value struct {
		Kind   string   `json:"kind"`
		Op     string   `json:"op,omitempty"`
		Values []string `json:"values"`
	}
	if err := json.Unmarshal(raw, &value); err != nil ||
		value.Kind != "fk" || (value.Op != "" && value.Op != "in") ||
		len(value.Values) != 1 {
		return nil, orderFlowAnchorError(field)
	}
	id, err := uuid.Parse(strings.TrimSpace(value.Values[0]))
	if err != nil {
		return nil, orderFlowAnchorError(field)
	}
	delete(filter, field)
	return &id, nil
}

func orderFlowAnchorError(field string) error {
	return apierror.Validation("订单收发货历史筛选条件错误", map[string][]string{
		field: {"须为仅含一个 UUID 的 fk/in 筛选"},
	})
}

func orderFlowItemDTO(item orderflow.Item) gen.ScmOrderFlowItem {
	return gen.ScmOrderFlowItem{
		Id: item.ID, FlowType: gen.ScmFlowType(strings.ToUpper(item.FlowType)),
		VoucherNo:   item.VoucherNo,
		VoucherDate: openapi_types.Date{Time: item.VoucherDate},
		Status:      gen.ScmOrderFlowStatus(strings.ToUpper(item.Status)),
		CompanyId:   item.CompanyID, OrderId: item.OrderID, OrderItemId: item.OrderItemID,
		MaterialCode: item.MaterialCode, MaterialName: item.MaterialName,
		MaterialSpec: item.MaterialSpec, CustomerPartNo: item.CustomerPartNo,
		UnitName: item.UnitName, Qty: item.Qty.String(),
	}
}
