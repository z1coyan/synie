defmodule SynieCore.Repo.Migrations.SalDeliveryItemDrawingSnapshot do
  @moduledoc """
  发货条目补齐图纸挂接快照:存量行按当前物料 drawing 槽位整份复制到行
  (owner_type sal_delivery_item、category drawing)。新行由 DeliveryItem.SyncDrawings
  在保存时写入;本迁移只回填历史行,口径为迁移时点。
  """
  use Ecto.Migration

  def up do
    execute("""
    INSERT INTO sys_attachment (owner_type, owner_id, category, file_id, company_id)
    SELECT 'sal_delivery_item', i.id, 'drawing', a.file_id, i.company_id
    FROM sal_delivery_item i
    INNER JOIN sys_attachment a
      ON a.owner_type = 'inv_material' AND a.owner_id = i.material_id AND a.category = 'drawing'
    WHERE NOT EXISTS (
      SELECT 1 FROM sys_attachment x
      WHERE x.owner_type = 'sal_delivery_item'
        AND x.owner_id = i.id
        AND x.category = 'drawing'
        AND x.file_id = a.file_id
    )
    """)
  end

  def down do
    execute("DELETE FROM sys_attachment WHERE owner_type = 'sal_delivery_item' AND category = 'drawing'")
  end
end
