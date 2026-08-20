/**
 * 销售退货抽屉：共享实现的薄包装。open 桥必须在本模块实例化，与列表 layout 同树。
 */
import { createReturnDrawer } from '../../scm/-return-drawer'

export type { OpenReturnDrawer, ReturnRef } from '../../scm/-return-drawer'

export const { ReturnDrawerProvider, useReturnDrawer, returnAuditConfig } =
  createReturnDrawer('sales')
