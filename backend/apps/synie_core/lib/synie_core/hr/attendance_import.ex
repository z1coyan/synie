defmodule SynieCore.Hr.AttendanceImportStatus do
  @moduledoc "考勤导入批次状态:已解析/解析失败/已导入。"

  use Ash.Type.Enum,
    values: [parsed: "已解析", failed: "解析失败", imported: "已导入"]

  def graphql_type(_), do: :hr_attendance_import_status
end

defmodule SynieCore.Hr.AttendanceImport.ReadableFile do
  @moduledoc "校验上传文件对 actor 可见(防拿他人文件 id 挂导入);内部路径(nil actor)跳过。照银行导入先例。"

  use Ash.Resource.Validation

  @impl true
  def validate(changeset, _opts, context) do
    file_id = Ash.Changeset.get_attribute(changeset, :file_id)

    with %SynieCore.Authz.Actor{} = actor <- context.actor,
         false <- actor.super_admin,
         {:ok, nil} <- file_or_error(file_id, actor) do
      {:error, field: :file_id, message: "导入文件不存在或不可见"}
    else
      _ -> :ok
    end
  end

  defp file_or_error(nil, _actor), do: :ok

  defp file_or_error(file_id, actor) do
    Ash.get(SynieCore.Files.File, file_id, actor: actor, authorize?: true, error?: false)
  rescue
    # 读策略拒绝按不可见处理
    _ -> {:ok, nil}
  end
end

defmodule SynieCore.Hr.AttendanceImport.NoDuplicateFile do
  @moduledoc """
  同文件(sha256)防呆:已存在非 failed 状态的相同文件批次即拒绝(误重传是主要
  事故来源;确要重导可先删除原批次)。打卡层另有 (员工,时刻) 唯一兜底幂等。
  """

  use Ash.Resource.Validation

  require Ash.Query

  @impl true
  def validate(changeset, _opts, _context) do
    file_id = Ash.Changeset.get_attribute(changeset, :file_id)

    with true <- file_id != nil,
         {:ok, %{sha256: sha256}} when is_binary(sha256) <-
           Ash.get(SynieCore.Files.File, file_id, authorize?: false, error?: false),
         {:ok, [_existing | _]} <-
           SynieCore.Hr.AttendanceImport
           |> Ash.Query.filter(status != :failed and file.sha256 == ^sha256)
           |> Ash.Query.limit(1)
           |> Ash.read(authorize?: false) do
      {:error, field: :file_id, message: "已存在相同文件的导入批次,如需重新导入请先删除原批次"}
    else
      _ -> :ok
    end
  end
end

defmodule SynieCore.Hr.AttendanceImport.ParseOnCreate do
  @moduledoc """
  create 即解析预览:before_action(动作事务内)读文件解析并按考勤机编号匹配
  员工——成功置 parsed 并落摘要(总行/坏行/文件内重复/已匹配/未匹配及编号清单),
  失败置 failed + error(不 raise,失败批次照常落库供追溯)。暂存行不落库:
  执行导入时重新解析(spec 拍板,月导上万行避免行级写两遍)。
  """

  use Ash.Resource.Change

  alias SynieCore.Hr.AttendanceImport

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn cs ->
      case AttendanceImport.read_and_parse(Ash.Changeset.get_attribute(cs, :file_id)) do
        {:ok, parsed} ->
          emp_map =
            parsed.rows |> Enum.map(& &1.attendance_no) |> AttendanceImport.employee_map()

          {matched, unmatched} =
            Enum.split_with(parsed.rows, &Map.has_key?(emp_map, &1.attendance_no))

          cs
          |> Ash.Changeset.force_change_attribute(:status, :parsed)
          |> Ash.Changeset.force_change_attribute(:total_rows, parsed.total_rows)
          |> Ash.Changeset.force_change_attribute(:bad_rows, parsed.bad_rows)
          |> Ash.Changeset.force_change_attribute(:dup_rows, parsed.dup_rows)
          |> Ash.Changeset.force_change_attribute(:matched_rows, length(matched))
          |> Ash.Changeset.force_change_attribute(:unmatched_rows, length(unmatched))
          |> Ash.Changeset.force_change_attribute(:unmatched_detail, detail(unmatched))

        {:error, message} ->
          cs
          |> Ash.Changeset.force_change_attribute(:status, :failed)
          |> Ash.Changeset.force_change_attribute(:error, String.slice(message, 0, 500))
      end
    end)
  end

  @max_detail_nos 50

  defp detail([]), do: nil

  defp detail(unmatched) do
    counts = unmatched |> Enum.frequencies_by(& &1.attendance_no) |> Enum.sort_by(&elem(&1, 0))

    text =
      counts
      |> Enum.take(@max_detail_nos)
      |> Enum.map_join("、", fn {no, count} -> "#{no}×#{count}" end)

    if length(counts) > @max_detail_nos,
      do: text <> "……(等共 #{length(counts)} 个编号)",
      else: text
  end
