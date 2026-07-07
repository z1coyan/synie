defmodule SynieWeb.Schema do
  use Absinthe.Schema
  use AshGraphql, domains: [SynieCore]

  query do
    # Placeholder field — remove once a real query exists (Task 4 adds the
    # auto-generated hello query from the SynieCore domain).
    @desc "Remove me once you have a query of your own!"
    field :remove_me, :string do
      resolve(fn _, _, _ ->
        {:ok, "Remove me!"}
      end)
    end
  end

  mutation do
    # Custom absinthe mutations can be placed here
  end
end
