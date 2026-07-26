-- Manufacturing master data owns these queries as one deep module. Generated
-- methods deliberately carry the ManufacturingMaster prefix to avoid leaking
-- table-shaped naming into callers.

-- name: GetManufacturingMasterOperation :one
SELECT id,code,name,note,inserted_at,updated_at
FROM mfg_operation WHERE id=$1;

-- name: LockManufacturingMasterOperation :one
SELECT id,code,name,note,inserted_at,updated_at
FROM mfg_operation WHERE id=$1 FOR UPDATE;

-- name: CreateManufacturingMasterOperation :one
INSERT INTO mfg_operation(code,name,note) VALUES($1,$2,$3)
RETURNING id,code,name,note,inserted_at,updated_at;

-- name: UpdateManufacturingMasterOperation :one
UPDATE mfg_operation SET name=$2,note=$3,updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1 RETURNING id,code,name,note,inserted_at,updated_at;

-- name: DeleteManufacturingMasterOperation :execrows
DELETE FROM mfg_operation WHERE id=$1;

-- name: OperationHasManufacturingMasterReferences :one
SELECT EXISTS(SELECT 1 FROM mfg_bom_route r WHERE r.operation_id=$1)
    OR EXISTS(SELECT 1 FROM mfg_process_template_item i WHERE i.operation_id=$1);

-- name: GetManufacturingMasterTemplate :one
SELECT id,code,name,note,inserted_at,updated_at
FROM mfg_process_template WHERE id=$1;

-- name: LockManufacturingMasterTemplate :one
SELECT id,code,name,note,inserted_at,updated_at
FROM mfg_process_template WHERE id=$1 FOR UPDATE;

-- name: CreateManufacturingMasterTemplate :one
INSERT INTO mfg_process_template(code,name,note) VALUES($1,$2,$3)
RETURNING id,code,name,note,inserted_at,updated_at;

-- name: UpdateManufacturingMasterTemplate :one
UPDATE mfg_process_template SET name=$2,note=$3,updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1 RETURNING id,code,name,note,inserted_at,updated_at;

-- name: DeleteManufacturingMasterTemplate :execrows
DELETE FROM mfg_process_template WHERE id=$1;

-- name: ListManufacturingMasterTemplateItems :many
SELECT id,seq,requirement,is_outsourced,inserted_at,updated_at,template_id,operation_id
FROM mfg_process_template_item WHERE template_id=$1 ORDER BY seq,id;

-- name: LockManufacturingMasterTemplateItem :one
SELECT id,seq,requirement,is_outsourced,inserted_at,updated_at,template_id,operation_id
FROM mfg_process_template_item WHERE id=$1 FOR UPDATE;

-- name: CreateManufacturingMasterTemplateItem :one
INSERT INTO mfg_process_template_item(template_id,operation_id,seq,requirement,is_outsourced)
VALUES($1,$2,$3,$4,$5)
RETURNING id,seq,requirement,is_outsourced,inserted_at,updated_at,template_id,operation_id;

-- name: UpdateManufacturingMasterTemplateItem :one
UPDATE mfg_process_template_item
SET operation_id=$2,seq=$3,requirement=$4,is_outsourced=$5,
    updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id,seq,requirement,is_outsourced,inserted_at,updated_at,template_id,operation_id;

-- name: DeleteManufacturingMasterTemplateItem :execrows
DELETE FROM mfg_process_template_item WHERE id=$1;

-- name: GetManufacturingMasterBOM :one
SELECT id,code,plan_name,note,inserted_at,updated_at,material_id
FROM mfg_bom WHERE id=$1;

-- name: LockManufacturingMasterBOM :one
SELECT id,code,plan_name,note,inserted_at,updated_at,material_id
FROM mfg_bom WHERE id=$1 FOR UPDATE;

