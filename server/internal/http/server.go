package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/domain/accounting/glentry"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/base/company"
	"github.com/z1coyan/synie/server/internal/domain/base/currency"
	"github.com/z1coyan/synie/server/internal/domain/base/unit"
	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialcategory"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialunit"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockcount"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockdoc"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockentry"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stocktransfer"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/domain/trading/quotation"
	"github.com/z1coyan/synie/server/internal/http/gen"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/auth"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	fileplatform "github.com/z1coyan/synie/server/internal/platform/files"
	"github.com/z1coyan/synie/server/internal/platform/iam"
	"github.com/z1coyan/synie/server/internal/platform/meta"
	"github.com/z1coyan/synie/server/internal/platform/numbering"
	"github.com/z1coyan/synie/server/internal/platform/printing"
	"github.com/z1coyan/synie/server/internal/platform/settings"
)

const maxJSONBody = 1 << 20

type actorContextKey struct{}

type Server struct {
	pool           *pgxpool.Pool
	auth           *auth.Service
	registry       *meta.Registry
	glEntries      *glentry.Service
	glJournals     *gljournal.Service
	currencies     *currency.Service
	companies      *company.Service
	accounts       *account.Service
	units          *unit.Service
	customers      *customer.Service
	suppliers      *supplier.Service
	employees      *employee.Service
	materials      *material.Service
	materialCats   *materialcategory.Service
	materialUnits  *materialunit.Service
	warehouses     *warehouse.Service
	stockEntries   *stockentry.Service
	stockDocs      *stockdoc.Service
	stockTransfers *stocktransfer.Service
	stockCounts    *stockcount.Service
	orders         orderHTTPService
	quotations     quotationHTTPService
	fileService    *fileplatform.Service
	storageService *fileplatform.StorageService
	iam            *iam.Service
	numbering      *numbering.Service
	printing       *printing.Service
	settings       *settings.Service
	logger         *slog.Logger
}

type Dependencies struct {
	Pool           *pgxpool.Pool
	Auth           *auth.Service
	Registry       *meta.Registry
	GLEntries      *glentry.Service
	GLJournals     *gljournal.Service
	Currencies     *currency.Service
	Companies      *company.Service
	Accounts       *account.Service
	Units          *unit.Service
	Customers      *customer.Service
	Suppliers      *supplier.Service
	Employees      *employee.Service
	Materials      *material.Service
	MaterialCats   *materialcategory.Service
	MaterialUnits  *materialunit.Service
	Warehouses     *warehouse.Service
	StockEntries   *stockentry.Service
	StockDocs      *stockdoc.Service
	StockTransfers *stocktransfer.Service
	StockCounts    *stockcount.Service
	Orders         orderHTTPService
	Quotations     *quotation.Service
	FileService    *fileplatform.Service
	StorageService *fileplatform.StorageService
	IAM            *iam.Service
	Numbering      *numbering.Service
	Printing       *printing.Service
	Settings       *settings.Service
	Logger         *slog.Logger
}

func New(deps Dependencies) *Server {
	return &Server{
		pool: deps.Pool, auth: deps.Auth, registry: deps.Registry,
		glEntries: deps.GLEntries, glJournals: deps.GLJournals,
		currencies: deps.Currencies, companies: deps.Companies, accounts: deps.Accounts, units: deps.Units,
		customers: deps.Customers, suppliers: deps.Suppliers, employees: deps.Employees,
		materials: deps.Materials, materialCats: deps.MaterialCats,
		materialUnits: deps.MaterialUnits, warehouses: deps.Warehouses,
		stockEntries: deps.StockEntries, stockDocs: deps.StockDocs,
		stockTransfers: deps.StockTransfers, stockCounts: deps.StockCounts,
		orders: deps.Orders, quotations: deps.Quotations,
		iam: deps.IAM, numbering: deps.Numbering, printing: deps.Printing, settings: deps.Settings, fileService: deps.FileService, storageService: deps.StorageService, logger: deps.Logger,
	}
}

func (s *Server) Router() http.Handler {
	router := chi.NewRouter()
	router.Use(chimiddleware.RequestID)
	router.Use(chimiddleware.RealIP)
	router.Use(s.recoverer)
	router.Use(s.requestLogger)
	return gen.HandlerWithOptions(s, gen.ChiServerOptions{
		BaseURL:    "/api/v1",
		BaseRouter: router,
		Middlewares: []gen.MiddlewareFunc{
			s.authenticationMiddleware,
		},
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			s.writeError(w, r, apierror.Validation("请求路径参数不合法", map[string][]string{"path": {err.Error()}}))
		},
	})
}

var _ gen.ServerInterface = (*Server)(nil)

