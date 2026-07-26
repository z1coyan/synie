package settings

import "github.com/z1coyan/synie/server/internal/db/dbgen"

func salesFromGet(row dbgen.GetSalesSettingRow) SalesSetting {
	return SalesSetting{
		ID: row.ID, SampleItemMaxQty: row.SampleItemMaxQty,
		DeliveryOvershipRatio:   row.DeliveryOvershipRatio,
		SpotItemMaxQty:          row.SpotItemMaxQty,
		ReceiptOverreceiveRatio: row.ReceiptOverreceiveRatio,
		DemandOverorderRatio:    row.DemandOverorderRatio,
		InsertedAt:              row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func salesFromLock(row dbgen.LockSalesSettingRow) SalesSetting {
	return SalesSetting{
		ID: row.ID, SampleItemMaxQty: row.SampleItemMaxQty,
		DeliveryOvershipRatio:   row.DeliveryOvershipRatio,
		SpotItemMaxQty:          row.SpotItemMaxQty,
		ReceiptOverreceiveRatio: row.ReceiptOverreceiveRatio,
		DemandOverorderRatio:    row.DemandOverorderRatio,
		InsertedAt:              row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func salesFromUpdate(row dbgen.UpdateSalesSettingRow) SalesSetting {
	return SalesSetting{
		ID: row.ID, SampleItemMaxQty: row.SampleItemMaxQty,
		DeliveryOvershipRatio:   row.DeliveryOvershipRatio,
		SpotItemMaxQty:          row.SpotItemMaxQty,
		ReceiptOverreceiveRatio: row.ReceiptOverreceiveRatio,
		DemandOverorderRatio:    row.DemandOverorderRatio,
		InsertedAt:              row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func manufacturingFromDB(row dbgen.MfgSetting) ManufacturingSetting {
	return ManufacturingSetting{
		ID: row.ID, OutputOverreceiveRatio: row.OutputOverreceiveRatio,
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func accountingFromGet(row dbgen.GetAccountingSettingRow) AccountingSetting {
	return AccountingSetting{
		ID: row.ID, OCRAccessKeyID: textPtr(row.OcrAccessKeyID),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func accountingFromDB(row dbgen.AccSetting) AccountingSetting {
	return AccountingSetting{
		ID: row.ID, OCRAccessKeyID: textPtr(row.OcrAccessKeyID),
		InsertedAt: row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func systemFromGet(row dbgen.GetSystemSettingRow) SystemSetting {
	return SystemSetting{
		ID: row.ID, MarketFetchScheduleEnabled: row.MarketFetchScheduleEnabled,
		MarketFetchLastIntervalMinutes: int(row.MarketFetchLastIntervalMinutes),
		MarketFetchSettlementEnabled:   row.MarketFetchSettlementEnabled,
		MarketFetchLastRunAt:           timestampPtr(row.MarketFetchLastRunAt),
		MarketFetchLastSummary:         textPtr(row.MarketFetchLastSummary),
		InsertedAt:                     row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func systemFromLock(row dbgen.LockSystemSettingRow) SystemSetting {
	return SystemSetting{
		ID: row.ID, MarketFetchScheduleEnabled: row.MarketFetchScheduleEnabled,
		MarketFetchLastIntervalMinutes: int(row.MarketFetchLastIntervalMinutes),
		MarketFetchSettlementEnabled:   row.MarketFetchSettlementEnabled,
		MarketFetchLastRunAt:           timestampPtr(row.MarketFetchLastRunAt),
		MarketFetchLastSummary:         textPtr(row.MarketFetchLastSummary),
		InsertedAt:                     row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func systemFromUpdate(row dbgen.UpdateSystemSettingRow) SystemSetting {
	return SystemSetting{
		ID: row.ID, MarketFetchScheduleEnabled: row.MarketFetchScheduleEnabled,
		MarketFetchLastIntervalMinutes: int(row.MarketFetchLastIntervalMinutes),
		MarketFetchSettlementEnabled:   row.MarketFetchSettlementEnabled,
		MarketFetchLastRunAt:           timestampPtr(row.MarketFetchLastRunAt),
		MarketFetchLastSummary:         textPtr(row.MarketFetchLastSummary),
		InsertedAt:                     row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}

func systemFromRecord(row dbgen.RecordMarketFetchRow) SystemSetting {
	return SystemSetting{
		ID: row.ID, MarketFetchScheduleEnabled: row.MarketFetchScheduleEnabled,
		MarketFetchLastIntervalMinutes: int(row.MarketFetchLastIntervalMinutes),
		MarketFetchSettlementEnabled:   row.MarketFetchSettlementEnabled,
		MarketFetchLastRunAt:           timestampPtr(row.MarketFetchLastRunAt),
		MarketFetchLastSummary:         textPtr(row.MarketFetchLastSummary),
		InsertedAt:                     row.InsertedAt.Time.UTC(), UpdatedAt: row.UpdatedAt.Time.UTC(),
	}
}
