defmodule SynieCore.Acc.InvoiceStatus do
  @moduledoc "发票状态:草稿/已审核/已作废/已红冲。"

  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废", reversed: "已红冲"]

  def graphql_type(_), do: :acc_invoice_status
end

defmodule SynieCore.Acc.InvoiceDirection do
  @moduledoc "开票方向:开入(进项)/开出(销项)。"

  use Ash.Type.Enum, values: [inbound: "开入", outbound: "开出"]

  def graphql_type(_), do: :acc_invoice_direction
end

defmodule SynieCore.Acc.InvoiceKind do
  @moduledoc "发票种类。"

  use Ash.Type.Enum,
    values: [
      special: "增值税专用发票",
      normal: "增值税普通发票",
      electronic_special: "电子专用发票",
      electronic_normal: "电子普通发票",
      digital_special: "数电专票",
      digital_normal: "数电普票"
    ]

  def graphql_type(_), do: :acc_invoice_kind
end

defmodule SynieCore.Acc.InvoiceDraft do
  @moduledoc "校验发票处于草稿态(修改/删除的前提)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft do
      :ok
    else
      {:error, message: "仅草稿发票可修改或删除"}
    end
  end
end

defmodule SynieCore.Acc.PartyNotSelf do
  @moduledoc "对手校验:party_type 为内部公司时,对手不能是发票所属公司自身(不能给自己开票)。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    party_type = Ash.Changeset.get_attribute(changeset, :party_type)
    party_id = Ash.Changeset.get_attribute(changeset, :party_id)

    company_id =
      if changeset.action_type == :create do
        Ash.Changeset.get_attribute(changeset, :company_id)
      else
        changeset.data.company_id
      end

    if party_type == :company and not is_nil(party_id) and party_id == company_id do
      {:error, field: :party_id, message: "对手不能是本公司"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Acc.VatInvoice do
  @moduledoc """
  增值税发票(头),对应 `acc_vat_invoice` 表。

  `direction` 标识开票方向(开入即进项票、开出即销项票);对手 `party_type`/`party_id`
  为多态引用,复用凭证行/总账分录同款 `PartyType`(供应商/客户/内部公司)。

  编号分两层:`doc_no` 是内部单据编号,留空按 `acc.vat_invoice` 规则自动取号
  (AutoNumber),与凭证 `voucher_no` 同一套机制;`invoice_code`+`invoice_no` 才是
  真实发票代码/号码,公司内唯一(数电票无代码,`invoice_code` 存空串,判重同样生效)。

  `mirror_invoice_id` 自引用:内部两公司互开发票时可互链对向发票,供 Task 7 联动展示;
  对向发票被删时该外键由数据库置空(nilify),不级联删除。

  生命周期:草稿(可改可删)→ 已审核(audit,派生 `gl_entries/1` 过账)→
  已作废(void,原分录标 `is_cancelled`)/已红冲(reverse,交 `GL.reverse!` 生成红字组)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "acc_vat_invoice"
    repo SynieCore.Repo

    references do
      # 镜像草稿被删,原票互链自动置空
      reference :mirror_invoice, on_delete: :nilify
    end

    custom_indexes do
      # 防重录:invoice_code 非空默认空串(数电票存空串),空代码照常参与判重;草稿无号不占坑
      index [:company_id, :invoice_code, :invoice_no],
        unique: true,
        where: "invoice_no IS NOT NULL",
        name: "acc_vat_invoice_no_uniq",
        message: "该公司下相同发票代码+号码已登记"

      index [:company_id, :doc_no],
        unique: true,
        where: "doc_no IS NOT NULL",
        name: "acc_vat_invoice_doc_no_uniq",
        message: "单据编号已存在"

      index [:company_id, :status]
      index [:company_id, :invoice_date]
    end
  end

  graphql do
    type :acc_vat_invoice

    # items 整体按 JSON 串收发(同编号规则 segments 先例),前端一次 parse/stringify
    attribute_types items: :json_string
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :create, :update, :destroy, :audit, :void, :reverse]) do
      authorize_if SynieCore.Authz.Checks.HasPermission
    end

    # OCR 是录入辅助,复用 create 码不新设权限点(同银行流水 import 先例)
    policy action(:ocr) do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "create"}
    end

    policy action_type([:read, :update, :destroy]) do
      authorize_if SynieCore.Authz.Checks.CompanyScope
    end
  end

  def permission_prefix, do: "acc.vat_invoice"
  def permission_label, do: "增值税发票"
  def permission_actions, do: ~w(create read update delete audit void reverse)

  def grid_actions do
    [
      %{
        key: "audit",
        label: "审核",
        scope: "row",
        mutation: "auditAccVatInvoice",
        is_danger: false
      },
      %{key: "void", label: "作废", scope: "row", mutation: "voidAccVatInvoice", is_danger: true},
      %{
        key: "reverse",
        label: "红冲",
        scope: "row",
        mutation: "reverseAccVatInvoice",
        is_danger: true
      }
    ]
  end

  # 对手是多态引用(party_type 判别、无 belongs_to),声明给 GridMeta 反射成多态 fk 列
  def poly_refs do
    %{
      party_id: %{discriminator: :party_type, variants: SynieCore.Acc.PartyType.party_resources()}
    }
  end

  actions do
    read :read do
      primary? true

      pagination offset?: true,
                 countable: true,
                 required?: false,
                 default_limit: 20,
                 max_page_size: 200
    end

    create :create do
      accept [
        :company_id,
        :doc_no,
        :direction,
        :invoice_date,
        :party_type,
        :party_id,
        :invoice_kind,
        :invoice_code,
        :invoice_no,
        :seller_name,
        :seller_tax_no,
        :seller_address_phone,
        :seller_bank_account,
        :buyer_name,
        :buyer_tax_no,
        :buyer_address_phone,
        :buyer_bank_account,
        :items,
        :net_total,
        :tax_total,
        :gross_total,
        :issuer,
        :reviewer,
        :payee,
        :remarks,
        :party_account_id,
        :amount_account_id,
        :tax_account_id,
        :mirror_invoice_id
      ]

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      # 编号留空自动取号(须在构建期,见 AutoNumber moduledoc)
      change {SynieCore.Numbering.AutoNumber, attribute: :doc_no}

      # 录入人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end
    end

    update :update do
      accept [
        :doc_no,
        :direction,
        :invoice_date,
        :party_type,
        :party_id,
        :invoice_kind,
        :invoice_code,
        :invoice_no,
        :seller_name,
        :seller_tax_no,
        :seller_address_phone,
        :seller_bank_account,
        :buyer_name,
        :buyer_tax_no,
        :buyer_address_phone,
        :buyer_bank_account,
        :items,
        :net_total,
        :tax_total,
        :gross_total,
        :issuer,
        :reviewer,
        :payee,
        :remarks,
        :party_account_id,
        :amount_account_id,
        :tax_account_id,
        :mirror_invoice_id
      ]

      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Acc.InvoiceDraft, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.PartyNotSelf, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后头字段被改"竞态
          case __MODULE__.lock_invoice(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿发票可修改或删除")
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Acc.InvoiceDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后发票被删"竞态
          case __MODULE__.lock_invoice(cs.data.id) do
            {:ok, %{status: :draft}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅草稿发票可修改或删除")
          end
        end)
      end
    end

    update :audit do
      # 过账日期可在审核时补填/修正
      accept [:posting_date]
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿发票可审核"}
      end

      validate fn changeset, _context ->
        if Ash.Changeset.get_attribute(changeset, :posting_date) do
          :ok
        else
          {:error, field: :posting_date, message: "审核过账前必须填写过账日期"}
        end
      end

      validate fn changeset, _context ->
        case __MODULE__.audit_blockers(changeset.data) do
          [] ->
            case SynieCore.Acc.GL.validate_entries(
                   changeset.data.company_id,
                   __MODULE__.gl_entries(changeset.data)
                 ) do
              :ok -> :ok
              {:error, msg} -> {:error, message: msg}
            end

          msgs ->
            {:error, message: Enum.join(msgs, ";")}
        end
      end

      change fn changeset, context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :audited)
        |> Ash.Changeset.force_change_attribute(:audited_at, DateTime.utc_now())
        |> then(fn cs ->
          case context.actor do
            %SynieCore.Authz.Actor{user_id: user_id} ->
              Ash.Changeset.force_change_attribute(cs, :audited_by_id, user_id)

            _ ->
              cs
          end
        end)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:before_action 在动作事务内执行,FOR UPDATE 持锁到事务提交,
          # 借此串行化审核与并发改头/并发审核——关闭双审核竞态(构建期预检看到的状态可能已过期)
          case __MODULE__.lock_invoice(cs.data.id) do
            {:ok, %{status: :draft} = locked} ->
              case __MODULE__.audit_blockers(locked) do
                [] ->
                  case SynieCore.Acc.GL.validate_entries(
                         locked.company_id,
                         __MODULE__.gl_entries(locked)
                       ) do
                    :ok -> cs
                    {:error, msg} -> Ash.Changeset.add_error(cs, message: msg)
                  end

                msgs ->
                  Ash.Changeset.add_error(cs, message: Enum.join(msgs, ";"))
              end

            _ ->
              Ash.Changeset.add_error(cs, message: "仅草稿发票可审核")
          end
        end)
        |> Ash.Changeset.after_action(fn _cs, inv ->
          # 最后防线:事务内重读后过账(纵深防御,正常流程不应触发)
          SynieCore.Acc.GL.post!(
            %{
              voucher_type: "acc.vat_invoice",
              voucher_id: inv.id,
              voucher_no: inv.doc_no || inv.invoice_no,
              company_id: inv.company_id,
              posting_date: inv.posting_date
            },
            __MODULE__.gl_entries(inv)
          )

          {:ok, inv}
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核发票可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭双作废/作废与红冲并发竞态
          case __MODULE__.lock_invoice(cs.data.id) do
            {:ok, %{status: :audited}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核发票可作废")
          end
        end)
        |> Ash.Changeset.after_action(fn _cs, inv ->
          SynieCore.Acc.GL.cancel!("acc.vat_invoice", inv.id)
          {:ok, inv}
        end)
      end
    end

    update :reverse do
      accept [:red_invoice_no]
      argument :posting_date, :date, allow_nil?: false
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核发票可红冲"}
      end

      change fn changeset, _context ->
        posting_date = Ash.Changeset.get_argument(changeset, :posting_date)

        changeset
        |> Ash.Changeset.force_change_attribute(:status, :reversed)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭双红冲/红冲与作废并发竞态
          case __MODULE__.lock_invoice(cs.data.id) do
            {:ok, %{status: :audited}} -> cs
            _ -> Ash.Changeset.add_error(cs, message: "仅已审核发票可红冲")
          end
        end)
        |> Ash.Changeset.after_action(fn _cs, inv ->
          # 红字组生成完全交给 GL.reverse!,发票侧不自己拼分录
          SynieCore.Acc.GL.reverse!("acc.vat_invoice", inv.id, posting_date)
          {:ok, inv}
        end)
      end
    end

    action :ocr, :map do
      description "上传发票图片/PDF 后 OCR 识别,返回可回填创建表单的字段(不落库)"
      argument :file_id, :uuid, allow_nil?: false

      run fn input, context ->
        # DSL run 闭包内 alias 不生效(同 bank_reconciliation :remaining 先例),全限定
        case SynieCore.Ocr.recognize_invoice(context.actor, input.arguments.file_id) do
          {:ok, fields} ->
            {:ok, fields}

          # 字符串错误会被包成 Ash.Error.Unknown,AshGraphql 渲染不了;
          # 包成 Action.InvalidArgument(协议已实现)让中文信息透出到前端
          {:error, msg} ->
            {:error, Ash.Error.Action.InvalidArgument.exception(field: :file_id, message: msg)}
        end
      end
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :doc_no, :string do
      public? true
      constraints max_length: 32
      description "内部单据编号"
    end

    attribute :direction, SynieCore.Acc.InvoiceDirection do
      allow_nil? false
      public? true
      description "开票方向"
    end

    attribute :invoice_date, :date do
      public? true
      description "开票日期"
    end

    attribute :posting_date, :date do
      # 草稿可不填,审核时必须有(Task 4 的 audit 动作校验)
      public? true
      description "过账日期"
    end

    attribute :party_type, SynieCore.Acc.PartyType do
      allow_nil? false
      public? true
      description "对手类型"
    end

    attribute :party_id, :uuid do
      allow_nil? false
      public? true
      description "对手"
    end

    attribute :invoice_kind, SynieCore.Acc.InvoiceKind do
      allow_nil? false
      public? true
      description "发票种类"
    end

    attribute :invoice_code, :string do
      allow_nil? false
      default ""
      public? true

      # 数电票无发票代码,允许存空串(Ash 字符串类型默认把空串规整成 nil,这里显式放开)
      constraints max_length: 20, allow_empty?: true
      description "发票代码(数电票为空串)"
    end

    attribute :invoice_no, :string do
      public? true
      constraints max_length: 32
      description "发票号码"
    end

    attribute :seller_name, :string do
      public? true
      description "销方名称"
    end

    attribute :seller_tax_no, :string do
      public? true
      description "销方纳税人识别号"
    end

    attribute :seller_address_phone, :string do
      public? true
      description "销方地址、电话"
    end

    attribute :seller_bank_account, :string do
      public? true
      description "销方开户行及账号"
    end

    attribute :buyer_name, :string do
      public? true
      description "购方名称"
    end

    attribute :buyer_tax_no, :string do
      public? true
      description "购方纳税人识别号"
    end

    attribute :buyer_address_phone, :string do
      public? true
      description "购方地址、电话"
    end

    attribute :buyer_bank_account, :string do
      public? true
      description "购方开户行及账号"
    end

    attribute :items, {:array, :map} do
      allow_nil? false
      default []
      public? true
      description "发票明细"
    end

    attribute :net_total, :decimal do
      public? true
      description "不含税金额"
    end

    attribute :tax_total, :decimal do
      public? true
      description "税额"
    end

    attribute :gross_total, :decimal do
      public? true
      description "价税合计"
    end

    attribute :issuer, :string do
      public? true
      description "开票人"
    end

    attribute :reviewer, :string do
      public? true
      description "复核人"
    end

    attribute :payee, :string do
      public? true
      description "收款人"
    end

    attribute :remarks, :string do
      public? true
      description "备注"
    end

    attribute :red_invoice_no, :string do
      public? true
      description "红冲对应原发票号码"
    end

    attribute :status, SynieCore.Acc.InvoiceStatus do
      allow_nil? false
      writable? false
      default :draft
      public? true
      description "状态"
    end

    attribute :audited_at, :utc_datetime_usec do
      writable? false
      public? true
      description "审核时间"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :company, SynieCore.Base.Company do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "公司"
    end

    belongs_to :party_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "往来科目"
    end

    belongs_to :amount_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "金额科目"
    end

    belongs_to :tax_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "税额科目"
    end

    belongs_to :mirror_invoice, __MODULE__ do
      public? true
      attribute_public? true
      attribute_writable? true
      description "对向发票"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "录入人"
    end

    belongs_to :audited_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "审核人"
    end
  end

  @doc false
  # 发票粒度锁:FOR UPDATE 锁住发票行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化改/删/审核/作废/红冲
  def lock_invoice(invoice_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^invoice_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc "按三科目与方向派生分录组;红冲取负由 GL.reverse! 负责,不在此处理。"
  def gl_entries(%__MODULE__{} = inv) do
    currencies =
      SynieCore.Base.Account
      |> Ash.Query.filter(
        id in ^Enum.reject(
          [inv.party_account_id, inv.amount_account_id, inv.tax_account_id],
          &is_nil/1
        )
      )
      |> Ash.read!(authorize?: false)
      |> Map.new(&{&1.id, &1.currency_id})

    zero = Decimal.new(0)

    entry = fn account_id, debit, credit, party? ->
      %{
        account_id: account_id,
        currency_id: currencies[account_id],
        debit: debit,
        credit: credit,
        party_type: if(party?, do: inv.party_type),
        party_id: if(party?, do: inv.party_id),
        remarks: nil
      }
    end

    tax? = inv.tax_total != nil and Decimal.compare(inv.tax_total, 0) == :gt

    case inv.direction do
      :outbound ->
        [
          entry.(inv.party_account_id, inv.gross_total, zero, true),
          entry.(inv.amount_account_id, zero, inv.net_total, false)
        ] ++
          if(tax?, do: [entry.(inv.tax_account_id, zero, inv.tax_total, false)], else: [])

      :inbound ->
        [entry.(inv.amount_account_id, inv.net_total, zero, false)] ++
          if(tax?, do: [entry.(inv.tax_account_id, inv.tax_total, zero, false)], else: []) ++
          [entry.(inv.party_account_id, zero, inv.gross_total, true)]
    end
  end

  @doc "审核前的齐全性检查,返回缺失/错误清单(空 = 可审核)。"
  def audit_blockers(inv) do
    zero = Decimal.new(0)

    [
      {is_nil(inv.invoice_no), "审核前必须填写发票号码"},
      {is_nil(inv.invoice_date), "审核前必须填写开票日期"},
      {is_nil(inv.net_total) or is_nil(inv.tax_total) or is_nil(inv.gross_total),
       "审核前必须填写未税金额、税额与价税合计"},
      {not is_nil(inv.gross_total) and Decimal.compare(inv.gross_total, zero) != :gt,
       "价税合计必须大于零"},
      {not is_nil(inv.tax_total) and Decimal.compare(inv.tax_total, zero) == :lt, "税额不能为负"},
      {not (is_nil(inv.net_total) or is_nil(inv.tax_total) or is_nil(inv.gross_total)) and
         not Decimal.equal?(Decimal.add(inv.net_total, inv.tax_total), inv.gross_total),
       "未税金额+税额必须等于价税合计"},
      {is_nil(inv.party_account_id), "审核前必须选择往来科目"},
      {is_nil(inv.amount_account_id), "审核前必须选择价款科目"},
      {not is_nil(inv.tax_total) and Decimal.compare(inv.tax_total, zero) == :gt and
         is_nil(inv.tax_account_id), "税额大于零时必须选择税额科目"}
    ]
    |> Enum.filter(&elem(&1, 0))
    |> Enum.map(&elem(&1, 1))
  end
end
