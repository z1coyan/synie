defmodule SynieCore do
  use Ash.Domain,
    extensions: [AshGraphql.Domain]

  graphql do
  end

  resources do
    resource SynieCore.Resources.Hello
  end
end