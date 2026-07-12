defmodule SynieWeb.Router do
  use Phoenix.Router

  pipeline :graphql do
    plug(Plug.Parsers,
      parsers: [:urlencoded, :multipart, :json],
      pass: ["*/*"],
      json_decoder: Jason
    )

    plug(SynieWeb.Plugs.GraphqlContext)
    plug(AshGraphql.Plug)
  end

  pipeline :api do
    plug(Plug.Parsers,
      parsers: [:urlencoded, :multipart, :json],
      pass: ["*/*"],
      json_decoder: Jason,
      # 上传大小上限
      length: 50_000_000
    )

    # 复用 Bearer → actor 解析;Absinthe context 部分对 REST 无害
    plug(SynieWeb.Plugs.GraphqlContext)
  end

  scope "/api", SynieWeb do
    pipe_through [:api]

    post("/files", FileController, :create)
    get("/files/:id", FileController, :show)
  end

  scope "/graphql" do
    pipe_through [:graphql]

    # playground 仅在开关打开时挂载(生产默认关闭,避免暴露交互式查询控制台)
    if Application.compile_env(:synie_web, :graphiql_enabled, false) do
      forward(
        "/playground",
        Absinthe.Plug.GraphiQL,
        schema: Module.concat(["SynieWeb.Schema"]),
        interface: :playground
      )
    end

    forward(
      "/",
      Absinthe.Plug,
      schema: Module.concat(["SynieWeb.Schema"])
    )
  end
end
