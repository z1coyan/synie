defmodule SynieCore.Resources.Hello do
  use Ash.Resource, domain: SynieCore

  actions do
    defaults [:read]
  end

  attributes do
    uuid_primary_key :id
  end
end
