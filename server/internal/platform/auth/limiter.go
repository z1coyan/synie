package auth

import (
	"sync"
	"time"
)

type RateLimiter struct {
	mu       sync.Mutex
	max      int
	window   time.Duration
	attempts map[string][]time.Time
	now      func() time.Time
}

func NewRateLimiter(max int, window time.Duration) *RateLimiter {
	return &RateLimiter{max: max, window: window, attempts: make(map[string][]time.Time), now: time.Now}
}

func (l *RateLimiter) Blocked(bucket string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(bucket)
	return len(l.attempts[bucket]) >= l.max
}

func (l *RateLimiter) RecordFailure(bucket string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(bucket)
	l.attempts[bucket] = append(l.attempts[bucket], l.now())
}

func (l *RateLimiter) Reset(bucket string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, bucket)
}

func (l *RateLimiter) prune(bucket string) {
	cutoff := l.now().Add(-l.window)
	values := l.attempts[bucket]
	first := 0
	for first < len(values) && values[first].Before(cutoff) {
		first++
	}
	if first == len(values) {
		delete(l.attempts, bucket)
		return
	}
	l.attempts[bucket] = values[first:]
}
