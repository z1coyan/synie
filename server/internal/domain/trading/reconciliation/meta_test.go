package reconciliation

import (
	"reflect"
	"testing"

	"github.com/z1coyan/synie/server/internal/platform/authz"
	"github.com/z1coyan/synie/server/internal/platform/meta"
)

func TestResourceMetaKeepsLegacyHeadAndItemSurface(t *testing.T) {
	tests := []struct {
		side                   Side
		headName, itemName     string
		headFields, itemFields []string
		confirmLabel           string
	}{
		{
			side: SideSales, headName: "salReconciliations", itemName: "salReconciliationItems",
			headFields: []string{
				"id", "reconciliationNo", "reconciliationType", "partyType", "partyId",
				"postingDate", "remarks", "status", "insertedAt", "updatedAt", "companyId",
				"debitAccountId", "creditAccountId", "createdById", "grossTotal", "baseGrossTotal",
			},
			itemFields: []string{
				"id", "idx", "qty", "baseQty", "amount", "baseAmount", "remarks",
				"insertedAt", "updatedAt", "reconciliationId", "companyId", "deliveryItemId",
				"reconciliationNo", "reconciliationStatus", "deliveryNo", "deliveryDate",
				"materialName", "unitName", "orderCurrencyCode",
			},
			confirmLabel: "客户确认",
		},
		{
			side: SidePurchase, headName: "purReconciliations", itemName: "purReconciliationItems",
			headFields: []string{
				"id", "reconciliationNo", "reconciliationType", "partyType", "partyId",
				"postingDate", "remarks", "status", "insertedAt", "updatedAt", "companyId",
				"debitAccountId", "creditAccountId", "createdById", "grossTotal", "baseGrossTotal",
			},
			itemFields: []string{
				"id", "idx", "qty", "baseQty", "amount", "baseAmount", "remarks",
				"insertedAt", "updatedAt", "reconciliationId", "companyId", "receiptItemId",
				"outsourcedReceiptItemId", "reconciliationNo", "reconciliationStatus",
				"receiptNo", "receiptDate", "materialName", "unitName", "orderCurrencyCode",
			},
			confirmLabel: "供应商确认",
		},
	}
	for _, test := range tests {
		t.Run(string(test.side), func(t *testing.T) {
			registry := meta.NewRegistry()
			registry.MustRegister(HeadResourceMeta(test.side))
			registry.MustRegister(ItemResourceMeta(test.side))
			head, err := registry.BuildDocument(test.headName, &authz.Actor{SuperAdmin: true})
			if err != nil {
				t.Fatal(err)
			}
			item, err := registry.BuildDocument(test.itemName, &authz.Actor{SuperAdmin: true})
			if err != nil {
				t.Fatal(err)
			}
			if got := columnNames(head.Grid.Columns); !reflect.DeepEqual(got, test.headFields) {
				t.Fatalf("头字段 = %#v", got)
			}
			if got := columnNames(item.Grid.Columns); !reflect.DeepEqual(got, test.itemFields) {
				t.Fatalf("行字段 = %#v", got)
			}
			wantCapabilities := []string{
				"create", "update", "delete", "confirm", "unconfirm", "audit", "void",
			}
			if !reflect.DeepEqual(head.Grid.Capabilities, wantCapabilities) {
				t.Fatalf("头 capabilities = %#v", head.Grid.Capabilities)
			}
			if len(head.Grid.ExtendedActions) != 4 ||
				head.Grid.ExtendedActions[0].Label != test.confirmLabel {
				t.Fatalf("头动作 = %#v", head.Grid.ExtendedActions)
			}
			if len(item.Grid.Capabilities) != 0 || len(item.Grid.ExtendedActions) != 0 {
				t.Fatalf("行 capability/action = %#v/%#v",
					item.Grid.Capabilities, item.Grid.ExtendedActions)
			}
		})
	}
}

func columnNames(columns []meta.GridColumnDTO) []string {
	result := make([]string, 0, len(columns))
	for _, column := range columns {
		result = append(result, column.Name)
	}
	return result
}
