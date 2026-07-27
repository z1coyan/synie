package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// FilteredPlaceholder 是敏感字段在审计日志中的脱敏占位符，保持与历史数据一致。
const FilteredPlaceholder = "[FILTERED]"

type Change map[string]any

type Entry struct {
	Resource    string
	RecordID    uuid.UUID
	RecordLabel string
	ActionType  string
	ActionName  string
	CompanyID   *uuid.UUID
	Changes     map[string]Change
	// SensitiveFields 由调用方从自己资源的 meta（AuditMeta.SensitiveFields）取出声明，
	// 写入前其中字段的变更值一律替换为 FilteredPlaceholder；为空时行为与之前一致。
	SensitiveFields []string
}

// FilterSensitive 返回脱敏后的 changes 副本：凡在 sensitiveFields 中声明的字段，
// 其 Change 内所有值（from/to 等）都替换为 FilteredPlaceholder，键结构保持不变。
// 未声明敏感字段或 changes 为空时原样返回，不复制。
func FilterSensitive(changes map[string]Change, sensitiveFields []string) map[string]Change {
	if len(changes) == 0 || len(sensitiveFields) == 0 {
		return changes
	}
	sensitive := make(map[string]struct{}, len(sensitiveFields))
	for _, field := range sensitiveFields {
		sensitive[field] = struct{}{}
	}
	filtered := make(map[string]Change, len(changes))
	for field, change := range changes {
		if _, ok := sensitive[field]; !ok {
			filtered[field] = change
			continue
		}
		redacted := make(Change, len(change))
		for key := range change {
			redacted[key] = FilteredPlaceholder
		}
		filtered[field] = redacted
	}
	return filtered
}

func Diff(before, after map[string]any, allowed []string) map[string]Change {
	changes := make(map[string]Change)
	for _, field := range allowed {
		from, to := before[field], after[field]
		if reflect.DeepEqual(from, to) {
			continue
		}
		changes[field] = Change{"from": from, "to": to}
	}
	return changes
}

func Created(after map[string]any, allowed []string) map[string]Change {
	changes := make(map[string]Change, len(allowed))
	for _, field := range allowed {
		changes[field] = Change{"to": after[field]}
	}
	return changes
}

func Destroyed(before map[string]any, allowed []string) map[string]Change {
	changes := make(map[string]Change, len(allowed))
	for _, field := range allowed {
		changes[field] = Change{"from": before[field]}
	}
	return changes
}

func Write(ctx context.Context, tx pgx.Tx, actor *authz.Actor, entry Entry) error {
	raw, err := json.Marshal(FilterSensitive(entry.Changes, entry.SensitiveFields))
	if err != nil {
		return fmt.Errorf("编码审计 diff: %w", err)
	}
	var actorID *uuid.UUID
	var actorName *string
	if actor != nil {
		actorID = &actor.UserID
		name := actor.Username
		actorName = &name
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO sys_audit_log (
			resource, record_id, record_label, action_type, action_name,
			actor_id, actor_name, company_id, changes
		) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9::jsonb)
	`, entry.Resource, entry.RecordID, entry.RecordLabel, entry.ActionType, entry.ActionName,
		actorID, actorName, entry.CompanyID, string(raw))
	if err != nil {
		return fmt.Errorf("写审计日志: %w", err)
	}
	return nil
}
