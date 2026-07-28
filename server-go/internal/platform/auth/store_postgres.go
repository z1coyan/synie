package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/z1coyan/synie/server/internal/db/dbgen"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

type PostgresStore struct {
	queries *dbgen.Queries
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{queries: dbgen.New(pool)}
}

func (s *PostgresStore) CredentialsByUsername(ctx context.Context, username string) (User, error) {
	row, err := s.queries.CredentialsByUsername(ctx, username)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("按用户名读取用户: %w", err)
	}
	return User{
		ID:             row.ID,
		Username:       row.Username,
		Name:           textPointer(row.Name.String, row.Name.Valid),
		HashedPassword: row.HashedPassword,
	}, nil
}

func (s *PostgresStore) ActorByUserID(ctx context.Context, userID uuid.UUID) (*authz.Actor, error) {
	row, err := s.queries.UserActorBase(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取 Actor 用户: %w", err)
	}

	permissions, err := s.queries.UserPermissions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("读取 Actor 权限: %w", err)
	}
	actor := &authz.Actor{
		UserID:       row.ID,
		Username:     row.Username,
		Name:         textPointer(row.Name.String, row.Name.Valid),
		SuperAdmin:   row.SuperAdmin,
		AllCompanies: row.AllCompanies,
		Permissions:  make(map[string]struct{}, len(permissions)),
	}
	for _, permission := range permissions {
		actor.Permissions[permission] = struct{}{}
	}

	actor.CompanyIDs, err = s.queries.UserCompanyIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("读取 Actor 公司范围: %w", err)
	}
	return actor, nil
}

func textPointer(value string, valid bool) *string {
	if !valid {
		return nil
	}
	return &value
}
