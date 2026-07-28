/**
 * 初始化示例数据编排（原 platform/setup/sampledata）。
 * platform/setup 只保留向导状态机；本包由组合根注入 seedSampleData 回调。
 */
export { seedSampleData } from './sampledata/index.ts'
export type { SampleDataDeps, SampleSummary } from './sampledata/types.ts'
export {
  MARKER_BANK_ACCOUNT_NO,
  MARKER_CUSTOMER_CODE,
} from './sampledata/helpers.ts'
