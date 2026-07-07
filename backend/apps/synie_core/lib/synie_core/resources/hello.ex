defmodule SynieCore.Resources.Hello do
  use Ash.Resource,
    domain: SynieCore,
    extensions: [AshGraphql.Resource]

  graphql do
    type :hello

    queries do
      action :say_hello, :say_hello
    end
  end

  actions do
    defaults [:read]

    action :say_hello, :string do
      argument :name, :string, allow_nil?: false

      run fn input, _ ->
        {:ok, "Hello, #{input.arguments.name}"}
      end
    end
  end

  attributes do
    uuid_primary_key :id
  end
end