import { createFileRoute } from '@tanstack/react-router'
import { MaterialsPage } from '~/components/materials-page/MaterialsPage'

export const Route = createFileRoute('/_app/scm/materials')({
  // extraFields 非默认首屏,跳过 loader
  component: MaterialsRoute,
})

function MaterialsRoute() {
  return (
    <MaterialsPage
      title="物料管理"
      description="全局共享的物料主数据:分库存/虚拟/资产三类,可标记客户物料;编号按「分类号[客户号]-序号」自动取号,不可手填;图纸、其他文件与单位转换建料时即可一并录入。"
    />
  )
}
