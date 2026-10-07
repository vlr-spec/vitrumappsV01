# pyrefly: ignore [missing-import]
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Dict, Union
from datetime import date, time, datetime

# --- Defect Master Schemas ---

class DefectMasterBase(BaseModel):
    defect_type: str = Field(..., description="Critical, Major, or Minor")
    defect_sr: int
    defect_name: str
    is_active: bool = True

class DefectMasterCreate(DefectMasterBase):
    pass

class DefectMasterUpdate(BaseModel):
    defect_type: Optional[str] = None
    defect_sr: Optional[int] = None
    defect_name: Optional[str] = None
    is_active: Optional[bool] = None

class DefectMasterResponse(DefectMasterBase):
    defect_id: int

    class Config:
        from_attributes = True

# --- Quality Daily Aggregate Schemas ---

class QualityHourlyEntrySchema(BaseModel):
    # entry_id / report_id are echoed back by the client for convenience only —
    # the backend identifies rows by (machine_no, production_time) and takes the
    # report from production_date. They are optional so a row the frontend
    # invented locally (blank slot, "+" copy) never fails validation with a 422
    # that would abort the whole save.
    entry_id: Optional[Union[int, str]] = None
    report_id: Optional[Union[int, str]] = None
    machine_no: int
    shift_id: int
    production_time: str
    bottle_id: Optional[int] = None
    weight_front: Optional[float] = None
    weight_middle: Optional[float] = None
    weight_rear: Optional[float] = None
    weight_avg: Optional[float] = None
    speed_per_min: Optional[float] = None
    packing_category: Union[List[str], str, None] = None
    packing_size: Optional[int] = None
    cartons: Optional[int] = None
    bottles_in_nos: Optional[int] = None
    efficiency_percentage: Optional[float] = None
    weight_efficiency: Optional[float] = None
    sqc: Optional[int] = None
    qc_hold: Optional[int] = None
    num: Optional[int] = None
    remarks: Optional[str] = None
    defect_ids: List[str] = []
    job_id: Optional[str] = None
    # Logical grouping identifier for manual-split time segments (e.g. "SG001").
    # Echoed/persisted only — never influences job, scheduling or calculation logic.
    split_group_id: Optional[str] = None
    # Row lock status of this hourly row (hourly_production.is_locked).
    # Read-only through this schema: the daily save never writes it (only the
    # dedicated lock endpoint does), so a client cannot unlock a row by simply
    # echoing is_locked = false in a save payload.
    is_locked: Optional[bool] = False

    @field_validator(
        "bottle_id",
        "packing_size",
        "cartons",
        "bottles_in_nos",
        "sqc",
        "qc_hold",
        "num",
        mode="before",
    )
    @classmethod
    def _whole_number(cls, value):
        """Coerce integer columns before validation.

        The grid uses free numeric inputs, so a keystroke like "12.5" arrives as
        a fractional float. Rejecting it with a 422 would abort the WHOLE day's
        save (every row is one request), so whole-number columns are truncated
        here instead. Genuinely non-numeric input is still reported as a
        validation error rather than being silently stored.
        """
        if value is None or value == "":
            return None
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, int):
            return value
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError("must be a whole number")
        if number != number or number in (float("inf"), float("-inf")):
            raise ValueError("must be a whole number")
        return int(number)

class QualityShiftAssignmentSchema(BaseModel):
    supervisor: str
    executive: str

class QualityDailyRequest(BaseModel):
    production_date: str
    hourly: Dict[str, Dict[str, QualityHourlyEntrySchema]]
    shift_assignments: Dict[str, QualityShiftAssignmentSchema]
    # Explicitly deleted manual split rows (machine -> list of time labels).
    # Hourly rows are never deleted; splits are minute-granularity rows that the
    # frontend removes locally and the backend drops here so the delete persists
    # after Save/Refresh/reload and the next hour's original period is restored.
    deleted_splits: Optional[Dict[str, List[str]]] = None

class QualityDailyResponse(BaseModel):
    hourly: Dict[str, Dict[str, QualityHourlyEntrySchema]]
    shift_assignments: Dict[str, QualityShiftAssignmentSchema]
    continuation: Optional[Dict[str, Dict[str, QualityHourlyEntrySchema]]] = None

class QualityRowLockRequest(BaseModel):
    """Lock/unlock exactly ONE hourly row (POST /api/production/quality/daily/lock/).

    This is the only API allowed to write hourly_production.is_locked, and it
    touches nothing else on the row: one request persists one checkbox. The
    row is addressed the same way the grid identifies it — production date +
    machine + time-of-day label — so no entry_id has to be known by the client.
    """
    production_date: str
    machine_no: int
    production_time: str
    is_locked: bool

class QualityRowLockResponse(BaseModel):
    """Confirmation of the persisted lock state for the one row requested."""
    entry_id: Optional[Union[int, str]] = None
    machine_no: int
    production_time: str
    is_locked: bool

class QualityJobRowSchema(BaseModel):
    """One machine + Job ID row of the job-wise production summary.

    job_start_time / job_end_time carry the PRODUCTION date together with the
    job's start/end clock time: a slot between 12:00 AM and 8:59 AM belongs to
    the previous production date, so its date part is that production date,
    never the next calendar day.
    """
    machine_no: int
    job_id: str
    bottle_id: Optional[int] = None
    job_start_time: datetime
    job_end_time: Optional[datetime] = None
    status: str = ""
    remarks: Optional[str] = None
    production_units: int = 0

