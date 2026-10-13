from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, aliased
from sqlalchemy import and_, or_, func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from typing import List

from app.db.session import get_db
from app.models.product import BottleMaster, BottleConfiguration
from app.models.audit_log import AuditLog
from app.schemas.product import (
    BottleMasterResponse, BottleMasterCreate,
    BottleConfigurationResponse, BottleConfigurationCreate,
    BottleConfigurationBulkRequest,
    BottleOptionResponse,
    ParentChildMappingCreate, ParentChildMappingUpdate, ParentChildMappingBulkCreate,
    ParentChildMappingResponse,
)
from app.api.permissions import (
    require_module_edit,
    require_any_module_read,
    MODULE_PRODUCTION_PLANNING,
    MODULE_BOTTLE_MASTER,
)
from app.api.auth import get_current_user
from app.models.auth import AuthUser

router = APIRouter(prefix="/products", tags=["Production Products"])

@router.get("/bottles/", response_model=List[BottleMasterResponse])
def get_all_bottles(db: Session = Depends(get_db), _user: AuthUser = Depends(require_any_module_read([MODULE_PRODUCTION_PLANNING, MODULE_BOTTLE_MASTER]))):
    return db.query(BottleMaster).all()

@router.post("/bottles/", response_model=BottleMasterResponse)
def create_bottle(
    bottle_in: BottleMasterCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    """Creates a bottle identity (name only).

    A bottle is NOT created per machine: bottle_master holds the name, and the
    per-machine section weight/speeds are configured separately through
    bottle_configuration.
    """
    duplicate = db.query(BottleMaster).filter(
        func.lower(BottleMaster.bottle_name) == bottle_in.bottle_name.strip().lower()
    ).first()
    if duplicate:
        raise HTTPException(
            status_code=400,
            detail=f"A bottle named '{bottle_in.bottle_name.strip()}' already exists.",
        )

    new_bottle = BottleMaster(bottle_name=bottle_in.bottle_name.strip())
    db.add(new_bottle)
    # bottle_id comes from the sequence, so flush first and then record the
    # new bottle as its own parent (group_id == bottle_id). Without this a
    # freshly created bottle would have a NULL group_id and would not be
    # selectable as a parent bottle in the parent/child mapping screen.
    # The audit row joins the same transaction, so one commit persists both.
    db.flush()
    new_bottle.group_id = new_bottle.bottle_id
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="CREATED_BOTTLE",
        details=f"User ({current_user.employee_id}) created Bottle '{new_bottle.bottle_name}' with ID {new_bottle.bottle_id}"
    ))
    db.commit()
    db.refresh(new_bottle)

    return new_bottle

@router.put("/bottles/{bottle_id}", response_model=BottleMasterResponse)
def update_bottle(
    bottle_id: int,
    bottle_in: BottleMasterCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    existing = db.query(BottleMaster).filter(BottleMaster.bottle_id == bottle_id).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Bottle not found.")

    new_name = bottle_in.bottle_name.strip()
    duplicate = db.query(BottleMaster).filter(
        BottleMaster.bottle_id != bottle_id,
        func.lower(BottleMaster.bottle_name) == new_name.lower(),
    ).first()
    if duplicate:
        raise HTTPException(
            status_code=400,
            detail=f"A bottle named '{new_name}' already exists.",
        )

    existing.bottle_name = new_name

    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="UPDATED_BOTTLE",
        details=f"User ({current_user.employee_id}) updated Bottle {bottle_id} to '{new_name}'"
    ))
    db.commit()
    return existing


