import { describe, expect, test } from 'bun:test'
import { parseSetupStatus, stripLocalConvexCredentials } from './reset.ts'

describe('stripLocalConvexCredentials', () => {
  test('移除会随 backend volume 失效的本地凭据并保留无关配置', () => {
    expect(
      stripLocalConvexCredentials(
        [
          '# keep this comment',
          'CUSTOM_LOCAL_FLAG=keep',
          'CONVEX_SELF_HOSTED_PROJECT=synie-old',
          'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210',
          'CONVEX_SELF_HOSTED_SITE_URL=http://127.0.0.1:3211',
          'CONVEX_SELF_HOSTED_ADMIN_KEY=never-print-this',
          'VITE_CONVEX_URL=http://127.0.0.1:3210',
          'VITE_CONVEX_SITE_URL=http://127.0.0.1:3211',
          'VITE_SITE_URL=http://127.0.0.1:3000',
          '',
        ].join('\n'),
      ),
    ).toBe('# keep this comment\nCUSTOM_LOCAL_FLAG=keep\n')
  })

  test('只有托管凭据时返回空文件', () => {
    expect(stripLocalConvexCredentials('CONVEX_SELF_HOSTED_ADMIN_KEY=old\n')).toBe('')
  })
})

describe('parseSetupStatus', () => {
  test('只接受具有两个布尔后置条件的 JSON', () => {
    expect(parseSetupStatus('{"hasUsers":false,"initialized":false}\n')).toEqual({
      initialized: false,
      hasUsers: false,
    })
    for (const invalid of [
      'not-json',
      '[]',
      '{}',
      '{"initialized":false,"hasUsers":0}',
    ]) {
      expect(() => parseSetupStatus(invalid)).toThrow()
    }
  })
})
