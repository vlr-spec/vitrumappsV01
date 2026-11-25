# pyrefly: ignore [missing-import]
"""
Packaging Master CRUD -- reads and writes the existing ``hpr.packaging_master``
table (packaging_id, packaging_code UNIQUE, packaging_description).

RBAC: the panel itself lives inside Master Management and has no
``module_master`` row of its own, so writes reuse the database-driven
permissions of the Master Management child modules (Bottle Master / Holiday
Master). Quality Control screens also read packaging codes for their Pack Type
dropdowns, so the read route additionally accepts Quality Control read through
``require_any_module_read``. Nothing is granted here: read access lists the
rows, edit access is required for POST/PUT/DELETE, and every decision is read
from ``auth.user_module_permissions`` at request time.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.db.session import get_db
from app.models.packaging import PackagingMaster
from app.models.audit_log import AuditLog
from app.schemas.packaging import PackagingCreate, PackagingUpdate, PackagingResponse
from app.api.permissions import (
    MODULE_BOTTLE_MASTER,
    MODULE_HOLIDAY_MASTER,
    MODULE_QUALITY_CONTROL,
    require_any_module_edit,
    require_any_module_read,
)
from app.api.auth import get_current_user
from app.models.auth import AuthUser

router = APIRouter(prefix="/packaging", tags=["Packaging Master"])

# Master Management child modules: may edit ANY -> may create / update / delete
# packaging records. Quality Control only needs the read shared by its Pack Type
# dropdowns; it must never gain Master Management write access here.
MASTER_MANAGEMENT_MODULES = [MODULE_BOTTLE_MASTER, MODULE_HOLIDAY_MASTER]
PACKAGING_READ_MODULES = [*MASTER_MANAGEMENT_MODULES, MODULE_QUALITY_CONTROL]

CODE_MAX_LENGTH = 20
DESCRIPTION_MAX_LENGTH = 150


def _validated(packaging_code: str, packaging_description: str) -> tuple[str, str]:
    """Strip and validate the two mandatory fields before any database write.

    Mirrors the column limits (VARCHAR(20) / VARCHAR(150)) so an over-long
    value is rejected with a clear 400 instead of a database error.
    """
    code = (packaging_code or "").strip()
    description = (packaging_description or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Packaging Code is required.")
    if not description:
        raise HTTPException(status_code=400, detail="Packaging Description is required.")
    if len(code) > CODE_MAX_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Packaging Code must be {CODE_MAX_LENGTH} characters or fewer.",
        )
    if len(description) > DESCRIPTION_MAX_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Packaging Description must be {DESCRIPTION_MAX_LENGTH} characters or fewer.",
        )
    return code, description


@router.get("/", response_model=List[PackagingResponse])
def get_all_packaging(
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_any_module_read(PACKAGING_READ_MODULES)),
):
    # packaging_id order keeps the insertion order shown in the panel; the id
    # itself is only used as the internal key for UPDATE/DELETE.
    return db.query(PackagingMaster).order_by(PackagingMaster.packaging_id).all()


@router.post("/", response_model=PackagingResponse)
def create_packaging(
    packaging_in: PackagingCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_any_module_edit(MASTER_MANAGEMENT_MODULES)),
):
    code, description = _validated(packaging_in.packaging_code, packaging_in.packaging_description)

    # Exact-match uniqueness, the same rule as the packaging_code UNIQUE
    # constraint, so the API and the database can never disagree.
    existing = db.query(PackagingMaster).filter(PackagingMaster.packaging_code == code).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Packaging code '{code}' already exists.",
        )

    new_packaging = PackagingMaster(packaging_code=code, packaging_description=description)
    db.add(new_packaging)
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="CREATED_PACKAGING",
        details=f"User ({current_user.employee_id}) created packaging '{code}' ({description})",
    ))
    db.commit()
    db.refresh(new_packaging)
    return new_packaging


@router.put("/{packaging_id}", response_model=PackagingResponse)
def update_packaging(
    packaging_id: int,
    packaging_in: PackagingUpdate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_any_module_edit(MASTER_MANAGEMENT_MODULES)),
):
    # packaging_id is the unique identifier for UPDATE -- never packaging_code.
    existing = db.query(PackagingMaster).filter(PackagingMaster.packaging_id == packaging_id).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Packaging record not found.")

    code, description = _validated(packaging_in.packaging_code, packaging_in.packaging_description)

    conflict = (
        db.query(PackagingMaster)
        .filter(
            PackagingMaster.packaging_code == code,
            PackagingMaster.packaging_id != packaging_id,
        )
        .first()
    )
    if conflict:
        raise HTTPException(
            status_code=400,
            detail=f"Packaging code '{code}' already exists.",
        )

    previous_code = existing.packaging_code
    existing.packaging_code = code
    existing.packaging_description = description
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="UPDATED_PACKAGING",
        details=(
            f"User ({current_user.employee_id}) updated packaging id {packaging_id} "
            f"('{previous_code}' -> '{code}')"
        ),
    ))
    db.commit()
    db.refresh(existing)
    return existing


@router.delete("/{packaging_id}")
def delete_packaging(
    packaging_id: int,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_any_module_edit(MASTER_MANAGEMENT_MODULES)),
):
    # packaging_id is the unique identifier for DELETE -- never packaging_code.
    existing = db.query(PackagingMaster).filter(PackagingMaster.packaging_id == packaging_id).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Packaging record not found.")

    deleted_code = existing.packaging_code
    db.delete(existing)
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="DELETED_PACKAGING",
        details=f"User ({current_user.employee_id}) deleted packaging '{deleted_code}' (id {packaging_id})",
    ))
    db.commit()
    return {"ok": True}
