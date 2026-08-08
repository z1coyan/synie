# syntax=docker/dockerfile:1

# Synie TanStack Start 前端镜像。构建上下文为仓库根（monorepo：
# web 构建依赖 packages/shared 与 @synie/server 的 hono/client 类型契约）。
#
# HeroUI Pro 是付费闭源包：`bun install` 时 postinstall 需要 HEROUI_AUTH_TOKEN
# 才能下载真实组件码。token 经 BuildKit secret 注入（只存在于该 RUN，不进镜像层与构建日志）：
#   docker build -f web/Dockerfile --secret id=HEROUI_AUTH_TOKEN,env=HEROUI_AUTH_TOKEN -t synie-web .
# Dokploy：compose.deploy.yaml 已声明 build secrets，token 写在 Dokploy Environment 即可。
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY server ./server
COPY web ./web
# 保留根 package.json 的 trustedDependencies（@heroui-pro/react 需要 postinstall 下载组件码）。
# required=false：无 token 时 install 仍成功但 Pro 组件码缺失，后续 vite build 会明确报错
RUN --mount=type=secret,id=HEROUI_AUTH_TOKEN,env=HEROUI_AUTH_TOKEN,required=false \
    bun install
RUN bun run --filter synie-web build

FROM oven/bun:1.3.14
WORKDIR /app
# SSR 产物（dist/server）externalize 了 node_modules，运行时仍需完整依赖树
#（Bun 隔离安装：web/node_modules 是指向根 node_modules/.bun 的软链，必须整树拷贝）
COPY --from=build --chown=bun:bun /app ./
WORKDIR /app/web
ENV PORT=3000
EXPOSE 3000
# 非 root 运行（oven/bun 镜像内置 bun 用户）
USER bun
# SSR 首页未登录会 302 到 /login，属健康；仅 5xx 视为异常
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/', { redirect: 'manual' }); process.exit(r.status < 500 ? 0 : 1)"
# serve.ts：Bun 原生静态资源 + SSR 生产服务器（无额外依赖）
CMD ["bun", "serve.ts"]
