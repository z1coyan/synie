package stock

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func seedPGFixture(
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture pgFixture,
	currencyID uuid.UUID,
	suffix string,
) error {
	batch := &pgx.Batch{}
	batch.Queue(
		`INSERT INTO bas_currency (id,name,iso_code,active) VALUES ($1,$2,$3,true)`,
		currencyID, "库存测试币-"+suffix, "I"+suffix,
	)
	batch.Queue(
		`INSERT INTO bas_company (id,code,name,short_name,base_currency_id)
		 VALUES ($1,$2,$3,$3,$4)`,
		fixture.companyID, "C"+suffix, "库存测试公司-"+suffix, currencyID,
	)
	batch.Queue(
		`INSERT INTO bas_unit (id,unit_type,is_base,name,symbol,ratio)
		 VALUES ($1,'quantity',false,$2,$3,1)`,
		fixture.unitID, "库存测试单位-"+suffix, "u"+suffix,
	)
	batch.Queue(
		`INSERT INTO inv_material_category (id,code,name,is_leaf,active)
		 VALUES ($1,$2,$3,true,true)`,
		fixture.categoryID, "CAT"+suffix, "库存测试分类-"+suffix,
	)
	batch.Queue(
		`INSERT INTO inv_material (id,code,name,category_id,default_unit_id)
		 VALUES ($1,$2,$3,$4,$5)`,
		fixture.materialID, "MAT"+suffix, "库存测试物料-"+suffix,
		fixture.categoryID, fixture.unitID,
	)
	batch.Queue(
		`INSERT INTO inv_warehouse (id,name,company_id,is_leaf,active,allow_negative)
		 VALUES ($1,$2,$3,true,true,false),($4,$5,$3,true,true,false)`,
		fixture.warehouseID, "库存主仓-"+suffix, fixture.companyID,
		fixture.otherWHID, "库存二仓-"+suffix,
	)
	results := pool.SendBatch(ctx, batch)
	return results.Close()
}
