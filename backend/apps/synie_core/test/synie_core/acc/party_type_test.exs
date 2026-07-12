defmodule SynieCore.Acc.PartyTypeTest do
  use ExUnit.Case, async: true

  alias SynieCore.Acc.PartyType

  test "对手类型含供应商/客户/内部公司三类" do
    assert Enum.sort(PartyType.values()) == Enum.sort([:supplier, :customer, :company])
  end

  test "party_resources 内部公司映射到公司主数据" do
    assert PartyType.party_resources()[:company] == SynieCore.Base.Company
  end
end