func (s *Server) GetHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.pool.Ping(ctx); err != nil {
		s.writeError(w, r, apierror.Wrap(apierror.CodeInternal, "数据库暂不可用", err))
		return
	}
	s.writeJSON(w, http.StatusOK, gen.Health{Status: gen.HealthStatusOk, Database: gen.HealthDatabaseOk})
}

func (s *Server) Login(w http.ResponseWriter, r *http.Request) {
	var body gen.LoginRequest
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, apierror.New(apierror.CodeUnauthorized, "用户名或密码错误"))
		return
	}
	if len(body.Username) > 64 || len(body.Password) > 1024 {
		s.writeError(w, r, apierror.New(apierror.CodeUnauthorized, "用户名或密码错误"))
		return
	}
	result, err := s.auth.Login(r.Context(), body.Username, body.Password, loginBucket(r, body.Username))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	s.writeJSON(w, http.StatusOK, gen.LoginResponse{
		Token: result.Token, ExpiresAt: result.ExpiresAt,
		User: gen.SessionUser{Id: result.User.ID, Username: result.User.Username, Name: result.User.Name},
	})
}

func (s *Server) GetMe(w http.ResponseWriter, r *http.Request) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	permissions := make([]string, 0, len(actor.Permissions))
	if actor.SuperAdmin {
		for _, group := range s.registry.PermissionCatalog() {
			for _, action := range group.Actions {
				permissions = append(permissions, group.Prefix+":"+action)
			}
		}
	} else {
		for permission := range actor.Permissions {
			permissions = append(permissions, permission)
		}
	}
	sort.Strings(permissions)
	companyIDs := make([]uuid.UUID, len(actor.CompanyIDs))
	copy(companyIDs, actor.CompanyIDs)
	sort.Slice(companyIDs, func(i, j int) bool { return companyIDs[i].String() < companyIDs[j].String() })
	w.Header().Set("Cache-Control", "no-store")
	s.writeJSON(w, http.StatusOK, gen.MeResponse{
		User:       gen.SessionUser{Id: actor.UserID, Username: actor.Username, Name: actor.Name},
		SuperAdmin: actor.SuperAdmin, AllCompanies: actor.AllCompanies,
		Permissions: permissions, CompanyIds: companyIDs,
	})
}

func (s *Server) GetSetupStatus(w http.ResponseWriter, r *http.Request) {
	status, err := dbgen.New(s.pool).GetSetupStatus(r.Context())
	if err != nil {
		s.writeError(w, r, apierror.Wrap(apierror.CodeInternal, "读取初始化状态失败", err))
		return
	}
	s.writeJSON(w, http.StatusOK, gen.SetupStatus{
		Initialized: status.Initialized,
		HasUsers:    status.HasUsers,
	})
}

func (s *Server) GetTodoUnreadCount(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "acc.vat_invoice:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	bypass, companyIDs := actor.CompanyFilter()
	count, err := dbgen.New(s.pool).CountUnreadTodos(r.Context(), dbgen.CountUnreadTodosParams{
		UserID: actor.UserID, BypassCompanyScope: bypass, CompanyIds: companyIDs,
	})
	if err != nil {
		s.writeError(w, r, apierror.Wrap(apierror.CodeInternal, "读取待办未读数失败", err))
		return
	}
	s.writeJSON(w, http.StatusOK, gen.TodoUnreadCount{Count: count})
}

func (s *Server) ListResourceMeta(w http.ResponseWriter, r *http.Request) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"resources": s.registry.Summaries(actor)})
}

func (s *Server) GetResourceMeta(w http.ResponseWriter, r *http.Request, name gen.ResourceName) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	document, err := s.registry.BuildDocument(name, actor)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, document)
}

func (s *Server) GetPermissionCatalog(w http.ResponseWriter, r *http.Request) {
	if _, err := requireActor(r); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"groups": s.registry.PermissionCatalog()})
}

