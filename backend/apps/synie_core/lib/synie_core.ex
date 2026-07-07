defmodule SynieCore do
  use Ash.Domain

  resources do
    resource SynieCore.Resources.Hello
  end
end
