# Plan 006: PdfConverter 超时杀进程 + 全局并发上限

> **执行者须知**:逐步执行,每步跑完验证命令确认预期结果再进下一步。只改 In scope 文件。命中 STOP 条件立即停手上报。按 Git workflow 提交。跳过「更新 plans/README.md」。上报前对照工具输出核对声明。
>
> **漂移检查(先跑)**:`git diff --stat 67a4f3f..HEAD -- backend/apps/synie_core/lib/synie_core/printing/pdf_converter.ex backend/apps/synie_core/lib/synie_core/application.ex`
> 若有变更,对照「现状」;不一致即 STOP。

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: 无
- **Category**: bug / perf
- **Planned at**: commit `67a4f3f`, 2026-07-23

## Why this matters

两个进程治理漏洞会在生产上把打印功能变成自伤武器:

1. **超时不杀 soffice**:`Task.yield(task, timeout) || Task.shutdown(task, :brutal_kill)` 只杀 BEAM 侧 Task 进程;`System.cmd` 的 port 关闭并不会终止外部 OS 进程,soffice(重型进程,数百 MB)会**继续跑成孤儿**。一份让 LibreOffice 挂死的坏 xlsx,每次重试都漏一个僵尸 soffice,直到内存耗尽。且 `after File.rm_rf(tmp_root)` 在 soffice 尚存活时删它的工作目录,行为未定义。
2. **无并发上限**:每次转换起一个独立 soffice。10 个用户同时点打印 = 10 个 soffice 并发,容器内存直接见顶。ADR 定了单请求 100 条上限,但没有全局并发闸门。

修复后:转换命令经 `timeout(1)` 包裹(超时对**进程组**发 KILL,覆盖 soffice 的子进程),BEAM 侧超时仅作兜底;全局并发经一个 OTP 限流器(默认 2,可配)排队,过载排队而不是压垮容器。

## 现状

- `backend/apps/synie_core/lib/synie_core/printing/pdf_converter.ex` — LO 哑转换 seam。关键段(36–83 行):

  ```elixir
  defp do_convert(xlsx, soffice, timeout) do
    tmp_root = Path.join(System.tmp_dir!(), "synie-print-" <> random_id())
    ...
      task =
        Task.async(fn ->
          System.cmd(soffice, args, stderr_to_stdout: true)
        end)

      case Task.yield(task, timeout) || Task.shutdown(task, :brutal_kill) do
        {:ok, {_output, 0}} -> read_pdf_output(out_dir)
        {:ok, {output, code}} -> ...{:error, {:convert_failed, ...}}
        nil -> {:error, :timeout}
      end
    after
      File.rm_rf(tmp_root)
    end
  ```

  配置读取:`soffice_path/0`(`:synie_core, :soffice_path` → env `SOFFICE_PATH` → `"soffice"`)、`timeout_ms/0`(`:synie_core, :soffice_timeout_ms`,默认 120_000)。错误类型:`:soffice_not_found | :timeout | :convert_failed | :no_output | {:convert_failed, msg}`——**公共错误契约,勿改**(`printing.ex` 的 `convert_pdf/1` 按这些原子映射中文文案)。
- `backend/apps/synie_core/lib/synie_core/application.ex` — 监督树:

  ```elixir
  children =
    [SynieCore.Repo] ++
      if Application.get_env(:synie_core, :market_fetch_scheduler, true) do
        [SynieCore.Base.MarketFetch.Scheduler]
      else
        []
      end
  ```

- 环境事实:开发机 Linux,`/usr/bin/timeout` 存在(uutils coreutils 0.2.2,支持 `-s`/`-k`);生产镜像 `backend/Dockerfile` 基于 Debian(装 `libreoffice-calc-nogui`),coreutils `timeout` 自带。GNU/uutils `timeout` 默认把子命令放入独立进程组,超时对组发信号,能捎上 soffice 的 oosplash/soffice.bin 子进程。
- 测试:`backend/apps/synie_core/test/synie_core/printing/pdf_converter_test.exs` 已有「假可执行脚本」模式(写临时 shell 脚本模拟 soffice 成功/失败/超时),`:libreoffice` tag 的真机用例默认排除。**注意**:现有超时用例只断言返回 `:timeout`,不断言进程被杀。

## 需要的命令

