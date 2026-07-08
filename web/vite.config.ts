import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  server: {
    port: 3000,
    allowedHosts: ['home-n5pro', '.ts.net'],
    proxy: {
      '/graphql': {
        target: 'http://localhost:4000',
        changeOrigin: true
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
    tanstackStart({ srcDirectory: 'app' }),
    viteReact()
  ]
})