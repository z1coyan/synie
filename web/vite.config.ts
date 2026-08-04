import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  server: {
    // 默认监听所有网卡（局域网 / Tailscale）。端口用 WEB_PORT，避免与 API 的 PORT=8080 冲突。
    host: process.env.WEB_HOST || process.env.HOST || '0.0.0.0',
    port: Number(process.env.WEB_PORT || 3000),
    allowedHosts: ['home-n5pro', '.ts.net', 'home-macmini'],
    proxy: {
      '/api/v1': {
        target: `http://localhost:${process.env.SYNIE_API_PORT || process.env.GO_API_PORT || 8080}`,
        changeOrigin: true,
        // better-auth 对带 cookie 的写请求严格校验 Origin(须与 API host 同源);
        // dev 代理下浏览器 Origin 是前端口,统一改写为 target。生产同源部署无此问题
        headers: {
          origin: `http://localhost:${process.env.SYNIE_API_PORT || process.env.GO_API_PORT || 8080}`
        }
      }
    },
    fs: {
      // node_modules 在 git worktree 里是指向主 checkout 的软链,按真实路径放行,否则静态资源(字体等)403
      allow: [searchForWorkspaceRoot(process.cwd()), fs.realpathSync(path.join(import.meta.dirname, 'node_modules'))]
    }
  },
  resolve: {
    alias: {
      '~': path.resolve(import.meta.dirname, 'app')
    }
  },
  plugins: [
    // Tailwind 走 Vite 插件,避免 PostCSS 把 HeroUI 组件 CSS 拆开单独编译丢 utility
    tailwindcss(),
    tanstackStart({ srcDirectory: 'app' }),
    viteReact()
  ]
})
