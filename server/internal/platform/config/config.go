package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr   string
	DatabaseURL string
	AuthSecret []byte
	TokenTTL   time.Duration
	LogLevel   slog.Level
}

func Load() (Config, error) {
	cfg := Config{
		HTTPAddr: envOr("HTTP_ADDR", ":8080"),
		TokenTTL: 7 * 24 * time.Hour,
		LogLevel: slog.LevelInfo,
	}

	if raw := os.Getenv("AUTH_TOKEN_TTL"); raw != "" {
		ttl, err := time.ParseDuration(raw)
		if err != nil || ttl <= 0 {
			return Config{}, fmt.Errorf("AUTH_TOKEN_TTL 必须是正数 duration: %q", raw)
		}
		cfg.TokenTTL = ttl
	}

	switch strings.ToLower(envOr("LOG_LEVEL", "info")) {
	case "debug":
		cfg.LogLevel = slog.LevelDebug
	case "info":
		cfg.LogLevel = slog.LevelInfo
	case "warn", "warning":
		cfg.LogLevel = slog.LevelWarn
	case "error":
		cfg.LogLevel = slog.LevelError
	default:
		return Config{}, errors.New("LOG_LEVEL 仅支持 debug/info/warn/error")
	}

	secret := os.Getenv("AUTH_SECRET")
	if len(secret) < 32 {
		return Config{}, errors.New("AUTH_SECRET 至少需要 32 字节")
	}
	cfg.AuthSecret = []byte(secret)

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		var err error
		cfg.DatabaseURL, err = postgresURLFromEnv()
		if err != nil {
			return Config{}, err
		}
	}

	return cfg, nil
}

func postgresURLFromEnv() (string, error) {
	host := envOr("PGHOST", "localhost")
	portRaw := envOr("PGPORT", "5432")
	port, err := strconv.Atoi(portRaw)
	if err != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("PGPORT 无效: %q", portRaw)
	}
	user := envOr("PGUSER", "postgres")
	database := os.Getenv("PGDATABASE")
	if database == "" {
		return "", errors.New("必须设置 DATABASE_URL 或 PGDATABASE")
	}

	u := &url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(user, os.Getenv("PGPASSWORD")),
		Host:   fmt.Sprintf("%s:%d", host, port),
		Path:   database,
	}
	q := u.Query()
	q.Set("sslmode", envOr("PGSSLMODE", "disable"))
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
