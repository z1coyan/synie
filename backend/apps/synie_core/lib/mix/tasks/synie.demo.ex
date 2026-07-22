defmodule Mix.Tasks.Synie.Demo do
  @shortdoc "Dev/test: 一键初始化演示环境(管理员+京泰公司+示例业务数据)"

  @moduledoc """
  开发/测试环境一键搭好可登录的演示库:管理员、公司、科目、仓库、完成初始化并写入示例数据。

      cd backend
      mix synie.demo

  写入内容(与向导「从示例数据开始」一致):

  - 用户:`admin` / `admin123`(超级管理员,姓名「管理员」,首选语言简体中文)
  - 公司:`JT` / 台州京泰电气有限公司 / 台州京泰 / 本币人民币;小企业会计准则科目表 + 默认仓库
  - 示例:3 客户、3 供应商、6 物料、销采报价各 2 张(含已审核与草稿)

  **仅允许** `MIX_ENV=dev` 或 `test`。已初始化的库直接拒绝(不会覆盖)。
  空库需先 `mix ecto.migrate`(或 `mix synie.db.reset`)。
  """

  use Mix.Task

  @impl Mix.Task
  def run(_args) do
    unless Mix.env() in [:dev, :test] do
      Mix.raise("synie.demo 仅允许在 MIX_ENV=dev|test 下运行,当前: #{Mix.env()}")
    end

    Mix.Task.run("app.config")
    {:ok, _} = Application.ensure_all_started(:synie_core)

    require Ash.Query

    alias SynieCore.Authz
    alias SynieCore.Base.Account
    alias SynieCore.Base.Company
    alias SynieCore.Base.Currency
    alias SynieCore.Inv.Warehouse
    alias SynieCore.Setup

    if Setup.initialized?() do
      Mix.raise("系统已完成初始化,拒绝再跑 synie.demo(请先 mix synie.db.reset)")
    end

    Mix.shell().info([:yellow, "* 初始化演示环境…", :reset])

    {:ok, user} =
      Setup.create_first_user(%{
        username: "admin",
        name: "管理员",
        password: "admin123"
      })

    Mix.shell().info("  管理员 admin 已创建")

    {:ok, _} = Setup.seed_common_currencies()

    cny =
      Currency
      |> Ash.Query.filter(iso_code == "CNY")
      |> Ash.read_one!(authorize?: false)

    :ok = Setup.activate_only_base_currency(cny.id)

    company =
      Company
      |> Ash.Changeset.for_create(:create, %{
        code: "JT",
        name: "台州京泰电气有限公司",
        short_name: "台州京泰",
        base_currency_id: cny.id
      })
      |> Ash.create!(authorize?: false)

    Mix.shell().info("  公司 JT 台州京泰电气有限公司 已创建")

    actor = Authz.build_actor(user)

    account_count =
      Account
      |> Ash.ActionInput.for_action(:init_from_template, %{
        company_id: company.id,
        template: :small
      })
      |> Ash.run_action!(authorize?: false, actor: actor)

    Mix.shell().info("  科目表(小企业) #{account_count} 个")

    warehouse_count =
      Warehouse
      |> Ash.ActionInput.for_action(:seed_defaults, %{company_id: company.id})
      |> Ash.run_action!(authorize?: false, actor: actor)

    Mix.shell().info("  默认仓库 #{warehouse_count} 个")

    :ok = Setup.complete(actor, "zh-CN", seed_sample_data: true)

    Mix.shell().info([
      :green,
      "* 完成。",
      :reset,
      " 登录 admin / admin123,公司 JT,已含示例客户/供应商/物料/报价。"
    ])
  end
end
