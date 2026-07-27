// Package marketsched 进程内行情定时调度:每分钟一个节拍,读 sys_setting 配置判定是否拉取。
//
// 语义对齐 Elixir 版 SynieCore.Base.MarketFetch.Scheduler / Sessions:
//   - 定时总开关关 → 不跑
//   - 最新价:交易时段内按配置间隔(30/60/120 分,非法值按 60)对齐槽位触发
//   - 结算:配置允许时,工作日 15:30/16:00/16:30/17:00(上海)尝试补拉
//
// 上海时区固定 UTC+8(国内无夏令时),不引入 tz 数据库依赖(与 bank_import 等先例一致)。
package marketsched

import "time"

const shanghaiOffset = 8 * time.Hour

// Config 行情定时调度配置(来自 sys_setting 单行表)。
type Config struct {
	ScheduleEnabled     bool // 定时总开关
	LastIntervalMinutes int  // 最新价拉取间隔,仅 30/60/120,其余按 60 计
	SettlementEnabled   bool // 结算自动补拉开关
}

// SlotKey 标记某上海日历日的某个时间槽已触发,防止同槽重复运行。
type SlotKey struct {
	Date string // 上海日历日,格式 2006-01-02
	Slot int    // 当日分钟数(最新价为槽起点,结算为尝试时刻)
}

// State 调度记忆:上次触发的最新价槽与结算槽。零值表示尚未触发过(首次运行)。
type State struct {
	Lasts      SlotKey
	Settlement SlotKey
}

// Decision 一次节拍的调度决策;Next 为应落回调度器的状态。
type Decision struct {
	RunLasts       bool
	RunSettlements bool
	Next           State
}

// Decide 纯函数:给定配置、当前 UTC 时刻与上次触发状态,判定本节拍是否应触发拉取。
// 槽内第 0–1 分钟均视为到达(容忍分钟级 tick 漂移),靠 SlotKey 去重保证同槽只跑一次。
func Decide(cfg Config, now time.Time, prev State) Decision {
	decision := Decision{Next: prev}
	if !cfg.ScheduleEnabled {
		return decision
	}
	sh := now.UTC().Add(shanghaiOffset)
	mins := sh.Hour()*60 + sh.Minute()
	date := sh.Format("2006-01-02")

	interval := normalizeInterval(cfg.LastIntervalMinutes)
	slotStart := mins / interval * interval
	if mins-slotStart <= 1 && inLastSession(mins) {
		key := SlotKey{Date: date, Slot: slotStart}
		if prev.Lasts != key {
			decision.RunLasts = true
			decision.Next.Lasts = key
		}
	}

	if cfg.SettlementEnabled && isWeekday(sh) {
		if slot, ok := settlementSlot(mins); ok {
			key := SlotKey{Date: date, Slot: slot}
			if prev.Settlement != key {
				decision.RunSettlements = true
				decision.Next.Settlement = key
			}
		}
	}
	return decision
}

func normalizeInterval(n int) int {
	switch n {
	case 30, 60, 120:
		return n
	default:
		return 60
	}
}

// inLastSession 是否处于可拉最新价的交易时段(上海墙钟分钟数):
// 日盘 09:00–15:05,夜盘 21:00–次日 02:35(覆盖有色夜盘至 01:00 与金银至 02:30)。
func inLastSession(mins int) bool {
	day := mins >= 9*60 && mins < 15*60+5
	night := mins >= 21*60 || mins < 2*60+35
	return day || night
}

func isWeekday(sh time.Time) bool {
	weekday := sh.Weekday()
	return weekday != time.Saturday && weekday != time.Sunday
}

// settlementSlot 结算尝试槽:15:30/16:00/16:30/17:00,槽后 1 分钟内也视为到达(容忍 tick 漂移)。
func settlementSlot(mins int) (int, bool) {
	for _, slot := range []int{15*60 + 30, 16 * 60, 16*60 + 30, 17 * 60} {
		if mins >= slot && mins <= slot+1 {
			return slot, true
		}
	}
	return 0, false
}
