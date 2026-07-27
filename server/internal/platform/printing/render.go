package printing

// 打印/导出编排门面（移植 Elixir SynieCore.Printing.print/export 语义）：
// 鉴权 → 载模板文件 → 装配 doc → Renderer →（print 时）PdfConverter。
// 权限：print/batch_print/export 按资源权限码；记录级公司数据权限由装配器落实。
// 不写业务表、不写审计「打印事件」（v1 ADR：不留痕）。

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const (
	RenderModePrint  = "print"
	RenderModeExport = "export"

	maxRenderBatch = 100

	xlsxContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	pdfContentType  = "application/pdf"
)

type RenderInput struct {
	Resource   string
	Mode       string
	TemplateID uuid.UUID
	IDs        []uuid.UUID
}

type RenderOutput struct {
	Binary      []byte
	ContentType string
	Filename    string
}

// Render 执行模板打印（PDF）或模板导出（xlsx）。
func (s *Service) Render(ctx context.Context, actor *authz.Actor, input RenderInput) (RenderOutput, error) {
	if input.Mode != RenderModePrint && input.Mode != RenderModeExport {
		return RenderOutput{}, apierror.Validation("mode 须为 print 或 export",
			map[string][]string{"mode": {"须为 print 或 export"}})
	}
	if _, ok := s.catalog.Get(input.Resource); !ok {
		return RenderOutput{}, apierror.Validation("不支持的资源类型 "+input.Resource,
			map[string][]string{"resource": {"不在打印字段目录中"}})
	}
	if len(input.IDs) < 1 {
		return RenderOutput{}, apierror.Validation("请至少选择一条单据",
			map[string][]string{"ids": {"请至少选择一条单据"}})
	}
	if len(input.IDs) > maxRenderBatch {
		return RenderOutput{}, apierror.Validation("单次最多处理 100 条",
			map[string][]string{"ids": {"单次最多处理 100 条"}})
	}
	action := "export"
	if input.Mode == RenderModePrint {
		action = "print"
		if len(input.IDs) > 1 {
			action = "batch_print"
		}
	}
	if !actor.HasPermission(input.Resource + ":" + action) {
		return RenderOutput{}, apierror.New(apierror.CodeForbidden, "无权限执行该操作")
	}
	builder, ok := s.builders[input.Resource]
	if !ok {
		return RenderOutput{}, apierror.New(apierror.CodeNotImplemented,
			"资源 "+input.Resource+" 的模板打印暂未接入")
	}
	// 受信读：动作权限已校验；模板为全局主数据、无公司维度（对齐 Elixir 权限解耦决策）
	template, err := s.Get(ctx, input.TemplateID)
	if err != nil {
		return RenderOutput{}, err
	}
	if template.Resource != input.Resource {
		return RenderOutput{}, apierror.Validation("模板与单据资源类型不匹配",
			map[string][]string{"templateId": {"模板与单据资源类型不匹配"}})
	}
	if s.files == nil {
		return RenderOutput{}, apierror.New(apierror.CodeInternal, "文件读取服务未初始化")
	}
	if _, raw, err := s.files.ReadStoredFile(ctx, template.FileID); err != nil {
		return RenderOutput{}, apierror.Validation("无法读取模板文件",
			map[string][]string{"templateId": {"无法读取模板文件"}})
	} else {
		return s.renderWithTemplate(ctx, actor, builder, raw, input, len(input.IDs))
	}
}

func (s *Service) renderWithTemplate(
	ctx context.Context,
	actor *authz.Actor,
	builder DocBuilder,
	templateRaw []byte,
	input RenderInput,
	count int,
) (RenderOutput, error) {
	docs, err := builder.BuildDocs(ctx, actor, input.IDs)
	if err != nil {
		return RenderOutput{}, err
	}
	filename := renderFilename(builder.Label(), docs, input.Mode, count)
	if input.Mode == RenderModeExport {
		named := make([]NamedDoc, 0, len(docs))
		for _, doc := range docs {
			named = append(named, NamedDoc{Name: doc.SheetName, Doc: doc.Doc})
		}
		xlsx, renderErr := RenderSheets(templateRaw, named)
		if renderErr != nil {
			return RenderOutput{}, renderError(renderErr)
		}
		return RenderOutput{Binary: xlsx, ContentType: xlsxContentType, Filename: filename}, nil
	}
	printDocs := make([]PrintDoc, 0, len(docs))
	for _, doc := range docs {
		printDocs = append(printDocs, doc.Doc)
	}
	xlsx, renderErr := RenderPages(templateRaw, printDocs)
	if renderErr != nil {
		return RenderOutput{}, renderError(renderErr)
	}
	pdf, convertErr := s.pdfConverter().ConvertXlsxToPDF(ctx, xlsx)
	if convertErr != nil {
		return RenderOutput{}, convertError(convertErr)
	}
	return RenderOutput{Binary: pdf, ContentType: pdfContentType, Filename: filename}, nil
}

func renderFilename(label string, docs []BuiltDoc, mode string, count int) string {
	ext := ".pdf"
	if mode == RenderModeExport {
		ext = ".xlsx"
	}
	if count == 1 && len(docs) == 1 && docs[0].SheetName != "" {
		return docs[0].SheetName + ext
	}
	return label + "-批量-" + time.Now().Format("2006-01-02") + ext
}

func renderError(err error) error {
	if errors.Is(err, ErrEmptyDocs) {
		return apierror.Validation("请至少选择一条单据", map[string][]string{"ids": {"请至少选择一条单据"}})
	}
	return apierror.Validation(err.Error(), map[string][]string{"templateId": {err.Error()}})
}

// convertError 转换错误 → 中文文案（对齐 Elixir Printing.convert_pdf 映射）。
func convertError(err error) error {
	switch {
	case errors.Is(err, ErrSofficeNotFound):
		return apierror.New(apierror.CodeInternal,
			"PDF 转换服务不可用（未找到 LibreOffice），请使用导出 Excel 或联系管理员")
	case errors.Is(err, ErrSofficeTimeout):
		return apierror.New(apierror.CodeInternal, "PDF 转换超时，请减少批量条数或稍后重试")
	case errors.Is(err, ErrSofficeNoOutput):
		return apierror.New(apierror.CodeInternal, "PDF 转换未生成文件")
	default:
		var failed *ConvertFailedError
		if errors.As(err, &failed) && failed.Detail != "" {
			return apierror.New(apierror.CodeInternal, "PDF 转换失败: "+failed.Detail)
		}
		return apierror.New(apierror.CodeInternal, "PDF 转换失败")
	}
}