end

defmodule SynieCore.Hr.AttendanceImport.ExecuteImport do
  @moduledoc """
  执行导入:before_action 内 FOR UPDATE 锁批次复检 parsed(与撤销/双执行互斥,
  照银行导入先例)→ 重新解析文件 → 匹配员工(勾选自动建时逐个带 actor 走正常
  员工创建,须兼有 hr.employee:create,fail-closed)→ 剔除库中已存在的
  (员工,时刻)(静默跳过计数,幂等)→ after_action 批量直写打卡表。
  """

  use Ash.Resource.Change

  require Ash.Query

  alias SynieCore.Hr.{AttendanceImport, AttendancePunch, Employee}

  @impl true
  def change(changeset, _opts, context) do
    actor = context.actor
    auto_create? = Ash.Changeset.get_argument(changeset, :auto_create_employees)

    changeset
    |> Ash.Changeset.force_change_attribute(:status, :imported)
    |> Ash.Changeset.force_change_attribute(:imported_at, DateTime.utc_now())
    |> then(fn cs ->
      case actor do
        %SynieCore.Authz.Actor{user_id: user_id} ->
          Ash.Changeset.force_change_attribute(cs, :imported_by_id, user_id)

        _ ->
          cs
      end
    end)
    |> Ash.Changeset.before_action(fn cs ->
      case AttendanceImport.lock_import(cs.data.id) do
        {:ok, %{status: :parsed}} -> prepare(cs, auto_create?, actor)
        _ -> Ash.Changeset.add_error(cs, message: "仅「已解析」状态的批次可执行导入")
      end
    end)
    |> Ash.Changeset.after_action(fn cs, record ->
      rows =
        (cs.context[:punch_rows] || [])
        |> Enum.map(&Map.put(&1, :import_id, record.id))

      case rows do
        [] ->
          {:ok, record}

        rows ->
          %Ash.BulkResult{status: :success} =
            Ash.bulk_create(rows, AttendancePunch, :create,
              authorize?: false,
              actor: actor,
              return_errors?: true,
              stop_on_error?: true
            )

          {:ok, record}
      end
    end)
  end

  defp prepare(cs, auto_create?, actor) do
    with {:ok, parsed} <- AttendanceImport.read_and_parse(cs.data.file_id),
         {:ok, emp_map, auto_created} <- ensure_employees(parsed.rows, auto_create?, actor) do
      {matched, unmatched} =
        Enum.split_with(parsed.rows, &Map.has_key?(emp_map, &1.attendance_no))

      punch_rows =
        Enum.map(matched, fn row ->
          %{
            employee_id: Map.fetch!(emp_map, row.attendance_no),
            attendance_no: row.attendance_no,
            punched_at: row.punched_at
          }
        end)

      {punch_rows, skipped_existing} = drop_existing(punch_rows)

      cs
      |> Ash.Changeset.set_context(%{punch_rows: punch_rows})
      |> Ash.Changeset.force_change_attribute(:imported_count, length(punch_rows))
      |> Ash.Changeset.force_change_attribute(:skipped_existing_rows, skipped_existing)
      |> Ash.Changeset.force_change_attribute(:skipped_unmatched_rows, length(unmatched))
      |> Ash.Changeset.force_change_attribute(:auto_created_count, auto_created)
    else
      {:error, message} -> Ash.Changeset.add_error(cs, message: message)
    end
  end

  defp ensure_employees(rows, auto_create?, actor) do
    nos = rows |> Enum.map(& &1.attendance_no) |> Enum.uniq()
    emp_map = AttendanceImport.employee_map(nos)
    missing = Enum.reject(nos, &Map.has_key?(emp_map, &1))

    if missing == [] or not auto_create?,
      do: {:ok, emp_map, 0},
      else: create_missing(missing, emp_map, actor)
  end

  # 逐个带 actor 走正常员工创建(须 hr.employee:create,编号走 AutoNumber)
  defp create_missing(missing, emp_map, actor) do
    emp_map =
      Enum.reduce(missing, emp_map, fn no, acc ->
        employee =
          Employee
          |> Ash.Changeset.for_create(:create, %{name: "[未知]", attendance_no: no})
          |> Ash.create!(actor: actor, authorize?: true)

        Map.put(acc, no, employee.id)
      end)

    {:ok, emp_map, length(missing)}
  rescue
    Ash.Error.Forbidden ->
      {:error, "无权自动创建员工(需要「员工-新增」权限),可去掉勾选仅导入已匹配的行"}

    e in Ash.Error.Invalid ->
      messages =
        e.errors
        |> Enum.map(fn
          %{message: message} when is_binary(message) -> message
          other -> Exception.message(other)
        end)
        |> Enum.join(";")

      {:error, "自动创建员工失败:#{messages}"}
  end

  # 查涉及员工在文件时间范围内的既有打卡,内存剔除(月导≈1.5 万行,可承受)
  defp drop_existing([]), do: {[], 0}

  defp drop_existing(rows) do
    employee_ids = rows |> Enum.map(& &1.employee_id) |> Enum.uniq()
    {min_row, max_row} = Enum.min_max_by(rows, & &1.punched_at, DateTime)

    existing =
      AttendancePunch
      |> Ash.Query.filter(
        employee_id in ^employee_ids and
          punched_at >= ^min_row.punched_at and
          punched_at <= ^max_row.punched_at
      )
      |> Ash.read!(authorize?: false)
      |> MapSet.new(&{&1.employee_id, &1.punched_at})

    kept = Enum.reject(rows, &MapSet.member?(existing, {&1.employee_id, &1.punched_at}))
    {kept, length(rows) - length(kept)}
  end
