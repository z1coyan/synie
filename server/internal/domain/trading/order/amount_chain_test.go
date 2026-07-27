package order

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/shopspring/decimal"
)

// amountChainFixture 是迁移规划明令「Go 单测必跑」的金额链路 golden
// （原 contracts/fixtures/amount_chain.yaml，转为 JSON 迁入本包 testdata）。
// 它冻结两条契约：金额链按 half-up（负数远离零）舍入；金额以 JSON string 上线。
type amountChainFixture struct {
	Version  int    `json:"version"`
	Rounding string `json:"rounding"`
	Wire     string `json:"wire"`
	Cases    []struct {
		Name       string `json:"name"`
		Qty        string `json:"qty"`
		Price      string `json:"price"`
		Rate       string `json:"rate"`
		Amount     string `json:"amount"`
		BaseAmount string `json:"baseAmount"`
		BasePrice  string `json:"basePrice"`
	} `json:"cases"`
}

func TestAmountChainMatchesGoldenFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/fixtures/amount_chain.json")
	if err != nil {
		t.Fatalf("金额链路 fixture 缺失或不可读（fail-closed）: %v", err)
	}
	var fixture amountChainFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Rounding != "half-up" || fixture.Wire != "string" || len(fixture.Cases) == 0 {
		t.Fatalf("fixture 约定头变更: rounding=%q wire=%q cases=%d",
			fixture.Rounding, fixture.Wire, len(fixture.Cases))
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			item := &Item{
				Qty:   decimal.RequireFromString(tc.Qty),
				Price: decimal.RequireFromString(tc.Price),
			}
			deriveItemAmounts(item, decimal.RequireFromString(tc.Rate))
			assertAmountWire(t, "amount", item.Amount, tc.Amount, 2)
			assertAmountWire(t, "basePrice", item.BasePrice, tc.BasePrice, 4)
			assertAmountWire(t, "baseAmount", item.BaseAmount, tc.BaseAmount, 2)
		})
	}
}

// assertAmountWire 断言金额值按 half-up 命中 fixture、保留约定小数位，
// 且 JSON 上线形态是 string。Go 的 decimal 序列化会去掉末尾零
// （"-1.0050" 上线为 "-1.005"），与 Elixir 的定标输出仅是表示差异，
// 数值与标度一致，故对 string 内容按数值比对。
func assertAmountWire(t *testing.T, field string, got decimal.Decimal, want string, places int32) {
	t.Helper()
	wantDecimal := decimal.RequireFromString(want)
	if !got.Equal(wantDecimal) {
		t.Fatalf("%s = %s, want %s（half-up 金额链失配）", field, got, want)
	}
	if got.Exponent() != -places {
		t.Fatalf("%s = %s 标度为 %d 位, want %d 位", field, got, -got.Exponent(), places)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wire, ok := strings.CutPrefix(string(encoded), `"`)
	if !ok || !strings.HasSuffix(wire, `"`) {
		t.Fatalf("%s wire = %s, 金额必须以 JSON string 上线", field, encoded)
	}
	if !decimal.RequireFromString(strings.TrimSuffix(wire, `"`)).Equal(wantDecimal) {
		t.Fatalf("%s wire = %s, want %s", field, encoded, want)
	}
}