-- name: CreateManufacturingMasterBOM :one
INSERT INTO mfg_bom(code,plan_name,note,material_id) VALUES($1,$2,$3,$4)
RETURNING id,code,plan_name,note,inserted_at,updated_at,material_id;

-- name: UpdateManufacturingMasterBOM :one
UPDATE mfg_bom
SET plan_name=$2,note=$3,updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id,code,plan_name,note,inserted_at,updated_at,material_id;

-- name: DeleteManufacturingMasterBOM :execrows
DELETE FROM mfg_bom WHERE id=$1;

-- name: CountManufacturingMasterBOMRoutes :one
SELECT count(*) FROM mfg_bom_route WHERE bom_id=$1;

-- name: LockManufacturingMasterComponent :one
SELECT id,quantity,loss_rate,note,inserted_at,updated_at,bom_id,material_id,unit_id
FROM mfg_bom_component WHERE id=$1 FOR UPDATE;

-- name: CreateManufacturingMasterComponent :one
INSERT INTO mfg_bom_component(bom_id,material_id,unit_id,quantity,loss_rate,note)
VALUES($1,$2,$3,$4,$5,$6)
RETURNING id,quantity,loss_rate,note,inserted_at,updated_at,bom_id,material_id,unit_id;

-- name: UpdateManufacturingMasterComponent :one
UPDATE mfg_bom_component
SET material_id=$2,unit_id=$3,quantity=$4,loss_rate=$5,note=$6,
    updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id,quantity,loss_rate,note,inserted_at,updated_at,bom_id,material_id,unit_id;

-- name: DeleteManufacturingMasterComponent :execrows
DELETE FROM mfg_bom_component WHERE id=$1;

-- name: LockManufacturingMasterRoute :one
SELECT id,seq,requirement,is_outsourced,inserted_at,updated_at,bom_id,operation_id
FROM mfg_bom_route WHERE id=$1 FOR UPDATE;

-- name: CreateManufacturingMasterRoute :one
INSERT INTO mfg_bom_route(bom_id,operation_id,seq,requirement,is_outsourced)
VALUES($1,$2,$3,$4,$5)
RETURNING id,seq,requirement,is_outsourced,inserted_at,updated_at,bom_id,operation_id;

-- name: UpdateManufacturingMasterRoute :one
UPDATE mfg_bom_route
SET operation_id=$2,seq=$3,requirement=$4,is_outsourced=$5,
    updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id,seq,requirement,is_outsourced,inserted_at,updated_at,bom_id,operation_id;

-- name: DeleteManufacturingMasterRoute :execrows
DELETE FROM mfg_bom_route WHERE id=$1;

-- name: LockManufacturingMasterByproduct :one
SELECT id,quantity,note,inserted_at,updated_at,bom_id,material_id,unit_id
FROM mfg_bom_byproduct WHERE id=$1 FOR UPDATE;

-- name: CreateManufacturingMasterByproduct :one
INSERT INTO mfg_bom_byproduct(bom_id,material_id,unit_id,quantity,note)
VALUES($1,$2,$3,$4,$5)
RETURNING id,quantity,note,inserted_at,updated_at,bom_id,material_id,unit_id;

-- name: UpdateManufacturingMasterByproduct :one
UPDATE mfg_bom_byproduct
SET material_id=$2,unit_id=$3,quantity=$4,note=$5,
    updated_at=(now() AT TIME ZONE 'utc')
WHERE id=$1
RETURNING id,quantity,note,inserted_at,updated_at,bom_id,material_id,unit_id;

-- name: DeleteManufacturingMasterByproduct :execrows
DELETE FROM mfg_bom_byproduct WHERE id=$1;

-- name: ManufacturingMasterUnitAllowed :one
SELECT EXISTS(SELECT 1 FROM inv_material m WHERE m.id=$1 AND m.default_unit_id=$2)
    OR EXISTS(SELECT 1 FROM inv_material_unit mu WHERE mu.material_id=$1 AND mu.unit_id=$2);
