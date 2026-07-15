defmodule SynieCore.FilesTest do
  use ExUnit.Case, async: true

  import SynieCore.AuthzFixtures

  alias SynieCore.Acc.GlJournal
  alias SynieCore.Authz
  alias SynieCore.Files
  alias SynieCore.Files.Attachment
  alias SynieCore.Files.File, as: StoredFile
  alias SynieCore.Files.StorageEndpoint
  alias SynieCore.Sales.Customer
  alias SynieCore.Storage

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(SynieCore.Repo)

    base = Path.join(System.tmp_dir!(), "synie_files_test_#{System.unique_integer([:positive])}")
    root = Path.join(base, "objects")
    File.mkdir_p!(root)

    src = Path.join(base, "合同.pdf")
    File.write!(src, "PDF 内容")

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

    %{root: root, src: src}
  end

  defp actor_with!(permissions, companies \\ []) do
    user = user!()
    role = role!()
    Enum.each(permissions, &grant!(role, &1))
    assign!(user, role)
    Enum.each(companies, &grant_company!(user, &1))
    Authz.build_actor(user)
  end

  defp customer! do
    Customer
    |> Ash.Changeset.for_create(:create, %{
      code: "C#{System.unique_integer([:positive])}",
      name: "测试客户"
    })
    |> Ash.create!(authorize?: false)
  end

  # 公司作用域宿主样板:凭证头(company_id 由 belongs_to 去规范化到附件)
  defp gl_journal!(company) do
    GlJournal
    |> Ash.Changeset.for_create(:create, %{
      company_id: company.id,
      voucher_no: "V#{System.unique_integer([:positive])}",
      date: Date.utc_today()
    })
    |> Ash.create!(authorize?: false)
  end

  defp upload_params(src, extra \\ %{}) do
    Map.merge(
      %{path: src, filename: "合同.pdf", content_type: "application/pdf"},
      extra
    )
  end

  # root 下所有真实对象文件(排除空日期目录)
  defp object_files(root) do
    root
    |> Path.join("**/*")
    |> Path.wildcard()
    |> Enum.reject(&File.dir?/1)
  end

  describe "Files.upload/2" do
    test "有 sys.file:create:落库 + 落盘,元数据完整", %{src: src} do
      actor = actor_with!(["sys.file:create"])

      assert {:ok, %{file: file, attachment: nil}} = Files.upload(actor, upload_params(src))

      assert file.storage == "test_local"
      assert file.filename == "合同.pdf"
      assert file.content_type == "application/pdf"
      assert file.size == byte_size("PDF 内容")
      assert file.sha256 == :sha256 |> :crypto.hash("PDF 内容") |> Base.encode16(case: :lower)
      assert file.uploaded_by_id == actor.user_id
      # key 由服务端生成:日期目录 + uuid + 净化后的扩展名,不含原始文件名
      assert file.key =~ ~r|^\d{4}/\d{2}/\d{2}/[0-9a-f-]{36}\.pdf$|
      assert {:ok, "PDF 内容"} = Storage.read(file.storage, file.key)
    end

    test "无权限:拒绝且不留下物理对象", %{src: src, root: root} do
      actor = actor_with!(["sys.file:read"])

      assert {:error, :forbidden} = Files.upload(actor, upload_params(src))
      assert {:ok, []} = File.ls(root)
    end

    test "带 owner 参数:同时创建附件关联", %{src: src} do
      # maybe_attach 现会用 actor 读宿主:需真实客户 + sales.customer:read
      actor = actor_with!(["sys.file:create", "sales.customer:read"])
      customer = customer!()

      assert {:ok, %{file: file, attachment: att}} =
               Files.upload(
                 actor,
                 upload_params(src, %{
                   owner_type: "sal_customer",
                   owner_id: customer.id,
                   category: "contract"
                 })
               )

      assert att.file_id == file.id
      assert att.owner_type == "sal_customer"
      assert att.category == "contract"
      # 全局宿主(客户无 company_id)→ 附件 company_id 为空
      assert att.company_id == nil
    end

    test "category 缺省为 default", %{src: src} do
      actor = actor_with!(["sys.file:create", "sales.customer:read"])
      customer = customer!()

      assert {:ok, %{attachment: att}} =
               Files.upload(
                 actor,
                 upload_params(src, %{owner_type: "sal_customer", owner_id: customer.id})
               )

      assert att.category == "default"
    end

    test "未知 owner_type:被拒且事务回滚(无文件/附件残留)", %{src: src, root: root} do
      actor = actor_with!(["sys.file:create"])

      assert {:error, :unknown_owner_type} =
               Files.upload(
                 actor,
                 upload_params(src, %{owner_type: "not_a_resource", owner_id: Ash.UUID.generate()})
               )

      assert Ash.read!(StoredFile, authorize?: false) == []
      assert Ash.read!(Attachment, authorize?: false) == []
      # 物理对象已清理(delete 只删对象文件,空日期目录残留无妨)
      assert object_files(root) == []
    end

    test "宿主 actor 看不见:被拒 :forbidden_owner 且事务回滚", %{src: src, root: root} do
      co_a = company!()
      co_b = company!()
      host_b = gl_journal!(co_b)

      # actor 只有 A 公司,读不到 B 公司的凭证宿主
      actor = actor_with!(["sys.file:create", "acc.gl_journal:read"], [co_a])

      assert {:error, :forbidden_owner} =
               Files.upload(
                 actor,
                 upload_params(src, %{owner_type: "acc_gl_journal", owner_id: host_b.id})
               )

      # 连文件行一起回滚,物理对象也清理
      assert Ash.read!(StoredFile, authorize?: false) == []
      assert Ash.read!(Attachment, authorize?: false) == []
      assert object_files(root) == []
    end

    test "挂接公司宿主:附件 company_id 去规范化自宿主", %{src: src} do
      company = company!()
      host = gl_journal!(company)
      actor = actor_with!(["sys.file:create", "acc.gl_journal:read"], [company])

      assert {:ok, %{attachment: att}} =
               Files.upload(
                 actor,
                 upload_params(src, %{owner_type: "acc_gl_journal", owner_id: host.id})
               )

      assert att.company_id == company.id
    end
  end

  describe "附件查询与删除" do
    setup %{src: src} do
      actor =
        actor_with!([
          "sys.file:create",
          "sys.file:read",
          "sys.file:delete",
          "sales.customer:read"
        ])

      customer = customer!()
      owner_id = customer.id

      {:ok, %{file: file, attachment: att}} =
        Files.upload(actor, upload_params(src, %{owner_type: "sal_customer", owner_id: owner_id}))

      # :file 是 ExUnit context 保留字段,换名
      %{actor: actor, owner_id: owner_id, stored: file, att: att}
    end

    test "按 owner 过滤可查到附件(带 file 元数据)", %{actor: actor, owner_id: owner_id, att: att} do
      results =
        Attachment
        |> Ash.Query.filter_input(%{owner_type: "sal_customer", owner_id: owner_id})
        |> Ash.Query.load(:file)
        |> Ash.read!(actor: actor)

      assert [%{id: id, file: %{filename: "合同.pdf"}}] = results
      assert id == att.id
    end

    test "无 sys.file:read 查询被拒", %{owner_id: owner_id} do
      nobody = actor_with!([])

      assert {:error, %Ash.Error.Forbidden{}} =
               Attachment
               |> Ash.Query.filter_input(%{owner_type: "sal_customer", owner_id: owner_id})
               |> Ash.read(actor: nobody)
    end

    test "文件仍被附件引用时拒删并报中文错", %{actor: actor, stored: file} do
      assert {:error, err} = Ash.destroy(file, actor: actor)
      assert Exception.message(err) =~ "仍有业务挂接"
    end

    test "先删附件再删文件,物理对象同步清理", %{actor: actor, stored: file, att: att} do
      :ok = Ash.destroy!(att, actor: actor)
      :ok = Ash.destroy!(file, actor: actor)

      assert {:error, :not_found} = Storage.read(file.storage, file.key)
    end
  end

  describe "附件读公司隔离(照 sys_audit_log)" do
    test "A actor 列不到 B 公司凭证的附件;A 公司的看得到", %{src: src} do
      co_a = company!()
      co_b = company!()
      host_a = gl_journal!(co_a)
      host_b = gl_journal!(co_b)

      actor_a = actor_with!(["sys.file:create", "sys.file:read", "acc.gl_journal:read"], [co_a])
      actor_b = actor_with!(["sys.file:create", "sys.file:read", "acc.gl_journal:read"], [co_b])

      {:ok, %{attachment: att_a}} =
        Files.upload(
          actor_a,
          upload_params(src, %{owner_type: "acc_gl_journal", owner_id: host_a.id})
        )

      {:ok, %{attachment: att_b}} =
        Files.upload(
          actor_b,
          upload_params(src, %{owner_type: "acc_gl_journal", owner_id: host_b.id})
        )

      visible_to_a = Attachment |> Ash.read!(actor: actor_a) |> Enum.map(& &1.id)

      assert att_a.id in visible_to_a
      refute att_b.id in visible_to_a
    end

    test "全局宿主(客户)附件对任意持权者可见(company_id 为空)", %{src: src} do
      customer = customer!()
      uploader = actor_with!(["sys.file:create", "sales.customer:read"])

      {:ok, %{attachment: att}} =
        Files.upload(
          uploader,
          upload_params(src, %{owner_type: "sal_customer", owner_id: customer.id})
        )

      # 另一个只有 sys.file:read、无任何公司授权的 actor 也能读到该附件
      reader = actor_with!(["sys.file:read"])
      visible = Attachment |> Ash.read!(actor: reader) |> Enum.map(& &1.id)

      assert att.id in visible
    end
  end

  describe "attach/2(给已有文件补挂附件)" do
    test "裸文件可补挂到可见宿主,company_id 从宿主去规范化", %{src: src} do
      actor = actor_with!(["sys.file:create", "sys.file:read", "sales.customer:read"])
      customer = customer!()

      {:ok, %{file: file, attachment: nil}} =
        Files.upload(actor, %{path: src, filename: "合同.pdf", content_type: "application/pdf"})

      assert {:ok, %Attachment{} = attachment} =
               Files.attach(actor, %{
                 file_id: file.id,
                 owner_type: "sal_customer",
                 owner_id: customer.id,
                 category: "original"
               })

      assert attachment.file_id == file.id
      assert attachment.owner_type == "sal_customer"
      assert attachment.category == "original"
    end

    test "宿主不可见 → forbidden_owner;未知宿主 → unknown_owner_type", %{src: src} do
      actor = actor_with!(["sys.file:create", "sys.file:read"])
      customer = customer!()

      {:ok, %{file: file}} =
        Files.upload(actor, %{path: src, filename: "a.pdf", content_type: "application/pdf"})

      # 无 sales.customer:read → 看不见宿主
      assert {:error, :forbidden_owner} =
               Files.attach(actor, %{
                 file_id: file.id,
                 owner_type: "sal_customer",
                 owner_id: customer.id
               })

      assert {:error, :unknown_owner_type} =
               Files.attach(actor, %{
                 file_id: file.id,
                 owner_type: "not_exist",
                 owner_id: customer.id
               })
    end

    test "缺 owner 参数 → missing_owner;文件不可见 → file_not_found", %{src: src} do
      actor = actor_with!(["sys.file:create", "sys.file:read"])

      {:ok, %{file: file}} =
        Files.upload(actor, %{path: src, filename: "b.pdf", content_type: "application/pdf"})

      assert {:error, :missing_owner} = Files.attach(actor, %{file_id: file.id})

      no_read = actor_with!([])
      assert {:error, :file_not_found} = Files.attach(no_read, %{file_id: file.id})
    end
  end

  test "权限目录含 sys.file 组" do
    assert %{prefix: "sys.file", actions: ~w(create read delete)} in SynieCore.Authz.Registry.catalog()
  end
end
