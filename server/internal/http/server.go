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
	"github.com/z1coyan/synie/server/internal/domain/accounting/glentry"
	"github.com/z1coyan/synie/server/internal/domain/accounting/gljournal"
	"github.com/z1coyan/synie/server/internal/domain/base/account"
	"github.com/z1coyan/synie/server/internal/domain/base/company"
	"github.com/z1coyan/synie/server/internal/domain/base/currency"
	"github.com/z1coyan/synie/server/internal/domain/base/unit"
	"github.com/z1coyan/synie/server/internal/domain/finance/banking"
	"github.com/z1coyan/synie/server/internal/domain/finance/documents"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/outsourced"
	"github.com/z1coyan/synie/server/internal/domain/fulfillment/standard"
	"github.com/z1coyan/synie/server/internal/domain/hr/employee"
	hroperations "github.com/z1coyan/synie/server/internal/domain/hr/operations"
	"github.com/z1coyan/synie/server/internal/domain/inventory/material"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialcategory"
	"github.com/z1coyan/synie/server/internal/domain/inventory/materialunit"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockcount"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockdoc"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stockentry"
	"github.com/z1coyan/synie/server/internal/domain/inventory/stocktransfer"
	"github.com/z1coyan/synie/server/internal/domain/inventory/warehouse"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/execution"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/master"
	"github.com/z1coyan/synie/server/internal/domain/purchase/supplier"
	"github.com/z1coyan/synie/server/internal/domain/sales/companyaccountdefault"
	"github.com/z1coyan/synie/server/internal/domain/sales/customer"
	"github.com/z1coyan/synie/server/internal/domain/scm/orderflow"
	"github.com/z1coyan/synie/server/internal/domain/systemops"
	"github.com/z1coyan/synie/server/internal/domain/trading/reconciliation"
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
	setupplatform "github.com/z1coyan/synie/server/internal/platform/setup"
)

const maxJSONBody = 1 << 20

type actorContextKey struct{}

type setupHTTPService interface {
	CreateFirstUser(context.Context, setupplatform.FirstUserInput) (setupplatform.FirstUserResult, error)
	SeedCommonCurrencies(context.Context) (int, error)
	ActivateBaseCurrency(context.Context, uuid.UUID) error
	Complete(context.Context, *authz.Actor, string, bool) error
}

// Server 直接内嵌依赖结构体:字段清单只维护 Dependencies 一份,
// New 不再逐字段拷贝,避免 Server 字段、Dependencies、New() 三份手工同步。
type Server struct {
	Dependencies
}

type Dependencies struct {
	Pool                   *pgxpool.Pool
	Auth                   *auth.Service
	Registry               *meta.Registry
	GLEntries              *glentry.Service
	GLJournals             *gljournal.Service
	Currencies             *currency.Service
	Companies              *company.Service
	Accounts               *account.Service
	Units                  *unit.Service
	Customers              *customer.Service
	Suppliers              *supplier.Service
	Employees              *employee.Service
	HROperations           *hroperations.Service
	FinanceBanking         *banking.Service
	FinanceDocuments       *documents.Service
	Materials              *material.Service
	MaterialCats           *materialcategory.Service
	MaterialUnits          *materialunit.Service
	Warehouses             *warehouse.Service
	StockEntries           *stockentry.Service
	StockDocs              *stockdoc.Service
	StockTransfers         *stocktransfer.Service
	StockCounts            *stockcount.Service
	Orders                 orderHTTPService
	Quotations             quotationHTTPService
	ManufacturingMaster    *master.Service
	ManufacturingExecution *execution.Service
	StandardFulfillment    *standard.Service
	OutsourcedFulfillment  *outsourced.Service
	Reconciliations        *reconciliation.Service
	CompanyAccountDefaults *companyaccountdefault.Service
	OrderFlowItems         *orderflow.Service
	SystemOps              *systemops.Service
	FileService            *fileplatform.Service
	StorageService         *fileplatform.StorageService
	IAM                    *iam.Service
	Numbering              *numbering.Service
	Printing               *printing.Service
	Settings               *settings.Service
	Setup                  setupHTTPService
	Logger                 *slog.Logger
}

func New(deps Dependencies) *Server {
	return &Server{Dependencies: deps}
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
			s.writeError(w, r, bindingError(r, err))
		},
	})
}

var _ gen.ServerInterface = (*Server)(nil)

