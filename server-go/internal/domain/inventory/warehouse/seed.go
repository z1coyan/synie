package warehouse

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// SeedCompanyDefaults creates the three documented stock locations in the
// caller's transaction. It is intentionally idempotent for future repair use.
func SeedCompanyDefaults(ctx context.Context, tx pgx.Tx, actor *authz.Actor, companyID uuid.UUID, code string) (int, error) {
	queries := dbgen.New(tx)
	exists, err := queries.CompanyHasWarehouses(ctx, companyID)
	if err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "检查默认仓库失败", err)
	}
	if exists {
		return 0, nil
	}
	root, err := queries.CreateSeedWarehouse(ctx, dbgen.CreateSeedWarehouseParams{
		Name: code + " - 所有仓库", IsLeaf: false, CompanyID: companyID,
	})
	if err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "创建默认仓库失败", err)
	}
	rows := []dbgen.CreateSeedWarehouseRow{root}
	for _, name := range []string{code + " - 默认仓库", code + " - 在途"} {
		row, err := queries.CreateSeedWarehouse(ctx, dbgen.CreateSeedWarehouseParams{
			Name: name, IsLeaf: true, CompanyID: companyID, ParentID: &root.ID,
		})
		if err != nil {
			return 0, apierror.Wrap(apierror.CodeInternal, "创建默认仓库失败", err)
		}
		rows = append(rows, row)
	}
	for _, row := range rows {
		if err := audit.Write(ctx, tx, actor, audit.Entry{
			Resource: "inv_warehouse", RecordID: row.ID, RecordLabel: row.Name,
			ActionType: "create", ActionName: "create", CompanyID: &companyID,
			Changes: audit.Created(map[string]any{
				"name": row.Name, "is_leaf": row.IsLeaf, "active": row.Active,
				"is_outsourced": row.IsOutsourced, "allow_negative": row.AllowNegative,
				"company_id": row.CompanyID, "parent_id": row.ParentID,
				"account_id": row.AccountID, "party_type": row.PartyType, "party_id": row.PartyID,
			}, []string{"name", "is_leaf", "active", "is_outsourced", "allow_negative", "company_id", "parent_id", "account_id", "party_type", "party_id"}),
		}); err != nil {
			return 0, apierror.Wrap(apierror.CodeInternal, "记录默认仓库审计失败", err)
		}
	}
	return len(rows), nil
}
