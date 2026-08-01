import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  convexQuery,
  useConvexAuth,
  useConvexAction,
  useConvexMutation,
} from '@convex-dev/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Button,
  Checkbox,
  Input,
  InputGroup,
  Label,
  ListBox,
  Select,
  Spinner,
  TextField,
  toast,
} from '@heroui/react'
import { authClient, signInErrorMessage } from '~/lib/auth-client'
import { api } from '~/lib/convex-api'
import { mapConvexError } from '~/lib/convex-errors'
import { clearCatalogCache } from '~/lib/resources/catalog'
import { ConvexAuthFrame } from './convex-auth-frame'

function SetupError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <ConvexAuthFrame title="初始化向导" description="初始化服务暂时不可用">
      <div className="mt-10 flex flex-col items-start gap-4">
        <p className="text-sm leading-6 text-ink-500">{message}</p>
        <Button variant="secondary" onPress={retry}>重试</Button>
      </div>
    </ConvexAuthFrame>
  )
}

function FirstAdminForm() {
  const queryClient = useQueryClient()
  const createFirstUser = useConvexMutation(api.setup.createFirstUser.createFirstUser)
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const setup = useMutation({
    mutationFn: async () => {
      if (password !== confirmPassword) throw new Error('password_mismatch')
      const normalizedUsername = username.trim()
      await createFirstUser({
        username: normalizedUsername,
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      const signIn = await authClient.signIn.username({ username: normalizedUsername, password })
      return { signInError: signIn.error ?? null }
    },
    onSuccess: ({ signInError }) => {
      clearCatalogCache()
      queryClient.clear()
      if (signInError) {
        toast.warning('管理员已创建，请登录后继续初始化', {
          description: signInErrorMessage(signInError),
        })
        window.location.replace('/login')
        return
      }
      window.location.replace('/setup')
    },
    onError: (error) => {
      if (error instanceof Error && error.message === 'password_mismatch') {
        toast.danger('两次输入的密码不一致')
        return
      }
      const mapped = mapConvexError(error, '初始化失败，请稍后重试')
      toast.danger('创建管理员失败', { description: mapped.message })
    },
  })

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!username.trim() || !password || !confirmPassword || setup.isPending) return
    setup.mutate()
  }

  return (
    <ConvexAuthFrame title="初始化向导" description="第 1 步：创建唯一的首位超级管理员">
      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-5">
        <TextField value={username} onChange={setUsername} isDisabled={setup.isPending}>
          <Label>管理员用户名</Label>
          <Input autoFocus autoComplete="username" className="rounded-sm" />
        </TextField>
        <TextField value={name} onChange={setName} isDisabled={setup.isPending}>
          <Label>姓名（可选）</Label>
          <Input autoComplete="name" className="rounded-sm" />
        </TextField>
        <TextField value={password} onChange={setPassword} isDisabled={setup.isPending}>
          <Label>密码</Label>
          <InputGroup className="rounded-sm">
            <InputGroup.Input type={showPassword ? 'text' : 'password'} autoComplete="new-password" />
            <InputGroup.Suffix className="pr-1">
              <Button size="sm" variant="ghost" onPress={() => setShowPassword((value) => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>
                {showPassword ? '隐藏' : '显示'}
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
        </TextField>
        <TextField value={confirmPassword} onChange={setConfirmPassword} isDisabled={setup.isPending}>
          <Label>确认密码</Label>
          <Input type={showPassword ? 'text' : 'password'} autoComplete="new-password" className="rounded-sm" />
        </TextField>
        <Button type="submit" size="lg" isPending={setup.isPending} isDisabled={!username.trim() || !password || !confirmPassword} className="mt-2 w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.2em] hover:bg-brand-ink-mid">
          {setup.isPending ? '正在创建' : '创建管理员并继续'}
        </Button>
      </form>
    </ConvexAuthFrame>
  )
}

function BusinessSetupForm() {
  const queryClient = useQueryClient()
  const options = useQuery(convexQuery(api.setup.complete.options, {}))
  const completeSetup = useConvexMutation(api.setup.complete.complete)
  const seedSample = useConvexAction(api.setup.sampleAction.seed)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [shortName, setShortName] = useState('')
  const [currencyId, setCurrencyId] = useState<string | null>(null)
  const [accountTemplate, setAccountTemplate] = useState('SMALL')
  const [preferredLanguage, setPreferredLanguage] = useState('zh-CN')
  const [seedSampleData, setSeedSampleData] = useState(false)

  useEffect(() => {
    if (currencyId || !options.data?.currencies.length) return
    const cny = options.data.currencies.find((item) => item.isoCode === 'CNY')
    setCurrencyId(String(cny?.id ?? options.data.currencies[0].id))
  }, [currencyId, options.data])

  const finishNavigation = (message: string) => {
    clearCatalogCache()
    queryClient.clear()
    toast.success('系统初始化完成', { description: message })
    window.location.replace('/')
  }

  const completion = useMutation({
    mutationFn: async () => {
      const result = await completeSetup({
        company: {
          code,
          name,
          shortName,
          baseCurrencyId: currencyId as never,
          accountTemplate: accountTemplate as 'CAS' | 'SMALL' | 'INTL',
        },
        preferredLanguage,
        seedSampleData,
      })
      if (result.sampleRequired) {
        const sample = await seedSample({})
        if (!sample.completed) throw new Error(`示例数据停在 ${sample.stage} 阶段，请重试`)
      }
      return result
    },
    onSuccess: (result) => {
      finishNavigation(`已创建 ${result.accounts} 个会计科目、默认仓库${result.sampleRequired ? '及完整演示业务链' : ''}`)
    },
    onError: (error) => {
      const mapped = mapConvexError(error, '初始化失败，所有本次写入已回滚')
      toast.danger('完成初始化失败', { description: mapped.message })
    },
  })

  const resumeSample = useMutation({
    mutationFn: () => seedSample({}),
    onSuccess: (result) => {
      if (!result.completed) {
        toast.warning('示例数据尚未生成完成', { description: `当前阶段：${result.stage}` })
        return
      }
      finishNavigation('完整演示业务链已生成')
    },
    onError: (error) => {
      const mapped = mapConvexError(error, '示例数据生成失败，可安全重试')
      toast.danger('继续初始化失败', { description: mapped.message })
    },
  })

  if (options.isPending) {
    return <ConvexAuthFrame title="初始化向导" description="正在加载基础资料"><div className="mt-10 flex h-40 items-center justify-center"><Spinner size="lg" /></div></ConvexAuthFrame>
  }
  if (options.isError || !options.data) {
    return <SetupError message={mapConvexError(options.error, '无法加载初始化选项').message} retry={() => options.refetch()} />
  }
  if (options.data.resumeSample) {
    return (
      <ConvexAuthFrame title="初始化向导" description="业务底座已建立，继续生成演示业务链">
        <div className="mt-10 flex flex-col gap-5">
          <p className="text-sm leading-6 text-ink-500">
            {options.data.existingCompanyName ?? '首个公司'} 的基础资料已安全提交。示例数据按阶段生成；中断后可从最后完成的阶段继续，不会重复写入。
          </p>
          <Button size="lg" isPending={resumeSample.isPending} onPress={() => resumeSample.mutate()} className="w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.15em] hover:bg-brand-ink-mid">
            {resumeSample.isPending ? '正在继续初始化' : '继续生成完整演示业务链'}
          </Button>
        </div>
      </ConvexAuthFrame>
    )
  }

  const valid = /^[A-Za-z]{2}$/.test(code.trim()) && name.trim() && shortName.trim() && currencyId
  return (
    <ConvexAuthFrame title="初始化向导" description="第 2 步：创建首个公司并一次性建立业务底座">
      <form onSubmit={(event) => { event.preventDefault(); if (valid && !completion.isPending) completion.mutate() }} className="mt-8 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <TextField value={code} onChange={setCode} isDisabled={completion.isPending}>
            <Label>公司编号（2 位英文）</Label><Input autoFocus maxLength={2} />
          </TextField>
          <TextField value={shortName} onChange={setShortName} isDisabled={completion.isPending}>
            <Label>公司简称</Label><Input />
          </TextField>
        </div>
        <TextField value={name} onChange={setName} isDisabled={completion.isPending}>
          <Label>公司名称</Label><Input />
        </TextField>
        <Select value={currencyId} onChange={(value) => setCurrencyId(value == null ? null : String(value))} isDisabled={completion.isPending}>
          <Label>本位币</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>{options.data.currencies.map((item) => <ListBox.Item key={item.id} id={String(item.id)} textValue={`${item.isoCode} ${item.name}`}>{item.isoCode} - {item.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
        </Select>
        <Select value={accountTemplate} onChange={(value) => setAccountTemplate(String(value))} isDisabled={completion.isPending}>
          <Label>会计科目模板</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>{options.data.accountTemplates.map((item) => <ListBox.Item key={item.code} id={item.code} textValue={item.name}>{item.name}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
        </Select>
        <Select value={preferredLanguage} onChange={(value) => setPreferredLanguage(String(value))} isDisabled={completion.isPending}>
          <Label>首选语言</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox><ListBox.Item id="zh-CN" textValue="简体中文">简体中文<ListBox.ItemIndicator /></ListBox.Item><ListBox.Item id="en-US" textValue="English">English<ListBox.ItemIndicator /></ListBox.Item></ListBox></Select.Popover>
        </Select>
        <Checkbox slot={null} isSelected={seedSampleData} onChange={setSeedSampleData} isDisabled={completion.isPending}>
          <Checkbox.Content>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <span className="text-sm">创建完整演示业务链</span>
          </Checkbox.Content>
        </Checkbox>
        <p className="text-xs leading-5 text-ink-500">基础资料在一个事务内创建；可选演示链覆盖销售、采购、制造、委外、库存、财务与工资，并支持中断后继续。</p>
        <Button type="submit" size="lg" isPending={completion.isPending} isDisabled={!valid} className="mt-2 w-full rounded-sm bg-brand-ink text-brand-porcelain tracking-[0.15em] hover:bg-brand-ink-mid">
          {completion.isPending ? '正在建立业务底座' : '完成初始化'}
        </Button>
      </form>
    </ConvexAuthFrame>
  )
}

export function ConvexSetupPage() {
  const navigate = useNavigate()
  const auth = useConvexAuth()
  const status = useQuery(convexQuery(api.setup.status.get, {}))

  useEffect(() => {
    if (status.data?.initialized) navigate({ to: auth.isAuthenticated ? '/' : '/login', replace: true })
  }, [auth.isAuthenticated, navigate, status.data])

  if (status.isPending || auth.isLoading) {
    return <ConvexAuthFrame title="初始化向导" description="正在确认部署状态"><div className="mt-10 flex h-40 items-center justify-center"><Spinner size="lg" /></div></ConvexAuthFrame>
  }
  if (status.isError) {
    return <SetupError message={mapConvexError(status.error, '无法连接初始化服务').message} retry={() => status.refetch()} />
  }
  if (status.data.initialized) return null
  if (!status.data.hasUsers) return <FirstAdminForm />
  if (!auth.isAuthenticated) {
    return (
      <ConvexAuthFrame title="初始化向导" description="管理员已创建，请登录后继续">
        <div className="mt-10 flex flex-col gap-4"><p className="text-sm leading-6 text-ink-500">业务底座尚未完成。仅首位超级管理员可继续，不会覆盖已有账号。</p><Button onPress={() => navigate({ to: '/login' })}>前往登录</Button></div>
      </ConvexAuthFrame>
    )
  }
  return <BusinessSetupForm />
}