| 用途 | 命令 | 预期 |
|------|------|------|
| 环境 | `export PATH="$HOME/.elixir-install/installs/otp/28.4/bin:$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$PATH"` | mix 可用 |
| 转换测试 | `cd backend/apps/synie_core && mix test test/synie_core/printing/pdf_converter_test.exs` | 全绿 |
| 打印全套 | `cd backend/apps/synie_core && mix test test/synie_core/printing/` | 全绿 |
| 格式 | `cd backend && mix format --check-formatted` | exit 0 |

## Scope

**In scope**:
- `backend/apps/synie_core/lib/synie_core/printing/pdf_converter.ex`
- 新文件 `backend/apps/synie_core/lib/synie_core/printing/converter_limiter.ex`
- `backend/apps/synie_core/lib/synie_core/application.ex`(挂限流器)
- `backend/apps/synie_core/test/synie_core/printing/pdf_converter_test.exs`
- `backend/Dockerfile`(仅允许加一行注释说明依赖 coreutils timeout;Debian 自带,无需装包)

**Out of scope**:
- 引入新 Hex 依赖(muontrap/erlexec 等)——不加。
- `printing.ex` 错误映射与公共错误契约。
- 异步队列/后台批量(ADR 明确 v1 不做)。

## Git workflow

- 当前分支,单提交:`fix: PDF 转换超时杀进程组并加全局并发上限`。

## Steps

### Step 1: timeout(1) 包裹转换命令(2026-07-24 修订:默认 TERM + `-k 5` 升级)

> **修订背景**:首轮执行发现本机 `timeout (uutils coreutils) 0.2.2` 的 `-s KILL` 路径静默失效(`timeout -v -s KILL -k 5 1 sleep 5` 打印 "sending signal KILL" 但进程照常跑满,exit 125)。默认 TERM 路径实测正常(`timeout 1 sleep 10` 1.01s 终止,exit 124)。soffice 对 TERM 正常响应退出;真·挂死忽略 TERM 的场景由 `-k 5` 的 KILL 升级兜底——该升级在生产镜像(Debian,GNU coreutils)有效,在开发机 uutils 上可能同样失效,属已知残留风险,写入 moduledoc 与本计划维护注记,不阻塞。

`do_convert/3` 改为:若 `System.find_executable("timeout")` 存在,实际执行 `System.cmd(timeout_bin, ["-k", "5", "#{超时秒}", soffice | args], ...)`(**默认 TERM 信号,不传 `-s KILL`**;超时秒 = `div(timeout, 1000)` 向上取整,至少 1);BEAM 侧 `Task.yield` 兜底超时放宽到 `timeout + 10_000`(防 timeout(1) 自身异常)。退出码映射:经 timeout 包裹时,`124`(超时 TERM)、`137`(KILL 升级)、`125`(timeout 自身异常路径,uutils 已观测到)→ `{:error, :timeout}`;其余非零仍走 `{:convert_failed, ...}`。找不到 `timeout` 可执行文件时维持现行为(直接跑 soffice,BEAM 兜底超时),moduledoc 注明「无 timeout(1) 时超时不能保证杀死 soffice;uutils timeout 的 KILL 升级路径存在已知缺陷」。

**验证**:先冒烟 `timeout -k 5 1 sleep 10; echo $?` → 预期 124 **且命令在约 1 秒返回**(用 `time` 观测,不能等满 10 秒);再 `cd backend/apps/synie_core && mix test test/synie_core/printing/pdf_converter_test.exs` → 既有非 tag 用例全绿,且「超时返回 :timeout」用例耗时应降到 ~1.5s 内(`--trace` 观测,首轮执行时为 10.2s 即为未真杀的信号)。

### Step 2: 超时确实杀进程的回归测试

新用例「超时后假进程被杀死」:假可执行脚本启动时 `echo $$ > pid文件` 然后 `sleep 60`;脚本**不得 trap TERM**(默认信号处置)。调 `convert_xlsx_to_pdf`(配置超时 1000ms 左右,配合 timeout 秒数向上取整至少 1 的语义)→ 断言返回 `{:error, :timeout}`;随后轮询(至多 ~3s)`System.cmd("kill", ["-0", pid])` 非零退出(进程已不在)。断言「sh 已死」即可;若其子 `sleep` 因 uutils KILL 升级缺陷残留,不在断言范围(测试注释说明,生产 GNU coreutils 不受此限)。

**验证**:`mix test test/synie_core/printing/pdf_converter_test.exs` → 全绿含新用例。

### Step 3: 并发限流器

