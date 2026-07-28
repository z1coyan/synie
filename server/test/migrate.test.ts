import { describe, expect, test } from 'bun:test'
import { extractUpSection } from '../db/migrate.ts'

describe('goose Up 段提取', () => {
  test('提取 Up 到 Down 之间的内容', () => {
    const content = '-- +goose Up\nCREATE TABLE a(id int);\n\n-- +goose Down\nDROP TABLE a;\n'
    expect(extractUpSection(content, 'x.sql')).toBe('\nCREATE TABLE a(id int);\n\n')
  })

  test('无 Down 注解时 Up 到文件尾', () => {
    const content = '-- +goose Up\nCREATE TABLE a(id int);\n'
    expect(extractUpSection(content, 'x.sql')).toBe('\nCREATE TABLE a(id int);\n')
  })

  test('完全无注解时整体视为 Up', () => {
    const content = 'CREATE TABLE a(id int);\n'
    expect(extractUpSection(content, 'x.sql')).toBe(content)
  })

  test('有 Down 无 Up 视为非法', () => {
    expect(() => extractUpSection('-- +goose Down\nDROP TABLE a;\n', 'x.sql')).toThrow('缺少 Up 注解')
  })

  test('baseline 真实文件：Down 段的 DROP 不进入执行内容', async () => {
    const content = await Bun.file(new URL('../db/migrations/00001_baseline.sql', import.meta.url)).text()
    const up = extractUpSection(content, '00001_baseline.sql')
    expect(up).toContain('CREATE TABLE public.sys_user')
    expect(up).not.toContain('DROP TABLE IF EXISTS public.sys_user_role CASCADE')
  })
})
