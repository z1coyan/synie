package stockdoc

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func seedDocFixture(
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture docFixture,
	currencyID uuid.UUID,
	suffix string,
) error {
	batch := &pgx.Batch{}
	batch.Queue(
		`INSERT INTO bas_currency (id,name,iso_code,active) VALUES ($1,$2,$3,true)`,
		currencyID, "单据测试币-"+suffix, "D"+suffix,
	)
	batch.Queue(
		`INSERT INTO bas_company (id,code,name,short_name,base_currency_id)
		 VALUES ($1,$2,$3,$3,$4)`,
		fixture.companyID, "D"+suffix, "单据测试公司-"+suffix, currencyID,
	)
	batch.Queue(
		`INSERT INTO sys_user (id,username,name,hashed_password,super_admin,all_companies)
		 VALUES ($1,$2,$3,'test',true,true)`,
		fixture.userID, "doc-"+suffix, "单据测试用户-"+suffix,
	)
	batch.Queue(
		`INSERT INTO bas_unit (id,unit_type,is_base,name,symbol,ratio)
		 VALUES ($1,'weight',false,$2,$3,1),($4,'quantity',false,$5,$6,1)`,
		fixture.unitID, "千克-"+suffix, "kg"+suffix,
		fixture.boxID, "箱-"+suffix, "box"+suffix,
	)
	batch.Queue(
		`INSERT INTO inv_material_category (id,code,name,is_leaf,active)
		 VALUES ($1,$2,$3,true,true)`,
		fixture.categoryID, "DCAT"+suffix, "单据测试分类-"+suffix,
	)
	batch.Queue(
		`INSERT INTO inv_material (id,code,name,spec,category_id,default_unit_id)
		 VALUES ($1,$2,$3,'M6x20',$4,$5)`,
		fixture.materialID, "DMAT"+suffix, "单据测试物料-"+suffix,
		fixture.categoryID, fixture.unitID,
	)
	batch.Queue(
		`INSERT INTO inv_material_unit (id,material_id,unit_id,factor)
		 VALUES ($1,$2,$3,10)`,
		uuid.New(), fixture.materialID, fixture.boxID,
	)
	batch.Queue(
		`INSERT INTO inv_warehouse (id,name,company_id,is_leaf,active,allow_negative)
		 VALUES ($1,$2,$3,true,true,false)`,
		fixture.warehouseID, "单据测试仓-"+suffix, fixture.companyID,
	)
	results := pool.SendBatch(ctx, batch)
	return results.Close()
}
