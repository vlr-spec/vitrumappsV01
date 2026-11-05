# pyrefly: ignore [missing-import]
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Union
from datetime import date, time, datetime


def parse_time_input(value: Union[time, str, None]) -> Optional[time]:
    if value is None:
        return None
    if isinstance(value, time):
        return value.replace(second=0, microsecond=0)
    raw = str(value).strip().upper()
    if not raw:
        return None
    for fmt in ("%I:%M %p", "%I:%M%p", "%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(raw, fmt).time().replace(second=0, microsecond=0)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(raw).time().replace(second=0, microsecond=0)
    except ValueError:
        pass
    raise ValueError(f"Invalid time format: {value!r}")


def format_time_display(t: Optional[time]) -> str:
    if t is None:
        return ""
    hour = t.hour % 12 or 12
    ap = "AM" if t.hour < 12 else "PM"
    return f"{hour}:{t.minute:02d} {ap}"


class EmployeeResponse(BaseModel):
    """One employee available for a dropdown.

    ``roles`` lists the ACTIVE ``sqc.sqc_role`` role codes held by the employee
    (e.g. CHECKER, QA_EXECUTIVE) so the frontend can populate the Checker and
    QA Executive dropdowns from a single request.
    """

    employee_id: str
    employee_name: str
    roles: List[str] = []


# --- Numbering Schemas ---

class NumberingEntryBase(BaseModel):
    production_date: Union[date, str]
    machine_no: int = Field(..., ge=1, le=4)
    job_id: str = Field(..., min_length=1)
    bottle_id: Optional[int] = None
    pack_type: Optional[str] = None
    shift: int = Field(..., ge=1, le=3)
    entry_time: Union[time, str]
    pcs_per_pack: Optional[int] = Field(None, ge=0)
    cartons: Optional[int] = Field(None, ge=0)
    defective_bottles: Optional[int] = Field(None, ge=0)
    defect_id: Optional[Union[int, str]] = None
    defect_ids: Optional[List[Union[int, str]]] = None
    mould: Optional[str] = None
    section_no: Optional[str] = None
    checker_id: Optional[str] = None
    remarks: Optional[str] = None

    @field_validator("production_date", mode="before")
    @classmethod
    def validate_date(cls, v):
        if isinstance(v, date):
            return v
        if isinstance(v, str):
            return datetime.strptime(v.strip(), "%Y-%m-%d").date()
        raise ValueError("Invalid date format, expected YYYY-MM-DD")

    @field_validator("entry_time", mode="before")
    @classmethod
    def validate_entry_time(cls, v):
        t = parse_time_input(v)
        if t is None:
            raise ValueError("entry_time cannot be empty")
        return t

    @field_validator("bottle_id", "pcs_per_pack", "cartons", "defective_bottles", mode="before")
    @classmethod
    def coerce_int(cls, v):
        if v is None or v == "":
            return None
        return int(v)

    @field_validator("defect_id", mode="before")
    @classmethod
    def coerce_defect_id(cls, v):
        if v is None or v == "":
            return None
        return int(v)

    @field_validator("defect_ids", mode="before")
    @classmethod
    def coerce_defect_ids(cls, v):
        if not v:
            return None
        res = []
        for item in v:
            if item is not None and str(item).strip() != "":
                res.append(int(item))
        return res


class NumberingEntryCreate(NumberingEntryBase):
    pass


class NumberingEntryUpdate(BaseModel):
    production_date: Optional[Union[date, str]] = None
    machine_no: Optional[int] = Field(None, ge=1, le=4)
    job_id: Optional[str] = None
    bottle_id: Optional[int] = None
    pack_type: Optional[str] = None
    shift: Optional[int] = Field(None, ge=1, le=3)
    entry_time: Optional[Union[time, str]] = None
    pcs_per_pack: Optional[int] = Field(None, ge=0)
    cartons: Optional[int] = Field(None, ge=0)
    defective_bottles: Optional[int] = Field(None, ge=0)
    defect_id: Optional[Union[int, str]] = None
    defect_ids: Optional[List[Union[int, str]]] = None
    entry_ids: Optional[List[Union[int, str]]] = None
    mould: Optional[str] = None
    section_no: Optional[str] = None
    checker_id: Optional[str] = None
    remarks: Optional[str] = None

    @field_validator("production_date", mode="before")
    @classmethod
    def validate_date(cls, v):
        if v is None or v == "":
            return None
        if isinstance(v, date):
            return v
        return datetime.strptime(str(v).strip(), "%Y-%m-%d").date()

    @field_validator("entry_time", mode="before")
    @classmethod
    def validate_entry_time(cls, v):
        if v is None or v == "":
            return None
        return parse_time_input(v)

    @field_validator("bottle_id", "pcs_per_pack", "cartons", "defective_bottles", mode="before")
    @classmethod
    def coerce_int(cls, v):
        if v is None or v == "":
            return None
        return int(v)

    @field_validator("defect_id", mode="before")
    @classmethod
    def coerce_defect_id(cls, v):
        if v is None or v == "":
            return None
        return int(v)

    @field_validator("defect_ids", mode="before")
    @classmethod
    def coerce_defect_ids(cls, v):
        if not v:
            return None
        res = []
        for item in v:
            if item is not None and str(item).strip() != "":
                res.append(int(item))
        return res

    @field_validator("entry_ids", mode="before")
    @classmethod
    def coerce_entry_ids(cls, v):
        if not v:
            return None
        return [str(item) for item in v if item is not None and str(item).strip() != ""]


class NumberingEntryUpdateWithId(NumberingEntryUpdate):
    entry_id: Union[int, str]


class NumberingEntryResponse(BaseModel):
    entry_id: str
    entry_ids: Optional[List[str]] = None
    production_date: str
    machine_no: int
    job_id: str
    bottle_id: Optional[int] = None
    bottle_name: Optional[str] = None
    pack_type: Optional[str] = None
    shift: int
    entry_time: str
    pcs_per_pack: Optional[int] = None
    cartons: Optional[int] = None
    defective_bottles: Optional[int] = None
    defect_id: Optional[str] = None
    defect_ids: Optional[List[str]] = None
    defect_name: Optional[str] = None
    defect_names: Optional[List[str]] = None
    mould: Optional[str] = None
    section_no: Optional[str] = None
    checker_id: Optional[str] = None
    checker_name: Optional[str] = None
    qa_shift_ex_id: Optional[str] = None
    qa_shift_ex_name: Optional[str] = None
    remarks: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class NumberingSaveRequest(BaseModel):
    inserts: List[NumberingEntryCreate] = []
    updates: List[NumberingEntryUpdateWithId] = []


# --- SQC/QC HOLD Schemas ---

class SqcQcHoldEntryBase(BaseModel):
    production_date: Union[date, str]
    machine_no: int = Field(..., ge=1, le=4)
    job_id: str = Field(..., min_length=1)
    bottle_id: Optional[int] = None
    pack_type: Optional[str] = None
    lot_no: Optional[str] = None
    shift: int = Field(..., ge=1, le=3)
    entry_time: Union[time, str]
    pcs_per_pack: Optional[int] = Field(None, ge=0)
    cartons: Optional[int] = Field(None, ge=0)
    defective_bottles: Optional[int] = Field(None, ge=0)
    defect_id: Optional[Union[int, str]] = None
    defect_ids: Optional[List[Union[int, str]]] = None
    mould: Optional[str] = None
    section_no: Optional[str] = None
    checker_id: Optional[str] = None
    remarks: Optional[str] = None

    @field_validator("production_date", mode="before")
    @classmethod
    def validate_date(cls, v):
        if isinstance(v, date):
            return v
        if isinstance(v, str):
            return datetime.strptime(v.strip(), "%Y-%m-%d").date()
        raise ValueError("Invalid date format, expected YYYY-MM-DD")

    @field_validator("entry_time", mode="before")
    @classmethod
    def validate_entry_time(cls, v):
        t = parse_time_input(v)
        if t is None:
            raise ValueError("entry_time cannot be empty")
        return t

    @field_validator("bottle_id", "pcs_per_pack", "cartons", "defective_bottles", mode="before")
    @classmethod
    def coerce_int(cls, v):
        if v is None or v == "":
            return None
        return int(v)

    @field_validator("defect_id", mode="before")
    @classmethod
    def coerce_defect_id(cls, v):
        if v is None or v == "":
            return None
        return int(v)

    @field_validator("defect_ids", mode="before")
    @classmethod
    def coerce_defect_ids(cls, v):
        if not v:
            return None
        res = []
        for item in v:
            if item is not None and str(item).strip() != "":
                res.append(int(item))
        return res


class SqcQcHoldEntryCreate(SqcQcHoldEntryBase):
    pass


class SqcQcHoldEntryUpdate(BaseModel):
    production_date: Optional[Union[date, str]] = None
    machine_no: Optional[int] = Field(None, ge=1, le=4)
    job_id: Optional[str] = None
    bottle_id: Optional[int] = None
    pack_type: Optional[str] = None
    lot_no: Optional[str] = None
    shift: Optional[int] = Field(None, ge=1, le=3)
    entry_time: Optional[Union[time, str]] = None
    pcs_per_pack: Optional[int] = Field(None, ge=0)
    cartons: Optional[int] = Field(None, ge=0)
    defective_bottles: Optional[int] = Field(None, ge=0)
    defect_id: Optional[Union[int, str]] = None
    defect_ids: Optional[List[Union[int, str]]] = None
    entry_ids: Optional[List[Union[int, str]]] = None
    mould: Optional[str] = None
    section_no: Optional[str] = None
    checker_id: Optional[str] = None
    remarks: Optional[str] = None

    @field_validator("production_date", mode="before")
    @classmethod
    def validate_date(cls, v):
        if v is None or v == "":
            return None
        if isinstance(v, date):
            return v
        return datetime.strptime(str(v).strip(), "%Y-%m-%d").date()

    @field_validator("entry_time", mode="before")
    @classmethod
    def validate_entry_time(cls, v):
        if v is None or v == "":
            return None
        return parse_time_input(v)

    @field_validator("bottle_id", "pcs_per_pack", "cartons", "defective_bottles", mode="before")
    @classmethod
    def coerce_int(cls, v):
        if v is None or v == "":
            return None
        return int(v)

    @field_validator("defect_id", mode="before")
    @classmethod
    def coerce_defect_id(cls, v):
        if v is None or v == "":
            return None
        return int(v)

    @field_validator("defect_ids", mode="before")
    @classmethod
    def coerce_defect_ids(cls, v):
        if not v:
            return None
        res = []
        for item in v:
            if item is not None and str(item).strip() != "":
                res.append(int(item))
        return res

    @field_validator("entry_ids", mode="before")
    @classmethod
    def coerce_entry_ids(cls, v):
        if not v:
            return None
        return [str(item) for item in v if item is not None and str(item).strip() != ""]


class SqcQcHoldEntryUpdateWithId(SqcQcHoldEntryUpdate):
    entry_id: Union[int, str]


class SqcQcHoldEntryResponse(BaseModel):
    entry_id: str
    entry_ids: Optional[List[str]] = None
    production_date: str
    machine_no: int
    job_id: str
    bottle_id: Optional[int] = None
    bottle_name: Optional[str] = None
    pack_type: Optional[str] = None
    lot_no: Optional[str] = None
    shift: int
    entry_time: str
    pcs_per_pack: Optional[int] = None
    cartons: Optional[int] = None
    defective_bottles: Optional[int] = None
    defect_id: Optional[str] = None
    defect_ids: Optional[List[str]] = None
    defect_name: Optional[str] = None
    defect_names: Optional[List[str]] = None
    mould: Optional[str] = None
    section_no: Optional[str] = None
    checker_id: Optional[str] = None
    checker_name: Optional[str] = None
    qa_shift_ex_id: Optional[str] = None
    qa_shift_ex_name: Optional[str] = None
    remarks: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SqcQcHoldSaveRequest(BaseModel):
    inserts: List[SqcQcHoldEntryCreate] = []
    updates: List[SqcQcHoldEntryUpdateWithId] = []


class RepackingSaveResponse(BaseModel):
    inserted_count: int
    updated_count: int
    items: List[Union[NumberingEntryResponse, SqcQcHoldEntryResponse]]


class RepackingDataResponse(BaseModel):
    """Combined response for both numbering and SQC/QC HOLD entries of one date.

    Allows the frontend to fetch all saved repacking data for a production date
    in a single API request instead of two separate round-trips.
    """
    numbering: List[NumberingEntryResponse] = []
    sqc_qc_hold: List[SqcQcHoldEntryResponse] = []
