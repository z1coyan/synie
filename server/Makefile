GO ?= go
OAPI_CODEGEN_VERSION := v2.8.0
SQLC_VERSION := v1.31.1
GOOSE_VERSION := v3.27.1
OPENAPI_SPEC := ../contracts/openapi/openapi.yaml

.PHONY: generate test lint verify-codegen migration-up migration-down

generate:
	$(GO) run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$(OAPI_CODEGEN_VERSION) --config oapi-codegen.yaml $(OPENAPI_SPEC)
	$(GO) run github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION) generate

test:
	$(GO) test ./...

# gofmt 检查(仅 server/ 目录) + go vet;CI 与本地同源,CI job 直接调用本目标。
lint:
	@unformatted="$$(gofmt -l .)"; \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt 检查失败,以下文件未格式化(请运行 gofmt -w .):"; \
		echo "$$unformatted"; \
		exit 1; \
	fi
	$(GO) vet ./...

# 代码生成物新鲜度校验:重新生成(oapi-codegen + sqlc)后检查 git diff,
# 只比对生成物目录,避免仓库中其他未提交改动干扰。
verify-codegen:
	$(MAKE) generate
	@git diff --exit-code -- internal/http/gen internal/db/dbgen || { \
		echo "代码生成物不是最新的:请运行 make generate 并提交生成物"; \
		exit 1; \
	}

migration-up:
	$(GO) run github.com/pressly/goose/v3/cmd/goose@$(GOOSE_VERSION) -dir db/migrations postgres "$(DATABASE_URL)" up

migration-down:
	$(GO) run github.com/pressly/goose/v3/cmd/goose@$(GOOSE_VERSION) -dir db/migrations postgres "$(DATABASE_URL)" down
