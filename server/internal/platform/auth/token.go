package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const tokenIssuer = "synie"

type TokenManager struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

func NewTokenManager(secret []byte, ttl time.Duration) TokenManager {
	return TokenManager{secret: append([]byte(nil), secret...), ttl: ttl, now: time.Now}
}

func (m TokenManager) Issue(userID uuid.UUID) (string, time.Time, error) {
	now := m.now().UTC()
	expiresAt := now.Add(m.ttl)
	claims := jwt.RegisteredClaims{
		Issuer:    tokenIssuer,
		Subject:   userID.String(),
		ExpiresAt: jwt.NewNumericDate(expiresAt),
		IssuedAt:  jwt.NewNumericDate(now),
		NotBefore: jwt.NewNumericDate(now),
		ID:        uuid.NewString(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(m.secret)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("签发 JWT: %w", err)
	}
	return signed, expiresAt, nil
}

func (m TokenManager) Verify(raw string) (uuid.UUID, error) {
	claims := &jwt.RegisteredClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("JWT alg 必须是 HS256")
		}
		return m.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithIssuer(tokenIssuer), jwt.WithTimeFunc(m.now))
	if err != nil || !token.Valid {
		return uuid.Nil, errors.New("登录令牌无效或已过期")
	}
	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return uuid.Nil, errors.New("登录令牌 subject 无效")
	}
	return userID, nil
}
