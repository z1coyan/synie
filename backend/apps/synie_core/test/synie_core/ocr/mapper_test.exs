defmodule SynieCore.Ocr.MapperTest do
  use ExUnit.Case, async: true

  alias SynieCore.Ocr.AcceptanceMapper
  alias SynieCore.Ocr.InvoiceMapper

  @invoice_data %{
    "data" => %{
      "invoiceCode" => "3300214130",
      "invoiceNumber" => "12345678",
      "invoiceDate" => "2026年07月01日",
      "invoiceType" => "数电票(增值税专用发票)",
      "sellerName" => "杭州测试科技有限公司",
      "sellerTaxNumber" => "91330100MA27XXXXXX",
      "sellerContactInfo" => "杭州市西湖区 0571-88888888",
      "sellerBankAccountInfo" => "工行西湖支行 1202020409000000000",
      "purchaserName" => "宁波示例贸易有限公司",
      "purchaserTaxNumber" => "91330200MA28XXXXXX",
      "purchaserContactInfo" => "宁波市鄞州区 0574-66666666",
      "purchaserBankAccountInfo" => "建行鄞州支行 33101983600051000000",
      "invoiceAmountPreTax" => "¥1,000.00",
      "invoiceTax" => "¥130.00",
      "totalAmount" => "¥1,130.00",
      "drawer" => "张三",
      "reviewer" => "李四",
      "recipient" => "王五",
      "remarks" => "合同号 HT-001",
      "invoiceDetails" => [
        %{
          "itemName" => "*信息技术服务*软件开发",
          "specification" => "V1.0",
          "unit" => "项",
          "quantity" => "1",
          "unitPrice" => "1000",
          "amount" => "1,000.00",
          "taxRate" => "13%",
          "tax" => "130.00"
        }
      ]
    }
  }

  test "发票:全字段映射为抽屉 camelCase 键" do
    m = InvoiceMapper.map(@invoice_data)

    assert m["invoiceCode"] == "3300214130"
    assert m["invoiceNo"] == "12345678"
    assert m["invoiceDate"] == "2026-07-01"
    assert m["invoiceKind"] == "DIGITAL_SPECIAL"
    assert m["sellerName"] == "杭州测试科技有限公司"
    assert m["buyerName"] == "宁波示例贸易有限公司"
    assert m["buyerTaxNo"] == "91330200MA28XXXXXX"
    assert m["netTotal"] == "1000.00"
    assert m["taxTotal"] == "130.00"
    assert m["grossTotal"] == "1130.00"
    assert m["issuer"] == "张三"
    assert m["payee"] == "王五"

    assert [item] = m["items"]
    assert item["name"] == "*信息技术服务*软件开发"
    assert item["model"] == "V1.0"
    assert item["quantity"] == "1"
    assert item["price"] == "1000"
    assert item["net_amount"] == "1000.00"
    assert item["tax_rate"] == "13%"
    assert item["tax_amount"] == "130.00"
  end

  test "发票:识别不出的键整体省略;发票种类按关键词归类" do
    m = InvoiceMapper.map(%{"data" => %{"invoiceType" => "增值税电子普通发票"}})
    assert m["invoiceKind"] == "ELECTRONIC_NORMAL"
    refute Map.has_key?(m, "invoiceNo")
    refute Map.has_key?(m, "items")

    assert InvoiceMapper.map(%{"data" => %{"invoiceType" => "增值税专用发票"}})["invoiceKind"] ==
             "SPECIAL"

    assert InvoiceMapper.map(%{"data" => %{"invoiceType" => "增值税普通发票"}})["invoiceKind"] ==
             "NORMAL"
  end

  test "发票:兼容 Data 无 data 嵌套层的返回" do
    m = InvoiceMapper.map(%{"invoiceNumber" => "888"})
    assert m["invoiceNo"] == "888"
  end

  test "日期归一:横杠与紧凑格式" do
    assert InvoiceMapper.map(%{"data" => %{"invoiceDate" => "2026-07-01"}})["invoiceDate"] ==
             "2026-07-01"

    assert InvoiceMapper.map(%{"data" => %{"invoiceDate" => "20260701"}})["invoiceDate"] ==
             "2026-07-01"

    refute Map.has_key?(InvoiceMapper.map(%{"data" => %{"invoiceDate" => "识别失败"}}), "invoiceDate")
  end

  test "承兑:映射为票面草稿 snake_case 键" do
    m =
      AcceptanceMapper.map(%{
        "data" => %{
          "draftNumber" => "130331200093520210630123456789012",
          "issueDate" => "2026年06月30日",
          "validToDate" => "2026-12-30",
          "totalAmount" => "1,000,000.00",
          "acceptanceDate" => "2026-07-01",
          "assignability" => "可转让",
          "issuerName" => "出票公司",
          "issuerAccountNumber" => "111",
          "issuerAccountBank" => "工行A支行",
          "payeeName" => "收款公司",
          "payeeAccountNumber" => "222",
          "payeeAccountBank" => "建行B支行",
          "acceptorName" => "承兑银行",
          "acceptorAccountNumber" => "333",
          "acceptorAccountBank" => "工行营业部",
          "acceptorBankNumber" => "102331000000"
        }
      })

    assert m["bill_no"] == "130331200093520210630123456789012"
    assert m["bill_kind"] == "BANK_ACCEPTANCE"
    assert m["issue_date"] == "2026-06-30"
    assert m["due_date"] == "2026-12-30"
    assert m["face_amount"] == "1000000.00"
    assert m["acceptance_date"] == "2026-07-01"
    assert m["transferable"] == true
    assert m["drawer_name"] == "出票公司"
    assert m["drawer_account"] == "111"
    assert m["drawer_bank_name"] == "工行A支行"
    assert m["payee_name"] == "收款公司"
    assert m["acceptor_name"] == "承兑银行"
    assert m["acceptor_bank_no"] == "102331000000"
  end

  test "承兑:不可转让 → transferable false;缺失字段省略" do
    m = AcceptanceMapper.map(%{"data" => %{"assignability" => "不得转让"}})
    assert m["transferable"] == false
    refute Map.has_key?(m, "bill_no")
  end
end
