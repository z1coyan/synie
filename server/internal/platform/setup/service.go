package setup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/auth"
	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/setup/sampledata"
)

const setupLockKey int64 = 0x53594e4945534554

var commonCurrencies = []struct {
	name, code, symbol string
}{
	{"人民币", "CNY", "￥"}, {"美元", "USD", "$"}, {"欧元", "EUR", "€"},
	{"日元", "JPY", "¥"}, {"港币", "HKD", "HK$"}, {"新台币", "TWD", "NT$"},
	{"英镑", "GBP", "£"}, {"韩元", "KRW", "₩"}, {"新加坡元", "SGD", "S$"},
	{"澳大利亚元", "AUD", "A$"}, {"加拿大元", "CAD", "C$"}, {"瑞士法郎", "CHF", "CHF"},
	{"澳门元", "MOP", "MOP$"}, {"泰铢", "THB", "฿"}, {"马来西亚林吉特", "MYR", "RM"},
	{"印尼盾", "IDR", "Rp"}, {"越南盾", "VND", "₫"}, {"菲律宾比索", "PHP", "₱"},
	{"印度卢比", "INR", "₹"}, {"俄罗斯卢布", "RUB", "₽"},
}

type Service struct {
	pool   *pgxpool.Pool
	hasher auth.PasswordHasher
	tokens auth.TokenManager
	sample sampledata.Dependencies
	now    func() time.Time
}

type FirstUserInput struct {
	Username string
	Name     *string
	Password string
}

type FirstUserResult struct {
	Token     string
	ExpiresAt time.Time
	User      auth.User
}

func NewService(pool *pgxpool.Pool, hasher auth.PasswordHasher, tokens auth.TokenManager, sample ...sampledata.Dependencies) *Service {
	svc := &Service{pool: pool, hasher: hasher, tokens: tokens, now: time.Now}
	if len(sample) > 0 {
		svc.sample = sample[0]
	}
	return svc
}

