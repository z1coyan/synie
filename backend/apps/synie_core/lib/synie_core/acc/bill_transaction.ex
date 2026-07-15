defmodule SynieCore.Acc.BillTransactionType do
  @moduledoc "承兑交易类型。"
  use Ash.Type.Enum,
    values: [
      receive: "接收",
      endorse: "转让",
      settle: "兑付",
      discount: "贴现",
      reallocate: "调拨"
    ]

  def graphql_type(_), do: :acc_bill_transaction_type
end

defmodule SynieCore.Acc.BillTransactionStatus do
  @moduledoc "承兑交易状态:草稿/已审核/已作废。"
  use Ash.Type.Enum, values: [draft: "草稿", audited: "已审核", voided: "已作废"]
  def graphql_type(_), do: :acc_bill_transaction_status
end

defmodule SynieCore.Acc.BillTransactionDraft do
  @moduledoc "校验交易处于草稿态(修改/删除的前提)。"
  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    if changeset.data.status == :draft,
      do: :ok,
      else: {:error, message: "仅草稿交易可修改或删除"}
  end
end

defmodule SynieCore.Acc.BillTransactionRules do
  @moduledoc """
  类型-字段矩阵与段勾稽:
  - receive/endorse 必填对手;settle/discount/reallocate 对手必须为空
  - discount 必填贴现四件(org/rate/interest/net)且 amount = interest + net;其余类型四件必须为空
  - reallocate 必填 to_bank_account_id(同公司/启用/≠转出);其余类型必须为空
  - 段勾稽:sub_end − sub_start + 1 = amount × 100;1 ≤ sub_start ≤ sub_end ≤ face_amount × 100
    (bill_id 为空时——接收走 bill_attrs 建档——build 期跳过越界这一步,由建档 change 在
    before_action 补上 bill_id 后调用 `check_face_range/2` 复检)
  """
  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, _context) do
    with :ok <- party_rule(changeset),
         :ok <- discount_rule(changeset),
         :ok <- reallocate_rule(changeset) do
      segment_rule(changeset)
    end
  end

  defp party_rule(changeset) do
    type = Ash.Changeset.get_attribute(changeset, :transaction_type)
    party_type = Ash.Changeset.get_attribute(changeset, :party_type)
    party_id = Ash.Changeset.get_attribute(changeset, :party_id)

    cond do
      type in [:receive, :endorse] and (is_nil(party_type) or is_nil(party_id)) ->
        {:error, field: :party_id, message: "接收/转让必须选择交易对手"}

      type not in [:receive, :endorse] and (not is_nil(party_type) or not is_nil(party_id)) ->
        {:error, field: :party_id, message: "该交易类型不填交易对手"}

      true ->
        :ok
    end
  end

  defp discount_rule(changeset) do
    type = Ash.Changeset.get_attribute(changeset, :transaction_type)
    org = Ash.Changeset.get_attribute(changeset, :discount_org)
    rate = Ash.Changeset.get_attribute(changeset, :discount_rate)
    interest = Ash.Changeset.get_attribute(changeset, :interest)
    net = Ash.Changeset.get_attribute(changeset, :net_amount)
    amount = Ash.Changeset.get_attribute(changeset, :amount)

    cond do
      type == :discount and (is_nil(org) or is_nil(rate) or is_nil(interest) or is_nil(net)) ->
        {:error, field: :discount_org, message: "贴现必须填写贴现机构、利率、利息与实收金额"}

      type == :discount and Decimal.compare(rate, 0) == :lt ->
        {:error, field: :discount_rate, message: "贴现利率不能为负"}

      type == :discount and Decimal.compare(interest, 0) == :lt ->
        {:error, field: :interest, message: "贴现利息不能为负"}

      type == :discount and Decimal.compare(net, 0) != :gt ->
        {:error, field: :net_amount, message: "贴现实收金额必须大于零"}

      type == :discount and
          (is_nil(amount) or not Decimal.equal?(amount, Decimal.add(interest, net))) ->
        {:error, field: :net_amount, message: "贴现金额必须等于利息+实收金额"}

      type != :discount and (org || rate || interest || net) ->
        {:error, field: :discount_org, message: "非贴现交易不填贴现机构、利率、利息与实收金额"}

      true ->
        :ok
    end
  end

  defp reallocate_rule(changeset) do
    type = Ash.Changeset.get_attribute(changeset, :transaction_type)
    to_id = Ash.Changeset.get_attribute(changeset, :to_bank_account_id)
    from_id = Ash.Changeset.get_attribute(changeset, :bank_account_id)

    if type == :reallocate do
      cond do
        is_nil(to_id) ->
          {:error, field: :to_bank_account_id, message: "调拨必须选择转入账户"}

        to_id == from_id ->
          {:error, field: :to_bank_account_id, message: "转入账户不能与转出账户相同"}

        true ->
          # update 不查启用(照 OwnBankAccount 主账户先例,允许改错录归属)
          SynieCore.Acc.OwnBankAccount.validate(
            changeset,
            [attribute: :to_bank_account_id, check_active: changeset.action_type == :create],
            %{}
          )
      end
    else
      if is_nil(to_id) do
        :ok
      else
        {:error, field: :to_bank_account_id, message: "该交易类型不填转入账户"}
      end
    end
  end

  defp segment_rule(changeset) do
    sub_start = Ash.Changeset.get_attribute(changeset, :sub_start)
    sub_end = Ash.Changeset.get_attribute(changeset, :sub_end)
    amount = Ash.Changeset.get_attribute(changeset, :amount)
    bill_id = Ash.Changeset.get_attribute(changeset, :bill_id)

    cond do
      is_nil(sub_start) or is_nil(sub_end) or is_nil(amount) ->
        # allow_nil? false 的必填校验兜底,这里不重复报错
        :ok

      sub_start < 1 ->
        {:error, field: :sub_start, message: "子票起必须大于等于1"}

      sub_end < sub_start ->
        {:error, field: :sub_end, message: "子票止不能小于子票起"}

      Decimal.compare(amount, 0) != :gt ->
        {:error, field: :amount, message: "交易金额必须大于零"}

      not Decimal.equal?(Decimal.mult(amount, 100), Decimal.new(sub_end - sub_start + 1)) ->
        {:error, field: :sub_end, message: "子票止必须等于 子票起+金额×100−1"}

      is_nil(bill_id) ->
        :ok

      true ->
        case Ash.get(SynieCore.Acc.Bill, bill_id, authorize?: false) do
          {:ok, bill} -> check_face_range(sub_end, bill.face_amount)
          {:error, _} -> :ok
        end
    end
  end

  @doc false
  # 子票段不能越出票据包范围;供上面的构建期校验、以及 create 里 bill_attrs 建档
  # 拿到 bill 之后在 before_action 内复检共用(建档路径 build 期还没有 bill,拿不到 face_amount)
  def check_face_range(sub_end, face_amount) do
    if Decimal.compare(Decimal.new(sub_end), Decimal.mult(face_amount, 100)) == :gt do
      {:error, field: :sub_end, message: "子票段超出票据包范围"}
    else
      :ok
    end
  end