func (s *Server) QueryBasCurrencies(w http.ResponseWriter, r *http.Request) {
	if err := requirePermission(r, "base.currency:read"); err != nil {
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
	query := currency.ListQuery{Filter: body.Filter}
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
	result, err := s.currencies.List(r.Context(), query)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	items := make([]gen.Currency, 0, len(result.Results))
	for _, item := range result.Results {
		items = append(items, currencyDTO(item))
	}
	s.writeJSON(w, http.StatusOK, gen.CurrencyList{Count: result.Count, Results: items})
}

func (s *Server) GetBasCurrency(w http.ResponseWriter, r *http.Request, id gen.ID) {
	if err := requirePermission(r, "base.currency:read"); err != nil {
		s.writeError(w, r, err)
		return
	}
	item, err := s.currencies.Get(r.Context(), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, currencyDTO(item))
}

func (s *Server) CreateBasCurrency(w http.ResponseWriter, r *http.Request) {
	actor, err := actorWithPermission(r, "base.currency:create")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body gen.CurrencyCreate
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	item, err := s.currencies.Create(r.Context(), actor, currency.CreateInput{
		Name: body.Name, ISOCode: body.IsoCode, Symbol: body.Symbol, Active: body.Active,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, currencyDTO(item))
}

func (s *Server) UpdateBasCurrency(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.currency:update")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var body struct {
		Name   *string         `json:"name,omitempty"`
		Active *bool           `json:"active,omitempty"`
		Symbol json.RawMessage `json:"symbol,omitempty"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		s.writeError(w, r, invalidJSON(err))
		return
	}
	input := currency.UpdateInput{Name: body.Name, Active: body.Active}
	if body.Symbol != nil {
		input.Symbol.Set = true
		if string(body.Symbol) != "null" {
			var symbol string
			if err := json.Unmarshal(body.Symbol, &symbol); err != nil {
				s.writeError(w, r, apierror.Validation("币种参数不合法", map[string][]string{"symbol": {"必须是字符串或 null"}}))
				return
			}
			input.Symbol.Value = &symbol
		}
	}
	item, err := s.currencies.Update(r.Context(), actor, id, input)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, currencyDTO(item))
}

func (s *Server) DeleteBasCurrency(w http.ResponseWriter, r *http.Request, id gen.ID) {
	actor, err := actorWithPermission(r, "base.currency:delete")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.currencies.Delete(r.Context(), actor, id); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func currencyDTO(item currency.Currency) gen.Currency {
	return gen.Currency{
		Id: item.ID, Name: item.Name, IsoCode: item.ISOCode, Symbol: item.Symbol,
		Active: item.Active, InsertedAt: item.InsertedAt, UpdatedAt: item.UpdatedAt,
	}
}

func (s *Server) authenticationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/healthz" || r.URL.Path == "/api/v1/auth/login" ||
			r.URL.Path == "/api/v1/setup/status" {
			next.ServeHTTP(w, r)
			return
		}
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		scheme, token, ok := strings.Cut(header, " ")
		if !ok || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(token) == "" {
			s.writeError(w, r, apierror.New(apierror.CodeUnauthorized, "请先登录"))
			return
		}
		actor, err := s.auth.Authenticate(r.Context(), strings.TrimSpace(token))
		if err != nil {
			s.writeError(w, r, err)
			return
		}
		ctx := context.WithValue(r.Context(), actorContextKey{}, actor)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func requireActor(r *http.Request) (*authz.Actor, error) {
	actor, ok := r.Context().Value(actorContextKey{}).(*authz.Actor)
	if !ok || actor == nil {
		return nil, apierror.New(apierror.CodeUnauthorized, "请先登录")
	}
	return actor, nil
}

func actorWithPermission(r *http.Request, permission string) (*authz.Actor, error) {
	actor, err := requireActor(r)
	if err != nil {
		return nil, err
	}
	if !actor.HasPermission(permission) {
		return nil, apierror.New(apierror.CodeForbidden, "无权执行此操作")
	}
	return actor, nil
}

func requirePermission(r *http.Request, permission string) error {
	_, err := actorWithPermission(r, permission)
	return err
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("请求体只能包含一个 JSON 值")
		}
		return err
	}
	return nil
}

func invalidJSON(err error) error {
	return apierror.Validation("请求 JSON 不合法", map[string][]string{"body": {err.Error()}})
}

func loginBucket(r *http.Request, username string) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return host + "|" + strings.ToLower(strings.TrimSpace(username))
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		s.logger.Error("写 HTTP JSON 响应失败", "error", err)
	}
}

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	status := apierror.Status(err)
	var appErr *apierror.Error
	if !errors.As(err, &appErr) {
		appErr = apierror.Wrap(apierror.CodeInternal, "服务暂不可用", err)
		status = http.StatusInternalServerError
	}
	if status >= 500 {
		s.logger.ErrorContext(r.Context(), "HTTP 请求失败", "method", r.Method, "path", r.URL.Path, "error", err)
	}
	apiErr := gen.APIError{Code: gen.APIErrorCode(appErr.Code), Message: appErr.Message}
	if len(appErr.Fields) > 0 {
		fields := appErr.Fields
		apiErr.Fields = &fields
	}
	s.writeJSON(w, status, gen.ErrorEnvelope{Error: apiErr})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.ErrorContext(r.Context(), "HTTP panic", "method", r.Method, "path", r.URL.Path, "panic", recovered)
				s.writeError(w, r, apierror.New(apierror.CodeInternal, "服务暂不可用"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		s.logger.InfoContext(r.Context(), "HTTP 请求", "method", r.Method, "path", r.URL.Path,
			"duration_ms", time.Since(started).Milliseconds(), "request_id", chimiddleware.GetReqID(r.Context()))
	})
}