新文件 `converter_limiter.ex`:`SynieCore.Printing.ConverterLimiter`,GenServer 令牌桶:

- `start_link/1`(`name: __MODULE__`);state:`%{max: N, in_use: 0, waiting: :queue}`;`max` 读 `Application.get_env(:synie_core, :soffice_max_concurrency, 2)`。
- `acquire/0`:`GenServer.call(__MODULE__, :acquire, :infinity)`;有余量立即放行并 `Process.monitor` 调用方,满了入队(保存 `{from, monitor_ref}`)。
- `release/0`:归还令牌,唤醒队首。
- `handle_info({:DOWN, ...})`:持有者/等待者崩溃自动回收令牌或出队(防泄漏)。
- 中文 moduledoc:为什么限(soffice 重型)、默认 2、配置键。
- `pdf_converter.ex` 的 `convert_xlsx_to_pdf/1`:`soffice_available?` 之后、`do_convert` 之前 `ConverterLimiter.acquire()`,`after` 里 `release()`(包住 do_convert 整体,`try/after`)。若限流器进程不存在(如某些单元测试环境未起 app),`acquire` 会 exit——用 `Process.whereis(ConverterLimiter)` 判空则直接放行,保持模块可脱离监督树单测的既有性质。
- `application.ex` children 里 `SynieCore.Repo` 之后加 `SynieCore.Printing.ConverterLimiter`。

**验证**:`cd backend/apps/synie_core && mix test test/synie_core/printing/` → 全绿。

### Step 4: 限流回归测试

新用例「并发受限流器约束」:启动一个独立限流器(`start_supervised!({ConverterLimiter, max: 1})`——为可测,`start_link` 接受 `max:` 覆盖配置;转换器取进程用注册名,测试里直接测限流器本身即可,不必穿透 converter):两个 Task 各 `acquire → sleep 150ms → release`,断言总耗时 ≥ 250ms(串行证据);另一用例:持有者被 kill 后第二个等待者能获得令牌(DOWN 回收)。

**验证**:`mix test test/synie_core/printing/pdf_converter_test.exs`(或新 `converter_limiter_test.exs`,任选,放 printing 目录)→ 全绿。

## Test plan

见 Step 2/4;假可执行样板照同文件既有用例。计时断言留裕量(≥250ms 而非 ==300ms),避免 flaky。

## Done criteria

- [ ] `cd backend/apps/synie_core && mix test test/synie_core/printing/` 全绿,新用例在
- [ ] `cd backend && mix format --check-formatted` exit 0
- [ ] `git status` 无 in-scope 外改动
- [ ] `grep -n "ConverterLimiter" backend/apps/synie_core/lib/synie_core/application.ex` 恰一处
- [ ] 公共错误契约未变:`grep -n "error_reason" backend/apps/synie_core/lib/synie_core/printing/pdf_converter.ex` 的类型定义与基线一致

## STOP conditions

- 「现状」摘录与实际代码不符。
- 冒烟 `time timeout -k 5 1 sleep 10` 未在 ~2 秒内返回或退出码非 124——默认 TERM 路径也失效,停下上报(2026-07-24 已实测本机 TERM 路径正常,此条防环境再变)。
- Step 2 的杀进程断言在两次修复尝试后仍 flaky——停下上报(可能是 uutils 行为差异,需要人工定夺)。
- 需要新增 Hex 依赖才能完成——超界,停。

## Maintenance notes

- **uutils timeout 已知缺陷(2026-07-24 实测)**:`-s KILL` 与 KILL 升级路径静默失效(信号显示已发、进程照常运行)。开发机上「soffice 忽略 TERM 的真·挂死」仍可能残留进程;生产镜像(Debian,GNU coreutils)不受此限。若升级开发机 coreutils,可跑 `timeout -v -s KILL -k 5 1 sleep 5` 复核(GNU 应 ~1s 返回 137)。
- 生产镜像:Debian 自带 coreutils timeout;若未来换 Alpine 基础镜像,busybox timeout 语义不同(无 `-k`),`SOFFICE_PATH` 一带的部署文档要跟着验。
- `soffice_max_concurrency` 默认 2 是保守值:LO 单实例转换本身较快,排队优于挤爆内存;运维可按容器内存调。
- 评审重点:limiter 的 DOWN 处理(持有者崩溃不漏令牌);converter 在无 limiter 进程时的直通分支不要吞掉正常路径。
