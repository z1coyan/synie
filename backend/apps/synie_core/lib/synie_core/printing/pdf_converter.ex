defmodule SynieCore.Printing.PdfConverter do
  @moduledoc """
  LibreOffice headless 哑转换：xlsx binary → PDF binary。

  不填充模板、不改 page setup。并发转换使用独立 UserInstallation profile，
  避免 soffice 单实例锁。配置：

    * `:synie_core, :soffice_path` 或环境变量 `SOFFICE_PATH`（默认 `"soffice"`）
    * `:synie_core, :soffice_timeout_ms`（默认 120_000）

  见 docs/adr/2026-07-23-print-template.md。
  """

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
      do_convert(xlsx, soffice, timeout)
    else
      {:error, :soffice_not_found}
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

      task =
        Task.async(fn ->
          System.cmd(soffice, args, stderr_to_stdout: true)
        end)

      case Task.yield(task, timeout) || Task.shutdown(task, :brutal_kill) do
        {:ok, {_output, 0}} ->
          read_pdf_output(out_dir)

        {:ok, {output, code}} ->
          msg = String.trim(to_string(output))
          if msg == "", do: {:error, :convert_failed}, else: {:error, {:convert_failed, "退出码 #{code}: #{String.slice(msg, 0, 200)}"}}

        nil ->
          {:error, :timeout}
      end
    after
      File.rm_rf(tmp_root)
    end
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
