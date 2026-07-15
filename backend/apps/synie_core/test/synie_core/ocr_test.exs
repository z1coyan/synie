defmodule SynieCore.OcrTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.Setting
  alias SynieCore.Acc.VatInvoice
  alias SynieCore.Authz
  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Ocr.AliyunClient

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_ocr_test_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "发票.png")
    File.write!(src, "fake png bytes")

    StorageEndpoint
    |> Ash.Changeset.for_create(:create, %{
      name: "test_local",
      label: "测试本地",
      kind: :local,
      root: root
    })
    |> Ash.Changeset.force_change_attribute(:is_default, true)
    |> Ash.create!(authorize?: false)

    on_exit(fn -> File.rm_rf!(base) end)

    %{src: src}
  end

  defp actor_with!(permissions) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Authz.build_actor(user)
  end

  defp configure_ocr! do
    Setting.get()
    |> Ash.Changeset.for_update(:update, %{ocr_access_key_id: "ak", ocr_access_key_secret: "sk"})
    |> Ash.update!(authorize?: false)
  end

  defp upload!(actor, src, content_type) do
    {:ok, %{file: file}} =
      SynieCore.Files.upload(actor, %{
        path: src,
        filename: Path.basename(src),
        content_type: content_type
      })

    file
  end

  defp stub_invoice_success do
    Req.Test.stub(AliyunClient, fn conn ->
      Req.Test.json(conn, %{
        "RequestId" => "r",
        "Data" =>
          Jason.encode!(%{
            "data" => %{"invoiceNumber" => "12345678", "totalAmount" => "¥1,130.00"}
          })
      })
    end)
  end

  test "未配置凭证 → 明确错误", %{src: src} do
    actor = actor_with!(["sys.file:create", "sys.file:read"])
    file = upload!(actor, src, "image/png")

    assert {:error, msg} = SynieCore.Ocr.recognize_invoice(actor, file.id)
    assert msg =~ "凭证"
  end

  test "发票识别 happy path:取文件字节 → 调阿里云 → 映射字段", %{src: src} do
    configure_ocr!()
    stub_invoice_success()
    actor = actor_with!(["sys.file:create", "sys.file:read"])
    file = upload!(actor, src, "image/png")

    assert {:ok, fields} = SynieCore.Ocr.recognize_invoice(actor, file.id)
    assert fields["invoiceNo"] == "12345678"
    assert fields["grossTotal"] == "1130.00"
  end

  test "只能识别本人上传的文件", %{src: src} do
    configure_ocr!()
    uploader = actor_with!(["sys.file:create", "sys.file:read"])
    other = actor_with!(["sys.file:create", "sys.file:read"])
    file = upload!(uploader, src, "image/png")

    assert {:error, msg} = SynieCore.Ocr.recognize_invoice(other, file.id)
    assert msg =~ "本人上传"
  end

  test "承兑不收 PDF、发票收 PDF", %{src: src} do
    configure_ocr!()
    stub_invoice_success()
    actor = actor_with!(["sys.file:create", "sys.file:read"])
    file = upload!(actor, src, "application/pdf")

    assert {:ok, _} = SynieCore.Ocr.recognize_invoice(actor, file.id)
    assert {:error, msg} = SynieCore.Ocr.recognize_bank_acceptance(actor, file.id)
    assert msg =~ "格式"
  end

  test "generic action :ocr 权限复用 create", %{src: src} do
    configure_ocr!()
    stub_invoice_success()

    can = actor_with!(["sys.file:create", "sys.file:read", "acc.vat_invoice:create"])
    file = upload!(can, src, "image/png")

    assert {:ok, %{"invoiceNo" => "12345678"}} =
             VatInvoice
             |> Ash.ActionInput.for_action(:ocr, %{file_id: file.id})
             |> Ash.run_action(actor: can)

    cannot = actor_with!(["sys.file:create", "sys.file:read"])
    file2 = upload!(cannot, src, "image/png")

    assert {:error, %Ash.Error.Forbidden{}} =
             VatInvoice
             |> Ash.ActionInput.for_action(:ocr, %{file_id: file2.id})
             |> Ash.run_action(actor: cannot)
  end
end
