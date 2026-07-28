package marketsched

import (
	"testing"
	"time"
)

// 2026-07-17 是周五,2026-07-18 周六,2026-07-19 周日(上海时区)。
func utc(hour, minute int) time.Time {
	return time.Date(2026, 7, 17, hour, minute, 30, 0, time.UTC)
}

func shanghai(hour, minute int) time.Time {
	return utc(hour-8, minute)
}

func onConfig() Config {
	return Config{ScheduleEnabled: true, LastIntervalMinutes: 60, SettlementEnabled: true}
}

func TestDecideScheduleDisabled(t *testing.T) {
	cfg := onConfig()
	cfg.ScheduleEnabled = false
	// 09:00 上海本是整点槽且在日盘时段,关总开关则一律不跑
	decision := Decide(cfg, shanghai(9, 0), State{})
	if decision.RunLasts || decision.RunSettlements {
		t.Fatalf("disabled decide = %#v", decision)
	}
	// 结算槽也不跑
	decision = Decide(cfg, shanghai(15, 30), State{})
	if decision.RunLasts || decision.RunSettlements {
		t.Fatalf("disabled settlement decide = %#v", decision)
	}
}

func TestDecideLastsSlots(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		now  time.Time
		prev State
		want bool
	}{
		{"首次运行整点到槽", onConfig(), shanghai(9, 0), State{}, true},
		{"槽内第1分钟容忍漂移", onConfig(), shanghai(9, 1), State{}, true},
		{"槽内第2分钟不触发", onConfig(), shanghai(9, 2), State{}, false},
		{"非槽位不触发", onConfig(), shanghai(9, 30), State{}, false},
		{"同槽去重", onConfig(), shanghai(9, 0), State{Lasts: SlotKey{Date: "2026-07-17", Slot: 540}}, false},
		{"下一槽再触发", onConfig(), shanghai(10, 0), State{Lasts: SlotKey{Date: "2026-07-17", Slot: 540}}, true},
		{"日盘起点前不触发", onConfig(), shanghai(8, 0), State{}, false},
		{"日盘末段 15:00 触发", onConfig(), shanghai(15, 0), State{}, true},
		{"日盘结束后不触发", onConfig(), shanghai(16, 0), State{}, false},
		{"夜盘 21:00 触发", onConfig(), shanghai(21, 0), State{}, true},
		{"夜盘跨零点触发", onConfig(), shanghai(0, 0), State{}, true},
		{"夜盘末尾 02:30 非槽位不触发", onConfig(), shanghai(2, 30), State{}, false},
		{"间隔30分半点槽触发", Config{ScheduleEnabled: true, LastIntervalMinutes: 30, SettlementEnabled: true}, shanghai(9, 30), State{}, true},
		{"间隔120分两小时槽触发", Config{ScheduleEnabled: true, LastIntervalMinutes: 120, SettlementEnabled: true}, shanghai(10, 0), State{}, true},
		{"间隔120分奇数点不触发", Config{ScheduleEnabled: true, LastIntervalMinutes: 120, SettlementEnabled: true}, shanghai(9, 0), State{}, false},
		{"非法间隔按60分", Config{ScheduleEnabled: true, LastIntervalMinutes: 45, SettlementEnabled: true}, shanghai(10, 0), State{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			decision := Decide(tc.cfg, tc.now, tc.prev)
			if decision.RunLasts != tc.want {
				t.Fatalf("RunLasts = %v, want %v (decide=%#v)", decision.RunLasts, tc.want, decision)
			}
		})
	}
}

func TestDecideLastsStateAdvance(t *testing.T) {
	decision := Decide(onConfig(), shanghai(9, 0), State{})
	if !decision.RunLasts {
		t.Fatal("expected lasts run")
	}
	want := SlotKey{Date: "2026-07-17", Slot: 540}
	if decision.Next.Lasts != want {
		t.Fatalf("next lasts key = %#v, want %#v", decision.Next.Lasts, want)
	}
}

func TestDecideSettlementSlots(t *testing.T) {
	slots := []struct {
		hour, minute, wantSlot int
	}{
		{15, 30, 930}, {16, 0, 960}, {16, 30, 990}, {17, 0, 1020},
	}
	for _, slot := range slots {
		decision := Decide(onConfig(), shanghai(slot.hour, slot.minute), State{})
		if !decision.RunSettlements {
			t.Fatalf("%02d:%02d should trigger settlement", slot.hour, slot.minute)
		}
		want := SlotKey{Date: "2026-07-17", Slot: slot.wantSlot}
		if decision.Next.Settlement != want {
			t.Fatalf("next settlement key = %#v, want %#v", decision.Next.Settlement, want)
		}
	}
}

func TestDecideSettlementBoundaries(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		now  time.Time
		prev State
		want bool
	}{
		{"槽后1分钟容忍漂移", onConfig(), shanghai(15, 31), State{}, true},
		{"槽后2分钟不触发", onConfig(), shanghai(15, 32), State{}, false},
		{"槽前不触发", onConfig(), shanghai(15, 29), State{}, false},
		{"同槽去重", onConfig(), shanghai(15, 30), State{Settlement: SlotKey{Date: "2026-07-17", Slot: 930}}, false},
		{"下一尝试槽重试", onConfig(), shanghai(16, 0), State{Settlement: SlotKey{Date: "2026-07-17", Slot: 930}}, true},
		{"结算开关关不触发", Config{ScheduleEnabled: true, LastIntervalMinutes: 60, SettlementEnabled: false}, shanghai(15, 30), State{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			decision := Decide(tc.cfg, tc.now, tc.prev)
			if decision.RunSettlements != tc.want {
				t.Fatalf("RunSettlements = %v, want %v (decide=%#v)", decision.RunSettlements, tc.want, decision)
			}
		})
	}
}

func TestDecideSettlementWeekendSkipped(t *testing.T) {
	// 2026-07-18 周六 15:30 上海 = 07:30 UTC
	saturday := time.Date(2026, 7, 18, 7, 30, 0, 0, time.UTC)
	if decision := Decide(onConfig(), saturday, State{}); decision.RunSettlements {
		t.Fatal("周六不应触发结算补拉")
	}
	sunday := time.Date(2026, 7, 19, 7, 30, 0, 0, time.UTC)
	if decision := Decide(onConfig(), sunday, State{}); decision.RunSettlements {
		t.Fatal("周日不应触发结算补拉")
	}
}

func TestDecideFirstRunOutsideSlots(t *testing.T) {
	// 首次运行(零状态)但不在任何槽位:不补跑,等下一槽
	decision := Decide(onConfig(), shanghai(9, 45), State{})
	if decision.RunLasts || decision.RunSettlements {
		t.Fatalf("decide = %#v", decision)
	}
}
