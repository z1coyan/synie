package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/http/gen"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
)

const maxMultipartBody = 51 << 20

func (s *Server) QuerySysFiles(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "sys.file:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Limit, Offset *int
		Search        *string
		Sort          *gen.Sort
		Filter        map[string]json.RawMessage
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	query := fileplatform.ListQuery{Filter: body.Filter}
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
	result, err := s.fileService.List(r.Context(), query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	rows := make([]gen.StoredFile, 0, len(result.Results))
	for _, value := range result.Results {
		rows = append(rows, storedFileDTO(value))
	}
	s.writeJSON(w, http.StatusOK, gen.StoredFileList{Count: result.Count, Results: rows})
}

func (s *Server) GetSysFileMetadata(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sys.file:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.fileService.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, storedFileDTO(value))
}

func (s *Server) UploadFile(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sys.file:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxMultipartBody)
	if err = r.ParseMultipartForm(8 << 20); err != nil {
		s.writeError(w, r, invalidJSON(errors.New("缺少 file 字段或文件超过 50MB")))
		return
	}
	reader, header, err := r.FormFile("file")
	if err != nil {
		s.writeError(w, r, invalidJSON(errors.New("缺少 file 字段(multipart)")))
		return
	}
	defer reader.Close()
	var ownerID *uuid.UUID
	ownerIDRaw := firstFormValue(r, "ownerId", "owner_id")
	if ownerIDRaw != "" {
		parsed, parseErr := uuid.Parse(ownerIDRaw)
		if parseErr != nil {
			s.writeError(w, r, invalidJSON(errors.New("ownerId 必须是 UUID")))
			return
		}
		ownerID = &parsed
	}
	result, err := s.fileService.Upload(r.Context(), actor, fileplatform.UploadInput{
		Reader: reader, Filename: header.Filename, ContentType: header.Header.Get("Content-Type"),
		OwnerType: firstFormValue(r, "ownerType", "owner_type"), OwnerID: ownerID,
		Category: firstFormValue(r, "category"),
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	response := gen.FileUploadResult{File: storedFileDTO(result.File)}
	if result.Attachment != nil {
		value := attachmentDTO(*result.Attachment)
		response.Attachment = &value
	}
	s.writeJSON(w, http.StatusCreated, response)
}

func (s *Server) DownloadFile(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.file:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	result, err := s.fileService.Download(r.Context(), actor, id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if result.RedirectURL != "" {
		http.Redirect(w, r, result.RedirectURL, http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", result.ContentType)
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(result.Filename))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Content)
}

func (s *Server) DeleteSysFile(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.file:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.fileService.DeleteFile(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) AttachFile(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.file:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.AttachmentCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	category := ""
	if body.Category != nil {
		category = *body.Category
	}
	value, err := s.fileService.Attach(r.Context(), actor, id, fileplatform.AttachInput{
		OwnerType: body.OwnerType, OwnerID: body.OwnerId, Category: category,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, map[string]any{"attachment": attachmentDTO(value)})
}

func (s *Server) QuerySysAttachments(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sys.file:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.AttachmentQuery
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	query := fileplatform.AttachmentQuery{FileID: body.FileId, OwnerID: body.OwnerId}
	if body.Limit != nil {
		query.Limit = *body.Limit
	}
	if body.Offset != nil {
		query.Offset = *body.Offset
	}
	if body.OwnerType != nil {
		query.OwnerType = *body.OwnerType
	}
	if body.Category != nil {
		query.Category = *body.Category
	}
	result, err := s.fileService.ListAttachments(r.Context(), actor, query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	rows := make([]gen.Attachment, 0, len(result.Results))
	for _, value := range result.Results {
		rows = append(rows, attachmentDTO(value))
	}
	s.writeJSON(w, http.StatusOK, gen.AttachmentList{Count: result.Count, Results: rows})
}

func (s *Server) DeleteSysAttachment(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.file:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.fileService.DeleteAttachment(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QuerySysStorages(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "sys.storage:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Limit, Offset *int
		Search        *string
		Sort          *gen.Sort
		Filter        map[string]json.RawMessage
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	query := fileplatform.ListQuery{Filter: body.Filter}
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
	result, err := s.storageService.List(r.Context(), query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	rows := make([]gen.StorageEndpoint, 0, len(result.Results))
	for _, value := range result.Results {
		rows = append(rows, storageDTO(value))
	}
	s.writeJSON(w, http.StatusOK, gen.StorageEndpointList{Count: result.Count, Results: rows})
}

func (s *Server) GetSysStorage(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sys.storage:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.storageService.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, storageDTO(value))
}

func (s *Server) CreateSysStorage(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "sys.storage:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.StorageEndpointCreate
	if err = decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	value, err := s.storageService.Create(r.Context(), actor, fileplatform.StorageCreateInput{
		Name: body.Name, Label: body.Label, Kind: string(body.Kind), Root: body.Root,
		Endpoint: body.Endpoint, Region: body.Region, Bucket: body.Bucket, Prefix: body.Prefix,
		AccessKeyID: body.AccessKeyId, SecretAccessKey: body.SecretAccessKey,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, storageDTO(value))
}

func (s *Server) UpdateSysStorage(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.storage:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var raw map[string]json.RawMessage
	if err = decodeJSON(w, r, &raw); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	var body gen.StorageEndpointUpdate
	encoded, _ := json.Marshal(raw)
	if err = json.Unmarshal(encoded, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	if value, present := raw["label"]; present && string(value) == "null" {
		s.writeError(w, r, invalidJSON(errors.New("label 不能为 null")))
		return
	}
	input := fileplatform.StorageUpdateInput{Label: body.Label, SecretAccessKey: body.SecretAccessKey}
	input.Root, err = nullablePatch(raw, "root")
	if err == nil {
		input.Endpoint, err = nullablePatch(raw, "endpoint")
	}
	if err == nil {
		input.Region, err = nullablePatch(raw, "region")
	}
	if err == nil {
		input.Bucket, err = nullablePatch(raw, "bucket")
	}
	if err == nil {
		input.Prefix, err = nullablePatch(raw, "prefix")
	}
	if err == nil {
		input.AccessKeyID, err = nullablePatch(raw, "accessKeyId")
	}
	if err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	value, err := s.storageService.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, storageDTO(value))
}

func (s *Server) DeleteSysStorage(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.storage:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.storageService.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) SetDefaultSysStorage(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "sys.storage:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err = s.storageService.SetDefault(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func storedFileDTO(value fileplatform.File) gen.StoredFile {
	return gen.StoredFile{
		Id: value.ID, Storage: value.Storage, Key: value.Key, Filename: value.Filename,
		ContentType: value.ContentType, Size: value.Size, Sha256: value.SHA256,
		InsertedAt: value.InsertedAt, UploadedById: value.UploadedByID,
	}
}

func attachmentDTO(value fileplatform.Attachment) gen.Attachment {
	result := gen.Attachment{
		Id: value.ID, FileId: value.FileID, OwnerType: value.OwnerType, OwnerId: value.OwnerID,
		Category: value.Category, CompanyId: value.CompanyID, InsertedAt: value.InsertedAt,
	}
	if value.File != nil {
		file := storedFileDTO(*value.File)
		result.File = &file
	}
	return result
}

func storageDTO(value fileplatform.StorageEndpoint) gen.StorageEndpoint {
	return gen.StorageEndpoint{
		Id: value.ID, Name: value.Name, Label: value.Label, Kind: gen.StorageKind(value.Kind),
		Root: value.Root, Endpoint: value.Endpoint, Region: value.Region, Bucket: value.Bucket,
		Prefix: value.Prefix, AccessKeyId: value.AccessKeyID, SecretConfigured: value.SecretConfigured,
		Builtin: value.Builtin, IsDefault: value.IsDefault,
		InsertedAt: value.InsertedAt, UpdatedAt: value.UpdatedAt,
	}
}

func firstFormValue(r *http.Request, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(r.FormValue(name)); value != "" {
			return value
		}
	}
	return ""
}

func nullablePatch(raw map[string]json.RawMessage, key string) (**string, error) {
	value, ok := raw[key]
	if !ok {
		return nil, nil
	}
	var result *string
	if string(value) != "null" {
		var decoded string
		if err := json.Unmarshal(value, &decoded); err != nil {
			return nil, err
		}
		result = &decoded
	}
	return &result, nil
}
