FROM golang:1.26.4-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/synie ./cmd/synie \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/synie-seed ./cmd/seed \
    && GOBIN=/out go install github.com/pressly/goose/v3/cmd/goose@v3.27.1

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S synie \
    && adduser -S -G synie synie
WORKDIR /app
COPY --from=build /out/synie /usr/local/bin/synie
COPY --from=build /out/synie-seed /usr/local/bin/synie-seed
COPY --from=build /out/goose /usr/local/bin/goose
COPY --from=build --chown=synie:synie /src/db/migrations /app/db/migrations
USER synie
EXPOSE 8080
CMD ["/usr/local/bin/synie"]
