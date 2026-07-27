package marketsched

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/domain/base/market"
	"github.com/z1coyan/synie/server/internal/platform/settings"
)

const (
	// initialDelay 进程启动后首次节拍延迟(对齐 Elixir 版的 5 秒)。
	initialDelay = 5 * time.Second
	// tickInterval 调度节拍:每分钟一次;设置变更(开关/间隔)在下一节拍内生效。
	tickInterval = time.Minute
)

// Scheduler 进程内行情定时调度器。
//
// 并发模型:调度循环为单 goroutine 且同步执行每次拉取,上一轮未跑完不会并发启动下一轮
// (tick 自然顺延);running 仅为防御性兜底。部署按 compose 单副本假设,无多实例防护。
type Scheduler struct {
	settings *settings.Service
	market   *market.Service
	logger   *slog.Logger

	now              func() time.Time
	lastClient       market.LastPriceClient
	settlementClient market.SettlementPriceClient
	// runLasts/runSettlements 为测试注入口;空则走 market 服务的生产拉取路径
	runLasts       func(ctx context.Context, now time.Time) (market.RefreshResult, error)
	runSettlements func(ctx context.Context, now time.Time) (market.RefreshResult, error)

	state   State
	running atomic.Bool
}

// New 装配行情定时调度器(随服务进程启动,context 取消即优雅退出)。
func New(pool *pgxpool.Pool, logger *slog.Logger) *Scheduler {
	return &Scheduler{
		settings: settings.NewService(pool),
		market:   market.NewService(pool),
		logger:   logger,
		now:      time.Now,
	}
}

// Run 阻塞运行调度循环,直到 ctx 取消。panic 不会拖垮进程(单次运行内 recover)。
func (s *Scheduler) Run(ctx context.Context) {
	timer := time.NewTimer(initialDelay)
	defer timer.Stop()
	var ticks <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.tick(ctx)
			ticker := time.NewTicker(tickInterval)
			defer ticker.Stop()
			ticks = ticker.C
		case <-ticks:
			s.tick(ctx)
		}
	}
}

func (s *Scheduler) tick(ctx context.Context) {
	if !s.running.CompareAndSwap(false, true) {
		return
	}
	defer s.running.Store(false)

	setting, err := s.settings.GetSystem(ctx)
	if err != nil {
		s.log().Error("行情调度读取系统设置失败", "error", err)
		return
	}
	now := s.now().UTC().Truncate(time.Second)
	decision := Decide(Config{
		ScheduleEnabled:     setting.MarketFetchScheduleEnabled,
		LastIntervalMinutes: setting.MarketFetchLastIntervalMinutes,
		SettlementEnabled:   setting.MarketFetchSettlementEnabled,
	}, now, s.state)
	s.state = decision.Next

	if decision.RunLasts {
		s.log().Info("行情定时调度: 触发最新价拉取", "at", now)
		s.runSafely(ctx, "定时最新价", func(runCtx context.Context) (market.RefreshResult, error) {
			if s.runLasts != nil {
				return s.runLasts(runCtx, now)
			}
			return s.market.RefreshLastsWithClient(runCtx, nil, nil, now, s.lastPriceClient())
		})
	}
	if decision.RunSettlements {
		s.log().Info("行情定时调度: 触发结算价补拉", "at", now)
		s.runSafely(ctx, "定时结算价", func(runCtx context.Context) (market.RefreshResult, error) {
			if s.runSettlements != nil {
				return s.runSettlements(runCtx, now)
			}
			return s.market.RefreshSettlementsWithClient(runCtx, nil, nil, now, s.settlementPriceClient())
		})
	}
}

// runSafely 执行一轮拉取:recover panic、记录日志,失败时把失败摘要写回 sys_setting。
func (s *Scheduler) runSafely(ctx context.Context, label string, run func(context.Context) (market.RefreshResult, error)) {
	defer func() {
		if recovered := recover(); recovered != nil {
			s.log().Error("行情定时调度运行 panic", "label", label, "panic", recovered)
			s.recordFailure(ctx, label, fmt.Sprintf("运行异常: %v", recovered))
		}
	}()
	result, err := run(ctx)
	if err != nil {
		s.log().Error("行情定时调度运行失败", "label", label, "error", err)
		s.recordFailure(ctx, label, "运行异常: "+err.Error())
		return
	}
	for _, item := range result.Items {
		attrs := []any{"code", item.Code, "kind", item.Kind, "status", item.Status}
		if item.Message != nil {
			attrs = append(attrs, "message", *item.Message)
		}
		s.log().Info("行情定时拉取条目", attrs...)
	}
}

func (s *Scheduler) recordFailure(ctx context.Context, label, message string) {
	// 进程退出中 ctx 可能已取消,脱钩并限时,尽力把失败摘要写回设置表
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := s.settings.RecordMarketFetch(writeCtx, nil, label+": "+message); err != nil {
		s.log().Error("行情定时调度失败摘要写回失败", "label", label, "error", err)
	}
}

func (s *Scheduler) lastPriceClient() market.LastPriceClient {
	if s.lastClient != nil {
		return s.lastClient
	}
	return &market.PublicMarketClient{HTTPClient: &http.Client{Timeout: 15 * time.Second}}
}

func (s *Scheduler) settlementPriceClient() market.SettlementPriceClient {
	if s.settlementClient != nil {
		return s.settlementClient
	}
	return &market.PublicMarketClient{HTTPClient: &http.Client{Timeout: 15 * time.Second}}
}

func (s *Scheduler) log() *slog.Logger {
	if s.logger != nil {
		return s.logger
	}
	return slog.Default()
}
