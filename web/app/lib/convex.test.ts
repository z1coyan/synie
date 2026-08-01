import { describe, expect, test } from 'bun:test'
import {
  parseConvexEnvironment,
  resolveConvexBrowserEnvironment,
  resolveConvexServerEnvironment,
} from './convex'

describe('Convex web environment', () => {
  test('规范化三个公开 URL', () => {
    expect(
      parseConvexEnvironment({
        VITE_CONVEX_URL: 'http://127.0.0.1:3210/',
        VITE_CONVEX_SITE_URL: 'http://127.0.0.1:3211/',
        VITE_SITE_URL: 'http://localhost:3000/',
      }),
    ).toEqual({
      url: 'http://127.0.0.1:3210',
      siteUrl: 'http://127.0.0.1:3211',
      appUrl: 'http://localhost:3000',
    })
  })

  test('缺失或非 HTTP URL 时 fail-fast', () => {
    expect(() =>
      parseConvexEnvironment({
        VITE_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
        VITE_SITE_URL: 'http://localhost:3000',
      }),
    ).toThrow('VITE_CONVEX_URL')
    expect(() =>
      parseConvexEnvironment({
        VITE_CONVEX_URL: 'ws://127.0.0.1:3210',
        VITE_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
        VITE_SITE_URL: 'http://localhost:3000',
      }),
    ).toThrow('http 或 https')
  })

  test('SSR 容器只覆盖 Convex 私网地址，浏览器与应用 URL 保持公开值', () => {
    const publicEnvironment = parseConvexEnvironment({
      VITE_CONVEX_URL: 'https://convex.example.com',
      VITE_CONVEX_SITE_URL: 'https://convex-site.example.com',
      VITE_SITE_URL: 'https://erp.example.com',
    })

    expect(
      resolveConvexServerEnvironment(publicEnvironment, {
        SYNIE_CONVEX_INTERNAL_URL: 'http://convex-backend:3210/',
        SYNIE_CONVEX_INTERNAL_SITE_URL: 'http://convex-backend:3211/',
      }),
    ).toEqual({
      url: 'http://convex-backend:3210',
      siteUrl: 'http://convex-backend:3211',
      appUrl: 'https://erp.example.com',
    })
    expect(resolveConvexServerEnvironment(publicEnvironment, {})).toEqual(
      publicEnvironment,
    )
  })

  test('生产浏览器优先采用容器启动时注入的公开 URL', () => {
    expect(resolveConvexBrowserEnvironment(
      {
        VITE_CONVEX_URL: 'http://127.0.0.1:3210',
        VITE_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
        VITE_SITE_URL: 'http://127.0.0.1:3000',
      },
      {
        VITE_CONVEX_URL: 'http://127.0.0.1:38210',
        VITE_CONVEX_SITE_URL: 'http://127.0.0.1:38211',
        VITE_SITE_URL: 'http://127.0.0.1:38300',
      },
    )).toEqual({
      url: 'http://127.0.0.1:38210',
      siteUrl: 'http://127.0.0.1:38211',
      appUrl: 'http://127.0.0.1:38300',
    })
  })
})
