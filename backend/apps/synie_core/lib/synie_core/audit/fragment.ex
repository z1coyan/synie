defmodule SynieCore.Audit.Fragment do
  @moduledoc """
  资源接入审计的唯一入口:

      use Ash.Resource,
        ...,
        fragments: [SynieCore.Audit.Fragment]

  注意:受审计资源的 update/destroy 动作需 `require_atomic? false`
  (after_action 钩子无法原子执行,Ash 3 默认动作原子化);
  批量操作须用 `strategy: :stream`,`:atomic` 会绕过审计。
  """

  use Spark.Dsl.Fragment, of: Ash.Resource

  changes do
    change SynieCore.Audit.Track, on: [:create, :update, :destroy]
  end
end
