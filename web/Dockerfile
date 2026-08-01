# Keep the build and runtime ABI identical. The digest pins Bun and the Debian
# base; dependency and application bytes remain pinned by bun.lock.
FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS build

WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY web/package.json ./web/package.json
# HeroUI Pro is a licensed dependency. Its installer downloads the licensed
# dist bundle and requires the CI token in clean environments. BuildKit mounts
# the token only for this RUN step; it is never an ARG, ENV, copied file, or
# image layer. The explicit postinstall call also covers package-manager caches
# that restore the bootstrap package without rerunning its lifecycle script.
RUN --mount=type=secret,id=heroui_auth_token,required=true \
    HEROUI_AUTH_TOKEN="$(tr -d '\r\n' </run/secrets/heroui_auth_token)" \
    bun install --frozen-lockfile \
  && if [ ! -f web/node_modules/@heroui-pro/react/dist/index.js ]; then \
       HEROUI_AUTH_TOKEN="$(tr -d '\r\n' </run/secrets/heroui_auth_token)" \
       node web/node_modules/@heroui-pro/react/dist/postinstall/index.js; \
     fi \
  && test -s web/node_modules/@heroui-pro/react/dist/index.js

COPY . .

ARG VITE_CONVEX_URL=http://127.0.0.1:3210
ARG VITE_CONVEX_SITE_URL=http://127.0.0.1:3211
ARG VITE_SITE_URL=http://127.0.0.1:3000
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL \
    VITE_CONVEX_SITE_URL=$VITE_CONVEX_SITE_URL \
    VITE_SITE_URL=$VITE_SITE_URL
RUN cd web && bun run build

FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS runtime

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates coreutils curl fontconfig fonts-noto-cjk libreoffice-calc \
  && rm -rf /var/lib/apt/lists/* \
  && soffice --version \
  && fc-match "Noto Sans CJK SC"

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/web/node_modules ./web/node_modules
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/web/runtime-server.ts ./web/runtime-server.ts
COPY --from=build /app/web/dist ./web/dist

ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    TMPDIR=/tmp
USER bun
WORKDIR /app/web
EXPOSE 3000
CMD ["bun", "run", "start"]
