import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Input,
  InputGroup,
  Label,
  ListBox,
  Select,
  Spinner,
  TextField,
  toast,
} from '@heroui/react'
import { AppearanceSwitch } from '~/components/appearance-switch'
import { setToken } from '~/lib/auth'
import { gqlFetch } from '~/lib/graphql'
import { fetchSetupStatus } from '~/lib/setup'

// —— GraphQL 文档(setup 四个操作无 codegen 生成,照 login.tsx 手写) ——
const LOGIN_MUTATION = `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      token
      user { id username name }
    }
  }
`
const CREATE_FIRST_USER = `
  mutation ($username: String!, $name: String, $password: String!) {
    setupCreateFirstUser(username: $username, name: $name, password: $password) {
      token
      user { id username name }
    }
  }
`
const SEED_CURRENCIES = `
  mutation { setupSeedCommonCurrencies }
`
const ACTIVATE_ONLY_BASE_CURRENCY = `
  mutation ($currencyId: ID!) {
    setupActivateOnlyBaseCurrency(currencyId: $currencyId)
  }
`
const COMPANIES_QUERY = `
  query { basCompanies(limit: 1, offset: 0) { count results { id name } } }
`
const CURRENCIES_QUERY = `
  query { basCurrencies(limit: 200, offset: 0) { count results { id name isoCode symbol } } }
`
const accountCountQuery = (companyId: string) => `
  query { basAccounts(limit: 1, offset: 0, filter: {companyId: {eq: ${JSON.stringify(companyId)}}}) { count } }
`
const CREATE_COMPANY = `
  mutation ($input: CreateBasCompanyInput!) {
    createBasCompany(input: $input) { result { id } errors { message } }
  }
`
// 泛型 action 返回标量(创建条数),同 accounts.tsx;错误走 top-level errors 由 gqlFetch 抛出
const INIT_FROM_TEMPLATE = `
  mutation ($input: InitBasAccountFromTemplateInput!) {
    initBasAccountFromTemplate(input: $input)
  }
`
// 默认仓库种子(所有仓库/默认仓库/在途),同 INIT_FROM_TEMPLATE 的标量返回约定;幂等,已有仓库返回 0
const SEED_WAREHOUSE_DEFAULTS = `
  mutation ($input: SeedInvWarehouseDefaultsInput!) {
    seedInvWarehouseDefaults(input: $input)
  }
`
const COMPLETE_SETUP = `
  mutation ($preferredLanguage: String!, $seedSampleData: Boolean) {
    setupComplete(preferredLanguage: $preferredLanguage, seedSampleData: $seedSampleData)
  }
`

interface SessionUser {
  id: string
  username: string
  name: string | null
}
interface LoginResult {
  token: string
  user: SessionUser
}
interface Currency {
  id: string
  name: string
  isoCode: string
  symbol: string | null
}
interface CompanyRow {
  id: string
  name: string
}

/** 初始化路径:空白只建底座;示例另写客商/物料/报价,并预填演示公司与管理员 */
type SetupPath = 'blank' | 'sample'

// 示例数据路径预填(与 mix synie.demo 一致,可在向导中改)
const SAMPLE_DEFAULTS = {
  username: 'admin',
  name: '管理员',
  password: 'admin123',
  companyCode: 'JT',
  companyName: '台州京泰电气有限公司',
  companyShortName: '台州京泰',
  language: 'zh-CN',
  template: 'SMALL',
} as const

// 与 accounts.tsx 的模板清单一致;必选、无默认
const TEMPLATES = [
  { value: 'CAS', label: '企业会计准则' },
  { value: 'SMALL', label: '小企业会计准则' },
  { value: 'INTL', label: '国际通用(精简)' },
]

const LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
]

const COMPANY_CODE_RE = /^[A-Za-z]{2}$/

export const Route = createFileRoute('/setup')({
  beforeLoad: async () => {
    // SSR 首屏发不了相对路径 fetch,客户端在组件内再兜底一次(同 login.tsx 模式)
    if (typeof window === 'undefined') return
    const status = await fetchSetupStatus().catch(() => null)
    if (status?.initialized) throw redirect({ to: '/' })
  },
  component: SetupPage,
})

function SetupPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  // 默认空白;选「示例数据」后预填管理员/公司并在完成时落示例业务数据
  const [path, setPath] = useState<SetupPath>('blank')
  const goStep2 = useCallback(() => setStep(2), [])
  const goStep3 = useCallback(() => setStep(3), [])

  const status = useQuery({ queryKey: ['setupStatus'], queryFn: fetchSetupStatus })

  // 已完成初始化:向导永久关闭,回工作台(beforeLoad 在 SSR 读不到时的客户端兜底)
  useEffect(() => {
    if (status.data?.initialized) {
      navigate({ to: '/', replace: true })
    }
  }, [status.data, navigate])

  return (
    <div className="min-h-screen flex bg-porcelain text-ink-900">
      {/* 左栏:品牌仪式面(同 login,恒定玄蓝) */}
      <aside className="relative hidden lg:flex lg:w-[52%] xl:w-[55%] flex-col justify-between overflow-hidden bg-brand-ink text-brand-porcelain">
        <ResourceLattice />

        <span
          aria-hidden
          className="absolute right-8 top-1/2 -translate-y-1/2 select-none text-xs tracking-[0.5em] text-brand-porcelain/25 font-brand"
          style={{ writingMode: 'vertical-rl' }}
        >
          万物皆资源 · 秩序即效率
        </span>

        <header className="relative z-10 flex items-baseline gap-3 px-12 pt-10">
          <span className="font-brand text-2xl tracking-wide">Synie</span>
          <span className="h-4 w-px bg-gilt/70" aria-hidden />
          <span className="text-xs tracking-[0.35em] text-brand-porcelain/60">
            企业资源管理系统
          </span>
        </header>

        <div className="relative z-10 px-12 pb-16 max-w-xl">
          <h1 className="font-brand text-4xl xl:text-5xl leading-snug tracking-wide">
            基业初立,
            <br />
            万象待启。
          </h1>
          <p className="mt-6 text-sm leading-relaxed text-brand-porcelain/55">
            首次启动,三步完成初始化:管理员、公司与首选语言。可选从示例业务数据起步。
          </p>
          <div className="mt-10 flex items-center gap-4 text-[11px] tracking-[0.3em] text-brand-porcelain/35">
            <span className="h-px w-10 bg-gilt/50" aria-hidden />
            <span>一次性</span>
            <span>初始化</span>
            <span>向导</span>
          </div>
        </div>
      </aside>

      {/* 右栏:向导(跟随外观) */}
      <main className="relative flex flex-1 flex-col justify-center px-8 sm:px-16 py-12">
        <div className="absolute right-6 top-6 sm:right-10 sm:top-8">
          <AppearanceSwitch size="sm" />
        </div>
        <div className="mx-auto w-full max-w-sm">
          {/* 小屏时的词标 */}
          <div className="mb-10 flex items-baseline gap-3 lg:hidden">
            <span className="font-brand text-2xl">Synie</span>
            <span className="text-xs tracking-[0.3em] text-ink-500">
              企业资源管理系统
            </span>
          </div>

          <h2 className="font-brand text-3xl tracking-wide">初始化向导</h2>
          <p className="mt-3 text-sm text-ink-500">全新部署的一次性初始化,完成后本页自动关闭</p>

          <div className="mt-8">
            <StepIndicator current={step} />
          </div>

          {status.isPending ? (
            <Loading />
          ) : status.isError || !status.data ? (
            <LoadError
              message={status.error instanceof Error ? status.error.message : '状态查询失败'}
              onRetry={() => status.refetch()}
            />
          ) : status.data.initialized ? (
            <Loading /> // 即将跳转工作台
          ) : step === 1 ? (
            <StepAdmin
              hasUsers={status.data.hasUsers}
              path={path}
              onPathChange={setPath}
              onDone={goStep2}
            />
          ) : step === 2 ? (
            <StepCompany path={path} onDone={goStep3} />
          ) : (
            <StepLanguage seedSampleData={path === 'sample'} />
          )}

          <p className="mt-16 text-xs text-ink-500/60">
            © 2026 Synie · 企业内部系统
          </p>
        </div>
      </main>
    </div>
  )
}

const STEPS = ['管理员', '公司', '首选语言']

