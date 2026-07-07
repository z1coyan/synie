defmodule SynieWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :synie_web

  socket("/live", Phoenix.LiveView.Socket)

  plug(Plug.Static,
    at: "/",
    from: :synie_web,
    gzip: false,
    only: ~w(assets fonts images favicon.ico robots.txt)
  )

  plug(Plug.RequestId)
  plug(Plug.Telemetry, event_prefix: [:phoenix, :endpoint])

  plug(Plug.Session,
    store: :cookie,
    key: "_synie_web_key",
    signing_salt: "synie_salt"
  )

  plug(:router)
  def router(conn, _opts), do: SynieWeb.Router.call(conn, [])
end
