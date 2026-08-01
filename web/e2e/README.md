# Convex 浏览器 E2E

浏览器验收只针对自托管 Convex 栈，覆盖初始化、Better Auth 同源会话、
ResourceBinding 权限边界与 XLSX/PDF 打印闭环。旧业务 HTTP API 套件已随独立后端退役。

完整本地验收由根目录执行：

```bash
bun run e2e:self-hosted
```

若目标栈和 Web 已启动，可单独执行 Playwright：

```bash
cd web
E2E_BASE_URL=http://127.0.0.1:3000 bun run e2e:test
```

`convex-printing.e2e.ts` 需要验收脚本注入的打印 fixture 环境变量；建议通过
根目录命令运行，避免手工配置漂移。
