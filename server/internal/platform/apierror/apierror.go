package apierror

import (
	"errors"
	"net/http"
)

type Code string

const (
	CodeUnauthorized   Code = "unauthorized"
	CodeRateLimited    Code = "rate_limited"
	CodeForbidden      Code = "forbidden"
	CodeValidation     Code = "validation"
	CodeNotFound       Code = "not_found"
	CodeConflict       Code = "conflict"
	CodeNotImplemented Code = "not_implemented"
	CodeInternal       Code = "internal"
)

type Error struct {
	Code    Code                `json:"code"`
	Message string              `json:"message"`
	Fields  map[string][]string `json:"fields,omitempty"`
	Cause   error               `json:"-"`
}

func (e *Error) Error() string {
	return e.Message
}

func (e *Error) Unwrap() error {
	return e.Cause
}

func New(code Code, message string) *Error {
	return &Error{Code: code, Message: message}
}

func Wrap(code Code, message string, cause error) *Error {
	return &Error{Code: code, Message: message, Cause: cause}
}

func Validation(message string, fields map[string][]string) *Error {
	return &Error{Code: CodeValidation, Message: message, Fields: fields}
}

func Status(err error) int {
	var target *Error
	if !errors.As(err, &target) {
		return http.StatusInternalServerError
	}
	switch target.Code {
	case CodeUnauthorized:
		return http.StatusUnauthorized
	case CodeRateLimited:
		return http.StatusTooManyRequests
	case CodeForbidden:
		return http.StatusForbidden
	case CodeValidation:
		return http.StatusBadRequest
	case CodeNotFound:
		return http.StatusNotFound
	case CodeConflict:
		return http.StatusConflict
	case CodeNotImplemented:
		return http.StatusNotImplemented
	default:
		return http.StatusInternalServerError
	}
}
