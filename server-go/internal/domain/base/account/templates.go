package account

import (
	"context"
	_ "embed"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

//go:embed templates.json
var templateData []byte

type templateEntry struct {
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Direction string  `json:"direction"`
	IsGroup   bool    `json:"is_group"`
	Parent    *string `json:"parent"`
	Role      *string `json:"role"`
}

type TemplateResult struct {
	CreatedCount int `json:"createdCount"`
}

func (s *Service) InitializeTemplate(
	ctx context.Context,
	actor *authz.Actor,
	companyID uuid.UUID,
	template string,
) (TemplateResult, error) {
	key := strings.ToLower(strings.TrimSpace(template))
	var templates map[string][]templateEntry
	if err := json.Unmarshal(templateData, &templates); err != nil {
		return TemplateResult{}, apierror.Wrap(apierror.CodeInternal, "读取会计科目模板失败", err)
	}
	entries, ok := templates[key]
	if !ok {
		return TemplateResult{}, apierror.Validation("会计科目模板参数不合法", map[string][]string{
			"template": {"仅支持 CAS/SMALL/INTL"},
		})
	}
	if !actor.CanAccessCompany(companyID) {
		return TemplateResult{}, apierror.New(apierror.CodeForbidden, "无权访问该公司")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TemplateResult{}, apierror.Wrap(apierror.CodeInternal, "初始化会计科目失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockTree(ctx, tx, companyID); err != nil {
		return TemplateResult{}, err
	}
	var companyExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM bas_company WHERE id = $1)`, companyID).Scan(&companyExists); err != nil {
		return TemplateResult{}, apierror.Wrap(apierror.CodeInternal, "校验公司失败", err)
	}
	if !companyExists {
		return TemplateResult{}, apierror.Validation("会计科目模板参数不合法", map[string][]string{"companyId": {"公司不存在"}})
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM bas_account WHERE company_id = $1`, companyID).Scan(&count); err != nil {
		return TemplateResult{}, apierror.Wrap(apierror.CodeInternal, "检查公司科目失败", err)
	}
	if count != 0 {
		return TemplateResult{}, apierror.New(apierror.CodeConflict, "该公司已有会计科目，不能重复初始化")
	}

	parentIDs := make(map[string]uuid.UUID, len(entries))
	for _, entry := range entries {
		var parentID *uuid.UUID
		if entry.Parent != nil {
			id, exists := parentIDs[*entry.Parent]
			if !exists {
				return TemplateResult{}, apierror.New(apierror.CodeInternal, "会计科目模板父子顺序不合法")
			}
			parentID = &id
		}
		role := entry.Role
		if role != nil {
			normalized := strings.ToUpper(*role)
			role = &normalized
		}
		var item Account
		err := tx.QueryRow(ctx, `
			INSERT INTO bas_account (
				code, name, direction, is_group, active, role, parent_id, company_id
			) VALUES ($1, $2, $3, $4, true, $5, $6, $7)
			RETURNING id, code, name, direction, is_group, active, role,
			          parent_id, company_id, currency_id, inserted_at, updated_at
		`, entry.Code, entry.Name, strings.ToLower(entry.Direction), entry.IsGroup, role, parentID, companyID,
		).Scan(&item.ID, &item.Code, &item.Name, &item.Direction, &item.IsGroup, &item.Active,
			&item.Role, &item.ParentID, &item.CompanyID, &item.CurrencyID, &item.InsertedAt, &item.UpdatedAt)
		if err != nil {
			return TemplateResult{}, mapWriteError("初始化会计科目失败", err)
		}
		normalizeResult(&item)
		parentIDs[item.Code] = item.ID
		if err := audit.Write(ctx, tx, actor, audit.Entry{
			Resource: "bas_account", RecordID: item.ID, RecordLabel: item.Name, CompanyID: &companyID,
			ActionType: "create", ActionName: "init_from_template",
			Changes: audit.Created(snapshot(item), auditedFields),
		}); err != nil {
			return TemplateResult{}, apierror.Wrap(apierror.CodeInternal, "初始化会计科目失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return TemplateResult{}, mapWriteError("初始化会计科目失败", err)
	}
	return TemplateResult{CreatedCount: len(entries)}, nil
}
