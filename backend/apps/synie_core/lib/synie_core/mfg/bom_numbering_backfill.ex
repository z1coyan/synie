defmodule SynieCore.Mfg.BomNumberingBackfill do
  @moduledoc """
  既有 BOM 补编号(随放开一物料多张的迁移落地;独立成模块,测试直调同一份逻辑)。

  迁移前 BOM 无编号列、一物料至多一张;迁移加列后由本模块兜底,无需人工返工:

  1. 种子 `mfg.bom` 启用编号规则(固定文本 `M(B)-` + 4 位补零序号,全局不按公司),
     该资源已有规则则跳过(不覆盖用户配置);
  2. 为 `code` 为空的存量行按创建顺序补 `M(B)-NNNN`;
  3. 编号计数器垫到已用最大序号,避免后续自动取号与存量撞号。

  幂等:规则已存在、无空 `code` 行、计数器已更高时均为无操作,可重复执行。
  """

  alias SynieCore.Repo

  @resource "mfg.bom"
  @rule_name "BOM 编号"
  @prefix "M(B)-"
  @padding 4

  # 从编号中解析 M(B)- 序号的 PG 正则(括号/数字用字符类写法,免反斜杠转义)
  @seq_regex "M[(]B[)]-([0-9]+)"

  @doc "执行补编号全流程(规则种子 → 存量补号 → 垫计数器),幂等。"
  def run! do
    seed_rule!()
    backfill_codes!()
    seed_counter!()
    :ok
  end

  # 规则种子:同 Setup.ensure_numbering_rule! 口径——该资源已有任一规则(含停用)即跳过。
  # segments 内联为 SQL 字面量(均为模块常量):走 $ 参数会被当成 JSON 字符串二次编码
  defp seed_rule! do
    Repo.query!(
      """
      INSERT INTO sys_numbering_rule (id, resource, name, segments, per_company, enabled, inserted_at, updated_at)
      SELECT gen_random_uuid(), $1, $2,
             ARRAY['{"type":"text","value":"#{@prefix}"}'::jsonb, '{"type":"seq","padding":#{@padding}}'::jsonb],
             false, true, now(), now()
      WHERE NOT EXISTS (SELECT 1 FROM sys_numbering_rule WHERE resource = $1)
      """,
      [@resource, @rule_name]
    )
  end

  # 存量空编号行按创建顺序补号;序号接在已用最大序号之后(重跑安全)
  defp backfill_codes! do
    %{rows: rows} =
      Repo.query!("SELECT id FROM mfg_bom WHERE code IS NULL ORDER BY inserted_at, id")

    rows
    |> Enum.with_index(max_used_seq() + 1)
    |> Enum.each(fn {[id], seq} ->
      Repo.query!("UPDATE mfg_bom SET code = $1 WHERE id = $2", [format_seq(seq), id])
    end)
  end

  # 计数器垫到已用最大序号(GREATEST 不回头);无已用序号时不落行,下次取号自然从 1 起
  defp seed_counter! do
    Repo.query!(
      """
      INSERT INTO sys_numbering_counter (id, rule_id, scope_key, value, inserted_at, updated_at)
      SELECT gen_random_uuid(), r.id, $2, s.max_seq, now(), now()
      FROM sys_numbering_rule r,
           (SELECT COALESCE(MAX(CAST(substring(code FROM '#{@seq_regex}') AS integer)), 0) AS max_seq
            FROM mfg_bom WHERE code IS NOT NULL) s
      WHERE r.resource = $1 AND s.max_seq > 0
      ON CONFLICT (rule_id, scope_key)
      DO UPDATE SET value = GREATEST(sys_numbering_counter.value, EXCLUDED.value), updated_at = now()
      """,
      [@resource, @prefix]
    )
  end

  # 已用最大序号:只认 M(B)-NNNN 形态,手填编号(如 "BOM-A")不参与计数
  defp max_used_seq do
    %{rows: [[max_seq]]} =
      Repo.query!(
        "SELECT COALESCE(MAX(CAST(substring(code FROM '#{@seq_regex}') AS integer)), 0) FROM mfg_bom WHERE code IS NOT NULL"
      )

    max_seq
  end

  defp format_seq(seq) do
    @prefix <> (seq |> Integer.to_string() |> String.pad_leading(@padding, "0"))
  end
end
