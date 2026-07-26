package sampledata

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
)

const markerCustomerCode = "C01"

func ptr[T any](v T) *T { return &v }

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func daysAgo(n int) time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -n)
}

func dateString(t time.Time) string { return t.Format("2006-01-02") }

func alreadySeeded(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sal_customer WHERE code = $1)`, markerCustomerCode).Scan(&exists)
	if err != nil {
		return false, apierror.Wrap(apierror.CodeInternal, "检查示例数据标记失败", err)
	}
	return exists, nil
}

func unitBySymbol(ctx context.Context, pool *pgxpool.Pool, symbol string) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx, `SELECT id FROM bas_unit WHERE symbol = $1`, symbol).Scan(&id)
	if err != nil {
		return uuid.Nil, apierror.New(apierror.CodeConflict, fmt.Sprintf("示例数据需要计量单位 %s,请先完成初始化单位种子", symbol))
	}
	return id, nil
}

func leafCategory(ctx context.Context, pool *pgxpool.Pool, code string) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx, `SELECT id FROM inv_material_category WHERE code = $1`, code).Scan(&id)
	if err != nil {
		return uuid.Nil, apierror.New(apierror.CodeConflict, fmt.Sprintf("示例数据需要物料分类 %s,请先完成初始化分类种子", code))
	}
	return id, nil
}

func accountByCode(ctx context.Context, pool *pgxpool.Pool, companyID uuid.UUID, code string) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx, `SELECT id FROM bas_account WHERE company_id = $1 AND code = $2`, companyID, code).Scan(&id)
	if err != nil {
		return uuid.Nil, apierror.New(apierror.CodeConflict, fmt.Sprintf("示例数据需要科目 %s(按小企业会计准则模板),请先完成科目表初始化", code))
	}
	return id, nil
}

func warehouseBySuffix(ctx context.Context, pool *pgxpool.Pool, companyID uuid.UUID, suffix string) (uuid.UUID, string, error) {
	rows, err := pool.Query(ctx, `SELECT id, name FROM inv_warehouse WHERE company_id = $1`, companyID)
	if err != nil {
		return uuid.Nil, "", apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return uuid.Nil, "", apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
		}
		if strings.HasSuffix(name, suffix) {
			return id, name, nil
		}
	}
	if err := rows.Err(); err != nil {
		return uuid.Nil, "", apierror.Wrap(apierror.CodeInternal, "读取仓库失败", err)
	}
	return uuid.Nil, "", apierror.New(apierror.CodeConflict, fmt.Sprintf("示例数据需要名称以「%s」结尾的仓库,请先完成默认仓库种子", suffix))
}

func loadCompany(ctx context.Context, pool *pgxpool.Pool, companyID uuid.UUID) (companyInfo, error) {
	var c companyInfo
	err := pool.QueryRow(ctx, `
		SELECT id, code, name, short_name, base_currency_id
		FROM bas_company WHERE id = $1`, companyID).
		Scan(&c.ID, &c.Code, &c.Name, &c.ShortName, &c.BaseCurrencyID)
	if err != nil {
		return companyInfo{}, apierror.Wrap(apierror.CodeInternal, "读取示例数据公司失败", err)
	}
	return c, nil
}