# ─── Parent–Child Bottle Mapping ──────────────────────────────────────────────
#
# The relationship lives exclusively in the existing
# production.bottle_master.group_id column:
#
#   group_id == bottle_id          -> the bottle is a parent (unmapped bottle)
#   group_id == <other bottle_id>  -> the bottle is a child of that parent
#
# Reading a relationship is the self-join the product spec calls for:
#
#   SELECT child.bottle_id, child.bottle_name, child.group_id,
#          parent.bottle_id, parent.bottle_name
#   FROM   production.bottle_master AS child
#   JOIN   production.bottle_master AS parent ON child.group_id = parent.bottle_id
#
# group_id is only a grouping pointer. It never rewrites bottle_id anywhere, so
# bottle_configuration, job_packaging, production_job and every report keep the
# exact bottle ids they were created with, and no weight/speed/machine data is
# touched by this section.

def _lock_bottle(db: Session, bottle_id: int) -> BottleMaster | None:
    """Fetch one bottle, taking a row lock on Postgres.

    The lock is only needed to stop two concurrent saves from both validating
    the same child bottle: SQLite already serialises writers and does not
    understand FOR UPDATE, so the lock is applied on the dialect that supports
    it and skipped elsewhere.
    """
    query = db.query(BottleMaster).filter(BottleMaster.bottle_id == bottle_id)
    if db.get_bind().dialect.name.startswith("postgresql"):
        query = query.with_for_update()
    return query.first()


def _mapping_query(db: Session, parent_bottle_id: int | None = None):
    """Self-join that resolves every child bottle to its parent bottle.

    The child.group_id != child.bottle_id filter drops the self-reference
    rows of unmapped bottles; without it every parent would appear as its own
    child and the saved-mappings list would be flooded with bogus pairs.
    """
    child = aliased(BottleMaster)
    parent = aliased(BottleMaster)
    query = (
        db.query(
            child.bottle_id.label("child_bottle_id"),
            child.bottle_name.label("child_bottle_name"),
            child.group_id,
            parent.bottle_id.label("parent_bottle_id"),
            parent.bottle_name.label("parent_bottle_name"),
        )
        .join(parent, child.group_id == parent.bottle_id)
        .filter(child.group_id != child.bottle_id)
    )
    if parent_bottle_id is not None:
        query = query.filter(parent.bottle_id == parent_bottle_id)
    return query.order_by(func.lower(parent.bottle_name), func.lower(child.bottle_name))


def _mapping_dict(row) -> dict:
    return {
        "parent_bottle_id": row.parent_bottle_id,
        "parent_bottle_name": row.parent_bottle_name,
        "child_bottle_id": row.child_bottle_id,
        "child_bottle_name": row.child_bottle_name,
    }


def _mapping_pair(parent: BottleMaster, child: BottleMaster) -> dict:
    return {
        "parent_bottle_id": parent.bottle_id,
        "parent_bottle_name": parent.bottle_name,
        "child_bottle_id": child.bottle_id,
        "child_bottle_name": child.bottle_name,
    }


@router.get("/bottles/parents/", response_model=List[BottleOptionResponse])
def get_parent_bottles(
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_any_module_read([MODULE_PRODUCTION_PLANNING, MODULE_BOTTLE_MASTER])),
):
    """Bottles that are valid parents: group_id == bottle_id.

    Bottles already assigned to another parent (group_id pointing elsewhere)
    are excluded, so a child can never be selected as a parent. A single
    indexed query — no full-table scan.
    """
    return (
        db.query(BottleMaster)
        .filter(BottleMaster.group_id == BottleMaster.bottle_id)
        .order_by(func.lower(BottleMaster.bottle_name), BottleMaster.bottle_id)
        .all()
    )


