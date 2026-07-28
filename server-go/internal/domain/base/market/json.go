package market

import "encoding/json"

func (item ChartInstrument) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{
		"id": item.ID, "instrumentId": item.InstrumentID, "code": item.Code, "name": item.Name,
		"currencyId": item.CurrencyID, "unitId": item.UnitID, "currencyCode": item.CurrencyCode,
		"unitName": item.UnitName, "defaultPriceKind": item.DefaultPriceKind,
	})
}
