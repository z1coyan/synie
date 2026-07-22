defmodule SynieCore.Acc.PartyTypeTest do
  use ExUnit.Case, async: true

  alias SynieCore.Acc.PartyType

  test "对手类型含供应商/客户/内部公司/员工四类" do
    assert Enum.sort(PartyType.values()) == Enum.sort([:supplier, :customer, :company, :employee])
  end

  test "party_resources 内部公司映射到公司主数据,员工映射到员工主数据" do
    assert PartyType.party_resources()[:company] == SynieCore.Base.Company
    assert PartyType.party_resources()[:employee] == SynieCore.Hr.Employee
  end
end
