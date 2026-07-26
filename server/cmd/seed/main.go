package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/z1coyan/synie/server/internal/db"
	"github.com/z1coyan/synie/server/internal/platform/auth"
	"github.com/z1coyan/synie/server/internal/platform/config"
)

func main() {
	if err := run(); err != nil {
		slog.Error("种子执行失败", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("加载配置: %w", err)
	}
	username := strings.TrimSpace(envOr("SEED_ADMIN_USERNAME", "admin"))
	password := os.Getenv("SEED_ADMIN_PASSWORD")
	name := strings.TrimSpace(envOr("SEED_ADMIN_NAME", "系统管理员"))
	if username == "" || len(username) > 64 {
		return errors.New("SEED_ADMIN_USERNAME 必须为 1 到 64 个字符")
	}
	if len(password) < 12 {
		return errors.New("SEED_ADMIN_PASSWORD 至少需要 12 个字符")
	}

	hash, err := auth.NewPasswordHasher(auth.DefaultArgon2Params()).Hash(password)
	if err != nil {
		return fmt.Errorf("生成管理员密码哈希: %w", err)
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	result, err := pool.Exec(ctx, `
		INSERT INTO sys_user (username, name, hashed_password, super_admin, all_companies)
		VALUES ($1, $2, $3, true, true)
		ON CONFLICT (username) DO NOTHING
	`, username, name, hash)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			return fmt.Errorf("写管理员种子(PostgreSQL %s): %w", pgErr.Code, err)
		}
		return fmt.Errorf("写管理员种子: %w", err)
	}
	if result.RowsAffected() == 0 {
		slog.Info("管理员已存在,未修改密码", "username", username)
	} else {
		slog.Info("管理员种子已创建", "username", username)
	}
	return nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
