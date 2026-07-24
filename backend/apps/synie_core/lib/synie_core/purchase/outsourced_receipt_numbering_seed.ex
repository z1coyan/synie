defmodule SynieCore.Purchase.OutsourcedReceiptNumberingSeed do
  @moduledoc """
  委外入库单编号规则种子(随建表迁移落地;老环境已完成初始化、向导不会再跑,
  新接 AutoNumber 的资源其启用规则须随迁移种子——先例 `SynieCore.Purchase.OutsourcedIssueNumberingSeed`)。

  种子 `purchase.outsourced_receipt` 启用编号规则:`P(O)-入库日期(YYYYMMDD)-4 位补零序号`,
  按公司计数(同采购入库等单据口径);该资源已有任一规则(含停用)则跳过,不覆盖用户配置。
  无存量数据,无需补号/垫计数器。幂等,可重复执行。
  """

  alias SynieCore.Repo

  @resource "purchase.outsourced_receipt"
  @rule_name "委外入库单编号"

  # 段定义与 Setup.seed_numbering_rules! 的单据口径一致(模块常量内联为 SQL 字面量,
  # 走 $ 参数会被当成 JSON 字符串二次编码,见 BomNumberingBackfill 注释)
  @segments [
    ~s|{"type":"text","value":"P(O)-"}|,
    ~s|{"type":"field","field":"receipt_date","format":"YYYYMMDD","label":"入库日期"}|,
    ~s|{"type":"text","value":"-"}|,
    ~s|{"type":"seq","padding":4}|
  ]

  @doc "种子启用编号规则,幂等。"
  def run! do
    segments = @segments |> Enum.map(&"'#{&1}'::jsonb") |> Enum.join(", ")

    Repo.query!(
      """
      INSERT INTO sys_numbering_rule (id, resource, name, segments, per_company, enabled, inserted_at, updated_at)
      SELECT gen_random_uuid(), $1, $2, ARRAY[#{segments}], true, true, now(), now()
      WHERE NOT EXISTS (SELECT 1 FROM sys_numbering_rule WHERE resource = $1)
      """,
      [@resource, @rule_name]
    )

    :ok
  end
end
