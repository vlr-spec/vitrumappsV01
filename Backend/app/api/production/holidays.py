# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session
from typing import List

from app.db.session import get_db
from app.models.holiday import HolidayMaster
from app.models.audit_log import AuditLog
from app.schemas.holiday import HolidayMasterResponse, HolidayMasterCreate
from app.api.permissions import require_module_edit, require_any_module_read, MODULE_HOLIDAY_MASTER, MODULE_PRODUCTION_PLANNING
from app.api.auth import get_current_user
from app.models.auth import AuthUser

router = APIRouter(prefix="/holidays", tags=["Holiday Master"])

@router.get("/", response_model=List[HolidayMasterResponse])
def get_all_holidays(
    db: Session = Depends(get_db),
    # Holidays are reference data: the planning grid renders them for anyone
    # who may read Production Planning, holiday management itself needs
    # Holiday Master read.  A 403 here must never block planning viewers from
    # loading their planning data.
    _user: AuthUser = Depends(require_any_module_read([MODULE_HOLIDAY_MASTER, MODULE_PRODUCTION_PLANNING])),
):
    return db.query(HolidayMaster).order_by(HolidayMaster.holiday_date).all()

@router.post("/", response_model=HolidayMasterResponse)
def create_holiday(
    holiday_in: HolidayMasterCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_HOLIDAY_MASTER)),
):
    existing = db.query(HolidayMaster).filter(HolidayMaster.holiday_date == holiday_in.holiday_date).first()
    if existing:
        raise HTTPException(status_code=400, detail="A holiday already exists for this date.")

    new_holiday = HolidayMaster(holiday_date=holiday_in.holiday_date, holiday_name=holiday_in.holiday_name)
    db.add(new_holiday)
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="CREATED_HOLIDAY",
        details=f"User ({current_user.employee_id}) created holiday '{new_holiday.holiday_name}' on {new_holiday.holiday_date}"
    ))
    db.commit()
    db.refresh(new_holiday)
    return new_holiday

@router.put("/{holiday_date}", response_model=HolidayMasterResponse)
def update_holiday(
    holiday_date: str,
    holiday_in: HolidayMasterCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_HOLIDAY_MASTER)),
):
    from datetime import date as dt_date
    parsed_date = dt_date.fromisoformat(holiday_date)
    existing = db.query(HolidayMaster).filter(HolidayMaster.holiday_date == parsed_date).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Holiday not found.")

    existing.holiday_name = holiday_in.holiday_name
    if holiday_in.holiday_date != parsed_date:
        conflict = db.query(HolidayMaster).filter(HolidayMaster.holiday_date == holiday_in.holiday_date).first()
        if conflict:
            raise HTTPException(status_code=400, detail="A holiday already exists for the new date.")
        existing.holiday_date = holiday_in.holiday_date

    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="UPDATED_HOLIDAY",
        details=f"User ({current_user.employee_id}) updated holiday '{existing.holiday_name}'"
    ))
    db.commit()
    db.refresh(existing)
    return existing

@router.delete("/{holiday_date}")
def delete_holiday(
    holiday_date: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_HOLIDAY_MASTER)),
):
    from datetime import date as dt_date
    parsed_date = dt_date.fromisoformat(holiday_date)
    existing = db.query(HolidayMaster).filter(HolidayMaster.holiday_date == parsed_date).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Holiday not found.")

    db.delete(existing)
    db.add(AuditLog(
        user_id=current_user.employee_id,
        action="DELETED_HOLIDAY",
        details=f"User ({current_user.employee_id}) deleted holiday '{existing.holiday_name}' on {parsed_date}"
    ))
    db.commit()
    return {"ok": True}