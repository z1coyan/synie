defmodule SynieWeb.AuthzMatrix.Gql do
  @moduledoc """
  矩阵的 GraphQL HTTP 载具:经真实 endpoint 管线(`POST /graphql` + Bearer token)
  发请求,token 验证、GraphqlContext plug、401 路径全部在射程内。
  不用 `Absinthe.run` 进程内直调——那会绕过整条 HTTP 缝。
  """

  import Phoenix.ConnTest

  @endpoint SynieWeb.Endpoint

  @doc "发 GraphQL 请求,返回解码后的 JSON(%{\"data\" => _, \"errors\" => _})。token 为 nil 即匿名。"
  def run(query, token \\ nil) do
    conn = build_conn() |> Plug.Conn.put_req_header("content-type", "application/json")

    conn =
      if token,
        do: Plug.Conn.put_req_header(conn, "authorization", "Bearer " <> token),
        else: conn

    conn
    |> post("/graphql", Jason.encode!(%{query: query}))
    |> json_response(200)
  end

  @doc "list 查询(带 count 聚合;limit 拉满避免分页截断)。"
  def list_query(field), do: "query { #{field}(limit: 200) { count results { id } } }"

  @doc "按 id 查询:list 查询 + id 等值过滤(前端速览/表单取数同款姿势)。"
  def by_id_query(field, id) do
    ~s|query { #{field}(filter: {id: {eq: "#{id}"}}) { count results { id } } }|
  end

  @doc "读侧枚举源 = 表格元数据白名单:资源模块 → GraphQL list 字段名。"
  def grid_field!(module) do
    SynieWeb.GridMeta.resources()
    |> Enum.find(fn {_name, m} -> m == module end)
    |> case do
      {name, _module} -> name
      nil -> raise "资源 #{inspect(module)} 不在 GridMeta 白名单,矩阵无法枚举其查询名"
    end
  end

  @doc """
  资源三件套 mutation 的 GraphQL 字段名(经域 mutations 反射,只认主动作;
  audit/cancel 等衍生 update 不属三件套)。无对应 mutation 时为 nil。
  """
  def primary_mutation_fields(module) do
    mutations = AshGraphql.Domain.Info.mutations(SynieCore)

    Map.new([:create, :update, :destroy], fn type ->
      primary = Ash.Resource.Info.primary_action(module, type)

      field =
        primary &&
          Enum.find_value(mutations, fn m ->
            if m.resource == module and m.type == type and m.action == primary.name,
              do: Absinthe.Utils.camelize(to_string(m.name), lower: true)
          end)

      {type, field}
    end)
  end

  @doc "响应中的可见 id 集;查询根为 null(被拒)时返回 nil。"
  def visible_ids(resp, field) do
    case resp["data"] do
      %{^field => %{"results" => results}} -> MapSet.new(results, & &1["id"])
      _denied -> nil
    end
  end

  @doc "响应中的 count 聚合;查询根为 null 时返回 nil。"
  def count(resp, field) do
    case resp["data"] do
      %{^field => %{"count" => count}} -> count
      _denied -> nil
    end
  end

  @doc "是否被拒:errors 非空且查询根无数据(不区分 forbidden 文案,拒绝形态即达标)。"
  def denied?(resp, field) do
    errors_present = is_list(resp["errors"]) and resp["errors"] != []
    no_data = visible_ids(resp, field) == nil
    errors_present and no_data
  end

  # ── 写侧(工单03)────────────────────────────────────────────────────────

  @doc "create mutation 文本。"
  def create_mutation(field, input) do
    "mutation { #{field}(input: #{encode_input(input)}) { result { id } errors { message } } }"
  end

  @doc "update mutation 文本。"
  def update_mutation(field, id, input) do
    ~s|mutation { #{field}(id: "#{id}", input: #{encode_input(input)}) { result { id } errors { message } } }|
  end

  @doc "destroy mutation 文本。"
  def destroy_mutation(field, id) do
    ~s|mutation { #{field}(id: "#{id}") { result { id } errors { message } } }|
  end

  @doc """
  mutation 是否被拒:result 无值,且顶层或载荷 errors 非空。
  (公司校验落在载荷 errors,功能权限/取数不可见落在顶层 errors,两种拒绝形态都认。)
  """
  def mutation_denied?(resp, field) do
    top_errors = is_list(resp["errors"]) and resp["errors"] != []

    case resp["data"] do
      %{^field => %{"result" => nil} = payload} ->
        top_errors or (is_list(payload["errors"]) and payload["errors"] != [])

      %{^field => nil} ->
        top_errors

      nil ->
        top_errors

      _result_present ->
        false
    end
  end

  @doc "mutation 成功产出的记录 id;未成功返回 nil。"
  def mutation_result_id(resp, field) do
    case resp["data"] do
      %{^field => %{"result" => %{"id" => id}}} -> id
      _other -> nil
    end
  end

  # GraphQL 输入字面量编码(矩阵输入只有字符串/数字/布尔的平面 map)
  defp encode_input(input) when is_map(input) do
    inner =
      Enum.map_join(input, ", ", fn {key, value} -> "#{key}: #{encode_value(value)}" end)

    "{" <> inner <> "}"
  end

  defp encode_value(value) when is_binary(value), do: inspect(value)
  defp encode_value(value) when is_number(value) or is_boolean(value), do: to_string(value)
end
