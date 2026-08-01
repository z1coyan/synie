import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { parseConvexEnvironment } from './app/lib/convex'

const repositoryRoot = path.resolve(import.meta.dirname, '..')

export default defineConfig(({ mode }) => {
  // env 文件统一放仓库根；只验证并暴露 VITE_* 公共 URL，绝不 define admin key。
  const fileEnv = loadEnv(mode, repositoryRoot, '')
  parseConvexEnvironment({
    VITE_CONVEX_URL: process.env.VITE_CONVEX_URL ?? fileEnv.VITE_CONVEX_URL,
    VITE_CONVEX_SITE_URL:
      process.env.VITE_CONVEX_SITE_URL ?? fileEnv.VITE_CONVEX_SITE_URL,
    VITE_SITE_URL: process.env.VITE_SITE_URL ?? fileEnv.VITE_SITE_URL,
  })

  return {
    envDir: repositoryRoot,
    server: {
      // 默认监听所有网卡（局域网 / Tailscale）。端口用 WEB_PORT，避免与 API 的 PORT=8080 冲突。
      host: process.env.WEB_HOST || process.env.HOST || '0.0.0.0',
      port: Number(process.env.WEB_PORT || 3000),
      allowedHosts: ['home-n5pro', '.ts.net', 'home-macmini'],
      fs: {
        // node_modules 在 git worktree 里是指向主 checkout 的软链,按真实路径放行,否则静态资源(字体等)403
        allow: [
          searchForWorkspaceRoot(process.cwd()),
          fs.realpathSync(path.join(import.meta.dirname, 'node_modules')),
        ],
      },
    },
    resolve: {
      alias: {
        '~': path.resolve(import.meta.dirname, 'app'),
      },
    },
    ssr: {
      // Better Auth component 的条件导出需由 Vite 一并转换，避免 SSR CJS/ESM 分叉。
      noExternal: ['@convex-dev/better-auth'],
    },
    plugins: [
      // Tailwind 走 Vite 插件,避免 PostCSS 把 HeroUI 组件 CSS 拆开单独编译丢 utility
      tailwindcss(),
      tanstackStart({ srcDirectory: 'app' }),
      viteReact(),
    ],
  }
})