function StepIndicator(props: { current: number }) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3">
      {STEPS.map((label, i) => {
        const n = i + 1
        const done = n < props.current
        const active = n === props.current
        return (
          <li key={label} className="flex items-center gap-2 sm:gap-3">
            {i > 0 && (
              <span
                aria-hidden
                className={`h-px w-6 sm:w-10 ${done || active ? 'bg-gilt' : 'bg-ink-500/25'}`}
              />
            )}
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs ${
                active
                  ? 'bg-ink-900 text-porcelain'
                  : done
                    ? 'bg-gilt text-ink-900'
                    : 'border border-ink-500/30 text-ink-500'
              }`}
            >
              {n}
            </span>
            <span className={`text-xs tracking-[0.2em] ${active ? 'font-medium text-ink-900' : 'text-ink-500'}`}>
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function Loading() {
  return (
    <div className="mt-10 flex h-40 items-center justify-center">
      <Spinner size="lg" />
    </div>
  )
}

function LoadError(props: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-10 flex flex-col items-start gap-3">
      <p className="text-sm text-ink-500">加载失败:{props.message}</p>
      <Button variant="secondary" onPress={props.onRetry}>
        重试
      </Button>
    </div>
  )
}

/** 步骤 1 · 管理员:无用户建首个超管;已有用户(断线续作)改走登录 */
function StepAdmin(props: {
  hasUsers: boolean
  path: SetupPath
  onPathChange: (path: SetupPath) => void
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const sample = props.path === 'sample'
  const [username, setUsername] = useState(sample ? SAMPLE_DEFAULTS.username : '')
  const [name, setName] = useState(sample ? SAMPLE_DEFAULTS.name : '')
  const [password, setPassword] = useState(sample ? SAMPLE_DEFAULTS.password : '')
  const [confirm, setConfirm] = useState(sample ? SAMPLE_DEFAULTS.password : '')
  const [showPassword, setShowPassword] = useState(false)

  // 切换路径时回填/清空示例默认值(仅新建管理员场景;续作登录不改口令框)
  useEffect(() => {
    if (props.hasUsers) return
    if (props.path === 'sample') {
      setUsername(SAMPLE_DEFAULTS.username)
      setName(SAMPLE_DEFAULTS.name)
      setPassword(SAMPLE_DEFAULTS.password)
      setConfirm(SAMPLE_DEFAULTS.password)
    } else {
      setUsername('')
      setName('')
      setPassword('')
      setConfirm('')
    }
  }, [props.path, props.hasUsers])

  const onAuthed = (result: LoginResult, message: string) => {
    setToken(result.token)
    // 清掉可能缓存的 me:null,否则进入下一步后布局会误判登录态失效(同 login.tsx)
    queryClient.removeQueries({ queryKey: ['me'] })
    toast.success(message)
    props.onDone()
  }

  const createUser = useMutation({
    mutationFn: () =>
      gqlFetch<{ setupCreateFirstUser: LoginResult }>(CREATE_FIRST_USER, {
        username,
        name: name.trim() === '' ? null : name.trim(),
        password,
      }),
    onSuccess: (data) =>
      onAuthed(data.setupCreateFirstUser, `管理员 ${data.setupCreateFirstUser.user.name ?? data.setupCreateFirstUser.user.username} 已创建`),
    onError: (error) => {
      toast.danger('创建管理员失败', {
        description: error instanceof Error ? error.message : '请稍后再试',
      })
    },
  })

  const login = useMutation({
    mutationFn: () => gqlFetch<{ login: LoginResult }>(LOGIN_MUTATION, { username, password }),
    onSuccess: (data) =>
      onAuthed(data.login, `欢迎回来,${data.login.user.name ?? data.login.user.username}`),
    onError: (error) => {
      toast.danger('登录失败', {
        description: error instanceof Error ? error.message : '请稍后再试',
      })
    },
  })

  const pending = createUser.isPending || login.isPending

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!username || !password || pending) return
    if (!props.hasUsers) {
      if (password !== confirm) {
        toast.warning('两次输入的密码不一致')
        return
      }
      createUser.mutate()
    } else {
      login.mutate()
    }
  }

  return (
    <div className="mt-8">
      {props.hasUsers ? (
        <p className="rounded-sm border border-ink-500/20 bg-ink-900/[0.03] px-4 py-3 text-sm text-ink-500">
          已存在管理员账号,请登录后继续初始化。
        </p>
      ) : (
        <>
          <p className="text-sm text-ink-500">选择起步方式,再创建首个管理员账号(超级管理员)。</p>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <PathCard
              active={props.path === 'blank'}
              title="空白项目"
              description="仅建管理员与公司底座,业务数据自行维护"
              onPress={() => props.onPathChange('blank')}
              disabled={pending}
            />
            <PathCard
              active={props.path === 'sample'}
              title="示例数据"
              description="预填演示账号与公司,完成时写入客户/供应商/物料/报价"
              onPress={() => props.onPathChange('sample')}
              disabled={pending}
            />
          </div>
          {sample && (
            <p className="mt-3 rounded-sm border border-gilt/40 bg-gilt/10 px-3 py-2 text-xs text-ink-500">
              已预填演示账号(可改)。完成初始化时将写入示例客户、供应商、物料与销采报价单。
            </p>
          )}
        </>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-5">
        <TextField value={username} onChange={setUsername} isDisabled={pending}>
          <Label>用户名</Label>
          <Input autoFocus autoComplete="username" className="rounded-sm" />
        </TextField>

        {!props.hasUsers && (
          <TextField value={name} onChange={setName} isDisabled={pending}>
            <Label>姓名(选填)</Label>
            <Input autoComplete="name" className="rounded-sm" />
          </TextField>
        )}

        <TextField value={password} onChange={setPassword} isDisabled={pending}>
          <Label>密码</Label>
          <InputGroup className="rounded-sm">
            <InputGroup.Input
              type={showPassword ? 'text' : 'password'}
              autoComplete={props.hasUsers ? 'current-password' : 'new-password'}
            />
            <InputGroup.Suffix className="pr-1">
              <Button
                size="sm"
                variant="ghost"
                className="text-xs text-ink-500 hover:text-ink-900"
                onPress={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? '隐藏' : '显示'}
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
        </TextField>

        {!props.hasUsers && (
          <TextField value={confirm} onChange={setConfirm} isDisabled={pending}>
            <Label>确认密码</Label>
            <Input type="password" autoComplete="new-password" className="rounded-sm" />
          </TextField>
        )}

        <Button
          type="submit"
          size="lg"
          isPending={pending}
          isDisabled={!username || !password || (!props.hasUsers && !confirm)}
          className="mt-2 w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.4em] hover:bg-brand-ink-mid"
        >
          {props.hasUsers ? '登录并继续' : '创建并继续'}
        </Button>
      </form>
    </div>
  )
}

function PathCard(props: {
  active: boolean
  title: string
  description: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onPress}
      className={`rounded-sm border px-3 py-3 text-left transition-colors ${
        props.active
          ? 'border-ink-900 bg-ink-900 text-porcelain'
          : 'border-ink-500/25 bg-transparent text-ink-900 hover:border-ink-500/50'
      } ${props.disabled ? 'opacity-50' : ''}`}
    >
      <div className={`text-sm font-medium tracking-wide ${props.active ? 'text-porcelain' : ''}`}>
        {props.title}
      </div>
      <div className={`mt-1 text-xs leading-relaxed ${props.active ? 'text-porcelain/70' : 'text-ink-500'}`}>
        {props.description}
      </div>
    </button>
  )
}

/** 步骤 2 · 公司:先静默预置常用货币;无公司走创建,已有公司(续作)按科目数分流 */
function StepCompany(props: { path: SetupPath; onDone: () => void }) {
  const sample = props.path === 'sample'
  const [seeded, setSeeded] = useState(false)
  const [code, setCode] = useState(sample ? SAMPLE_DEFAULTS.companyCode : '')
  const [name, setName] = useState(sample ? SAMPLE_DEFAULTS.companyName : '')
  const [shortName, setShortName] = useState(sample ? SAMPLE_DEFAULTS.companyShortName : '')
  const [baseCurrencyId, setBaseCurrencyId] = useState<string | null>(null)
  const [template, setTemplate] = useState<string | null>(sample ? SAMPLE_DEFAULTS.template : null)
  const [pending, setPending] = useState(false)

  // 进入公司步:幂等预置约 20 种常用货币(静默,成功不提示;失败仅告警,不阻塞后续选币)
  useEffect(() => {
    let cancelled = false
    gqlFetch<{ setupSeedCommonCurrencies: number }>(SEED_CURRENCIES)
      .catch((e) => toast.danger('预置常用货币失败', { description: (e as Error).message }))
      .finally(() => {
        if (!cancelled) setSeeded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const companies = useQuery({
    queryKey: ['setupCompanies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { count: number; results: CompanyRow[] } }>(COMPANIES_QUERY).then(
        (d) => d.basCompanies
      ),
  })

  // 货币选项在预置完成后拉取,否则可能拿不到刚补进来的币种
  const currencies = useQuery({
    queryKey: ['setupCurrencies'],
    enabled: seeded,
    queryFn: () =>
      gqlFetch<{ basCurrencies: { count: number; results: Currency[] } }>(CURRENCIES_QUERY).then(
        (d) => d.basCurrencies
      ),
  })

  const existing = (companies.data?.count ?? 0) > 0 ? (companies.data!.results[0] ?? null) : null

  // 续作语义:已有公司时查其科目数,0 走模板初始化,>0 由下方 effect 直接进步骤 3
  const accountCount = useQuery({
    queryKey: ['setupAccountCount', existing?.id],
    enabled: existing != null,
    queryFn: () =>
      gqlFetch<{ basAccounts: { count: number } }>(accountCountQuery(existing!.id)).then(
        (d) => d.basAccounts.count
      ),
  })

  // 本位币默认选中 CNY(预置清单含人民币)
  useEffect(() => {
    if (baseCurrencyId == null && currencies.data) {
      const cny = currencies.data.results.find((c) => c.isoCode === 'CNY')
      if (cny) setBaseCurrencyId(cny.id)
    }
  }, [currencies.data, baseCurrencyId])

  const { onDone } = props
  useEffect(() => {
    if (existing && (accountCount.data ?? 0) > 0) onDone()
  }, [existing, accountCount.data, onDone])

  const submitCreate = async () => {
    if (pending) return
    if (!COMPANY_CODE_RE.test(code.trim())) {
      toast.warning('公司编号需为恰好 2 位英文字母')
      return
    }
    if (!baseCurrencyId) {
      toast.warning('请选择本位币')
      return
    }
    if (!template) {
      toast.warning('请选择科目表模板')
      return
    }
    setPending(true)
    const id = toast('正在创建公司并初始化科目…', { isLoading: true, timeout: 0 })
    try {
      // 选定本币后仅启用该币种(预置货币默认全停);须在建公司前完成,公司本币校验要求启用中的货币
      await gqlFetch<{ setupActivateOnlyBaseCurrency: boolean }>(ACTIVATE_ONLY_BASE_CURRENCY, {
        currencyId: baseCurrencyId,
      })
      const created = await gqlFetch<{
        createBasCompany: { result: { id: string } | null; errors: { message: string }[] | null }
      }>(CREATE_COMPANY, {
        input: { code: code.trim(), name: name.trim(), shortName: shortName.trim(), baseCurrencyId },
      })
      const errors = created.createBasCompany.errors
      if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
      const companyId = created.createBasCompany.result!.id
      const init = await gqlFetch<{ initBasAccountFromTemplate: number }>(INIT_FROM_TEMPLATE, {
        input: { companyId, template },
      })
      // 建仓失败不阻断向导(公司/科目已就位):报错提示,仓库可事后手工补建
      let warehouseCount = 0
      let seedError: string | null = null
      try {
        const seed = await gqlFetch<{ seedInvWarehouseDefaults: number }>(SEED_WAREHOUSE_DEFAULTS, {
          input: { companyId },
        })
        warehouseCount = seed.seedInvWarehouseDefaults
      } catch (e) {
        seedError = (e as Error).message
      }
      toast.close(id)
      if (seedError) toast.danger('初始化默认仓库失败', { description: seedError })
      toast.success(
        `公司「${name.trim()}」已创建,并按模板初始化 ${init.initBasAccountFromTemplate} 个科目、${warehouseCount} 个仓库`
      )
      props.onDone()
    } catch (e) {
      toast.close(id)
      toast.danger('创建公司失败', { description: (e as Error).message })
      // 公司可能已创建、仅科目初始化失败:刷新列表,按续作分支只补初始化
      companies.refetch()
    } finally {
      setPending(false)
    }
  }

  const submitInitOnly = async () => {
    if (pending || !existing) return
    if (!template) {
      toast.warning('请选择科目表模板')
      return
    }
    setPending(true)
    const id = toast('正在初始化科目表…', { isLoading: true, timeout: 0 })
    try {
      const init = await gqlFetch<{ initBasAccountFromTemplate: number }>(INIT_FROM_TEMPLATE, {
        input: { companyId: existing.id, template },
      })
      toast.close(id)
      toast.success(`已按模板初始化 ${init.initBasAccountFromTemplate} 个科目`)
      props.onDone()
    } catch (e) {
      toast.close(id)
      toast.danger('初始化科目失败', { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  if (companies.isPending) return <Loading />
  if (companies.isError || !companies.data) {
    return (
      <LoadError
        message={companies.error instanceof Error ? companies.error.message : '公司查询失败'}
        onRetry={() => companies.refetch()}
      />
    )
  }

  // —— 续作分支:已有公司 ——
  if (existing) {
    if (accountCount.isPending || (accountCount.data ?? 0) > 0) return <Loading />
    if (accountCount.isError) {
      return (
        <LoadError
          message={accountCount.error instanceof Error ? accountCount.error.message : '科目查询失败'}
          onRetry={() => accountCount.refetch()}
        />
      )
    }
    return (
      <div className="mt-8">
        <p className="rounded-sm border border-ink-500/20 bg-ink-900/[0.03] px-4 py-3 text-sm text-ink-500">
          公司已存在:{existing.name}。其科目表尚未初始化,选择模板一键初始化后继续。
        </p>
        <div className="mt-6 flex flex-col gap-5">
          <Select value={template} onChange={(v) => setTemplate(v == null ? null : String(v))}>
            <Label>科目表模板</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {TEMPLATES.map((t) => (
                  <ListBox.Item key={t.value} id={t.value} textValue={t.label}>
                    {t.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="text-xs text-ink-500">将按所选模板为该公司一键初始化会计科目,后续可自行增删调整。</p>
          <Button
            size="lg"
            isPending={pending}
            isDisabled={!template}
            onPress={submitInitOnly}
            className="mt-2 w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.4em] hover:bg-brand-ink-mid"
          >
            初始化科目并继续
          </Button>
        </div>
      </div>
    )
  }

  // —— 创建分支:无公司 ——
  if (!seeded || currencies.isPending) return <Loading />
  if (currencies.isError || !currencies.data) {
    return (
      <LoadError
        message={currencies.error instanceof Error ? currencies.error.message : '货币查询失败'}
        onRetry={() => currencies.refetch()}
      />
    )
  }

  return (
    <div className="mt-8">
      <p className="text-sm text-ink-500">
        {sample
          ? '已预填演示公司(可改)。创建后将按模板初始化科目表,完成初始化时再写入示例业务数据。'
          : '创建第一家公司(记账主体),并按模板初始化其科目表。'}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          submitCreate()
        }}
        className="mt-6 flex flex-col gap-5"
      >
        <TextField value={code} onChange={setCode} isDisabled={pending}>
          <Label>公司编号</Label>
          <Input placeholder="如 SH" autoFocus className="rounded-sm" />
        </TextField>
        <p className="-mt-3 text-xs text-ink-500">恰好 2 位英文字母,创建后不可改。</p>

        <TextField value={name} onChange={setName} isDisabled={pending}>
          <Label>公司名称</Label>
          <Input placeholder="如 上海总部" className="rounded-sm" />
        </TextField>

        <TextField value={shortName} onChange={setShortName} isDisabled={pending}>
          <Label>公司简称</Label>
          <Input placeholder="如 上海" className="rounded-sm" />
        </TextField>

        <Select
          value={baseCurrencyId}
          onChange={(v) => setBaseCurrencyId(v == null ? null : String(v))}
          isDisabled={pending}
        >
          <Label>本位币</Label>
          <Select.Trigger>
            <Select.Value>
              {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {currencies.data.results.map((c) => (
                <ListBox.Item key={c.id} id={c.id} textValue={`${c.name}(${c.isoCode})`}>
                  {c.name}({c.isoCode})
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="-mt-3 text-xs text-ink-500">记账货币,单据双币换算的目标口径。</p>

        <Select value={template} onChange={(v) => setTemplate(v == null ? null : String(v))} isDisabled={pending}>
          <Label>科目表模板</Label>
          <Select.Trigger>
            <Select.Value>
              {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {TEMPLATES.map((t) => (
                <ListBox.Item key={t.value} id={t.value} textValue={t.label}>
                  {t.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="-mt-3 text-xs text-ink-500">必选。将按所选模板一键初始化会计科目,后续可自行增删调整。</p>

        <Button
          type="submit"
          size="lg"
          isPending={pending}
          isDisabled={!code.trim() || !name.trim() || !shortName.trim() || !baseCurrencyId || !template}
          className="mt-2 w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.4em] hover:bg-brand-ink-mid"
        >
          创建公司并继续
        </Button>
      </form>
    </div>
  )
}

/** 步骤 3 · 首选语言:写当前用户偏好并落完成旗标,随后回工作台 */
function StepLanguage(props: { seedSampleData: boolean }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [language, setLanguage] = useState(
    props.seedSampleData ? SAMPLE_DEFAULTS.language : 'zh-CN'
  )

  const complete = useMutation({
    mutationFn: () =>
      gqlFetch<{ setupComplete: boolean }>(COMPLETE_SETUP, {
        preferredLanguage: language,
        seedSampleData: props.seedSampleData,
      }),
    onSuccess: () => {
      // 落旗后门控即刻反转:清掉向导期缓存的 setupStatus/me,回 _app 重新判定
      queryClient.removeQueries({ queryKey: ['setupStatus'] })
      queryClient.removeQueries({ queryKey: ['me'] })
      toast.success(
        props.seedSampleData
          ? '初始化完成,示例客户/供应商/物料/报价已就绪'
          : '初始化完成,欢迎使用 Synie'
      )
      navigate({ to: '/' })
    },
    onError: (error) => {
      toast.danger('完成初始化失败', {
        description: error instanceof Error ? error.message : '请稍后再试',
      })
    },
  })

  return (
    <div className="mt-8">
      <p className="text-sm text-ink-500">选择当前用户的首选语言。</p>
      {props.seedSampleData && (
        <p className="mt-3 rounded-sm border border-gilt/40 bg-gilt/10 px-3 py-2 text-xs text-ink-500">
          完成时将同时写入示例业务数据:3 家客户、3 家供应商、6 种物料,以及销售/采购报价各 2 张。
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!complete.isPending) complete.mutate()
        }}
        className="mt-6 flex flex-col gap-5"
      >
        <Select value={language} onChange={(v) => v != null && setLanguage(String(v))} isDisabled={complete.isPending}>
          <Label>首选语言</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {LANGUAGES.map((l) => (
                <ListBox.Item key={l.value} id={l.value} textValue={l.label}>
                  {l.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <p className="-mt-3 text-xs text-ink-500">目前仅作偏好记录,界面翻译将在后续版本提供。</p>

        <Button
          type="submit"
          size="lg"
          isPending={complete.isPending}
          className="mt-2 w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.4em] hover:bg-brand-ink-mid"
        >
          完成初始化
        </Button>
      </form>
    </div>
  )
}

/** 左栏背景:细线经纬网格 + 呼吸的资源节点(同 login 页) */
function ResourceLattice() {
  return (
    <svg
      aria-hidden
      className="absolute inset-0 h-full w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="lattice" width="56" height="56" patternUnits="userSpaceOnUse">
          <path
            d="M 56 0 L 0 0 0 56"
            fill="none"
            stroke="rgba(250,250,247,0.05)"
            strokeWidth="1"
          />
        </pattern>
        <radialGradient id="vignette" cx="30%" cy="70%" r="90%">
          <stop offset="0%" stopColor="#12305e" />
          <stop offset="100%" stopColor="#0a1e3f" />
        </radialGradient>
      </defs>

      <rect width="100%" height="100%" fill="url(#vignette)" />
      <rect width="100%" height="100%" fill="url(#lattice)" />

      {/* 资源节点:仓储网络的抽象连线 */}
      <g stroke="rgba(201,161,90,0.35)" strokeWidth="1" fill="none">
        <path d="M 168 168 L 392 224 L 336 448 L 112 392 Z" />
        <path d="M 392 224 L 616 168" />
        <path d="M 336 448 L 560 504" />
      </g>
      <g fill="#c9a15a">
        <circle className="node-breathe" cx="168" cy="168" r="3" />
        <circle className="node-breathe-late" cx="392" cy="224" r="4" />
        <circle className="node-breathe" cx="336" cy="448" r="3" />
        <circle className="node-breathe-late" cx="112" cy="392" r="2.5" />
        <circle className="node-breathe" cx="616" cy="168" r="2.5" />
        <circle className="node-breathe-late" cx="560" cy="504" r="3" />
      </g>
    </svg>
  )
}