@router.get("/bottles/children/", response_model=List[BottleOptionResponse])
def get_child_bottles(
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_any_module_read([MODULE_PRODUCTION_PLANNING, MODULE_BOTTLE_MASTER])),
):
    """Bottles that may still be picked as a child.

    Excluded:
      * bottles already mapped to some parent (group_id != bottle_id) — they
        cannot be reassigned silently;
      * bottles that already own children — mapping them under another parent
        would turn a parent into a child and leave an invalid group.

    Two lightweight indexed queries (distinct owner ids, then the eligible
    rows ordered in SQL) instead of loading every bottle into Python.
    """
    referenced = {
        group_id
        for (group_id,) in db.query(BottleMaster.group_id)
        .filter(
            BottleMaster.group_id.isnot(None),
            BottleMaster.group_id != BottleMaster.bottle_id,
        )
        .distinct()
        .all()
    }
    query = db.query(BottleMaster).filter(
        or_(
            BottleMaster.group_id == BottleMaster.bottle_id,
            # Legacy rows created before group_id existed still load with a
            # NULL group_id; like before, they stay selectable as children.
            BottleMaster.group_id.is_(None),
        )
    )
    if referenced:
        query = query.filter(~BottleMaster.bottle_id.in_(referenced))
    return query.order_by(
        func.lower(BottleMaster.bottle_name), BottleMaster.bottle_id
    ).all()


@router.get("/bottles/mappings/", response_model=List[ParentChildMappingResponse])
def get_all_parent_child_mappings(
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_any_module_read([MODULE_PRODUCTION_PLANNING, MODULE_BOTTLE_MASTER])),
):
    """Every saved parent -> child relationship currently in bottle_master."""
    return [_mapping_dict(row) for row in _mapping_query(db).all()]


@router.get("/bottles/mappings/{parent_bottle_id}", response_model=List[ParentChildMappingResponse])
def get_parent_child_mappings(
    parent_bottle_id: int,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_any_module_read([MODULE_PRODUCTION_PLANNING, MODULE_BOTTLE_MASTER])),
):
    """Child bottles of one parent bottle (empty list when it has none)."""
    return [_mapping_dict(row) for row in _mapping_query(db, parent_bottle_id).all()]


@router.post("/bottles/mappings/", response_model=ParentChildMappingResponse)
def create_parent_child_mapping(
    mapping_in: ParentChildMappingCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    """Assign a child bottle to a parent bottle by setting group_id.

    Validates the pair first, then updates bottle_master.group_id and writes
    the audit entry in one transaction so a failure can never leave the
    relationship half applied. No other bottle column, bottle_configuration
    row or production record is modified.
    """
    parent_id = mapping_in.parent_bottle_id
    child_id = mapping_in.child_bottle_id

    if parent_id == child_id:
        raise HTTPException(status_code=400, detail="Parent bottle and child bottle cannot be the same.")

    parent = db.query(BottleMaster).filter(BottleMaster.bottle_id == parent_id).first()
    if parent is None:
        raise HTTPException(status_code=404, detail=f"Parent bottle {parent_id} does not exist.")
    child = _lock_bottle(db, child_id)
    if child is None:
        raise HTTPException(status_code=404, detail=f"Child bottle {child_id} does not exist.")

    # Targeted checks on the two fetched rows plus one EXISTS-style query,
    # instead of classifying the whole bottle_master table. A parent is valid
    # exactly when its own group_id points at itself.
    if parent.group_id != parent_id:
        raise HTTPException(
            status_code=400,
            detail=f"Bottle {parent_id} ('{parent.bottle_name}') is not a valid parent bottle.",
        )
    if child.group_id is not None and child.group_id != child_id:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Bottle {child_id} ('{child.bottle_name}') is already mapped to parent "
                f"{child.group_id}. Remove or edit that mapping first."
            ),
        )
    has_own_children = (
        db.query(BottleMaster.bottle_id)
        .filter(
            BottleMaster.group_id == child_id,
            BottleMaster.bottle_id != child_id,
        )
        .first()
        is not None
    )
    if has_own_children:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Bottle {child_id} ('{child.bottle_name}') already has child mappings of its "
                "own, so it cannot be assigned as a child bottle."
            ),
        )

    child.group_id = parent_id
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="MAPPED_BOTTLE",
        details=(
            f"User ({current_user.employee_id}) mapped child Bottle {child_id} "
            f"('{child.bottle_name}') to parent Bottle {parent_id} ('{parent.bottle_name}')"
        ),
    ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to save the parent-child bottle mapping.")

    return _mapping_pair(parent, child)


