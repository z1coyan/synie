package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/settings"
)

type accountingSettingUpdateBody struct {
	OCRAccessKeyID     json.RawMessage `json:"ocrAccessKeyId,omitempty"`
	OCRAccessKeySecret *string         `json:"ocrAccessKeySecret,omitempty"`
}

func (s *Server) GetSalesSetting(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "sales.setting:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.settings.GetSales(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, salesSettingDTO(value))
}

func (s *Server) UpdateSalesSetting(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sales.setting:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.SalesSettingUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := settings.SalesUpdate{
		SampleItemMaxQty: body.SampleItemMaxQty,
		SpotItemMaxQty:   body.SpotItemMaxQty,
	}
	if input.DeliveryOvershipRatio, err = decimalPointer(body.DeliveryOvershipRatio, "deliveryOvershipRatio"); err != nil {
		s.writeError(w, r, err)
		return
	}
	if input.ReceiptOverreceiveRatio, err = decimalPointer(body.ReceiptOverreceiveRatio, "receiptOverreceiveRatio"); err != nil {
		s.writeError(w, r, err)
		return
	}
	if input.DemandOverorderRatio, err = decimalPointer(body.DemandOverorderRatio, "demandOverorderRatio"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.settings.UpdateSales(r.Context(), actor, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, salesSettingDTO(value))
}

func (s *Server) GetManufacturingSetting(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "mfg.setting:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.settings.GetManufacturing(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, manufacturingSettingDTO(value))
}

func (s *Server) UpdateManufacturingSetting(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "mfg.setting:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.ManufacturingSettingUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	ratio, err := decimalPointer(body.OutputOverreceiveRatio, "outputOverreceiveRatio")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.settings.UpdateManufacturing(r.Context(), actor, settings.ManufacturingUpdate{
		OutputOverreceiveRatio: ratio,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, manufacturingSettingDTO(value))
}

func (s *Server) GetAccountingSetting(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "acc.setting:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.settings.GetAccounting(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, accountingSettingDTO(value))
}

func (s *Server) UpdateAccountingSetting(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.setting:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body accountingSettingUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var keyID **string
	if body.OCRAccessKeyID != nil {
		var value *string
		if string(body.OCRAccessKeyID) != "null" {
			var decoded string
			if err := json.Unmarshal(body.OCRAccessKeyID, &decoded); err != nil {
				s.writeError(w, r, invalidJSON(err))
				return
			}
			value = &decoded
		}
		keyID = &value
	}
	value, err := s.settings.UpdateAccounting(r.Context(), actor, settings.AccountingUpdate{
		OCRAccessKeyID: keyID, OCRAccessKeySecret: body.OCRAccessKeySecret,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, accountingSettingDTO(value))
}

func (s *Server) GetAccountingOCRConfigured(w http.ResponseWriter, r *http.Request) {
	if _, err := requireActor(r); err != nil {
		s.writeError(w, r, err)
		return
	}
	configured, err := s.settings.OCRConfigured(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.OCRConfigured{Configured: configured})
}

func (s *Server) GetSystemSetting(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "sys.setting:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.settings.GetSystem(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, systemSettingDTO(value))
}

func (s *Server) UpdateSystemSetting(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sys.setting:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.SystemSettingUpdate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var interval *int
	if body.MarketFetchLastIntervalMinutes != nil {
		value := int(*body.MarketFetchLastIntervalMinutes)
		interval = &value
	}
	value, err := s.settings.UpdateSystem(r.Context(), actor, settings.SystemUpdate{
		MarketFetchScheduleEnabled:     body.MarketFetchScheduleEnabled,
		MarketFetchLastIntervalMinutes: interval,
		MarketFetchSettlementEnabled:   body.MarketFetchSettlementEnabled,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, systemSettingDTO(value))
}

func decimalPointer(raw *string, field string) (*decimal.Decimal, error) {
	if raw == nil {
		return nil, nil
	}
	value, err := decimal.NewFromString(*raw)
	if err != nil {
		return nil, apierror.Validation("小数格式不合法", map[string][]string{field: {"必须是十进制字符串"}})
	}
	return &value, nil
}

func salesSettingDTO(value settings.SalesSetting) gen.SalesSetting {
	return gen.SalesSetting{
		Id: value.ID, SampleItemMaxQty: value.SampleItemMaxQty,
		DeliveryOvershipRatio:   value.DeliveryOvershipRatio.String(),
		SpotItemMaxQty:          value.SpotItemMaxQty,
		ReceiptOverreceiveRatio: value.ReceiptOverreceiveRatio.String(),
		DemandOverorderRatio:    value.DemandOverorderRatio.String(),
		InsertedAt:              value.InsertedAt, UpdatedAt: value.UpdatedAt,
	}
}

func manufacturingSettingDTO(value settings.ManufacturingSetting) gen.ManufacturingSetting {
	return gen.ManufacturingSetting{
		Id: value.ID, OutputOverreceiveRatio: value.OutputOverreceiveRatio.String(),
		InsertedAt: value.InsertedAt, UpdatedAt: value.UpdatedAt,
	}
}

func accountingSettingDTO(value settings.AccountingSetting) gen.AccountingSetting {
	return gen.AccountingSetting{
		Id: value.ID, OcrAccessKeyId: value.OCRAccessKeyID,
		InsertedAt: value.InsertedAt, UpdatedAt: value.UpdatedAt,
	}
}

func systemSettingDTO(value settings.SystemSetting) gen.SystemSetting {
	return gen.SystemSetting{
		Id:                             value.ID,
		MarketFetchScheduleEnabled:     value.MarketFetchScheduleEnabled,
		MarketFetchLastIntervalMinutes: gen.SystemSettingMarketFetchLastIntervalMinutes(value.MarketFetchLastIntervalMinutes),
		MarketFetchSettlementEnabled:   value.MarketFetchSettlementEnabled,
		MarketFetchLastRunAt:           value.MarketFetchLastRunAt,
		MarketFetchLastSummary:         value.MarketFetchLastSummary,
		InsertedAt:                     value.InsertedAt, UpdatedAt: value.UpdatedAt,
	}
}
