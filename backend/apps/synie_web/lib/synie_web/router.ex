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

  scope "/graphql" do
    pipe_through [:graphql]

    forward(
      "/playground",
      Absinthe.Plug.GraphiQL,
      schema: Module.concat(["SynieWeb.Schema"]),
      interface: :playground
    )

    forward(
      "/",
      Absinthe.Plug,
      schema: Module.concat(["SynieWeb.Schema"])
    )
  end
end