@router.post("/bottles/mappings/bulk/", response_model=List[ParentChildMappingResponse])
def bulk_create_parent_child_mappings(
    payload: ParentChildMappingBulkCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    """Assign several child bottles to one parent in a single transaction.

    Every child is validated with the same rules as the single mapping endpoint
    (exists, not already mapped, owns no children of its own); if any child is
    invalid nothing is written. On success all rows are updated with one UPDATE
    statement and one audit entry in one commit, so adding N children to the
    same parent costs one round-trip instead of N. No bottle_id, bottle_name,
    bottle_configuration row or production record is modified.
    """
    parent_id = payload.parent_bottle_id
    # De-duplicated, order preserved: re-picking the same child cannot create
    # a duplicate mapping.
    child_ids = list(dict.fromkeys(payload.child_bottle_ids))

    if not child_ids:
        raise HTTPException(status_code=400, detail="Select at least one child bottle.")
    if parent_id in child_ids:
        raise HTTPException(status_code=400, detail="Parent bottle and child bottle cannot be the same.")

    parent = db.query(BottleMaster).filter(BottleMaster.bottle_id == parent_id).first()
    if parent is None:
        raise HTTPException(status_code=404, detail=f"Parent bottle {parent_id} does not exist.")
    if parent.group_id != parent_id:
        raise HTTPException(
            status_code=400,
            detail=f"Bottle {parent_id} ('{parent.bottle_name}') is not a valid parent bottle.",
        )

    children = db.query(BottleMaster).filter(BottleMaster.bottle_id.in_(child_ids)).all()
    by_id = {c.bottle_id: c for c in children}
    for child_id in child_ids:
        child = by_id.get(child_id)
        if child is None:
            raise HTTPException(status_code=404, detail=f"Child bottle {child_id} does not exist.")
        if child.group_id is not None and child.group_id != child_id:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Bottle {child_id} ('{child.bottle_name}') is already mapped to parent "
                    f"{child.group_id}. Remove or edit that mapping first."
                ),
            )

    kid = (
        db.query(BottleMaster)
        .filter(
            BottleMaster.group_id.in_(child_ids),
            ~BottleMaster.bottle_id.in_(child_ids),
        )
        .first()
    )
    if kid is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Bottle {kid.group_id} already has child mappings of its "
                "own, so it cannot be assigned as a child bottle."
            ),
        )

    db.query(BottleMaster).filter(BottleMaster.bottle_id.in_(child_ids)).update(
        {BottleMaster.group_id: parent_id}, synchronize_session=False
    )
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="MAPPED_BOTTLE",
        details=(
            f"User ({current_user.employee_id}) mapped child Bottles {child_ids} "
            f"to parent Bottle {parent_id} ('{parent.bottle_name}')"
        ),
    ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to save the parent-child bottle mappings.")

    ordered = sorted(children, key=lambda c: ((c.bottle_name or "").lower(), c.bottle_id))
    return [_mapping_pair(parent, child) for child in ordered]


