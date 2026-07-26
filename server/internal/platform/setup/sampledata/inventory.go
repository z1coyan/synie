package sampledata

import (
	"context"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockcount"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockdoc"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stocktransfer"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func seedOpeningStock(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData,
) (int, error) {
	if _, err := createStockDoc(ctx, deps, actor, sc, stockdoc.DirectionIn, sc.Warehouses.Default, 85,
		"期初建账入库(材料与通用件)", []struct {
			key string
			qty int64
		}{
			{"box_shell", 100}, {"busbar", 100}, {"mount_plate", 80}, {"terminal_assy", 80},
			{"terminal_block", 2000}, {"copper_terminal", 3000}, {"rail", 300}, {"copper_bar", 300},
			{"screw", 8000}, {"insul_sleeve", 600}, {"carton", 1000}, {"stretch_film", 100},
		}, md); err != nil {
		return 0, err
	}
	if _, err := createStockDoc(ctx, deps, actor, sc, stockdoc.DirectionIn, sc.Warehouses.Finished, 80,
		"期初建账入库(成品)", []struct {
			key string
			qty int64
		}{
			{"box_shell", 60}, {"busbar", 60}, {"mount_plate", 40}, {"terminal_assy", 40},
		}, md); err != nil {
		return 0, err
	}
	return 2, nil
}

func seedInventoryDocuments(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData,
) (invDocsResult, error) {
	if _, err := createStockDoc(ctx, deps, actor, sc, stockdoc.DirectionOut, sc.Warehouses.Default, 20,
		"生产领料出库", []struct {
			key string
			qty int64
		}{
			{"copper_rod", 120}, {"steel_sheet", 60}, {"copper_bar", 40}, {"screw", 1500},
		}, md); err != nil {
		return invDocsResult{}, err
	}
	if err := seedTransfer(ctx, deps, actor, sc, md); err != nil {
		return invDocsResult{}, err
	}
	if err := seedStockCount(ctx, deps, actor, sc, md); err != nil {
		return invDocsResult{}, err
	}
	return invDocsResult{StockDocs: 1}, nil
}

func createStockDoc(
	ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx,
	direction stockdoc.Direction, warehouseID uuid.UUID, dateAgo int, summary string,
	items []struct {
		key string
		qty int64
	},
	md masterData,
) (uuid.UUID, error) {
	docDate := daysAgo(dateAgo)
	doc, err := deps.StockDocs.Create(ctx, actor, stockdoc.CreateInput{
		Direction: direction, DocDate: &docDate, Summary: ptr(summary),
		Remarks: ptr("初始化示例库存单据"), CompanyID: sc.Company.ID, WarehouseID: warehouseID,
	})
	if err != nil {
		return uuid.Nil, err
	}
	for i, line := range items {
		mat := md.Materials[line.key]
		if _, err := deps.StockDocs.CreateItem(ctx, actor, stockdoc.CreateItemInput{
			StockDocID: doc.ID, Idx: int64(i + 1), Qty: decimal.NewFromInt(line.qty),
			MaterialID: mat.ID, UnitID: mat.DefaultUnitID,
		}); err != nil {
			return uuid.Nil, err
		}
	}
	if _, err := deps.StockDocs.Audit(ctx, actor, doc.ID); err != nil {
		return uuid.Nil, err
	}
	return doc.ID, nil
}

func seedTransfer(ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData) error {
	docDate := daysAgo(10)
	transfer, err := deps.StockTransfers.Create(ctx, actor, stocktransfer.CreateInput{
		DocDate: &docDate, Summary: ptr("成品转仓调拨"), Remarks: ptr("初始化示例调拨单"),
		CompanyID: sc.Company.ID, FromWarehouseID: sc.Warehouses.Default,
		ToWarehouseID: sc.Warehouses.Finished, TransitWarehouseID: sc.Warehouses.Transit,
	})
	if err != nil {
		return err
	}
	lines := []struct {
		key string
		qty int64
	}{{"box_shell", 15}, {"terminal_block", 400}}
	itemIDs := make([]uuid.UUID, 0, len(lines))
	for i, line := range lines {
		mat := md.Materials[line.key]
		item, err := deps.StockTransfers.CreateItem(ctx, actor, stocktransfer.CreateItemInput{
			StockTransferID: transfer.ID, Idx: int64(i + 1), Qty: decimal.NewFromInt(line.qty),
			MaterialID: mat.ID, UnitID: mat.DefaultUnitID,
		})
		if err != nil {
			return err
		}
		itemIDs = append(itemIDs, item.ID)
	}
	if _, err := deps.StockTransfers.Ship(ctx, actor, transfer.ID); err != nil {
		return err
	}
	if _, err := deps.StockTransfers.Receive(ctx, actor, transfer.ID, stocktransfer.ReceiveInput{
		Receipts: []stocktransfer.Receipt{
			{ItemID: itemIDs[0], Qty: decimal.NewFromInt(15)},
			{ItemID: itemIDs[1], Qty: decimal.NewFromInt(250)},
		},
	}); err != nil {
		return err
	}
	return nil
}

func seedStockCount(ctx context.Context, deps Dependencies, actor *authz.Actor, sc seedCtx, md masterData) error {
	postingDate := daysAgo(3)
	count, err := deps.StockCounts.Create(ctx, actor, stockcount.CreateInput{
		PostingDate: &postingDate, Summary: ptr("月末例行盘点"), Remarks: ptr("初始化示例盘点单"),
		CompanyID: sc.Company.ID, WarehouseID: sc.Warehouses.Default, LoadAll: true,
	})
	if err != nil {
		return err
	}
	items, err := deps.StockCounts.ListItems(ctx, actor, count.ID)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return apierror.New(apierror.CodeConflict, "示例数据盘点整仓带出失败:默认仓库无账面余额")
	}
	screwID := md.Materials["screw"].ID
	railID := md.Materials["rail"].ID
	for _, item := range items {
		counted := item.BookQuantity
		switch item.MaterialID {
		case screwID:
			counted = item.BookQuantity.Sub(decimal.NewFromInt(50))
		case railID:
			counted = item.BookQuantity.Add(decimal.NewFromInt(5))
		}
		countedPtr := counted
		countedField := &countedPtr
		if _, err := deps.StockCounts.UpdateItem(ctx, actor, item.ID, stockcount.UpdateItemInput{
			CountedQuantity: &countedField,
		}); err != nil {
			return err
		}
	}
	if _, err := deps.StockCounts.Approve(ctx, actor, count.ID); err != nil {
		return err
	}
	return nil
}
