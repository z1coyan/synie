defmodule SynieCore.Printing.PdfConverter do
  @moduledoc """
  LibreOffice headless 哑转换：xlsx binary → PDF binary。

  不填充模板、不改 page setup。并发转换使用独立 UserInstallation profile，
  避免 soffice 单实例锁。配置：

    * `:synie_core, :soffice_path` 或环境变量 `SOFFICE_PATH`（默认 `"soffice"`）
    * `:synie_core, :soffice_timeout_ms`（默认 120_000）

  转换命令经系统 `timeout(1)` 包裹（默认 TERM 信号 + `-k 5` 秒后 KILL 升级）：
  超时对进程组发信号，能覆盖 soffice 派生的子进程，避免 BEAM 侧
  `Task.shutdown` 只杀 Task 本身、外部 soffice 进程沦为孤儿。**若本机找不到
  `timeout` 可执行文件，则直接跑 soffice，此时超时仅由 BEAM 侧兜底，不保证
  杀死 soffice 进程**；另外，本机 uutils coreutils 的 `-s KILL` 路径已知静默
  失效（信号显示已发但进程照常运行），故不使用 `-s KILL`，改用默认 TERM +
  `-k` 升级（生产镜像 Debian GNU coreutils 下 KILL 升级路径同样有效）。

  见 docs/adr/2026-07-23-print-template.md。
  """

  alias SynieCore.Printing.ConverterLimiter

  @default_timeout_ms 120_000

  @type error_reason ::
          :soffice_not_found
          | :timeout
          | :convert_failed
          | :no_output
          | {:convert_failed, String.t()}

  @doc "将 xlsx 二进制转为 PDF 二进制。"
  @spec convert_xlsx_to_pdf(binary()) :: {:ok, binary()} | {:error, error_reason()}
  def convert_xlsx_to_pdf(xlsx) when is_binary(xlsx) do
    soffice = soffice_path()
    timeout = timeout_ms()

    if soffice_available?(soffice) do
      with_limiter(fn -> do_convert(xlsx, soffice, timeout) end)
    else
      {:error, :soffice_not_found}
    end
  end

  # 全局并发限流：转换前取令牌，转换后（无论成败）归还。限流器进程不存在时
  # （如某些单测环境未起监督树）直接放行，保持本模块可脱离 app 单测的既有性质。
  defp with_limiter(fun) do
    if Process.whereis(ConverterLimiter) do
      ConverterLimiter.acquire()

      try do
        fun.()
      after
        ConverterLimiter.release()
      end
    else
      fun.()
    end
  end

  defp do_convert(xlsx, soffice, timeout) do
    tmp_root = Path.join(System.tmp_dir!(), "synie-print-" <> random_id())
    in_dir = Path.join(tmp_root, "in")
    out_dir = Path.join(tmp_root, "out")
    profile_dir = Path.join(tmp_root, "profile")
    in_path = Path.join(in_dir, "doc.xlsx")

    try do
      File.mkdir_p!(in_dir)
      File.mkdir_p!(out_dir)
      File.mkdir_p!(profile_dir)
      File.write!(in_path, xlsx)

      # file:// URL for UserInstallation（绝对路径）
      profile_url = "file://" <> profile_dir

      args = [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "-env:UserInstallation=#{profile_url}",
        "--convert-to",
        "pdf",
        "--outdir",
        out_dir,
        in_path
      ]

      {cmd, cmd_args, wrapped?} = build_command(soffice, args, timeout)

      # timeout(1) 自身也可能异常退出，BEAM 侧兜底放宽一段余量，避免抢在它前面误判
      yield_timeout = if wrapped?, do: timeout + 10_000, else: timeout

      task =
        Task.async(fn ->
          System.cmd(cmd, cmd_args, stderr_to_stdout: true)
        end)

      case Task.yield(task, yield_timeout) || Task.shutdown(task, :brutal_kill) do
        {:ok, {output, code}} ->
          handle_exit(code, output, wrapped?, out_dir)

        nil ->
          {:error, :timeout}
      end
    after
      File.rm_rf(tmp_root)
    end
  end

  # 找得到 timeout(1) 就用它包裹：默认 TERM 信号 + `-k 5` 秒后 KILL 升级，
  # 对进程组发信号，能捎上 soffice 的子进程；找不到则原样跑 soffice，
  # 维持原有行为（仅 BEAM 侧兜底）。不传 `-s KILL`——本机 uutils 该路径静默失效。
  defp build_command(soffice, args, timeout) do
    case System.find_executable("timeout") do
      nil ->
        {soffice, args, false}

      timeout_bin ->
        secs = max(1, div(timeout + 999, 1000))
        {timeout_bin, ["-k", "5", to_string(secs), soffice | args], true}
    end
  end

  defp handle_exit(0, _output, _wrapped?, out_dir), do: read_pdf_output(out_dir)

  # 经 timeout 包裹时的超时退出码：124（超时 TERM）、137（KILL 升级）、
  # 125（timeout 自身异常路径，本机 uutils 已观测到，功能上进程仍被杀）。
  defp handle_exit(code, _output, true, _out_dir) when code in [124, 137, 125] do
    {:error, :timeout}
  end

  defp handle_exit(code, output, _wrapped?, _out_dir) do
    msg = String.trim(to_string(output))

    if msg == "",
      do: {:error, :convert_failed},
      else: {:error, {:convert_failed, "退出码 #{code}: #{String.slice(msg, 0, 200)}"}}
  end

  defp read_pdf_output(out_dir) do
    case Path.wildcard(Path.join(out_dir, "*.pdf")) do
      [pdf | _] ->
        data = File.read!(pdf)

        if String.starts_with?(data, "%PDF") do
          {:ok, data}
        else
          {:error, :no_output}
        end

      [] ->
        {:error, :no_output}
    end
  end

  defp soffice_available?(path) do
    cond do
      path == "" ->
        false

      String.contains?(path, "/") or String.contains?(path, "\\") ->
        File.regular?(path) and File.exists?(path)

      true ->
        # PATH 上查找
        case System.find_executable(path) do
          nil -> false
          _ -> true
        end
    end
  end

  defp soffice_path do
    Application.get_env(:synie_core, :soffice_path) ||
      System.get_env("SOFFICE_PATH") ||
      "soffice"
  end

  defp timeout_ms do
    Application.get_env(:synie_core, :soffice_timeout_ms, @default_timeout_ms)
  end

  defp random_id do
    :crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)
  end
end
