defmodule SynieWeb.Schema do
  use Absinthe.Schema
  use AshGraphql, domains: [SynieCore]

  query do
  end

  mutation do
    # Custom absinthe mutations can be placed here
  end
end
