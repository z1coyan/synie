// Package pgconv 收敛各领域包重复抄写的 pgtype 转换助手。
//
// 历史副本存在细微语义差异，本包按语义分别导出函数，迁移时按原实现
// 逐一对应，保证行为不变：
//   - Date/DateAlways/DateUTC 对应三种 date 变体（零值无效 / 恒有效 / UTC+恒有效）
//   - Text/TextPtr 对应 text、toText/fromText、textPtr、optionalText(pgtype.Text)
//   - OptionalText 对应返回 any 的 text/optionalText 变体
package pgconv

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Text 将可空字符串转为 pgtype.Text（nil → invalid）。
func Text(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

// TextPtr 将 pgtype.Text 转为可空字符串（invalid → nil）。
func TextPtr(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

// OptionalText 将可空字符串转为数据库参数（nil → nil，否则为字符串值）。
func OptionalText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// Date 将时间转为 pgtype.Date，零值视为无效。
func Date(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value, Valid: !value.IsZero()}
}

// DateAlways 将时间转为 pgtype.Date，恒为有效（不做零值判断、不做 UTC 归一）。
func DateAlways(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value, Valid: true}
}

// DateUTC 将时间转为 pgtype.Date，先归一到 UTC 且恒为有效。
func DateUTC(value time.Time) pgtype.Date {
	return pgtype.Date{Time: value.UTC(), Valid: true}
}

// Timestamp 将时间转为 pgtype.Timestamp，零值视为无效。
func Timestamp(value time.Time) pgtype.Timestamp {
	return pgtype.Timestamp{Time: value, Valid: !value.IsZero()}
}

// TimestampAlways 将时间转为 pgtype.Timestamp，恒为有效。
func TimestampAlways(value time.Time) pgtype.Timestamp {
	return pgtype.Timestamp{Time: value, Valid: true}
}

// NullableDate 将可空时间转为 pgtype.Date（nil → invalid，否则恒有效）。
func NullableDate(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return DateAlways(*value)
}

// OptionalDate 将 pgtype.Date 转为可空时间（invalid → nil）。
func OptionalDate(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}

// OptionalTime 将 pgtype.Timestamp 转为可空 UTC 时间（invalid → nil）。
func OptionalTime(value pgtype.Timestamp) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC()
	return &result
}

// DateValue 将 pgtype.Date 转为 time.Time（invalid → 零值）。
func DateValue(value pgtype.Date) time.Time {
	if !value.Valid {
		return time.Time{}
	}
	return value.Time
}
