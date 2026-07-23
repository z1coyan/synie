# syntax=docker/dockerfile:1
# Synie ERP 后端生产镜像(umbrella release:synie_core + synie_web,release 名 synie)
#
# 构建(在 backend/ 目录下):
#   docker build -t synie-backend .
#
# 运行(数据库为外部 Postgres;prod 只认 DATABASE_URL):
#   docker run --rm -p 4000:4000 \
#     -e DATABASE_URL=postgres://user:pass@db-host:5432/synie \
#     -e SECRET_KEY_BASE=<mix phx.gen.secret 生成> \
#     -e PHX_HOST=erp.example.com \
#     synie-backend
#
# 环境变量:
#   DATABASE_URL     必填
#   SECRET_KEY_BASE  必填
#   PHX_HOST         endpoint url host,默认 localhost
#   PORT             HTTP 监听端口,默认 4000
#   POOL_SIZE        数据库连接池大小,默认 10
#   SOFFICE_PATH     soffice 路径(打印 PDF),默认 soffice;镜像已内置 libreoffice-calc

ARG ELIXIR_VERSION=1.20.2
ARG OTP_VERSION=28.3.3
ARG DEBIAN_VERSION=bookworm-20260713

ARG BUILDER_IMAGE=hexpm/elixir:${ELIXIR_VERSION}-erlang-${OTP_VERSION}-debian-${DEBIAN_VERSION}-slim
ARG RUNNER_IMAGE=debian:${DEBIAN_VERSION}-slim

FROM ${BUILDER_IMAGE} AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mix local.hex --force && mix local.rebar --force

ENV MIX_ENV=prod

COPY mix.exs mix.lock ./
COPY config config
COPY apps/synie_core/mix.exs apps/synie_core/
COPY apps/synie_web/mix.exs apps/synie_web/

RUN mix deps.get --only prod \
 && mix deps.compile

COPY apps/synie_core apps/synie_core
COPY apps/synie_web apps/synie_web

RUN mix compile \
 && mix release synie

FROM ${RUNNER_IMAGE} AS runner

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libstdc++6 openssl libncurses6 locales ca-certificates \
      libreoffice-calc-nogui \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
 && locale-gen

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8
ENV MIX_ENV=prod
ENV PHX_SERVER=true

WORKDIR /app

RUN useradd --create-home --shell /bin/bash synie
COPY --from=builder --chown=synie:synie /app/_build/prod/rel/synie ./

USER synie

EXPOSE 4000

CMD ["bin/synie", "start"]
