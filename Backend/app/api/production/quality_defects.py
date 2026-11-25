# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import case
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List

from app.db.session import get_db
from app.models.quality import DefectMaster
from app.schemas.quality import DefectMasterCreate, DefectMasterUpdate, DefectMasterResponse
from app.api.permissions import require_module_read, require_module_edit, MODULE_QUALITY_CONTROL
from app.models.auth import AuthUser

router = APIRouter()

# Display priority only — categories are data, not a whitelist. Any future
# category is returned after these and ordered by defect_sr like every other.
_DEFECT_CATEGORY_PRIORITY = ("Critical", "Major", "Minor", "Other")
_UNKNOWN_CATEGORY_PRIORITY = len(_DEFECT_CATEGORY_PRIORITY) + 1


def _defect_category_ordering():
    """ORDER BY expression: category priority, then defect_sr."""
    return case(
        *(
            (DefectMaster.defect_type == name, index)
            for index, name in enumerate(_DEFECT_CATEGORY_PRIORITY, start=1)
        ),
        else_=_UNKNOWN_CATEGORY_PRIORITY,
    )


def _clean_defect_type(value: str) -> str:
    """Accept any category stored in the master table, including `Other`."""
    cleaned = (value or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="defect_type cannot be empty")
    return cleaned


@router.get("/", response_model=List[DefectMasterResponse])
def list_defects(active_only: bool = True, db: Session = Depends(get_db), _user: AuthUser = Depends(require_module_read(MODULE_QUALITY_CONTROL))):
    """Return every master defect row, optionally excluding inactive ones.

    No filtering by defect_type is applied: all active categories (including
    `Other` and future ones) are fetched and sorted by category priority, then
    ascending defect_sr.
    """
    query = db.query(DefectMaster)
    if active_only:
        query = query.filter(DefectMaster.is_active == True)
    return query.order_by(
        _defect_category_ordering(), DefectMaster.defect_sr, DefectMaster.defect_id
    ).all()

@router.post("/", response_model=DefectMasterResponse)
def create_defect(
    defect: DefectMasterCreate,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL))
):
    defect.defect_type = _clean_defect_type(defect.defect_type)

    db_defect = DefectMaster(**defect.model_dump())
    db.add(db_defect)
    try:
        db.commit()
        db.refresh(db_defect)
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A defect with this name or (sr, type) already exists."
        )
    return db_defect

@router.put("/{defect_id}", response_model=DefectMasterResponse)
def update_defect(
    defect_id: int,
    defect_update: DefectMasterUpdate,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL))
):
    db_defect = db.query(DefectMaster).filter(DefectMaster.defect_id == defect_id).first()
    if not db_defect:
        raise HTTPException(status_code=404, detail="Defect not found")

    update_data = defect_update.model_dump(exclude_unset=True)
    if "defect_type" in update_data:
        update_data["defect_type"] = _clean_defect_type(update_data["defect_type"])

    for key, value in update_data.items():
        setattr(db_defect, key, value)
        
    try:
        db.commit()
        db.refresh(db_defect)
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A defect with this name or (sr, type) already exists."
        )
    return db_defect