@router.put("/bottles/mappings/{child_bottle_id}", response_model=ParentChildMappingResponse)
def update_parent_child_mapping(
    child_bottle_id: int,
    mapping_in: ParentChildMappingUpdate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    """Re-point an existing mapping: move a child bottle under a new parent."""
    parent_id = mapping_in.parent_bottle_id
    if parent_id == child_bottle_id:
        raise HTTPException(status_code=400, detail="Parent bottle and child bottle cannot be the same.")

    parent = db.query(BottleMaster).filter(BottleMaster.bottle_id == parent_id).first()
    if parent is None:
        raise HTTPException(status_code=404, detail=f"Parent bottle {parent_id} does not exist.")
    child = _lock_bottle(db, child_bottle_id)
    if child is None:
        raise HTTPException(status_code=404, detail=f"Child bottle {child_bottle_id} does not exist.")
    if child.group_id is None or child.group_id == child_bottle_id:
        raise HTTPException(
            status_code=400,
            detail=f"Bottle {child_bottle_id} ('{child.bottle_name}') is not part of any mapping.",
        )

    previous_parent_id = child.group_id
    if parent.group_id != parent_id:
        raise HTTPException(
            status_code=400,
            detail=f"Bottle {parent_id} ('{parent.bottle_name}') is not a valid parent bottle.",
        )

    child.group_id = parent_id
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="UPDATED_BOTTLE_MAPPING",
        details=(
            f"User ({current_user.employee_id}) moved child Bottle {child_bottle_id} "
            f"('{child.bottle_name}') from parent Bottle {previous_parent_id} to "
            f"parent Bottle {parent_id} ('{parent.bottle_name}')"
        ),
    ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to update the parent-child bottle mapping.")

    return _mapping_pair(parent, child)


@router.delete("/bottles/mappings/{child_bottle_id}")
def delete_parent_child_mapping(
    child_bottle_id: int,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    """Remove a mapping: the child bottle becomes its own parent again.

    Only group_id is reset (to the bottle's own bottle_id); the bottle itself
    and every reference to it elsewhere stay untouched.
    """
    child = _lock_bottle(db, child_bottle_id)
    if child is None:
        raise HTTPException(status_code=404, detail=f"Bottle {child_bottle_id} does not exist.")
    if child.group_id is None or child.group_id == child_bottle_id:
        raise HTTPException(
            status_code=400,
            detail=f"Bottle {child_bottle_id} ('{child.bottle_name}') is not part of any mapping.",
        )

    previous_parent_id = child.group_id
    child.group_id = child.bottle_id
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="DELETED_BOTTLE_MAPPING",
        details=(
            f"User ({current_user.employee_id}) removed the mapping of child Bottle "
            f"{child_bottle_id} ('{child.bottle_name}') from parent Bottle {previous_parent_id}"
        ),
    ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to delete the parent-child bottle mapping.")

    return {"ok": True}


@router.get("/configurations/", response_model=List[BottleConfigurationResponse])
def get_all_configurations(
    machine_no: int | None = None,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_any_module_read([MODULE_PRODUCTION_PLANNING, MODULE_BOTTLE_MASTER])),
):
    """List bottle configurations.

    bottle_configuration is keyed on (machine_no, bottle_id, section), so a
    machine only ever sees its own rows: pass machine_no to fetch the
    configuration of that machine alone. Omitting it returns every row, which
    is what the Bottle Master screen and the planning cache bootstrap need.
    """
    query = db.query(BottleConfiguration)
    if machine_no is not None:
        query = query.filter(BottleConfiguration.machine_no == machine_no)
    return query.all()

@router.post("/configurations/", response_model=BottleConfigurationResponse)
def create_configuration(
    config_in: BottleConfigurationCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    existing = db.query(BottleConfiguration).filter(
        BottleConfiguration.machine_no == config_in.machine_no,
        BottleConfiguration.bottle_id == config_in.bottle_id,
        BottleConfiguration.section == config_in.section,
    ).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Configuration already exists for Machine {config_in.machine_no}, Bottle {config_in.bottle_id}, Section {config_in.section}."
        )

    new_config = BottleConfiguration(
        machine_no=config_in.machine_no,
        bottle_id=config_in.bottle_id,
        section=config_in.section,
        weight=config_in.weight,
        speeds=config_in.speeds
    )
    db.add(new_config)
    db.commit()
    db.refresh(new_config)

    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="CONFIGURED_BOTTLE",
        details=f"User ({current_user.employee_id}) configured Bottle {new_config.bottle_id} on Machine {new_config.machine_no} Section {new_config.section}"
    ))
    db.commit()

    return new_config

