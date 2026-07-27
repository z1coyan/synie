package standard

// 装箱清单（行）：销售发货单下的可选子表，纯实物复核层——不落库存/总账/投影。
// 挂发货单（不挂发货条目），随单级联删除、审核后随单锁死；权限随
// sales.delivery 各动作（同发料清单随父单先例），不新增权限资源码。
// 全有或全无：整表可不填；填了则审核时逐物料硬校验
// 「Σ 装箱行 base ＝ Σ 该物料全部发货条目 base」，见 validatePackEquality。

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
	"github.com/z1coyan/synie/server/internal/db/filterbuild"
	"github.com/z1coyan/synie/server/internal/db/pgconv"
	"github.com/z1coyan/synie/server/internal/platform/apierror"
	"github.com/z1coyan/synie/server/internal/platform/audit"
	"github.com/z1coyan/synie/server/internal/platform/authz"
)

const (
	packLineTable = "sal_delivery_pack_line"
	packLineLabel = "装箱行"
)

var packLineAuditFields = []string{
	"idx", "box_no", "qty", "base_qty", "material_code", "material_name",
	"material_spec", "customer_part_no", "unit_name", "remarks",
	"delivery_id", "company_id", "material_id", "unit_id",
}

func (s *Service) CreatePackLine(
	ctx context.Context, actor *authz.Actor, input CreatePackLineInput,
) (PackLine, error) {
	spec := mustSpec(SideSales)
	if err := require(actor, spec, "create"); err != nil {
		return PackLine{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PackLine{}, apierror.Wrap(apierror.CodeInternal, "创建"+packLineLabel+"失败", err)
	}
	defer tx.Rollback(ctx)
	parent, err := lockDraftHead(ctx, tx, actor, spec, input.DeliveryID)
	if err != nil {
		return PackLine{}, err
	}
	line := PackLine{
		Idx: input.Idx, BoxNo: strings.TrimSpace(input.BoxNo), Qty: input.Qty,
		DeliveryID: input.DeliveryID, CompanyID: parent.CompanyID,
		MaterialID: input.MaterialID, Remarks: input.Remarks,
	}
	if err := derivePackLine(ctx, tx, &line, input.UnitID); err != nil {
		return PackLine{}, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO `+packLineTable+` (
		idx,box_no,qty,base_qty,material_code,material_name,material_spec,
		customer_part_no,unit_name,remarks,delivery_id,company_id,material_id,unit_id
	) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
		line.Idx, line.BoxNo, line.Qty, line.BaseQty, line.MaterialCode, line.MaterialName,
		pgconv.Text(line.MaterialSpec), pgconv.Text(line.CustomerPartNo), line.UnitName,
		pgconv.Text(line.Remarks), line.DeliveryID, line.CompanyID, line.MaterialID, line.UnitID,
	).Scan(&id)
	if err != nil {
		return PackLine{}, writeError(spec, "创建"+packLineLabel+"失败", err)
	}
	result, err := queryPackLineByID(ctx, tx, id, false)
	if err != nil {
		return PackLine{}, apierror.Wrap(apierror.CodeInternal, "读取新建"+packLineLabel+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, packLineTable, id, strconv.FormatInt(result.Idx, 10),
		"create", "create", result.CompanyID,
		audit.Created(packLineSnapshot(result), packLineAuditFields)); err != nil {
		return PackLine{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PackLine{}, writeError(spec, "创建"+packLineLabel+"失败", err)
	}
	return result, nil
}

func (s *Service) UpdatePackLine(
	ctx context.Context, actor *authz.Actor, id uuid.UUID, input UpdatePackLineInput,
) (PackLine, error) {
	spec := mustSpec(SideSales)
	if err := require(actor, spec, "update"); err != nil {
		return PackLine{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PackLine{}, apierror.Wrap(apierror.CodeInternal, "更新"+packLineLabel+"失败", err)
	}
	defer tx.Rollback(ctx)
	parentID, err := findPackLineParent(ctx, tx, id)
	if err != nil {
		return PackLine{}, err
	}
	if _, err := lockDraftHead(ctx, tx, actor, spec, parentID); err != nil {
		return PackLine{}, err
	}
	before, err := queryPackLineByID(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return PackLine{}, apierror.New(apierror.CodeNotFound, packLineLabel+"不存在")
	}
	if err != nil {
		return PackLine{}, apierror.Wrap(apierror.CodeInternal, "锁定"+packLineLabel+"失败", err)
	}
	after := before
	if input.Idx != nil {
		after.Idx = *input.Idx
	}
	if input.BoxNo != nil {
		after.BoxNo = strings.TrimSpace(*input.BoxNo)
	}
	if input.Qty != nil {
		after.Qty = *input.Qty
	}
	if input.MaterialID != nil {
		after.MaterialID = *input.MaterialID
	}
	if input.Remarks.Set {
		after.Remarks = input.Remarks.Value
	}
	var unitID *uuid.UUID
	if input.UnitID.Set {
		unitID = input.UnitID.Value
	} else {
		unitID = &after.UnitID
	}
	if err := derivePackLine(ctx, tx, &after, unitID); err != nil {
		return PackLine{}, err
	}
	changes := audit.Diff(packLineSnapshot(before), packLineSnapshot(after), packLineAuditFields)
	if len(changes) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return PackLine{}, writeError(spec, "更新"+packLineLabel+"失败", err)
		}
		return before, nil
	}
	_, err = tx.Exec(ctx, `UPDATE `+packLineTable+` SET
		idx=$2,box_no=$3,qty=$4,base_qty=$5,material_code=$6,material_name=$7,
		material_spec=$8,customer_part_no=$9,unit_name=$10,remarks=$11,
		material_id=$12,unit_id=$13,updated_at=(now() AT TIME ZONE 'utc') WHERE id=$1`,
		id, after.Idx, after.BoxNo, after.Qty, after.BaseQty, after.MaterialCode,
		after.MaterialName, pgconv.Text(after.MaterialSpec), pgconv.Text(after.CustomerPartNo),
		after.UnitName, pgconv.Text(after.Remarks), after.MaterialID, after.UnitID,
	)
	if err != nil {
		return PackLine{}, writeError(spec, "更新"+packLineLabel+"失败", err)
	}
	result, err := queryPackLineByID(ctx, tx, id, false)
	if err != nil {
		return PackLine{}, apierror.Wrap(apierror.CodeInternal, "读取更新后"+packLineLabel+"失败", err)
	}
	if err := writeAudit(ctx, tx, actor, packLineTable, id, strconv.FormatInt(result.Idx, 10),
		"update", "update", result.CompanyID, changes); err != nil {
		return PackLine{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PackLine{}, writeError(spec, "更新"+packLineLabel+"失败", err)
	}
	return result, nil
}

func (s *Service) DeletePackLine(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) error {
	spec := mustSpec(SideSales)
	if err := require(actor, spec, "delete"); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "删除"+packLineLabel+"失败", err)
	}
	defer tx.Rollback(ctx)
	parentID, err := findPackLineParent(ctx, tx, id)
	if err != nil {
		return err
	}
	if _, err := lockDraftHead(ctx, tx, actor, spec, parentID); err != nil {
		return err
	}
	line, err := queryPackLineByID(ctx, tx, id, true)
	if err != nil {
		return apierror.New(apierror.CodeNotFound, packLineLabel+"不存在")
	}
	if err := writeAudit(ctx, tx, actor, packLineTable, id, strconv.FormatInt(line.Idx, 10),
		"destroy", "destroy", line.CompanyID,
		audit.Destroyed(packLineSnapshot(line), packLineAuditFields)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM `+packLineTable+` WHERE id=$1`, id); err != nil {
		return writeError(spec, "删除"+packLineLabel+"失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return writeError(spec, "删除"+packLineLabel+"失败", err)
	}
	return nil
}

func (s *Service) GetPackLine(
	ctx context.Context, actor *authz.Actor, id uuid.UUID,
) (PackLine, error) {
	spec := mustSpec(SideSales)
	if err := require(actor, spec, "read"); err != nil {
		return PackLine{}, err
	}
	line, err := queryPackLineByID(ctx, s.pool, id, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.CanAccessCompany(line.CompanyID)) {
		return PackLine{}, apierror.New(apierror.CodeNotFound, packLineLabel+"不存在")
	}
	if err != nil {
		return PackLine{}, apierror.Wrap(apierror.CodeInternal, "读取"+packLineLabel+"失败", err)
	}
	return line, nil
}

func (s *Service) ListPackLines(
	ctx context.Context, actor *authz.Actor, query ListQuery,
) (PackLineListResult, error) {
	spec := mustSpec(SideSales)
	if err := require(actor, spec, "read"); err != nil {
		return PackLineListResult{}, err
	}
	if err := validatePage(&query); err != nil {
		return PackLineListResult{}, err
	}
	built, err := filterbuild.Build(PackLineResourceMeta(), filterbuild.Query{
		Limit: query.Limit, Offset: query.Offset, Search: query.Search,
		Sort: query.Sort, Filter: query.Filter,
	})
	if err != nil {
		return PackLineListResult{}, err
	}
	where, args := scopedWhere(actor, built.Where, append([]any(nil), built.Args...))
	orderBy := built.OrderBy
	if orderBy == "" {
		orderBy = ` ORDER BY "idx" ASC,"id" ASC`
	} else {
		orderBy += `,"id" ASC`
	}
	source := ` FROM ` + packLineTable
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return PackLineListResult{}, apierror.Wrap(apierror.CodeInternal, "查询"+packLineLabel+"失败", err)
	}
	defer tx.Rollback(ctx)
	var result PackLineListResult
	if err := tx.QueryRow(ctx, `SELECT count(*)`+source+where, args...).Scan(&result.Count); err != nil {
		return PackLineListResult{}, apierror.Wrap(apierror.CodeInternal, "统计"+packLineLabel+"失败", err)
	}
	listArgs := append([]any(nil), args...)
	limitAt := len(listArgs) + 1
	listArgs = append(listArgs, query.Limit, query.Offset)
	rows, err := tx.Query(ctx, packLineSelect+source+where+orderBy+
		fmt.Sprintf(" LIMIT $%d OFFSET $%d", limitAt, limitAt+1), listArgs...)
	if err != nil {
		return PackLineListResult{}, apierror.Wrap(apierror.CodeInternal, "查询"+packLineLabel+"失败", err)
	}
	defer rows.Close()
	result.Results = make([]PackLine, 0, query.Limit)
	for rows.Next() {
		line, scanErr := scanPackLine(rows)
		if scanErr != nil {
			return PackLineListResult{}, apierror.Wrap(apierror.CodeInternal, "读取"+packLineLabel+"结果失败", scanErr)
		}
		result.Results = append(result.Results, line)
	}
	if err := rows.Err(); err != nil {
		return PackLineListResult{}, apierror.Wrap(apierror.CodeInternal, "遍历"+packLineLabel+"结果失败", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PackLineListResult{}, apierror.Wrap(apierror.CodeInternal, "完成"+packLineLabel+"查询失败", err)
	}
	return result, nil
}

// derivePackLine 校验形状（箱号必填、数量 > 0、备注长度）并冻结物料快照：
// 单位限该物料默认单位或转换单位，系统折算 base_qty（6 位，同发货条目口径）；
// 快照五字段（编号/名称/规格/客户料号/单位名）保存时冻结，主数据后改不回溯。
func derivePackLine(
	ctx context.Context, tx pgx.Tx, line *PackLine, unitID *uuid.UUID,
) error {
	fields := map[string][]string{}
	if line.BoxNo == "" {
		fields["boxNo"] = []string{"必填"}
	} else if utf8.RuneCountInString(line.BoxNo) > 64 {
		fields["boxNo"] = []string{"最多 64 个字符"}
	}
	if !line.Qty.GreaterThan(decimal.Zero) {
		fields["qty"] = []string{"必须大于 0"}
	}
	if line.MaterialID == uuid.Nil {
		fields["materialId"] = []string{"必填"}
	}
	if line.Remarks != nil && utf8.RuneCountInString(*line.Remarks) > 512 {
		fields["remarks"] = []string{"最多 512 个字符"}
	}
	if len(fields) > 0 {
		return apierror.Validation(packLineLabel+"参数不合法", fields)
	}
	var (
		defaultUnitID uuid.UUID
		spec, partNo  pgtype.Text
	)
	err := tx.QueryRow(ctx, `SELECT code,name,spec,customer_part_no,default_unit_id
		FROM inv_material WHERE id=$1`, line.MaterialID).Scan(
		&line.MaterialCode, &line.MaterialName, &spec, &partNo, &defaultUnitID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation(packLineLabel+"参数不合法",
			map[string][]string{"materialId": {"物料不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取装箱物料失败", err)
	}
	chosenUnitID := defaultUnitID
	if unitID != nil && *unitID != uuid.Nil {
		chosenUnitID = *unitID
	}
	var unitName string
	var factor pgtype.Numeric
	err = tx.QueryRow(ctx, `SELECT u.name,mu.factor FROM bas_unit u
		LEFT JOIN inv_material_unit mu ON mu.material_id=$1 AND mu.unit_id=u.id
		WHERE u.id=$2`, line.MaterialID, chosenUnitID).Scan(&unitName, &factor)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierror.Validation(packLineLabel+"参数不合法",
			map[string][]string{"unitId": {"单位不存在"}})
	}
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取装箱单位失败", err)
	}
	baseQty := line.Qty
	if chosenUnitID != defaultUnitID {
		conversion, ok := numericDecimal(factor)
		if !ok || !conversion.GreaterThan(decimal.Zero) {
			return apierror.Validation(packLineLabel+"参数不合法",
				map[string][]string{"unitId": {"单位必须是物料默认单位或转换单位"}})
		}
		baseQty = line.Qty.Div(conversion).Round(6)
	}
	line.MaterialSpec, line.CustomerPartNo = pgconv.TextPtr(spec), pgconv.TextPtr(partNo)
	line.UnitID, line.UnitName = chosenUnitID, unitName
	line.BaseQty = baseQty
	return nil
}

// validatePackEquality 在审核事务内执行全有或全无校验：存在装箱行则按物料
// 分组（默认单位口径）比对「Σ 装箱行 base ＝ Σ 该物料全部发货条目 base」——
// 漏装任一物料、任一物料不等、含发货外物料，均拒审并点名物料与两侧数量；
// 无装箱行则跳过。
func validatePackEquality(
	ctx context.Context, tx pgx.Tx, headID uuid.UUID, items []Item,
) error {
	rows, err := tx.Query(ctx, `SELECT material_id,min(material_code),min(material_name),
		sum(base_qty) FROM `+packLineTable+` WHERE delivery_id=$1 GROUP BY material_id`, headID)
	if err != nil {
		return apierror.Wrap(apierror.CodeInternal, "读取装箱清单失败", err)
	}
	defer rows.Close()
	type materialSum struct {
		label string
		qty   decimal.Decimal
	}
	packed := make(map[uuid.UUID]materialSum)
	for rows.Next() {
		var materialID uuid.UUID
		var sum materialSum
		var code, name string
		if err := rows.Scan(&materialID, &code, &name, &sum.qty); err != nil {
			return apierror.Wrap(apierror.CodeInternal, "读取装箱清单失败", err)
		}
		sum.label = code + " " + name
		packed[materialID] = sum
	}
	if err := rows.Err(); err != nil {
		return apierror.Wrap(apierror.CodeInternal, "遍历装箱清单失败", err)
	}
	if len(packed) == 0 {
		return nil
	}
	shipped := make(map[uuid.UUID]materialSum)
	for _, item := range items {
		sum := shipped[item.MaterialID]
		sum.label = item.MaterialCode + " " + item.MaterialName
		sum.qty = sum.qty.Add(item.BaseQty)
		shipped[item.MaterialID] = sum
	}
	found := make([]packMismatch, 0)
	for materialID, pack := range packed {
		ship, ok := shipped[materialID]
		switch {
		case !ok:
			found = append(found, packMismatch{
				materialID: materialID, label: pack.label, packQty: pack.qty, foreign: true,
			})
		case !pack.qty.Equal(ship.qty):
			found = append(found, packMismatch{
				materialID: materialID, label: ship.label, shipQty: ship.qty, packQty: pack.qty,
			})
		}
	}
	for materialID, ship := range shipped {
		if _, ok := packed[materialID]; !ok {
			found = append(found, packMismatch{
				materialID: materialID, label: ship.label, shipQty: ship.qty, missing: true,
			})
		}
	}
	if len(found) == 0 {
		return nil
	}
	// 数量为默认单位口径：报错点名物料默认单位，避免误读成录入单位
	unitNames, err := materialDefaultUnitNames(ctx, tx, found)
	if err != nil {
		return err
	}
	mismatches := make([]string, 0, len(found))
	for _, m := range found {
		mismatches = append(mismatches, m.describe(unitNames[m.materialID]))
	}
	sort.Strings(mismatches)
	return apierror.New(apierror.CodeConflict,
		"装箱清单与发货数量不一致（默认单位口径）："+strings.Join(mismatches, "；"))
}

// packMismatch 是一条逐物料装箱差异：foreign=含发货外物料、missing=漏装、
// 其余为量不等；shipQty/packQty 均为默认单位口径。
type packMismatch struct {
	materialID uuid.UUID
	label      string
	shipQty    decimal.Decimal
	packQty    decimal.Decimal
	foreign    bool
	missing    bool
}

func (m packMismatch) describe(unit string) string {
	qty := func(value decimal.Decimal) string {
		if unit == "" {
			return value.String()
		}
		return value.String() + " " + unit
	}
	switch {
	case m.foreign:
		return fmt.Sprintf("物料 %s 不在发货条目中（发货 %s，装箱 %s）",
			m.label, qty(decimal.Zero), qty(m.packQty))
	case m.missing:
		return fmt.Sprintf("物料 %s 未装箱（发货 %s，装箱 %s）",
			m.label, qty(m.shipQty), qty(decimal.Zero))
	default:
		return fmt.Sprintf("物料 %s 发货 %s，装箱 %s", m.label, qty(m.shipQty), qty(m.packQty))
	}
}

// materialDefaultUnitNames 取差异物料的默认单位名（报错展示用）。
func materialDefaultUnitNames(
	ctx context.Context, tx pgx.Tx, mismatches []packMismatch,
) (map[uuid.UUID]string, error) {
	ids := make([]uuid.UUID, 0, len(mismatches))
	for _, m := range mismatches {
		ids = append(ids, m.materialID)
	}
	rows, err := tx.Query(ctx, `SELECT m.id,u.name FROM inv_material m
		JOIN bas_unit u ON u.id=m.default_unit_id WHERE m.id=ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "读取物料默认单位失败", err)
	}
	defer rows.Close()
	names := make(map[uuid.UUID]string, len(ids))
	for rows.Next() {
		var id uuid.UUID
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, apierror.Wrap(apierror.CodeInternal, "读取物料默认单位失败", err)
		}
		names[id] = name
	}
	if err := rows.Err(); err != nil {
		return nil, apierror.Wrap(apierror.CodeInternal, "遍历物料默认单位失败", err)
	}
	return names, nil
}

