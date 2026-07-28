package printing

// 单据装配 seam：把业务记录装配为渲染器的 PrintDoc（对齐 Elixir
// SynieCore.Printing.DocBuilder 的取值口径：值一律转字符串、空值归空串、
// 枚举渲染中文标签、布尔显示 是/否、日期/数字显示格式仍由单元格 Excel 格式承载）。
//
// Elixir 版靠 Ash 内省全资源通用装配；Go 侧按资源注册装配器（本期接入
// sales.order，对齐 print-engine 先例；新资源接入 = 注册一个 DocBuilder，
// 不改 Renderer/PdfConverter）。

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

// BuiltDoc 一份单据的装配结果：SheetName 供导出 sheet 名与单条文件名。
type BuiltDoc struct {
	SheetName string
	Doc       PrintDoc
}

// DocBuilder 按资源装配打印数据；实现须自行落实记录级数据权限（公司范围）。
type DocBuilder interface {
	// Label 资源中文名（批量文件名用，对齐 Elixir permission_label）
	Label() string
	BuildDocs(ctx context.Context, actor *authz.Actor, ids []uuid.UUID) ([]BuiltDoc, error)
}

// RegisterDocBuilder 注册资源装配器（NewService 已内置 sales.order）。
func (s *Service) RegisterDocBuilder(resource string, builder DocBuilder) {
	s.builders[resource] = builder
}

// SetPDFConverter 替换 PDF 转换器（测试降级/注入用）。
func (s *Service) SetPDFConverter(converter PDFConverter) {
	s.converter = converter
}

func (s *Service) pdfConverter() PDFConverter {
	if s.converter != nil {
		return s.converter
	}
	return NewSofficeConverterFromEnv()
}

// 格式化纪律：取值一律转字符串、空值归空串（对齐 Elixir DocBuilder.format）。

func formatDecimal(value decimal.Decimal) string { return value.String() }

// formatPtr 是「空指针归空串、非空走格式化」的统一形状。
func formatPtr[T any](value *T, format func(T) string) string {
	if value == nil {
		return ""
	}
	return format(*value)
}

func formatDecimalPtr(value *decimal.Decimal) string { return formatPtr(value, formatDecimal) }

func formatBool(value bool) string {
	if value {
		return "是"
	}
	return "否"
}

func formatBoolPtr(value *bool) string { return formatPtr(value, formatBool) }

// formatDate 对齐 Elixir Date.to_iso8601。
func formatDate(value time.Time) string { return value.Format("2006-01-02") }

// formatDateTime 对齐 Elixir NaiveDateTime.to_iso8601（库列为 timestamp without time zone）。
func formatDateTime(value time.Time) string { return value.Format("2006-01-02T15:04:05") }

func formatDateTimePtr(value *time.Time) string { return formatPtr(value, formatDateTime) }

func formatTextPtr(value *string) string {
	return formatPtr(value, func(text string) string { return text })
}

// 枚举中文标签（与 Elixir 枚举 values 描述一致，随类型定义同步维护）。

var salesOrderStatusLabels = map[string]string{
	"draft": "草稿", "audited": "已审核", "closed": "已关闭", "voided": "已作废",
}

var salesOrderTypeLabels = map[string]string{
	"regular": "常规订单", "sample": "样品订单",
}

var partyTypeLabels = map[string]string{
	"supplier": "供应商", "customer": "客户", "company": "内部公司", "employee": "员工",
}

var unitTypeLabels = map[string]string{
	"length": "长度", "area": "面积", "weight": "重量", "quantity": "数量",
}

var quotationPricingModeLabels = map[string]string{
	"fixed": "固定价", "qty_tiered": "数量梯度",
}

func enumLabel(labels map[string]string, value string) string {
	if value == "" {
		return ""
	}
	if label, ok := labels[value]; ok {
		return label
	}
	return value
}