func (s *Service) CreateFirstUser(ctx context.Context, input FirstUserInput) (FirstUserResult, error) {
	input.Username = strings.TrimSpace(input.Username)
	fields := map[string][]string{}
	if input.Username == "" || len([]rune(input.Username)) > 64 {
		fields["username"] = []string{"不能为空且长度不能超过 64"}
	}
	if input.Password == "" || len(input.Password) > 1024 {
		fields["password"] = []string{"不能为空且长度不能超过 1024"}
	}
	if input.Name != nil && len([]rune(*input.Name)) > 64 {
		fields["name"] = []string{"长度不能超过 64"}
	}
	if len(fields) > 0 {
		return FirstUserResult{}, apierror.Validation("首个管理员参数不合法", fields)
	}
	hash, err := s.hasher.Hash(input.Password)
	if err != nil {
		return FirstUserResult{}, apierror.Wrap(apierror.CodeInternal, "创建首个管理员失败", err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FirstUserResult{}, apierror.Wrap(apierror.CodeInternal, "创建首个管理员失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockSetup(ctx, tx); err != nil {
		return FirstUserResult{}, err
	}
	initialized, hasUsers, err := setupState(ctx, tx)
	if err != nil {
		return FirstUserResult{}, apierror.Wrap(apierror.CodeInternal, "读取初始化状态失败", err)
	}
	if initialized {
		return FirstUserResult{}, apierror.New(apierror.CodeConflict, "系统已完成初始化")
	}
	if hasUsers {
		return FirstUserResult{}, apierror.New(apierror.CodeConflict, "已存在用户,请直接登录")
	}
	var user auth.User
	err = tx.QueryRow(ctx, `
		INSERT INTO sys_user (username, name, hashed_password, super_admin, all_companies)
		VALUES ($1, $2, $3, true, true)
		RETURNING id, username::text, name, hashed_password`, input.Username, input.Name, hash).
		Scan(&user.ID, &user.Username, &user.Name, &user.HashedPassword)
	if err != nil {
		return FirstUserResult{}, mapCreateUserError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return FirstUserResult{}, mapCreateUserError(err)
	}
	token, expiresAt, err := s.tokens.Issue(user.ID)
	if err != nil {
		return FirstUserResult{}, apierror.Wrap(apierror.CodeInternal, "管理员已创建但签发登录态失败,请直接登录", err)
	}
	return FirstUserResult{Token: token, ExpiresAt: expiresAt, User: user}, nil
}

func (s *Service) SeedCommonCurrencies(ctx context.Context) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "预置常用货币失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockSetup(ctx, tx); err != nil {
		return 0, err
	}
	if err := rejectInitialized(ctx, tx); err != nil {
		return 0, err
	}
	created := int64(0)
	for _, currency := range commonCurrencies {
		command, err := tx.Exec(ctx, `
			INSERT INTO bas_currency (name, iso_code, symbol, active)
			VALUES ($1, $2, $3, false)
			ON CONFLICT (iso_code) DO NOTHING`, currency.name, currency.code, currency.symbol)
		if err != nil {
			return 0, apierror.Wrap(apierror.CodeInternal, "预置常用货币失败", err)
		}
		created += command.RowsAffected()
	}
	var hasCompanies bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bas_company)`).Scan(&hasCompanies); err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "预置常用货币失败", err)
	}
	if !hasCompanies {
		codes := make([]string, 0, len(commonCurrencies))
		for _, currency := range commonCurrencies {
			codes = append(codes, currency.code)
		}
		if _, err := tx.Exec(ctx, `UPDATE bas_currency SET active = false, updated_at = now() AT TIME ZONE 'utc' WHERE iso_code = ANY($1) AND active`, codes); err != nil {
			return 0, apierror.Wrap(apierror.CodeInternal, "预置常用货币失败", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, apierror.Wrap(apierror.CodeInternal, "预置常用货币失败", err)
	}
	return int(created), nil
}

func (s *Service) ActivateBaseCurrency(ctx context.Context, currencyID uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "启用本币失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockSetup(ctx, tx); err != nil {
		return err
	}
	if err := rejectInitialized(ctx, tx); err != nil {
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bas_currency WHERE id = $1)`, currencyID).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "启用本币失败", err)
	}
	if !exists {
		return apierror.New(apierror.CodeNotFound, "币种不存在")
	}
	var hasCompanies bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bas_company)`).Scan(&hasCompanies); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "启用本币失败", err)
	}
	if hasCompanies {
		return apierror.New(apierror.CodeConflict, "已有公司,不可重新选择初始化本币")
	}
	if _, err := tx.Exec(ctx, `UPDATE bas_currency SET active = (id = $1), updated_at = now() AT TIME ZONE 'utc' WHERE active IS DISTINCT FROM (id = $1)`, currencyID); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "启用本币失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "启用本币失败", err)
	}
	return nil
}

func (s *Service) Complete(ctx context.Context, actor *authz.Actor, language string, seedSampleData bool) error {
	if language != "zh-CN" && language != "en-US" {
		return apierror.Validation("完成初始化参数不合法", map[string][]string{"preferredLanguage": {"仅支持 zh-CN 或 en-US"}})
	}
	// 阶段一:写语言与幂等基础种子。领域服务自开事务,示例数据须在提交后才能读到分类/单位。
	if err := s.completeBaseSeeds(ctx, actor, language); err != nil {
		return err
	}
	// 阶段二:可选示例业务数据。失败不写完成旗标;C01 标记保证幂等跳过。
	if seedSampleData {
		if s.sample.Pool == nil {
			return apierror.New(apierror.CodeNotImplemented, "Go Setup 尚未配置示例数据依赖,初始化未完成且完成旗标未写入")
		}
		companyID, err := firstCompanyID(ctx, s.pool)
		if err != nil {
			return err
		}
		if companyID != nil {
			if _, err := sampledata.Seed(ctx, s.sample, actor, *companyID); err != nil {
				return err
			}
		}
	}
	// 阶段三:落完成旗标。
	return s.writeCompletedAt(ctx)
}

func (s *Service) completeBaseSeeds(ctx context.Context, actor *authz.Actor, language string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "完成初始化失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockSetup(ctx, tx); err != nil {
		return err
	}
	if err := rejectInitialized(ctx, tx); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE sys_user SET preferred_language = $2, updated_at = now() AT TIME ZONE 'utc' WHERE id = $1`, actor.UserID, language)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入首选语言失败", err)
	}
	if command.RowsAffected() != 1 {
		return apierror.New(apierror.CodeUnauthorized, "当前用户不存在")
	}
	if err := seedLocalStorage(ctx, tx); err != nil {
		return err
	}
	if err := seedNumberingRules(ctx, tx); err != nil {
		return err
	}
	if err := seedMaterialCategories(ctx, tx); err != nil {
		return err
	}
	if err := seedUnits(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "完成初始化失败", err)
	}
	return nil
}

