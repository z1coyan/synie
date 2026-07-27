// Package optional 提供全系统唯一的三态可选字段机制,
// 用于 PATCH 语义中区分「字段未传 / 显式置 null / 设置为值」。
//
// 历史背景: 系统曾并存两套机制——`**string` 双重指针与各领域包
// 各自重复声明的 OptionalString{Set, Value} 结构体。两者三态表达能力一致
// (OptionalString 的 Value *string 同样能表达「显式置空字符串」,
// 即 Set=true 且 Value 指向空串), 本包将其统一为泛型 Optional[T]。
package optional

// Optional[T] 表示一个可缺省的更新字段, 三态语义:
//   - 未设置:   Set=false (Value 无意义), 端点不得修改该字段
//   - 置 null:  Set=true 且 Value=nil, 端点应将字段清空
//   - 设置为值: Set=true 且 Value 指向新值 (可为空字符串等零值)
//
// 与旧机制的映射:
//   - **T 的 nil        -> Optional[T]{}
//   - **T 的 &nil       -> Optional[T]{Set: true}
//   - **T 的 &(&v)      -> Optional[T]{Set: true, Value: &v}
//   - OptionalString{Set, Value} -> Optional[string]{Set, Value} (逐字段同构)
type Optional[T any] struct {
	Set   bool
	Value *T
}

// Of 构造「设置为值」。
func Of[T any](value T) Optional[T] {
	return Optional[T]{Set: true, Value: &value}
}

// Null 构造「显式置 null」。
func Null[T any]() Optional[T] {
	return Optional[T]{Set: true}
}

// Unset 构造「未设置」。
func Unset[T any]() Optional[T] {
	return Optional[T]{}
}

// Apply 把三态更新落到目标可空字段上: 未设置时保持原值,
// 否则以 Value (可为 nil) 覆盖。target 通常为实体的 *T 字段地址。
func Apply[T any](target **T, value Optional[T]) {
	if value.Set {
		*target = value.Value
	}
}

// Map 对 Optional[T] 的值做类型转换, 保留 Set 与 null 语义。
func Map[T any, U any](value Optional[T], convert func(T) U) Optional[U] {
	if !value.Set {
		return Optional[U]{}
	}
	if value.Value == nil {
		return Optional[U]{Set: true}
	}
	converted := convert(*value.Value)
	return Optional[U]{Set: true, Value: &converted}
}
