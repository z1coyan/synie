# syntax=docker/dockerfile:1

# Synie Bun server 镜像。构建上下文为仓库根（monorepo：依赖 packages/shared）。
# 只保留 server 与 shared 两个 workspace 成员后安装（不装 web，无需 HeroUI 凭证）：
#   docker build -f server/Dockerfile -t synie-server .
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY server ./server
# 裁剪 workspaces 至本镜像成员（锁文件仍含全仓解析，install 只取所需子集）
RUN bun -e "const p=await Bun.file('package.json').json();p.workspaces=['packages/*','server'];delete p.trustedDependencies;await Bun.write('package.json',JSON.stringify(p,null,2)+'\n')"
RUN bun install

FROM oven/bun:1.3.14
WORKDIR /app
COPY --from=build --chown=bun:bun /app ./
# 上传文件默认落在 <工作目录>/uploads（UPLOADS_ROOT 可覆盖）；预建目录并授给 bun 用户，
# 生产部署应把 /app/server/uploads 挂到持久卷（见 compose.deploy.yaml）
RUN mkdir -p /app/server/uploads && chown bun:bun /app/server/uploads
WORKDIR /app/server
ENV PORT=8080
EXPOSE 8080
# 非 root 运行（oven/bun 镜像内置 bun 用户）
USER bun
# 健康检查打 /api/v1/healthz（含数据库连通性，无需鉴权）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/v1/healthz'); process.exit(r.status === 200 ? 0 : 1)"
CMD ["bun", "src/index.ts"]