func (s *Service) writeCompletedAt(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "完成初始化失败", err)
	}
	defer tx.Rollback(ctx)
	if err := lockSetup(ctx, tx); err != nil {
		return err
	}
	if err := rejectInitialized(ctx, tx); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE sys_setting SET setup_completed_at = $1, updated_at = now() AT TIME ZONE 'utc' WHERE setup_completed_at IS NULL`, s.now().UTC())
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "写入初始化完成旗标失败", err)
	}
	if command.RowsAffected() != 1 {
		return apierror.New(apierror.CodeConflict, "系统设置单行不存在或系统已完成初始化")
	}
	if err := tx.Commit(ctx); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "完成初始化失败", err)
	}
	return nil
}

func firstCompanyID(ctx context.Context, pool *pgxpool.Pool) (*uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx, `SELECT id FROM bas_company ORDER BY inserted_at, id LIMIT 1`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取首个公司失败", err)
	}
	return &id, nil
}

func lockSetup(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, setupLockKey); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "获取初始化锁失败", err)
	}
	if _, err := tx.Exec(ctx, `SELECT id FROM sys_setting ORDER BY id LIMIT 1 FOR UPDATE`); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "锁定初始化状态失败", err)
	}
	return nil
}

func setupState(ctx context.Context, tx pgx.Tx) (bool, bool, error) {
	var initialized, hasUsers bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sys_setting WHERE setup_completed_at IS NOT NULL), EXISTS (SELECT 1 FROM sys_user)`).Scan(&initialized, &hasUsers)
	return initialized, hasUsers, err
}

func rejectInitialized(ctx context.Context, tx pgx.Tx) error {
	initialized, _, err := setupState(ctx, tx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取初始化状态失败", err)
	}
	if initialized {
		return apierror.New(apierror.CodeConflict, "系统已完成初始化")
	}
	return nil
}