end

defmodule SynieCore.Hr.AttendanceImport do
  @moduledoc """
  考勤导入批次,对应 `hr_attendance_import` 表。一次 .dat 导入 = 一条批次:
  create 即解析出摘要预览(状态 parsed/failed,暂存行不落库);`import` 动作
  重新解析直写打卡表(可勾选自动创建不存在的员工),状态 imported;删除批次
  即整批撤销(打卡库级联删,任何状态可删——这是导错文件的唯一纠正口子)。

  全局不挂公司(照员工)。无独立权限点:全链路复用 `hr.attendance_punch:import`。
  """

  use Ash.Resource,
    domain: SynieCore,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource],
    authorizers: [Ash.Policy.Authorizer],
    fragments: [SynieCore.Audit.Fragment]

  require Ash.Query

  postgres do
    table "hr_attendance_import"
    repo SynieCore.Repo
  end

  graphql do
    type :hr_attendance_import
  end

  policies do
    bypass actor_attribute_equals(:super_admin, true) do
      authorize_if always()
    end

    policy always() do
      authorize_if {SynieCore.Authz.Checks.HasPermission, as: "import"}
    end
  end

  # 复用打卡导入权限码;actions 为空不进权限目录(照 acc.bank_import 先例)
  def permission_prefix, do: "hr.attendance_punch"
  def permission_actions, do: []
  # 前端表格按钮门控用(不进权限目录):持 import 码即可建/执行/删批次
  def grid_capabilities, do: ~w(import)

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
      accept [:file_id]

      validate {SynieCore.Hr.AttendanceImport.ReadableFile, []}
      validate {SynieCore.Hr.AttendanceImport.NoDuplicateFile, []}

      # 发起人自动取 actor;nil actor 只出现在受信内部路径,允许留空
      change fn changeset, context ->
        case context.actor do
          %SynieCore.Authz.Actor{user_id: user_id} ->
            Ash.Changeset.force_change_attribute(changeset, :created_by_id, user_id)

          _ ->
            changeset
        end
      end

      change {SynieCore.Hr.AttendanceImport.ParseOnCreate, []}
    end

    update :import do
      accept []
      require_atomic? false

      argument :auto_create_employees, :boolean do
        allow_nil? false
        default false
        description "自动创建不存在的员工(姓名[未知],须兼有员工新增权限)"
      end

      # 构建期预检(用户体验),权威复检在 before_action 锁内
      validate fn changeset, _context ->
        if changeset.data.status == :parsed,
          do: :ok,
          else: {:error, message: "仅「已解析」状态的批次可执行导入"}
      end

      change {SynieCore.Hr.AttendanceImport.ExecuteImport, []}
    end

    destroy :destroy do
      primary? true
      require_atomic? false
      # 任何状态可删:删除即整批撤销(打卡级联删),是导错文件的纠正口子;
      # 与执行导入的竞态由行锁天然串行(删除等锁,提交后连同新写打卡一并级联)
    end
  end

  attributes do
    uuid_primary_key :id

    attribute :status, SynieCore.Hr.AttendanceImportStatus do
      allow_nil? false
      public? true

      # 占位默认:必填校验先于 before_action,实际值由 ParseOnCreate 权威覆盖
      default :parsed
      description "状态"
    end

    attribute :error, :string do
      public? true
      constraints max_length: 500
      description "解析失败原因"
    end

    attribute :total_rows, :integer do
      public? true
      description "总行数"
    end

    attribute :bad_rows, :integer do
      public? true
      description "坏行数"
    end

    attribute :dup_rows, :integer do
      public? true
      description "文件内重复行数"
    end

    attribute :matched_rows, :integer do
      public? true
      description "已匹配行数"
    end

    attribute :unmatched_rows, :integer do
      public? true
      description "未匹配行数"
    end

    attribute :unmatched_detail, :string do
      public? true
      constraints max_length: 2000
      description "未匹配编号清单(编号×行数)"
    end

    attribute :imported_count, :integer do
      public? true
      description "导入打卡数"
    end

    attribute :skipped_existing_rows, :integer do
      public? true
      description "跳过已存在行数"
    end

    attribute :skipped_unmatched_rows, :integer do
      public? true
      description "跳过未匹配行数"
    end

    attribute :auto_created_count, :integer do
      public? true
      description "自动创建员工数"
    end

    attribute :imported_at, :utc_datetime do
      public? true
      description "导入时间"
    end

    create_timestamp :inserted_at, public?: true, description: "创建时间"
    update_timestamp :updated_at, public?: true, description: "更新时间"
  end

  relationships do
    belongs_to :file, SynieCore.Files.File do
      allow_nil? false
      public? true
      attribute_public? true
      attribute_writable? true
      description "导入文件"
    end

    belongs_to :created_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "发起人"
    end

    belongs_to :imported_by, SynieCore.Accounts.User do
      public? true
      attribute_public? true
      description "导入人"
    end

    has_many :punches, SynieCore.Hr.AttendancePunch do
      public? true
      destination_attribute :import_id
      description "打卡记录"
    end
  end

  aggregates do
    count :punch_count, :punches do
      public? true
      description "打卡数"
    end
  end

  @doc false
  # 批次粒度锁:FOR UPDATE 锁批次行本身;仅在 before_action 钩子内调用才有效
  # (照 BankImport.lock_import 先例),双执行/执行与删除并发靠它串行
  def lock_import(import_id) do
    __MODULE__
    |> Ash.Query.filter(id == ^import_id)
    |> Ash.Query.lock("FOR UPDATE")
    |> Ash.read_one(authorize?: false)
  end

  @doc false
  # 读存储对象并解析 .dat;创建预览与执行导入共用(暂存行不落库,两处各解析一次)
  def read_and_parse(file_id) do
    with {:ok, file} <- fetch_file(file_id),
         {:ok, binary} <- read_file(file) do
      SynieCore.Hr.AttendanceImport.Parser.parse(binary)
    end
  end

  @doc false
  # 考勤机编号 → 员工 id 映射(编号非空全局唯一由 Employee identity 保证)
  def employee_map(nos) do
    nos = Enum.uniq(nos)

    SynieCore.Hr.Employee
    |> Ash.Query.filter(attendance_no in ^nos)
    |> Ash.read!(authorize?: false)
    |> Map.new(&{&1.attendance_no, &1.id})
  end

  defp fetch_file(file_id) do
    case Ash.get(SynieCore.Files.File, file_id, authorize?: false, error?: false) do
      {:ok, nil} -> {:error, "导入文件不存在"}
      {:ok, file} -> {:ok, file}
      {:error, _} -> {:error, "导入文件不存在"}
    end
  end

  defp read_file(file) do
    case SynieCore.Storage.read(file.storage, file.key) do
      {:ok, binary} -> {:ok, binary}
      {:error, _reason} -> {:error, "读取存储对象失败,请重新上传文件"}
    end
  end
end
