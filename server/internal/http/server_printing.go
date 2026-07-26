package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/printing"
)

const printingPermission = "sys.print_template"

type printTemplateUpdateBody struct {
	Name    *string         `json:"name,omitempty"`
	FileID  *uuid.UUID      `json:"fileId,omitempty"`
	Remarks json.RawMessage `json:"remarks,omitempty"`
}

func (s *Server) ListPrintResources(w http.ResponseWriter, r *http.Request) {
	if _, err := requireActor(r); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, gen.PrintResourceList{
		Resources: s.printing.Catalog().Resources(),
	})
}

func (s *Server) GetPrintFieldCatalog(
	w http.ResponseWriter,
	r *http.Request,
	params gen.GetPrintFieldCatalogParams,
) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if !printing.CanUseTemplates(actor, params.Resource) {
		s.writeError(w, r, apierror.New(apierror.CodeForbidden, "无权查看该资源的打印字段目录"))
		return
	}
	value, ok := s.printing.Catalog().Get(params.Resource)
	if !ok {
		s.writeError(w, r, apierror.Validation("不支持的资源类型 "+params.Resource, map[string][]string{"resource": {"不在打印字段目录中"}}))
		return
	}
	s.writeJSON(w, http.StatusOK, printCatalogDTO(value))
}

func (s *Server) ListUsablePrintTemplates(
	w http.ResponseWriter,
	r *http.Request,
	params gen.ListUsablePrintTemplatesParams,
) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	values, err := s.printing.ListUsable(r.Context(), actor, params.Resource)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	results := make([]gen.PrintTemplate, 0, len(values))
	for _, value := range values {
		results = append(results, printTemplateDTO(value))
	}
	s.writeJSON(w, http.StatusOK, gen.PrintTemplateList{
		Count: int64(len(results)), Results: results,
	})
}

func (s *Server) QuerySysPrintTemplates(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, printingPermission+":read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Limit  *int                       `json:"limit,omitempty"`
		Offset *int                       `json:"offset,omitempty"`
		Search *string                    `json:"search,omitempty"`
		Sort   *gen.Sort                  `json:"sort,omitempty"`
		Filter map[string]json.RawMessage `json:"filter,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	query := printing.ListQuery{Filter: body.Filter}
	if body.Limit != nil {
		query.Limit = *body.Limit
	}
	if body.Offset != nil {
		query.Offset = *body.Offset
	}
	if body.Search != nil {
		query.Search = *body.Search
	}
	if body.Sort != nil {
		query.Sort = &filterbuild.Sort{Column: body.Sort.Column, Direction: string(body.Sort.Direction)}
	}
	result, err := s.printing.List(r.Context(), query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.PrintTemplate, 0, len(result.Results))
	for _, value := range result.Results {
		items = append(items, printTemplateDTO(value))
	}
	s.writeJSON(w, http.StatusOK, gen.PrintTemplateList{Count: result.Count, Results: items})
}

func (s *Server) GetSysPrintTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, printingPermission+":read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.printing.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, printTemplateDTO(value))
}

func (s *Server) CreateSysPrintTemplate(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, printingPermission+":create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.PrintTemplateCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	value, err := s.printing.Create(r.Context(), actor, printing.CreateInput{
		Name: body.Name, Resource: body.Resource, FileID: body.FileId, Remarks: body.Remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, printTemplateDTO(value))
}

func (s *Server) UpdateSysPrintTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, printingPermission+":update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body printTemplateUpdateBody
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var remarks **string
	if body.Remarks != nil {
		var value *string
		if string(body.Remarks) != "null" {
			var decoded string
			if err := json.Unmarshal(body.Remarks, &decoded); err != nil {
				s.writeError(w, r, invalidJSON(err))
				return
			}
			value = &decoded
		}
		remarks = &value
	}
	value, err := s.printing.Update(r.Context(), actor, id, printing.UpdateInput{
		Name: body.Name, FileID: body.FileID, Remarks: remarks,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, printTemplateDTO(value))
}

func (s *Server) DeleteSysPrintTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, printingPermission+":delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.printing.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) SetDefaultSysPrintTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, printingPermission+":update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.printing.SetDefault(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, printTemplateDTO(value))
}

func (s *Server) UnsetDefaultSysPrintTemplate(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, printingPermission+":update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.printing.UnsetDefault(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, printTemplateDTO(value))
}

func printCatalogDTO(value printing.ResourceCatalog) gen.PrintFieldCatalog {
	fields := make([]gen.PrintField, 0, len(value.Fields))
	for _, field := range value.Fields {
		fields = append(fields, gen.PrintField{Name: field.Name, Label: field.Label})
	}
	loops := make([]gen.PrintLoop, 0, len(value.Loops))
	for _, loop := range value.Loops {
		loopFields := make([]gen.PrintField, 0, len(loop.Fields))
		for _, field := range loop.Fields {
			loopFields = append(loopFields, gen.PrintField{Name: field.Name, Label: field.Label})
		}
		loops = append(loops, gen.PrintLoop{Name: loop.Name, Label: loop.Label, Fields: loopFields})
	}
	return gen.PrintFieldCatalog{Resource: value.Resource, Fields: fields, Loops: loops}
}

func printTemplateDTO(value printing.Template) gen.PrintTemplate {
	return gen.PrintTemplate{
		Id: value.ID, Name: value.Name, Resource: value.Resource,
		IsDefault: value.IsDefault, Remarks: value.Remarks, FileId: value.FileID,
		InsertedAt: value.InsertedAt, UpdatedAt: value.UpdatedAt,
	}
}
