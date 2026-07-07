import path from 'node:path'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/graphql': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
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