const packLineSelect = `SELECT id,idx,box_no,qty,base_qty,material_code,material_name,
	material_spec,customer_part_no,unit_name,remarks,inserted_at,updated_at,
	delivery_id,company_id,material_id,unit_id`

func queryPackLineByID(
	ctx context.Context, db interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	}, id uuid.UUID, lock bool,
) (PackLine, error) {
	sql := packLineSelect + ` FROM ` + packLineTable + ` WHERE id=$1`
	if lock {
		sql += ` FOR UPDATE`
	}
	return scanPackLine(db.QueryRow(ctx, sql, id))
}

func scanPackLine(row scanner) (PackLine, error) {
	var (
		line                  PackLine
		materialSpec          pgtype.Text
		customerPartNo        pgtype.Text
		remarks               pgtype.Text
		insertedAt, updatedAt pgtype.Timestamp
	)
	err := row.Scan(
		&line.ID, &line.Idx, &line.BoxNo, &line.Qty, &line.BaseQty, &line.MaterialCode,
		&line.MaterialName, &materialSpec, &customerPartNo, &line.UnitName, &remarks,
		&insertedAt, &updatedAt, &line.DeliveryID, &line.CompanyID, &line.MaterialID,
		&line.UnitID,
	)
	if err != nil {
		return PackLine{}, err
	}
	line.MaterialSpec, line.CustomerPartNo, line.Remarks =
		pgconv.TextPtr(materialSpec), pgconv.TextPtr(customerPartNo), pgconv.TextPtr(remarks)
	line.InsertedAt, line.UpdatedAt = insertedAt.Time, updatedAt.Time
	return line, nil
}

func findPackLineParent(
	ctx context.Context, tx pgx.Tx, id uuid.UUID,
) (uuid.UUID, error) {
	var parentID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT delivery_id FROM `+packLineTable+` WHERE id=$1`, id).Scan(&parentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, apierror.New(apierror.CodeNotFound, packLineLabel+"不存在")
	}
	if err != nil {
		return uuid.Nil, apierror.Wrap(apierror.CodeInternal, "读取"+packLineLabel+"失败", err)
	}
	return parentID, nil
}

func packLineSnapshot(line PackLine) map[string]any {
	return map[string]any{
		"idx": line.Idx, "box_no": line.BoxNo, "qty": line.Qty, "base_qty": line.BaseQty,
		"material_code": line.MaterialCode, "material_name": line.MaterialName,
		"material_spec": line.MaterialSpec, "customer_part_no": line.CustomerPartNo,
		"unit_name": line.UnitName, "remarks": line.Remarks,
		"delivery_id": line.DeliveryID, "company_id": line.CompanyID,
		"material_id": line.MaterialID, "unit_id": line.UnitID,
	}
}
