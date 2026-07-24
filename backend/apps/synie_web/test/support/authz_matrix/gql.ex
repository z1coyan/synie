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
end
