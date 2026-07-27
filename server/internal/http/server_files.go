package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/http/gen"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
)

const maxMultipartBody = 51 << 20

func fileListQuery(body listBody) fileplatform.ListQuery {
	limit, offset, search, sort, filter := listParts(body)
	return fileplatform.ListQuery{
		Limit: limit, Offset: offset, Search: search, Sort: sort, Filter: filter,
	}
}

func (s *Server) QuerySysFiles(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "sys.file:read", fileListQuery, ignoreActor(s.FileService.List),
		func(result fileplatform.FileList) any {
			return gen.StoredFileList{
				Count: result.Count, Results: mapItems(result.Results, storedFileDTO),
			}
		})
}

func (s *Server) GetSysFileMetadata(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sys.file:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.FileService.Get(r.Context(), id)
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
	result, err := s.FileService.Upload(r.Context(), actor, fileplatform.UploadInput{
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
	result, err := s.FileService.Download(r.Context(), actor, id)
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
	if err = s.FileService.DeleteFile(r.Context(), actor, id); err != nil {
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
	value, err := s.FileService.Attach(r.Context(), actor, id, fileplatform.AttachInput{
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
	result, err := s.FileService.ListAttachments(r.Context(), actor, query)
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
	if err = s.FileService.DeleteAttachment(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) QuerySysStorages(w http.ResponseWriter, r *http.Request) {
	queryList(s, w, r, "sys.storage:read", fileListQuery, ignoreActor(s.StorageService.List),
		func(result fileplatform.StorageList) any {
			return gen.StorageEndpointList{
				Count: result.Count, Results: mapItems(result.Results, storageDTO),
			}
		})
}

func (s *Server) GetSysStorage(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "sys.storage:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	value, err := s.StorageService.Get(r.Context(), id)
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
	value, err := s.StorageService.Create(r.Context(), actor, fileplatform.StorageCreateInput{
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
	value, err := s.StorageService.Update(r.Context(), actor, id, input)
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
	if err = s.StorageService.Delete(r.Context(), actor, id); err != nil {
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
	if err = s.StorageService.SetDefault(r.Context(), actor, id); err != nil {
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

// nullablePatch 在 platform/files 仍声明 **string 输入期间做边界适配;
// 解码本身统一走 optionalUpdate。
func nullablePatch(raw map[string]json.RawMessage, key string) (**string, error) {
	value, err := optionalUpdate[string](raw[key])
	if err != nil {
		return nil, err
	}
	return doublePtr(value), nil
}
