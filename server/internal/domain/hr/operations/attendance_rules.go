package operations

import (
	"time"

	"github.com/shopspring/decimal"
)

// 考勤日算规则常量（纯计时，不立配置表）。规则见
// docs/adr/2026-07-15-attendance-daily-calc.md，与 Elixir
// SynieCore.Hr.Attendance.Rules 对齐：
//
//   - 12:00 切分上下午桶；桶内最早卡=上班、最晚卡=下班
//   - 段工时 30 分钟向下取整，上下午各自取整
//   - 上午封顶 4h（= halfDayUnits 个半小时单位），下午超 4h 部分=加班
//   - 单日加班（取整后）≥3.5h（= bonusThresholdUnits）额外奖励 0.5 工日
//   - 月工日 = Σ正常工时 ÷ fullDayHours + Σ奖励工日
//
// 输入输出均为本地时刻；UTC↔本地固定偏移 attendanceImportUTCOffset
//（默认 +8h，与 .dat 导入约定一致，不引 tzdata）。
const (
	// morningAfternoonSplitHour 上下午桶切分点（本地钟点）。
	morningAfternoonSplitHour = 12
	// segmentRound 段工时最小单位。
	segmentRound = 30 * time.Minute
	// halfDayUnits 半天封顶的半小时单位数（4h = 8 单位）。
	halfDayUnits = 8
	// bonusThresholdUnits 奖励工日阈值的半小时单位数（3.5h = 7 单位）。
	bonusThresholdUnits = 7
	// fullDayHours 标准工日小时数；月工日 = Σ正常工时 ÷ fullDayHours + Σ奖励工日。
	fullDayHours = 8
	// fullDayHoursSQL 是嵌入 SQL 的字面量，必须与 fullDayHours 同步。
	fullDayHoursSQL = "8"
	// attendanceImportUTCOffset 导入/日切使用的固定 UTC 偏移。
	attendanceImportUTCOffset = 8 * time.Hour
	// attendanceOffsetInterval 是 SQL interval 字面量，必须与
	// attendanceImportUTCOffset 保持同步。
	attendanceOffsetInterval = "8 hours"
)

var (
	// bonusWorkday 单日加班达阈值后的奖励工日（日封顶）。
	bonusWorkday = decimal.RequireFromString("0.5")
	// unitsPerHour 半小时单位 → 小时的换算（2 单位 = 1 小时）。
	unitsPerHour = decimal.NewFromInt(2)
)
