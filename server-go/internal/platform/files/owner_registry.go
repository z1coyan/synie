package files

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// OwnerSpec 描述一个可挂附件的宿主资源：宿主表名、读权限前缀与是否公司隔离。
// 归属关系由各领域包声明（FileOwnerSpecs），启动时经 metaregistry 统一注册，
// platform 层不再硬编码任何领域表名或权限前缀。
type OwnerSpec struct {
	Table            string
	PermissionPrefix string
	CompanyScoped    bool
}

var (
	ownerMu       sync.RWMutex
	ownerRegistry = map[string]OwnerSpec{}
)

// RegisterOwner 注册一个附件宿主类型。与 meta.Registry.MustRegister 同一先例：
// 注册名冲突或 spec 不完整即 panic（启动期 fail-fast）。
func RegisterOwner(ownerType string, spec OwnerSpec) {
	if ownerType == "" || spec.Table == "" || spec.PermissionPrefix == "" {
		panic(fmt.Sprintf("files: 附件宿主注册不完整 (ownerType=%q)", ownerType))
	}
	ownerMu.Lock()
	defer ownerMu.Unlock()
	if _, exists := ownerRegistry[ownerType]; exists {
		panic("重复附件宿主注册: " + ownerType)
	}
	ownerRegistry[ownerType] = spec
}

// RegisteredOwners 返回当前注册表的副本，供装配测试对拍（防漏注册）。
func RegisteredOwners() map[string]OwnerSpec {
	ownerMu.RLock()
	defer ownerMu.RUnlock()
	snapshot := make(map[string]OwnerSpec, len(ownerRegistry))
	for ownerType, spec := range ownerRegistry {
		snapshot[ownerType] = spec
	}
	return snapshot
}

func lookupOwner(ownerType string) (OwnerSpec, bool) {
	ownerMu.RLock()
	defer ownerMu.RUnlock()
	spec, ok := ownerRegistry[ownerType]
	return spec, ok
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func resolveOwner(ctx context.Context, q rowQuerier, actor *authz.Actor, ownerType string, ownerID uuid.UUID) (*uuid.UUID, error) {
	spec, ok := lookupOwner(ownerType)
	if !ok {
		return nil, apierror.Validation("未知的宿主类型", map[string][]string{"ownerType": {"不在允许的附件宿主白名单"}})
	}
	if !actor.HasPermission(spec.PermissionPrefix + ":read") {
		return nil, apierror.New(apierror.CodeForbidden, "无权访问该宿主记录")
	}
	if !spec.CompanyScoped {
		var exists bool
		if err := q.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM "+spec.Table+" WHERE id = $1)", ownerID).Scan(&exists); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "校验附件宿主失败", err)
		}
		if !exists {
			return nil, apierror.New(apierror.CodeForbidden, "无权访问该宿主记录")
		}
		return nil, nil
	}
	var companyID uuid.UUID
	err := q.QueryRow(ctx, "SELECT company_id FROM "+spec.Table+" WHERE id = $1", ownerID).Scan(&companyID)
	if errors.Is(err, pgx.ErrNoRows) || !actor.CanAccessCompany(companyID) {
		return nil, apierror.New(apierror.CodeForbidden, "无权访问该宿主记录")
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "校验附件宿主失败", err)
	}
	return &companyID, nil
}