@router.put("/configurations/{machine_no}/{bottle_id}/{section}", response_model=BottleConfigurationResponse)
def update_configuration(
    machine_no: int,
    bottle_id: int,
    section: int,
    config_in: BottleConfigurationCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    existing = db.query(BottleConfiguration).filter(
        BottleConfiguration.machine_no == machine_no,
        BottleConfiguration.bottle_id == bottle_id,
        BottleConfiguration.section == section,
    ).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Bottle configuration not found.")

    existing.weight = config_in.weight
    existing.speeds = config_in.speeds

    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="UPDATED_BOTTLE_CONFIG",
        details=f"User ({current_user.employee_id}) updated config for Bottle {bottle_id} on Machine {machine_no} Section {section}"
    ))
    db.commit()
    db.refresh(existing)
    return existing

@router.delete("/configurations/{machine_no}/{bottle_id}/{section}")
def delete_configuration(
    machine_no: int,
    bottle_id: int,
    section: int,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    existing = db.query(BottleConfiguration).filter(
        BottleConfiguration.machine_no == machine_no,
        BottleConfiguration.bottle_id == bottle_id,
        BottleConfiguration.section == section,
    ).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Bottle configuration not found.")

    db.delete(existing)
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="DELETED_BOTTLE_CONFIG",
        details=f"User ({current_user.employee_id}) deleted config for Bottle {bottle_id} on Machine {machine_no} Section {section}"
    ))
    db.commit()
    return {"ok": True}

@router.post("/configurations/bulk/")
def bulk_upsert_configurations(
    payload: BottleConfigurationBulkRequest,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_BOTTLE_MASTER)),
):
    """Upserts many bottle configurations atomically in a single transaction.

    Mimics the existing per-row create/update behavior: rows that already exist
    (machine_no, bottle_id, section) are updated with the same audit action as
    update_configuration; new rows are inserted with the CONFIGURED_BOTTLE action.
    The whole batch commits or rolls back together.
    """
    configs = payload.configurations
    if not configs:
        return {"ok": True, "saved": 0}

    existing_keys = set(
        (r.machine_no, r.bottle_id, r.section)
        for r in db.query(
            BottleConfiguration.machine_no,
            BottleConfiguration.bottle_id,
            BottleConfiguration.section,
        )
        .filter(
            or_(
                *[
                    and_(
                        BottleConfiguration.machine_no == c.machine_no,
                        BottleConfiguration.bottle_id == c.bottle_id,
                        BottleConfiguration.section == c.section,
                    )
                    for c in configs
                ]
            )
        )
        .all()
    )

    table = BottleConfiguration.__table__
    dialect = db.get_bind().dialect.name
    insert_stmt = (pg_insert if dialect.startswith("postgresql") else sqlite_insert)(table)
    upsert_stmt = insert_stmt.on_conflict_do_update(
        index_elements=[table.c.machine_no, table.c.bottle_id, table.c.section],
        set_={
            "weight": insert_stmt.excluded.weight,
            "speeds": insert_stmt.excluded.speeds,
        },
    )

    try:
        db.execute(
            upsert_stmt,
            [
                {
                    "machine_no": c.machine_no,
                    "bottle_id": c.bottle_id,
                    "section": c.section,
                    "weight": c.weight,
                    "speeds": c.speeds,
                }
                for c in configs
            ],
        )

        for c in configs:
            is_update = (c.machine_no, c.bottle_id, c.section) in existing_keys
            db.add(AuditLog(
                user_id=current_user.employee_id,
                action="UPDATED_BOTTLE_CONFIG" if is_update else "CONFIGURED_BOTTLE",
                details=(
                    f"User ({current_user.employee_id}) updated config for Bottle {c.bottle_id} on Machine {c.machine_no} Section {c.section}"
                    if is_update
                    else f"User ({current_user.employee_id}) configured Bottle {c.bottle_id} on Machine {c.machine_no} Section {c.section}"
                ),
            ))
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Failed to bulk save bottle configurations.")

    return {"ok": True, "saved": len(configs)}
