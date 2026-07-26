GO ?= go
OAPI_CODEGEN_VERSION := v2.8.0
SQLC_VERSION := v1.31.1
GOOSE_VERSION := v3.27.1
OPENAPI_SPEC := ../contracts/openapi/openapi.yaml

.PHONY: generate test migration-up migration-down

generate:
	$(GO) run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$(OAPI_CODEGEN_VERSION) --config oapi-codegen.yaml $(OPENAPI_SPEC)
	$(GO) run github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION) generate

test:
	$(GO) test ./...

migration-up:
	$(GO) run github.com/pressly/goose/v3/cmd/goose@$(GOOSE_VERSION) -dir db/migrations postgres "$(DATABASE_URL)" up

migration-down:
	$(GO) run github.com/pressly/goose/v3/cmd/goose@$(GOOSE_VERSION) -dir db/migrations postgres "$(DATABASE_URL)" down
