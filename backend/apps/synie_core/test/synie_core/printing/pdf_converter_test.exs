defmodule SynieCore.Printing.PdfConverterTest do
  use ExUnit.Case, async: false

  alias SynieCore.Printing.PdfConverter
  alias SynieCore.PrintingFixture

  setup do
    prev_path = Application.get_env(:synie_core, :soffice_path)
    prev_timeout = Application.get_env(:synie_core, :soffice_timeout_ms)

    on_exit(fn ->
      restore(:soffice_path, prev_path)
      restore(:soffice_timeout_ms, prev_timeout)
    end)

    :ok
  end

  defp restore(key, nil), do: Application.delete_env(:synie_core, key)
  defp restore(key, val), do: Application.put_env(:synie_core, key, val)

  test "路径不存在时返回 :soffice_not_found" do
    Application.put_env(:synie_core, :soffice_path, "/nonexistent/soffice-#{System.unique_integer()}")

    xlsx = PrintingFixture.build(rows: [["x"]])
    assert {:error, :soffice_not_found} = PdfConverter.convert_xlsx_to_pdf(xlsx)
  end

  test "假可执行成功写出 PDF 时返回 binary" do
    script = write_fake_soffice(:success)
    Application.put_env(:synie_core, :soffice_path, script)

    xlsx = PrintingFixture.build(rows: [["hello"]])
    assert {:ok, pdf} = PdfConverter.convert_xlsx_to_pdf(xlsx)
    assert String.starts_with?(pdf, "%PDF")
  end

  test "假可执行非零退出时返回 convert_failed" do
    script = write_fake_soffice(:fail)
    Application.put_env(:synie_core, :soffice_path, script)

    xlsx = PrintingFixture.build(rows: [["x"]])
    assert {:error, reason} = PdfConverter.convert_xlsx_to_pdf(xlsx)
    assert reason == :convert_failed or match?({:convert_failed, _}, reason)
  end

  test "超时返回 :timeout" do
    script = write_fake_soffice(:hang)
    Application.put_env(:synie_core, :soffice_path, script)
    Application.put_env(:synie_core, :soffice_timeout_ms, 200)

    xlsx = PrintingFixture.build(rows: [["x"]])
    assert {:error, :timeout} = PdfConverter.convert_xlsx_to_pdf(xlsx)
  end

  # 本机若安装了真实 soffice，可选验证整链（默认不强制）
  @tag :libreoffice
  test "真实 soffice 可将最小 xlsx 转为 PDF" do
    Application.delete_env(:synie_core, :soffice_path)

    if System.find_executable("soffice") || System.find_executable("libreoffice") do
      path = System.find_executable("soffice") || System.find_executable("libreoffice")
      Application.put_env(:synie_core, :soffice_path, path)

      xlsx = PrintingFixture.build(rows: [["真实转换"]])
      assert {:ok, pdf} = PdfConverter.convert_xlsx_to_pdf(xlsx)
      assert String.starts_with?(pdf, "%PDF")
    else
      flunk("本机无 soffice/libreoffice，跳过意义下的失败——请装 LO 或 exclude 本 tag")
    end
  end

  defp write_fake_soffice(mode) do
    dir = Path.join(System.tmp_dir!(), "synie-fake-soffice-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    path = Path.join(dir, "soffice")

    body =
      case mode do
        :success ->
          """
          #!/bin/sh
          # 解析 --outdir
          outdir=""
          while [ $# -gt 0 ]; do
            if [ "$1" = "--outdir" ]; then
              outdir="$2"
              shift 2
              continue
            fi
            shift
          done
          printf '%%PDF-1.4 fake\\n' > "$outdir/doc.pdf"
          exit 0
          """

        :fail ->
          """
          #!/bin/sh
          echo "boom" >&2
          exit 1
          """

        :hang ->
          """
          #!/bin/sh
          sleep 30
          exit 0
          """
      end

    File.write!(path, body)
    File.chmod!(path, 0o755)
    path
  end
end
