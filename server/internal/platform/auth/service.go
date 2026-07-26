package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

var ErrUserNotFound = errors.New("user not found")

type User struct {
	ID             uuid.UUID
	Username       string
	Name           *string
	HashedPassword string
}

type Store interface {
	CredentialsByUsername(context.Context, string) (User, error)
	ActorByUserID(context.Context, uuid.UUID) (*authz.Actor, error)
}

type LoginResult struct {
	Token     string
	ExpiresAt time.Time
	User      User
}

type Service struct {
	store     Store
	hasher    PasswordHasher
	tokens    TokenManager
	limiter   *RateLimiter
	dummyHash string
}

func NewService(store Store, hasher PasswordHasher, tokens TokenManager, limiter *RateLimiter) (*Service, error) {
	dummyHash, err := hasher.Hash("synie-invalid-credential-dummy")
	if err != nil {
		return nil, fmt.Errorf("生成登录等时 dummy hash: %w", err)
	}
	return &Service{store: store, hasher: hasher, tokens: tokens, limiter: limiter, dummyHash: dummyHash}, nil
}

func (s *Service) Login(ctx context.Context, username, password, bucket string) (LoginResult, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return LoginResult{}, apierror.New(apierror.CodeUnauthorized, "用户名或密码错误")
	}
	if s.limiter.Blocked(bucket) {
		return LoginResult{}, &apierror.Error{Code: apierror.CodeRateLimited, Message: "登录尝试过于频繁,请稍后再试"}
	}

	user, err := s.store.CredentialsByUsername(ctx, username)
	hash := user.HashedPassword
	missing := errors.Is(err, ErrUserNotFound)
	if missing {
		hash = s.dummyHash
	} else if err != nil {
		return LoginResult{}, apierror.Wrap(apierror.CodeInternal, "登录暂不可用", err)
	}
	valid, verifyErr := s.hasher.Verify(hash, password)
	if verifyErr != nil && !missing {
		return LoginResult{}, apierror.Wrap(apierror.CodeInternal, "登录暂不可用", verifyErr)
	}
	if missing || !valid {
		s.limiter.RecordFailure(bucket)
		return LoginResult{}, apierror.New(apierror.CodeUnauthorized, "用户名或密码错误")
	}

	token, expiresAt, err := s.tokens.Issue(user.ID)
	if err != nil {
		return LoginResult{}, apierror.Wrap(apierror.CodeInternal, "登录暂不可用", err)
	}
	s.limiter.Reset(bucket)
	return LoginResult{Token: token, ExpiresAt: expiresAt, User: user}, nil
}

func (s *Service) Authenticate(ctx context.Context, rawToken string) (*authz.Actor, error) {
	userID, err := s.tokens.Verify(rawToken)
	if err != nil {
		return nil, apierror.New(apierror.CodeUnauthorized, "登录状态已失效,请重新登录")
	}
	actor, err := s.store.ActorByUserID(ctx, userID)
	if errors.Is(err, ErrUserNotFound) {
		return nil, apierror.New(apierror.CodeUnauthorized, "登录状态已失效,请重新登录")
	}
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "认证服务暂不可用", err)
	}
	return actor, nil
}