func (s *Server) GetHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.Pool.Ping(ctx); err != nil {
		s.writeError(w, r, apierror.Wrap(apierror.CodeInternal, "数据库暂不可用", err))
		return
	}
	s.writeJSON(w, http.StatusOK, gen.Health{Status: gen.HealthStatusOk, Database: gen.HealthDatabaseOk})
}

func (s *Server) Login(w http.ResponseWriter, r *http.Request) {
	var body gen.LoginRequest
	if err := decodeJSON(w, r, &body); err != nil {
		// 防枚举:请求解析失败与凭证错误返回完全一致的 401,不暴露请求格式细节
		s.writeError(w, r, apierror.New(apierror.CodeUnauthorized, "用户名或密码错误"))
		return
	}
	if len(body.Username) > 64 || len(body.Password) > 1024 {
		s.writeError(w, r, apierror.New(apierror.CodeUnauthorized, "用户名或密码错误"))
		return
	}
	result, err := s.Auth.Login(r.Context(), body.Username, body.Password, loginBucket(r, body.Username))
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
		for _, group := range s.Registry.PermissionCatalog() {
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
	status, err := dbgen.New(s.Pool).GetSetupStatus(r.Context())
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
	// 只读端点使用只读权限码;待办目前均为发票待办,故用发票 read 码
	actor, err := actorWithPermission(r, "acc.vat_invoice:read")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	count, err := s.SystemOps.UnreadCount(r.Context(), actor)
	if err != nil {
		s.writeError(w, r, err)
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
	s.writeJSON(w, http.StatusOK, map[string]any{"resources": s.Registry.Summaries(actor)})
}

func (s *Server) GetResourceMeta(w http.ResponseWriter, r *http.Request, name gen.ResourceName) {
	actor, err := requireActor(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	document, err := s.Registry.BuildDocument(name, actor)
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
	s.writeJSON(w, http.StatusOK, map[string]any{"groups": s.Registry.PermissionCatalog()})
}

func (s *Server) authenticationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/healthz" || r.URL.Path == "/api/v1/auth/login" ||
			r.URL.Path == "/api/v1/setup/status" || r.URL.Path == "/api/v1/setup/first-user" {
			next.ServeHTTP(w, r)
			return
		}
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		scheme, token, ok := strings.Cut(header, " ")
		if !ok || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(token) == "" {
			s.writeError(w, r, apierror.New(apierror.CodeUnauthorized, "请先登录"))
			return
		}
		actor, err := s.Auth.Authenticate(r.Context(), strings.TrimSpace(token))
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

func actorWithAnyPermission(r *http.Request, permissions ...string) (*authz.Actor, error) {
	actor, err := requireActor(r)
	if err != nil {
		return nil, err
	}
	for _, permission := range permissions {
		if actor.HasPermission(permission) {
			return actor, nil
		}
	}
	return nil, apierror.New(apierror.CodeForbidden, "无权执行此操作")
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

// bindingError 区分路径参数与查询参数绑定失败。oapi-codegen 的参数错误类型
// 不携带来源信息,这里借助 chi 路由模式判断参数名是否出现在路径中;
// 判断不了时按查询参数处理(必填缺失只会发生在查询参数上)。
func bindingError(r *http.Request, err error) error {
	name := ""
	var invalidFormat *gen.InvalidParamFormatError
	var required *gen.RequiredParamError
	switch {
	case errors.As(err, &invalidFormat):
		name = invalidFormat.ParamName
	case errors.As(err, &required):
		name = required.ParamName
	}
	source, label := "query", "请求查询参数不合法"
	if route := chi.RouteContext(r.Context()); route != nil && name != "" &&
		strings.Contains(route.RoutePattern(), "{"+name+"}") {
		source, label = "path", "请求路径参数不合法"
	}
	return apierror.Validation(label, map[string][]string{source: {err.Error()}})
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
		s.Logger.Error("写 HTTP JSON 响应失败", "error", err)
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
		s.Logger.ErrorContext(r.Context(), "HTTP 请求失败", "method", r.Method, "path", r.URL.Path, "error", err)
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
				s.Logger.ErrorContext(r.Context(), "HTTP panic", "method", r.Method, "path", r.URL.Path, "panic", recovered)
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
		s.Logger.InfoContext(r.Context(), "HTTP 请求", "method", r.Method, "path", r.URL.Path,
			"duration_ms", time.Since(started).Milliseconds(), "request_id", chimiddleware.GetReqID(r.Context()))
	})
}
