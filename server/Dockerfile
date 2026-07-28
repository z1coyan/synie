# syntax=docker/dockerfile:1

# Synie Bun server 镜像。构建上下文为仓库根（monorepo：依赖 packages/shared）。
# 只保留 server 与 shared 两个 workspace 成员后安装（不装 web，无需 HeroUI 凭证）：
#   docker build -f server/Dockerfile -t synie-server .
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared ./packages/shared
COPY server ./server
# 裁剪 workspaces 至本镜像成员（锁文件仍含全仓解析，install 只取所需子集）
RUN bun -e "const p=await Bun.file('package.json').json();p.workspaces=['packages/*','server'];delete p.trustedDependencies;await Bun.write('package.json',JSON.stringify(p,null,2)+'\n')"
RUN bun install

FROM oven/bun:1
WORKDIR /app
COPY --from=build /app ./
WORKDIR /app/server
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "src/index.ts"]
