// bun app/components/run-checks.ts —— 汇总运行各组件的纯函数自检
// 每个 *-checks.ts 在 import 时自执行断言,失败即 process.exit(1);全通过打印各自 ok。
// 纯逻辑,不依赖 @heroui-pro,可在无 Pro token 的环境(CI check 步骤)运行。
import './synie-data-grid/grid-checks.ts'
import './synie-record-drawer/record-drawer-checks.ts'
import './synie-remote-select/remote-select-checks.ts'
import './synie-editable-table/editable-table-checks.ts'
import './synie-permission-sheet/permission-sheet-checks.ts'

console.log('run-checks ok')
