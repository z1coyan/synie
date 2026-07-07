defmodule SynieCore.Accounts.Changes.HashPassword do
  @moduledoc "把 `password` 参数哈希后写入 `hashed_password`。"

  use Ash.Resource.Change

  @impl true
  def change(changeset, _opts, _context) do
    Ash.Changeset.before_action(changeset, fn changeset ->
      password = Ash.Changeset.get_argument(changeset, :password)

      Ash.Changeset.force_change_attribute(
        changeset,
        :hashed_password,
        Pbkdf2.hash_pwd_salt(password)
      )
    end)
  end
end
