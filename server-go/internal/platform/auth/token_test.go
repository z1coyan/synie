package auth

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTokenManager(t *testing.T) {
	now := time.Date(2026, 7, 25, 8, 0, 0, 0, time.UTC)
	manager := NewTokenManager([]byte("01234567890123456789012345678901"), time.Hour)
	manager.now = func() time.Time { return now }
	userID := uuid.New()
	raw, expiresAt, err := manager.Issue(userID)
	if err != nil {
		t.Fatal(err)
	}
	if !expiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("expiresAt = %s", expiresAt)
	}
	got, err := manager.Verify(raw)
	if err != nil || got != userID {
		t.Fatalf("Verify() = %s, %v", got, err)
	}
	manager.now = func() time.Time { return now.Add(2 * time.Hour) }
	if _, err := manager.Verify(raw); err == nil {
		t.Fatal("expired token should fail")
	}
}
