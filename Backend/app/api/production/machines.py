from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.db.session import get_db
from app.models.machine import MachineMaster
from app.models.audit_log import AuditLog
from app.schemas.machine import MachineMasterResponse, MachineMasterCreate
from app.api.permissions import (
    require_module_edit,
    require_any_module_read,
    MODULE_PRODUCTION_PLANNING,
    MODULE_BOTTLE_MASTER,
    MODULE_QUALITY_CONTROL,
)
from app.api.auth import get_current_user
from app.models.auth import AuthUser

router = APIRouter(prefix="/machines", tags=["Production Machines"])

@router.get("/", response_model=List[MachineMasterResponse])
def get_all_machines(
    db: Session = Depends(get_db),
    # Reference data: the planning grid, the Bottle Master panel and the
    # Quality Control reports all need the machine list, so read access to any
    # of those modules is sufficient.
    _user: AuthUser = Depends(require_any_module_read([MODULE_PRODUCTION_PLANNING, MODULE_BOTTLE_MASTER, MODULE_QUALITY_CONTROL])),
):
    machines = db.query(MachineMaster).all()
    return machines

@router.post("/", response_model=MachineMasterResponse)
def create_machine(
    machine_in: MachineMasterCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_PRODUCTION_PLANNING)),
):
    if machine_in.machine_no not in [1, 2, 3, 4]:
        raise HTTPException(status_code=400, detail="Only Machines 1, 2, 3, and 4 are supported in this factory.")

    if machine_in.gob_type not in [2, 3]:
        raise HTTPException(status_code=400, detail="Gob type must be 2 (Double Gob) or 3 (Triple Gob).")

    if machine_in.max_section < 1:
        raise HTTPException(status_code=400, detail="Max section must be at least 1.")

    new_machine = MachineMaster(
        machine_no=machine_in.machine_no,
        gob_type=machine_in.gob_type,
        max_section=machine_in.max_section
    )
    db.add(new_machine)

    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="CREATED_MACHINE",
        details=f"User ({current_user.employee_id}) created Machine {new_machine.machine_no}"
    ))

    db.commit()
    db.refresh(new_machine)
    return new_machine

@router.put("/{machine_no}", response_model=MachineMasterResponse)
def update_machine(
    machine_no: int,
    machine_in: MachineMasterCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_PRODUCTION_PLANNING)),
):
    existing = db.query(MachineMaster).filter(MachineMaster.machine_no == machine_no).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Machine not found.")

    if machine_no not in [1, 2, 3, 4]:
        raise HTTPException(status_code=400, detail="Only Machines 1, 2, 3, and 4 are supported in this factory.")

    existing.gob_type = machine_in.gob_type
    existing.max_section = machine_in.max_section

    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="UPDATED_MACHINE",
        details=f"User ({current_user.employee_id}) updated Machine {machine_no}"
    ))

    db.commit()
    db.refresh(existing)
    return existing
