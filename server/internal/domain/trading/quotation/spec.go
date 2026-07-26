package quotation

import "github.com/z1coyan/synie/server/internal/platform/apierror"

type sideSpec struct {
	side                  Side
	prefix                string
	label                 string
	headTable             string
	itemTable             string
	tierTable             string
	headResource          string
	itemResource          string
	tierResource          string
	headAuditResource     string
	itemAuditResource     string
	tierAuditResource     string
	headDestroyMutation   string
	itemDestroyMutation   string
	tierDestroyMutation   string
	auditMutation         string
	voidMutation          string
	partyLabel            string
	termsLabel            string
	allowedParty          map[string]struct{}
	partyVariants         []partyVariant
	customerMaterialGuard bool
}

type partyVariant struct {
	value, resource, label string
}

var specs = map[Side]sideSpec{
	SideSales: {
		side: SideSales, prefix: "sales.quotation", label: "销售报价单",
		headTable: "sal_quotation", itemTable: "sal_quotation_item",
		tierTable: "sal_quotation_tier", headResource: "salQuotations",
		itemResource: "salQuotationItems", tierResource: "salQuotationTiers",
		headAuditResource: "sal_quotation", itemAuditResource: "sal_quotation_item",
		tierAuditResource:   "sal_quotation_tier",
		headDestroyMutation: "destroySalQuotation",
		itemDestroyMutation: "destroySalQuotationItem",
		tierDestroyMutation: "destroySalQuotationTier",
		auditMutation:       "auditSalQuotation", voidMutation: "voidSalQuotation",
		partyLabel: "对手类型(客户/内部公司)", termsLabel: "报价条款(对客户,自由文本)",
		allowedParty: map[string]struct{}{"customer": {}, "company": {}},
		partyVariants: []partyVariant{
			{value: "COMPANY", resource: "basCompanies", label: "内部公司"},
			{value: "CUSTOMER", resource: "salCustomers", label: "客户"},
		},
		customerMaterialGuard: true,
	},
	SidePurchase: {
		side: SidePurchase, prefix: "purchase.quotation", label: "采购报价单",
		headTable: "pur_quotation", itemTable: "pur_quotation_item",
		tierTable: "pur_quotation_tier", headResource: "purQuotations",
		itemResource: "purQuotationItems", tierResource: "purQuotationTiers",
		headAuditResource: "pur_quotation", itemAuditResource: "pur_quotation_item",
		tierAuditResource:   "pur_quotation_tier",
		headDestroyMutation: "destroyPurQuotation",
		itemDestroyMutation: "destroyPurQuotationItem",
		tierDestroyMutation: "destroyPurQuotationTier",
		auditMutation:       "auditPurQuotation", voidMutation: "voidPurQuotation",
		partyLabel: "对手类型(供应商/内部公司)", termsLabel: "报价条款(对供应商,自由文本)",
		allowedParty: map[string]struct{}{"supplier": {}, "company": {}},
		partyVariants: []partyVariant{
			{value: "COMPANY", resource: "basCompanies", label: "内部公司"},
			{value: "SUPPLIER", resource: "purSuppliers", label: "供应商"},
		},
	},
}

func specFor(side Side) (sideSpec, error) {
	spec, ok := specs[side]
	if !ok {
		return sideSpec{}, apierror.New(apierror.CodeValidation, "报价方向不合法")
	}
	return spec, nil
}
