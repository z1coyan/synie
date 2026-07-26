package sampledata

import (
	"context"

	"github.com/google/uuid"
	"github.com/z1coyan/synie/server/internal/domain/manufacturing/master"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

func seedMfg(ctx context.Context, deps Dependencies, actor *authz.Actor, md masterData) (mfgResult, error) {
	opsByName := map[string]uuid.UUID{}
	var opIDs []uuid.UUID
	for _, name := range []string{"下料", "冲压", "折弯", "喷涂", "装配"} {
		op, err := deps.ManufacturingMaster.CreateOperation(ctx, actor, master.HeadCreateInput{Name: name})
		if err != nil {
			return mfgResult{}, err
		}
		opsByName[name] = op.ID
		opIDs = append(opIDs, op.ID)
	}

	t1, err := deps.ManufacturingMaster.CreateTemplate(ctx, actor, master.HeadCreateInput{Name: "钣金件标准工艺"})
	if err != nil {
		return mfgResult{}, err
	}
	for _, row := range []struct {
		op           string
		seq          int64
		req          string
		isOutsourced bool
	}{
		{"下料", 10, "按图下料,去毛刺", false},
		{"冲压", 20, "冲孔/落料一次成型", false},
		{"折弯", 30, "按图折弯,角度±1°", false},
		{"喷涂", 40, "外协喷涂,RAL7035", true},
	} {
		if _, err := deps.ManufacturingMaster.CreateTemplateItem(ctx, actor, t1.ID, master.RouteItemInput{
			Seq: row.seq, Requirement: ptr(row.req), IsOutsourced: row.isOutsourced,
			OperationID: opsByName[row.op],
		}); err != nil {
			return mfgResult{}, err
		}
	}

	t2, err := deps.ManufacturingMaster.CreateTemplate(ctx, actor, master.HeadCreateInput{Name: "铜排组件工艺"})
	if err != nil {
		return mfgResult{}, err
	}
	for _, row := range []struct {
		op  string
		seq int64
		req string
	}{
		{"下料", 10, "铜排定尺下料"},
		{"冲压", 20, "冲安装孔,去毛刺"},
		{"装配", 30, "端子压接,扭力按规范"},
	} {
		if _, err := deps.ManufacturingMaster.CreateTemplateItem(ctx, actor, t2.ID, master.RouteItemInput{
			Seq: row.seq, Requirement: ptr(row.req), OperationID: opsByName[row.op],
		}); err != nil {
			return mfgResult{}, err
		}
	}

	// BOM1 配电箱壳体 + 钣金模板路线
	bom1, err := deps.ManufacturingMaster.CreateBOM(ctx, actor, master.BOMCreateInput{
		MaterialID: md.Materials["box_shell"].ID, Note: ptr("示例 BOM"),
	})
	if err != nil {
		return mfgResult{}, err
	}
	for _, row := range []struct {
		key  string
		qty  string
		loss *string
		note *string
	}{
		{"steel_sheet", "2.5", nil, ptr("箱体展开料")},
		{"screw", "12", ptr("0.02"), ptr("装配紧固")},
		{"insul_sleeve", "0.5", nil, nil},
	} {
		if err := createBOMComponent(ctx, deps, actor, bom1.ID, md, row.key, row.qty, row.loss, row.note); err != nil {
			return mfgResult{}, err
		}
	}
	if _, err := deps.ManufacturingMaster.ApplyRouteTemplate(ctx, actor, bom1.ID, t1.ID); err != nil {
		return mfgResult{}, err
	}

	// BOM2 汇流铜排组件 + 手工路线 + 副产品
	bom2, err := deps.ManufacturingMaster.CreateBOM(ctx, actor, master.BOMCreateInput{
		MaterialID: md.Materials["busbar"].ID, Note: ptr("示例 BOM"),
	})
	if err != nil {
		return mfgResult{}, err
	}
	for _, row := range []struct {
		key  string
		qty  string
		loss *string
	}{
		{"copper_bar", "1.2", ptr("0.03")},
		{"terminal_block", "8", nil},
		{"insul_sleeve", "0.3", nil},
	} {
		if err := createBOMComponent(ctx, deps, actor, bom2.ID, md, row.key, row.qty, row.loss, nil); err != nil {
			return mfgResult{}, err
		}
	}
	for _, row := range []struct {
		op  string
		seq int64
		req string
	}{
		{"下料", 10, "铜排定尺下料"},
		{"装配", 20, "端子压接"},
	} {
		if _, err := deps.ManufacturingMaster.CreateBOMRoute(ctx, actor, bom2.ID, master.RouteItemInput{
			Seq: row.seq, Requirement: ptr(row.req), OperationID: opsByName[row.op],
		}); err != nil {
			return mfgResult{}, err
		}
	}
	scrap := md.Materials["scrap_copper"]
	if _, err := deps.ManufacturingMaster.CreateBOMByproduct(ctx, actor, master.ByproductInput{
		Quantity: dec("0.05"), Note: ptr("下料边角料"), BOMID: bom2.ID,
		MaterialID: scrap.ID, UnitID: scrap.DefaultUnitID,
	}); err != nil {
		return mfgResult{}, err
	}

	return mfgResult{
		Operations: opIDs, ProcessTemplates: []uuid.UUID{t1.ID, t2.ID},
		BOMs: []uuid.UUID{bom1.ID, bom2.ID}, OpsByName: opsByName,
	}, nil
}

func createBOMComponent(
	ctx context.Context, deps Dependencies, actor *authz.Actor, bomID uuid.UUID, md masterData,
	key, qty string, loss, note *string,
) error {
	mat := md.Materials[key]
	input := master.ComponentInput{
		Quantity: dec(qty), Note: note, BOMID: bomID,
		MaterialID: mat.ID, UnitID: mat.DefaultUnitID,
	}
	if loss != nil {
		v := dec(*loss)
		input.LossRate = &v
	}
	_, err := deps.ManufacturingMaster.CreateBOMComponent(ctx, actor, input)
	return err
}