func seedLocalStorage(ctx context.Context, tx pgx.Tx) error {
	root := os.Getenv("UPLOADS_ROOT")
	if root == "" {
		root = "uploads"
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO sys_storage (name, label, kind, root, builtin, is_default)
		VALUES ('local', '本地存储', 'local', $1, true, true)
		ON CONFLICT (name) DO NOTHING`, root)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "预置本地存储失败", err)
	}
	return nil
}

type numberingRule struct {
	resource, name string
	perCompany     bool
	segments       string
}

func seedNumberingRules(ctx context.Context, tx pgx.Tx) error {
	rules := []numberingRule{
		{"inv.material", "物料编号", false, `[{"type":"field","field":"category.code","label":"物料分类·分类编号"},{"type":"field","field":"customer.code","label":"所属客户(仅客户物料)·客户编号"},{"type":"text","value":"-"},{"type":"seq","padding":0}]`},
		{"hr.employee", "员工编号", false, `[{"type":"text","value":"H(E)-"},{"type":"seq","padding":4}]`},
		{"mfg.operation", "工序编号", false, `[{"type":"text","value":"M(O)-"},{"type":"seq","padding":4}]`},
		{"mfg.route_template", "工艺模板编号", false, `[{"type":"text","value":"M(T)-"},{"type":"seq","padding":4}]`},
		// 示例数据与制造主数据需要;numberables.json 已登记,此前完成种子漏了
		{"mfg.bom", "BOM编号", false, `[{"type":"text","value":"M(B)-"},{"type":"seq","padding":4}]`},
	}
	docs := []struct{ resource, name, prefix, field, label string }{
		{"sales.order", "销售订单编号", "S(O)", "order_date", "订单日期"}, {"sales.quotation", "销售报价编号", "S(Q)", "quotation_date", "报价日期"},
		{"sales.delivery", "销售发货编号", "S(D)", "delivery_date", "发货日期"}, {"sales.reconciliation", "销售对账编号", "S(R)", "posting_date", "业务日期"},
		{"purchase.order", "采购订单编号", "P(O)", "order_date", "订单日期"}, {"purchase.quotation", "采购报价编号", "P(Q)", "quotation_date", "报价日期"},
		{"purchase.receipt", "采购入库单编号", "P(R)", "receipt_date", "入库日期"}, {"purchase.reconciliation", "采购对账编号", "P(C)", "posting_date", "业务日期"},
		{"purchase.outsourced_issue", "委外发料编号", "P(OI)", "issue_date", "发料日期"},
		{"purchase.outsourced_receipt", "委外入库编号", "P(OR)", "receipt_date", "入库日期"},
		{"inv.stock_doc", "手工出入库单编号", "I(D)", "doc_date", "业务日期"}, {"inv.stock_transfer", "手工调拨单编号", "I(T)", "doc_date", "业务日期"},
		{"inv.stock_count", "库存盘点单编号", "I(C)", "posting_date", "业务日期"}, {"mfg.demand", "履约需求单编号", "M(D)", "demand_date", "业务日期"},
		{"mfg.work_order", "生产工单编号", "M(W)", "need_date", "需求日"}, {"mfg.output", "生产入库单编号", "M(R)", "output_date", "入库日期"},
		{"acc.gl_journal", "会计凭证编号", "A(J)", "date", "凭证日期"}, {"acc.vat_invoice", "增值税发票编号", "A(I)", "invoice_date", "开票日期"},
		{"acc.bill_transaction", "承兑交易编号", "A(B)", "occurred_on", "发生日期"}, {"acc.expense_report", "费用报销编号", "A(E)", "expense_date", "费用日期"},
	}
	for _, doc := range docs {
		segments := fmt.Sprintf(`[{"type":"text","value":"%s-"},{"type":"field","field":"%s","format":"YYYYMMDD","label":"%s"},{"type":"text","value":"-"},{"type":"seq","padding":4}]`, doc.prefix, doc.field, doc.label)
		rules = append(rules, numberingRule{doc.resource, doc.name, true, segments})
	}
	for _, rule := range rules {
		_, err := tx.Exec(ctx, `
			INSERT INTO sys_numbering_rule (resource, name, segments, per_company, enabled)
			SELECT $1, $2, ARRAY(SELECT jsonb_array_elements($3::jsonb)), $4, true
			WHERE NOT EXISTS (SELECT 1 FROM sys_numbering_rule WHERE resource = $1)`, rule.resource, rule.name, rule.segments, rule.perCompany)
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "预置编号规则失败", err)
		}
	}
	return nil
}

func seedMaterialCategories(ctx context.Context, tx pgx.Tx) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM inv_material_category)`).Scan(&exists); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "预置物料分类失败", err)
	}
	if exists {
		return nil
	}
	categories := []struct {
		code, name string
		children   [][2]string
	}{
		{"F", "产品", [][2]string{{"F(P)", "客户产品成品"}, {"F(S)", "半成品"}, {"F(G)", "通用成品"}}},
		{"P", "包材", [][2]string{{"P(W)", "木箱"}, {"P(C)", "纸箱"}, {"P(B)", "袋与填充"}}},
		{"E", "设备工量具", [][2]string{{"E(E)", "设备"}, {"E(T)", "工量具"}}},
		{"M", "劳保耗材", [][2]string{{"M(L)", "劳保用品"}, {"M(C)", "耗材"}}},
		{"S", "服务", [][2]string{{"S(G)", "一般服务"}}},
	}
	for _, category := range categories {
		var parentID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO inv_material_category (code, name, is_leaf, active) VALUES ($1, $2, false, true) RETURNING id`, category.code, category.name).Scan(&parentID); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "预置物料分类失败", err)
		}
		for _, child := range category.children {
			if _, err := tx.Exec(ctx, `INSERT INTO inv_material_category (code, name, is_leaf, active, parent_id) VALUES ($1, $2, true, true, $3)`, child[0], child[1], parentID); err != nil {
				return apierror.Wrap(apierror.CodeInternal, "预置物料分类失败", err)
			}
		}
	}
	return nil
}

func seedUnits(ctx context.Context, tx pgx.Tx) error {
	units := []struct {
		unitType            string
		wantBase            bool
		name, symbol, ratio string
	}{
		{"length", true, "毫米", "mm", "1"}, {"length", false, "微米", "μm", "0.001"}, {"length", false, "厘米", "cm", "10"}, {"length", false, "米", "m", "1000"}, {"length", false, "英寸", "in", "25.4"},
		{"area", true, "平方毫米", "mm²", "1"}, {"area", false, "平方厘米", "cm²", "100"}, {"area", false, "平方米", "m²", "1000000"}, {"weight", false, "克", "g", "0.000001"},
		{"quantity", true, "件", "pcs", "1"}, {"quantity", false, "只", "只", "1"}, {"quantity", false, "个", "个", "1"}, {"quantity", false, "套", "套", "1"}, {"quantity", false, "台", "台", "1"},
		{"quantity", false, "片", "片", "1"}, {"quantity", false, "根", "根", "1"}, {"quantity", false, "支", "支", "1"}, {"quantity", false, "块", "块", "1"}, {"quantity", false, "张", "张", "1"},
		{"quantity", false, "箱", "箱", "1"}, {"quantity", false, "包", "包", "1"}, {"quantity", false, "卷", "卷", "1"}, {"quantity", false, "捆", "捆", "1"}, {"quantity", false, "打", "打", "12"},
		{"quantity", false, "次", "次", "1"}, {"quantity", false, "项", "项", "1"},
	}
	for _, unit := range units {
		_, err := tx.Exec(ctx, `
			INSERT INTO bas_unit (unit_type, is_base, name, symbol, ratio)
			SELECT $1, ($2 AND NOT EXISTS (SELECT 1 FROM bas_unit WHERE unit_type = $1 AND is_base)), $3, $4, $5::numeric
			ON CONFLICT (symbol) DO NOTHING`, unit.unitType, unit.wantBase, unit.name, unit.symbol, unit.ratio)
		if err != nil {
			return apierror.Wrap(apierror.CodeInternal, "预置计量单位失败", err)
		}
	}
	return nil
}

func mapCreateUserError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apierror.Wrap(apierror.CodeConflict, "已存在用户,请直接登录", err)
	}
	return apierror.Wrap(apierror.CodeInternal, "创建首个管理员失败", err)
}