end

defmodule SynieCore.Acc.BillTransaction do
  @moduledoc """
  承兑交易,对应 `acc_bill_transaction` 表。五种类型单表:接收/转让/兑付/贴现/调拨,
  是 GL 的一个 voucher(与发票、手工凭证地位平等)。

  接收交易的建档契约:`bill_id` 与 `bill_attrs`(:map,snake_case 字符串键,键集 = Bill
  `:register` 的 accept 列表)二选一——票号已建档传 `bill_id`;未建档传 `bill_attrs`,
  由 `create` 的 before_action 调用 `Bill.:register` upsert(挂接不覆盖)。其余四种类型
  一律传 `bill_id`(从持有段选出)。

  `bill_id` 逻辑必填但属性层 `allow_nil?` 不能设为 false:bill_attrs 建档要到
  create 的 before_action 才落定 bill_id,而 Ash 的必填校验(require_values)发生在
  before_action 之前(同 `SynieCore.Numbering.AutoNumber` moduledoc 的警告)。真正的
  非空由 create 的显式校验(bill_id 或 bill_attrs 二选一)兜底,DB 外键仍校验存在性。

  生命周期:草稿(可改可删)→ 已审核(`audit`,派生 `gl_entries/1` 过账 + `BillLedger.replay!/1`
  重放库存)→ 已作废(`void`,原分录标 `is_cancelled` + 重放)。调拨类型不生凭证,`audit`/`void`
  均跳过 GL 调用,只驱动库存重放(段迁移/迁回)。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "acc_bill_transaction"
    repo SynieCore.Repo

    custom_indexes do
      index [:company_id, :doc_no],
        unique: true,
        where: "doc_no IS NOT NULL",
        name: "acc_bill_transaction_doc_no_uniq",
        message: "单据编号已存在"

      # BillLedger 重放取数(Task 3)
      index [:bill_id, :status]
      index [:company_id, :status]
      index [:company_id, :bank_account_id, :occurred_on]
    end

    # sub_start/sub_end 承载 face×100(10亿票 → 10^11),必须 bigint
    migration_types sub_start: :bigint, sub_end: :bigint
  end

  graphql do
    type :acc_bill_transaction
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy action([:read, :create, :update, :destroy, :audit, :void]) do
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

  def permission_prefix, do: "acc.bill_transaction"
  def permission_actions, do: ~w(create read update delete audit void)

  def grid_actions do
    [
      %{
        key: "audit",
        label: "审核",
        scope: "row",
        mutation: "auditAccBillTransaction",
        is_danger: false
      },
      %{
        key: "void",
        label: "作废",
        scope: "row",
        mutation: "voidAccBillTransaction",
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
        :transaction_type,
        :bank_account_id,
        :to_bank_account_id,
        :bill_id,
        :occurred_on,
        :sub_start,
        :sub_end,
        :amount,
        :party_type,
        :party_id,
        :discount_org,
        :discount_rate,
        :interest,
        :net_amount,
        :bill_account_id,
        :settle_account_id,
        :interest_account_id,
        :remarks
      ]

      # 接收建档:票号不存在时前端传票面参数(snake_case 字符串键 map,键集见 moduledoc)
      argument :bill_attrs, :map, allow_nil?: true

      validate {SynieCore.Authz.Validations.CompanyAccessible, []}
      validate {SynieCore.Acc.OwnBankAccount, check_active: true}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.BillTransactionRules, []}

      # 接收必须有票:bill_id 或 bill_attrs 至少其一;其余类型一律必须传 bill_id
      validate fn changeset, _context ->
        type = Ash.Changeset.get_attribute(changeset, :transaction_type)
        bill_id = Ash.Changeset.get_attribute(changeset, :bill_id)
        bill_attrs = Ash.Changeset.get_argument(changeset, :bill_attrs)

        cond do
          type == :receive and is_nil(bill_id) and is_nil(bill_attrs) ->
            {:error, field: :bill_id, message: "接收交易必须提供已有票据或票面信息"}

          type != :receive and is_nil(bill_id) ->
            {:error, field: :bill_id, message: "该交易类型必须选择票据"}

          true ->
            :ok
        end
      end

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

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # bill_attrs 建档:事务内 Bill.:register upsert(authorize?: false,挂接不覆盖),
          # 随后复检子票段未越出刚拿到的 face_amount(build 期无票,越界这一步被 segment_rule 跳过)
          case Ash.Changeset.get_argument(cs, :bill_attrs) do
            nil -> cs
            attrs -> register_bill(cs, attrs)
          end
        end)
      end
    end

    update :update do
      accept [
        :doc_no,
        :bank_account_id,
        :to_bank_account_id,
        :bill_id,
        :occurred_on,
        :sub_start,
        :sub_end,
        :amount,
        :party_type,
        :party_id,
        :discount_org,
        :discount_rate,
        :interest,
        :net_amount,
        :bill_account_id,
        :settle_account_id,
        :interest_account_id,
        :remarks
      ]

      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Acc.BillTransactionDraft, []}
      # update 不查启用:允许改错录归属(照 BankTransaction 先例)
      validate {SynieCore.Acc.OwnBankAccount, []}
      validate {SynieCore.Acc.PartyExists, []}
      validate {SynieCore.Acc.BillTransactionRules, []}

      # bill_id 属性层可空是 create 建档路径的技术让步(见 moduledoc),update 无此路径:
      # 保留在 accept 里允许改挂别的票,但置空即产生无票孤儿交易,必须拒绝
      validate fn changeset, _context ->
        if is_nil(Ash.Changeset.get_attribute(changeset, :bill_id)) do
          {:error, field: :bill_id, message: "交易必须关联票据"}
        else
          :ok
        end
      end

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后字段被改"竞态
          case lock_and_ensure(cs, :draft, "仅草稿交易可修改或删除") do
            {:ok, _locked, cs} -> cs
            {:error, cs} -> cs
          end
        end)
      end
    end

    destroy :destroy do
      primary? true
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate {SynieCore.Acc.BillTransactionDraft, []}

      change fn changeset, _context ->
        Ash.Changeset.before_action(changeset, fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭"并发审核后交易被删"竞态
          case lock_and_ensure(cs, :draft, "仅草稿交易可修改或删除") do
            {:ok, _locked, cs} -> cs
            {:error, cs} -> cs
          end
        end)
      end
    end

    update :audit do
      # 过账日期可在审核时补填/修正;调拨不生凭证,不填此参数
      accept [:posting_date]
      require_atomic? false

      # 构建期预检(用户体验,普通读即可):此时在动作事务之外,无需也不能加锁。
      # 权威复检在下方 change 的 before_action 钩子内(事务内 FOR UPDATE 重读)完成。
      validate fn changeset, _context ->
        if changeset.data.status == :draft, do: :ok, else: {:error, message: "仅草稿交易可审核"}
      end

      # 非调拨必填 posting_date;调拨忽略(不生凭证)。posting_date 是本次提交的输入,
      # 不来自可能过期的 changeset.data,无需在 before_action 里重复校验
      validate fn changeset, _context ->
        if changeset.data.transaction_type != :reallocate and
             is_nil(Ash.Changeset.get_attribute(changeset, :posting_date)) do
          {:error, field: :posting_date, message: "审核过账前必须填写过账日期"}
        else
          :ok
        end
      end

      validate fn changeset, _context ->
        bill = Ash.get!(SynieCore.Acc.Bill, changeset.data.bill_id, authorize?: false)

        case __MODULE__.audit_blockers(changeset.data, bill) do
          [] ->
            if changeset.data.transaction_type == :reallocate do
              :ok
            else
              case SynieCore.Acc.GL.validate_entries(
                     changeset.data.company_id,
                     __MODULE__.gl_entries(changeset.data)
                   ) do
                :ok -> :ok
                {:error, msg} -> {:error, message: msg}
              end
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
          case lock_and_ensure(cs, :draft, "仅草稿交易可审核") do
            {:ok, locked, cs} ->
              bill = Ash.get!(SynieCore.Acc.Bill, locked.bill_id, authorize?: false)

              case __MODULE__.audit_blockers(locked, bill) do
                [] ->
                  if locked.transaction_type == :reallocate do
                    cs
                  else
                    case SynieCore.Acc.GL.validate_entries(
                           locked.company_id,
                           __MODULE__.gl_entries(locked)
                         ) do
                      :ok -> cs
                      {:error, msg} -> Ash.Changeset.add_error(cs, message: msg)
                    end
                  end

                msgs ->
                  Ash.Changeset.add_error(cs, message: Enum.join(msgs, ";"))
              end

            {:error, cs} ->
              cs
          end
        end)
        |> Ash.Changeset.after_action(fn _cs, tx ->
          bill = Ash.get!(SynieCore.Acc.Bill, tx.bill_id, authorize?: false)

          # 调拨不生凭证:段迁移交给下面的 BillLedger.replay!
          if tx.transaction_type != :reallocate do
            SynieCore.Acc.GL.post!(
              %{
                voucher_type: "acc.bill_transaction",
                voucher_id: tx.id,
                voucher_no: tx.doc_no || bill.bill_no,
                company_id: tx.company_id,
                posting_date: tx.posting_date
              },
              __MODULE__.gl_entries(tx)
            )
          end

          # 库存全链重验(锁票据行);不合法则 {:error, _} 回滚整个审核事务(含上面已插入的分录),
          # 并把中文报错(含单号)透传成用户可见的 Ash 校验错误,而非顶层 something_went_wrong
          replay_bill!(tx)
        end)
      end
    end

    update :void do
      accept []
      require_atomic? false

      # 构建期预检(用户体验),权威复检在 before_action 钩子内
      validate fn changeset, _context ->
        if changeset.data.status == :audited, do: :ok, else: {:error, message: "仅已审核交易可作废"}
      end

      change fn changeset, _context ->
        changeset
        |> Ash.Changeset.force_change_attribute(:status, :voided)
        |> Ash.Changeset.before_action(fn cs ->
          # 权威复检:事务内 FOR UPDATE 重读,关闭双作废/作废与并发审核其他交易的竞态
          case lock_and_ensure(cs, :audited, "仅已审核交易可作废") do
            {:ok, _locked, cs} -> cs
            {:error, cs} -> cs
          end
        end)
        |> Ash.Changeset.after_action(fn _cs, tx ->
          # 调拨没有凭证可取消,跳过(照审核侧对称)
          if tx.transaction_type != :reallocate do
            SynieCore.Acc.GL.cancel!("acc.bill_transaction", tx.id)
          end

          # 移除本笔(已在上面提交为 voided)后重放:后续交易若消耗过本笔产生的段,
          # replay! 找不到覆盖段则 {:error, _} 回滚整个作废事务(状态与已取消的分录一并撤销),
          # 并把中文报错(含单号)透传成用户可见的 Ash 校验错误,而非顶层 something_went_wrong
          replay_bill!(tx)
        end)
      end
    end

    action :ocr, :map do
      description "上传承兑汇票图片后 OCR 识别,返回可回填接收票面草稿的字段(不落库)"
      argument :file_id, :uuid, allow_nil?: false

      run fn input, context ->
        # DSL run 闭包内 alias 不生效(同 bank_reconciliation :remaining 先例),全限定
        case SynieCore.Ocr.recognize_bank_acceptance(context.actor, input.arguments.file_id) do
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
      description "单据编号"
    end

    attribute :transaction_type, SynieCore.Acc.BillTransactionType do
      allow_nil? false
      public? true
      description "交易类型"
    end

    attribute :occurred_on, :date do
      allow_nil? false
      public? true
      description "发生日期"
    end

    attribute :sub_start, :integer do
      allow_nil? false
      public? true
      constraints min: 1
      description "子票起"
    end

    attribute :sub_end, :integer do
      allow_nil? false
      public? true
      constraints min: 1
      description "子票止"
    end

    attribute :amount, :decimal do
      allow_nil? false
      public? true
      description "交易金额(段金额)"
    end

    attribute :party_type, SynieCore.Acc.PartyType do
      public? true
      description "对手类型"
    end

    attribute :party_id, :uuid do
      public? true
      description "交易对手"
    end

    attribute :discount_org, :string do
      public? true
      constraints max_length: 64
      description "贴现机构"
    end

    attribute :discount_rate, :decimal do
      public? true
      description "贴现利率(年化%)"
    end

    attribute :interest, :decimal do
      public? true
      description "贴现利息"
    end

    attribute :net_amount, :decimal do
      public? true
      description "实收金额"
    end

    attribute :posting_date, :date do
      # 草稿可不填,审核时必须有(Task 4 的 audit 动作校验);调拨不生凭证不收此参数
      public? true
      description "过账日期"
    end

    attribute :status, SynieCore.Acc.BillTransactionStatus do
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

    attribute :remarks, :string do
      public? true
      description "备注"
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

    belongs_to :bank_account, SynieCore.Acc.BankAccount do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "本方银行账户(调拨为转出账户)"
    end

    belongs_to :to_bank_account, SynieCore.Acc.BankAccount do
      public? true
      attribute_public? true
      attribute_writable? true
      description "调拨转入账户"
    end

    belongs_to :bill, SynieCore.Acc.Bill do
      # 见 moduledoc:allow_nil? 不能设 false,否则 bill_attrs 建档路径必然先报必填
      public? true
      attribute_public? true
      attribute_writable? true
      description "关联票据"
    end

    belongs_to :bill_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "票据科目"
    end

    belongs_to :settle_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "结算科目"
    end

    belongs_to :interest_account, SynieCore.Base.Account do
      public? true
      attribute_public? true
      attribute_writable? true
      description "利息科目"
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

  # bill_attrs 只认这些 snake_case 字符串键,键集 = Bill :register 的 accept 列表
  @bill_attrs_keys ~w(
    bill_no bill_kind issue_date due_date face_amount
    drawer_name drawer_account drawer_bank_name drawer_bank_no
    payee_name payee_account payee_bank_name payee_bank_no
    acceptor_name acceptor_account acceptor_bank_name acceptor_bank_no
    transferable acceptance_date remarks
  )

  defp register_bill(changeset, attrs) do
    taken =
      for key <- @bill_attrs_keys, Map.has_key?(attrs, key), into: %{} do
        {String.to_existing_atom(key), Map.fetch!(attrs, key)}
      end

    case SynieCore.Acc.Bill
         |> Ash.Changeset.for_create(:register, taken, authorize?: false)
         |> Ash.create(authorize?: false) do
      {:ok, bill} ->
        changeset
        |> Ash.Changeset.force_change_attribute(:bill_id, bill.id)
        |> recheck_face_range(bill)

      {:error, _error} ->
        Ash.Changeset.add_error(changeset,
          field: :bill_attrs,
          message: "票据建档失败,请检查票号/种类/到期日/金额等必填票面信息"
        )
    end
  end

  defp recheck_face_range(changeset, bill) do
    sub_end = Ash.Changeset.get_attribute(changeset, :sub_end)

    case SynieCore.Acc.BillTransactionRules.check_face_range(sub_end, bill.face_amount) do
      :ok -> changeset
      {:error, opts} -> Ash.Changeset.add_error(changeset, opts)
    end
  end

  @doc false
  # 交易粒度锁:FOR UPDATE 锁住交易行本身;仅在 before_action 钩子内调用才有效——
  # before_action 在动作事务内执行,锁持有到事务提交,借此串行化改/删/审核/作废
  def lock_transaction(id) do
    __MODULE__
    |> Ash.Query.filter(id == ^id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 权威复检共用:事务内 FOR UPDATE 重读交易,状态不符则挂错(中文);
  # update/destroy/audit/void 四处 before_action 共用,行为与各自原逐字重复版本一致
  defp lock_and_ensure(changeset, expected_status, error_message) do
    case lock_transaction(changeset.data.id) do
      {:ok, %{status: ^expected_status} = locked} ->
        {:ok, locked, changeset}

      _ ->
        {:error, Ash.Changeset.add_error(changeset, message: error_message)}
    end
  end

  @doc false
  # audit/void after_action 共用:BillLedger.replay! 校验不合法时 raise ArgumentError
  # (中文,带单号),这里捕获转成 {:error, InvalidChanges}——after_action 返回 {:error, _}
  # 同样触发事务回滚(照 raise 原行为),但错误消息会作为 Ash 校验错误透传给前端,
  # 而不是被包成顶层 something_went_wrong 只进服务端日志
  defp replay_bill!(tx) do
    SynieCore.Acc.BillLedger.replay!(tx.bill_id)
    {:ok, tx}
  rescue
    e in ArgumentError ->
      {:error, Ash.Error.Changes.InvalidChanges.exception(message: e.message)}
  end

  @doc "按类型派生分录组;调拨不生凭证,返回 []。currency 取科目,照 vat_invoice.gl_entries 的 currencies map。"
  def gl_entries(%__MODULE__{transaction_type: :reallocate}), do: []

  def gl_entries(%__MODULE__{} = tx) do
    currencies =
      SynieCore.Base.Account
      |> Ash.Query.filter(
        id in ^Enum.reject(
          [tx.bill_account_id, tx.settle_account_id, tx.interest_account_id],
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
        party_type: if(party?, do: tx.party_type),
        party_id: if(party?, do: tx.party_id),
        remarks: nil
      }
    end

    case tx.transaction_type do
      :receive ->
        [
          entry.(tx.bill_account_id, tx.amount, zero, false),
          entry.(tx.settle_account_id, zero, tx.amount, true)
        ]

      :endorse ->
        [
          entry.(tx.settle_account_id, tx.amount, zero, true),
          entry.(tx.bill_account_id, zero, tx.amount, false)
        ]

      :settle ->
        [
          entry.(tx.settle_account_id, tx.amount, zero, false),
          entry.(tx.bill_account_id, zero, tx.amount, false)
        ]

      :discount ->
        interest? = Decimal.compare(tx.interest, 0) == :gt

        [entry.(tx.settle_account_id, tx.net_amount, zero, false)] ++
          if(interest?, do: [entry.(tx.interest_account_id, tx.interest, zero, false)], else: []) ++
          [entry.(tx.bill_account_id, zero, tx.amount, false)]
    end
  end

  @doc "审核前齐全性与日期/票面硬校验清单(空=可审核);bill 由调用方 load 后传入。"
  def audit_blockers(tx, bill) do
    type = tx.transaction_type

    [
      {type != :reallocate and is_nil(tx.bill_account_id), "审核前必须选择票据科目"},
      {type != :reallocate and is_nil(tx.settle_account_id), "审核前必须选择结算科目"},
      {type == :discount and Decimal.compare(tx.interest, 0) == :gt and
         is_nil(tx.interest_account_id), "贴现利息大于零时必须选择利息科目"},
      {type == :settle and Date.compare(tx.occurred_on, bill.due_date) == :lt,
       "兑付发生日期不能早于票据到期日 #{bill.due_date}"},
      {type in [:receive, :endorse, :discount] and
         Date.compare(tx.occurred_on, bill.due_date) == :gt,
       "#{SynieCore.Acc.BillTransactionType.description(type)}发生日期不能晚于票据到期日 " <>
         "#{bill.due_date}(到期后只能托收)"},
      {type in [:endorse, :discount] and not bill.transferable, "该票据「不得转让」,禁止转让与贴现"}
    ]
    |> Enum.filter(&elem(&1, 0))
    |> Enum.map(&elem(&1, 1))
  end
end
