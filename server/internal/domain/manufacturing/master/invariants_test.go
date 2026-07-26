package master

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func TestChildPermissionsFollowParentEditCapability(t *testing.T) {
	createActor := &authz.Actor{Permissions: map[string]struct{}{"mfg.bom:create": {}}}
	updateActor := &authz.Actor{Permissions: map[string]struct{}{"mfg.bom:update": {}}}
	readActor := &authz.Actor{Permissions: map[string]struct{}{"mfg.bom:read": {}}}

	if err := requireChild(createActor, bomPermission, "create"); err != nil {
		t.Fatalf("create capability should create a child: %v", err)
	}
	if err := requireChild(updateActor, bomPermission, "create"); err != nil {
		t.Fatalf("update capability should create a child: %v", err)
	}
	if err := requireChild(readActor, bomPermission, "read"); err != nil {
		t.Fatalf("read capability should read a child: %v", err)
	}
	if err := requireChild(readActor, bomPermission, "delete"); !isCode(err, apierror.CodeForbidden) {
		t.Fatalf("read capability must not delete a child: %v", err)
	}
}

func TestNormalizeHeadRejectsChangingAnchors(t *testing.T) {
	if _, _, _, err := normalizeHead("", " 工序 ", nil, "工序"); err != nil {
		t.Fatalf("empty code is allocated later and should be accepted: %v", err)
	}
	if err := rejectAnchor(uuid.New(), uuid.New(), "materialId", "创建后不可换物料"); !isCode(err, apierror.CodeValidation) {
		t.Fatalf("changing a material anchor should fail validation: %v", err)
	}
	if err := rejectAnchor(uuid.Nil, uuid.Nil, "materialId", "创建后不可换物料"); err != nil {
		t.Fatalf("equal anchors should be accepted: %v", err)
	}
}

func TestValidateBOMLine(t *testing.T) {
	bomMaterial, childMaterial := uuid.New(), uuid.New()
	if err := validateLine(bomMaterial, bomMaterial, decimal.NewFromInt(1), nil); !isCode(err, apierror.CodeValidation) {
		t.Fatalf("self material should fail validation: %v", err)
	}
	if err := validateLine(bomMaterial, childMaterial, decimal.Zero, nil); !isCode(err, apierror.CodeValidation) {
		t.Fatalf("zero quantity should fail validation: %v", err)
	}
	negative := decimal.RequireFromString("-0.01")
	if err := validateLine(bomMaterial, childMaterial, decimal.NewFromInt(1), &negative); !isCode(err, apierror.CodeValidation) {
		t.Fatalf("negative loss should fail validation: %v", err)
	}
	if err := validateLine(bomMaterial, childMaterial, decimal.NewFromInt(1), nil); err != nil {
		t.Fatalf("valid component should pass: %v", err)
	}
}

func TestTemplateRoutesAreValueSnapshots(t *testing.T) {
	items := []TemplateItem{
		{ID: uuid.New(), OperationID: uuid.New(), Seq: 20, Requirement: ptr("后处理"), IsOutsourced: true},
		{ID: uuid.New(), OperationID: uuid.New(), Seq: 10, Requirement: ptr("粗加工")},
	}
	routes := snapshotRoutes(uuid.New(), items)
	if len(routes) != 2 || routes[0].Seq != 10 || routes[1].Seq != 20 {
		t.Fatalf("snapshot should preserve template order: %#v", routes)
	}
	if routes[0].ID == items[1].ID || routes[0].OperationID != items[1].OperationID {
		t.Fatalf("snapshot must create private route identities while copying values: %#v", routes[0])
	}
	*items[1].Requirement = "模板后改"
	if got := *routes[0].Requirement; got != "粗加工" {
		t.Fatalf("route snapshot changed with template: %q", got)
	}
}

func isCode(err error, code apierror.Code) bool {
	var target *apierror.Error
	return errors.As(err, &target) && target.Code == code
}

func ptr(value string) *string { return &value }
