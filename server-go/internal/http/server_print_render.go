package httpapi

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/printing"
)

// RenderPrintOutput 单据模板打印/导出：二进制文件流直出（对齐 Elixir PrintController
// POST /api/print 语义），PDF / xlsx 经 Content-Disposition 附件名下发。
func (s *Server) RenderPrintOutput(w http.ResponseWriter, r *http.Request) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PrintRenderRequest
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	ids := make([]uuid.UUID, 0, len(body.Ids))
	for _, id := range body.Ids {
		ids = append(ids, id)
	}
	output, err := s.Printing.Render(r.Context(), actor, printing.RenderInput{
		Resource:   strings.TrimSpace(body.Resource),
		Mode:       string(body.Mode),
		TemplateID: body.TemplateId,
		IDs:        ids,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", output.ContentType)
	w.Header().Set("Content-Disposition",
		`attachment; filename="`+encodePrintFilename(output.Filename)+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(output.Binary)
}

// encodePrintFilename 非 ASCII 文件名按 URL 编码（对齐 Elixir encode_filename 回退）。
func encodePrintFilename(name string) string {
	ascii := true
	for _, r := range name {
		if r < 0x20 || r > 0x7E {
			ascii = false
			break
		}
	}
	if ascii {
		return name
	}
	return url.PathEscape(name)
}
