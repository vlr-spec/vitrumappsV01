# pyrefly: ignore [missing-import]
import logging
from typing import List, Optional, Union
from datetime import date, time as dtime, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy import text, bindparam

from app.db.session import get_db
from app.core.config import settings
from app.api.permissions import require_module_read, require_module_edit, MODULE_QUALITY_CONTROL
from app.models.auth import AuthUser
from app.models.audit_log import AuditLog
from app.schemas.repacking import (
    EmployeeResponse,
    NumberingEntryCreate,
    NumberingEntryUpdate,
    NumberingEntryResponse,
    NumberingSaveRequest,
    SqcQcHoldEntryCreate,
    SqcQcHoldEntryUpdate,
    SqcQcHoldEntryResponse,
    SqcQcHoldSaveRequest,
    format_time_display,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _sqc_table(table_name: str) -> str:
    schema = settings.sqc_schema
    return f'"{schema}"."{table_name}"' if schema else f'"{table_name}"'


def _production_table(table_name: str) -> str:
    schema = settings.production_schema
    return f'"{schema}"."{table_name}"' if schema else f'"{table_name}"'


def _hpr_table(table_name: str) -> str:
    schema = settings.hpr_schema
    return f'"{schema}"."{table_name}"' if schema else f'"{table_name}"'


def _auth_table(table_name: str) -> str:
    schema = settings.auth_schema
    return f'"{schema}"."{table_name}"' if schema else f'"{table_name}"'


def _format_time_sql(t: Union[dtime, str, None]) -> Optional[str]:
    if t is None:
        return None
    if isinstance(t, dtime):
        return t.strftime("%H:%M:%S")
    return str(t)


def _row_to_numbering_response(r) -> NumberingEntryResponse:
    entry_time_val = r["entry_time"]
    if isinstance(entry_time_val, dtime):
        time_str = format_time_display(entry_time_val)
    elif isinstance(entry_time_val, str):
        try:
            parts = entry_time_val.split(":")
            h, m = int(parts[0]), int(parts[1])
            time_str = format_time_display(dtime(h, m))
        except Exception:
            time_str = entry_time_val
    else:
        time_str = str(entry_time_val) if entry_time_val is not None else ""

    p_date = r["production_date"]
    date_str = p_date.isoformat() if isinstance(p_date, (date, datetime)) else str(p_date)

    c_at = r["created_at"]
    created_at_str = c_at.isoformat() if isinstance(c_at, datetime) else (str(c_at) if c_at else None)

    u_at = r["updated_at"]
    updated_at_str = u_at.isoformat() if isinstance(u_at, datetime) else (str(u_at) if u_at else None)

    return NumberingEntryResponse(
        entry_id=str(r["entry_id"]),
        entry_ids=r.get("entry_ids"),
        production_date=date_str,
        machine_no=int(r["machine_no"]),
        job_id=str(r["job_id"]),
        bottle_id=int(r["bottle_id"]) if r["bottle_id"] is not None else None,
        bottle_name=r.get("bottle_name"),
        pack_type=r["pack_type"],
        shift=int(r["shift"]),
        entry_time=time_str,
        pcs_per_pack=int(r["pcs_per_pack"]) if r["pcs_per_pack"] is not None else None,
        cartons=int(r["cartons"]) if r["cartons"] is not None else None,
        defective_bottles=int(r["defective_bottles"]) if r["defective_bottles"] is not None else None,
        defect_id=str(r["defect_id"]) if r["defect_id"] is not None else None,
        defect_ids=r.get("defect_ids"),
        defect_name=r.get("defect_name"),
        defect_names=r.get("defect_names"),
        mould=r["mould"],
        section_no=r["section_no"],
        checker_id=r["checker_id"],
        checker_name=r.get("checker_name"),
        qa_shift_ex_id=r["qa_shift_ex_id"],
        qa_shift_ex_name=r.get("qa_shift_ex_name"),
        created_at=created_at_str,
        updated_at=updated_at_str,
    )


def _row_to_sqc_response(r) -> SqcQcHoldEntryResponse:
    entry_time_val = r["entry_time"]
    if isinstance(entry_time_val, dtime):
        time_str = format_time_display(entry_time_val)
    elif isinstance(entry_time_val, str):
        try:
            parts = entry_time_val.split(":")
            h, m = int(parts[0]), int(parts[1])
            time_str = format_time_display(dtime(h, m))
        except Exception:
            time_str = entry_time_val
    else:
        time_str = str(entry_time_val) if entry_time_val is not None else ""

    p_date = r["production_date"]
    date_str = p_date.isoformat() if isinstance(p_date, (date, datetime)) else str(p_date)

    c_at = r["created_at"]
    created_at_str = c_at.isoformat() if isinstance(c_at, datetime) else (str(c_at) if c_at else None)

    u_at = r["updated_at"]
    updated_at_str = u_at.isoformat() if isinstance(u_at, datetime) else (str(u_at) if u_at else None)

    return SqcQcHoldEntryResponse(
        entry_id=str(r["entry_id"]),
        entry_ids=r.get("entry_ids"),
        production_date=date_str,
        machine_no=int(r["machine_no"]),
        job_id=str(r["job_id"]),
        bottle_id=int(r["bottle_id"]) if r["bottle_id"] is not None else None,
        bottle_name=r.get("bottle_name"),
        pack_type=r["pack_type"],
        lot_no=r["lot_no"],
        shift=int(r["shift"]),
        entry_time=time_str,
        pcs_per_pack=int(r["pcs_per_pack"]) if r["pcs_per_pack"] is not None else None,
        cartons=int(r["cartons"]) if r["cartons"] is not None else None,
        defective_bottles=int(r["defective_bottles"]) if r["defective_bottles"] is not None else None,
        defect_id=str(r["defect_id"]) if r["defect_id"] is not None else None,
        defect_ids=r.get("defect_ids"),
        defect_name=r.get("defect_name"),
        defect_names=r.get("defect_names"),
        mould=r["mould"],
        section_no=r["section_no"],
        checker_id=r["checker_id"],
        checker_name=r.get("checker_name"),
        qa_shift_ex_id=r["qa_shift_ex_id"],
        qa_shift_ex_name=r.get("qa_shift_ex_name"),
        created_at=created_at_str,
        updated_at=updated_at_str,
    )


def _group_numbering_rows(rows) -> List[NumberingEntryResponse]:
    grouped = {}
    for r in rows:
        time_key = _format_time_sql(r["entry_time"])
        key = (
            str(r["production_date"]),
            int(r["machine_no"]),
            int(r["shift"]),
            time_key,
            str(r["job_id"]),
            int(r["bottle_id"]) if r["bottle_id"] is not None else None,
            r["pack_type"],
            int(r["pcs_per_pack"]) if r["pcs_per_pack"] is not None else None,
            int(r["cartons"]) if r["cartons"] is not None else None,
            int(r["defective_bottles"]) if r["defective_bottles"] is not None else None,
            r["mould"],
            r["section_no"],
            r["checker_id"],
            r["qa_shift_ex_id"],
        )
        if key not in grouped:
            grouped[key] = {
                "base": dict(r),
                "entry_ids": [str(r["entry_id"])],
                "defect_ids": [str(r["defect_id"])] if r["defect_id"] is not None else [],
                "defect_names": [r["defect_name"]] if r.get("defect_name") else [],
            }
        else:
            grouped[key]["entry_ids"].append(str(r["entry_id"]))
            if r["defect_id"] is not None and str(r["defect_id"]) not in grouped[key]["defect_ids"]:
                grouped[key]["defect_ids"].append(str(r["defect_id"]))
            if r.get("defect_name") and r["defect_name"] not in grouped[key]["defect_names"]:
                grouped[key]["defect_names"].append(r["defect_name"])
            if r.get("updated_at") and (not grouped[key]["base"].get("updated_at") or r["updated_at"] > grouped[key]["base"]["updated_at"]):
                grouped[key]["base"]["updated_at"] = r["updated_at"]

    results = []
    for g in grouped.values():
        base = g["base"]
        defect_ids = g["defect_ids"]
        defect_names = g["defect_names"]
        base["defect_id"] = defect_ids[0] if defect_ids else None
        base["defect_ids"] = defect_ids
        base["defect_name"] = ", ".join(defect_names) if defect_names else None
        base["defect_names"] = defect_names
        base["entry_ids"] = g["entry_ids"]
        results.append(_row_to_numbering_response(base))
    return results


def _group_sqc_rows(rows) -> List[SqcQcHoldEntryResponse]:
    grouped = {}
    for r in rows:
        time_key = _format_time_sql(r["entry_time"])
        key = (
            str(r["production_date"]),
            int(r["machine_no"]),
            int(r["shift"]),
            time_key,
            str(r["job_id"]),
            int(r["bottle_id"]) if r["bottle_id"] is not None else None,
            r["pack_type"],
            r["lot_no"],
            int(r["pcs_per_pack"]) if r["pcs_per_pack"] is not None else None,
            int(r["cartons"]) if r["cartons"] is not None else None,
            int(r["defective_bottles"]) if r["defective_bottles"] is not None else None,
            r["mould"],
            r["section_no"],
            r["checker_id"],
            r["qa_shift_ex_id"],
        )
        if key not in grouped:
            grouped[key] = {
                "base": dict(r),
                "entry_ids": [str(r["entry_id"])],
                "defect_ids": [str(r["defect_id"])] if r["defect_id"] is not None else [],
                "defect_names": [r["defect_name"]] if r.get("defect_name") else [],
            }
        else:
            grouped[key]["entry_ids"].append(str(r["entry_id"]))
            if r["defect_id"] is not None and str(r["defect_id"]) not in grouped[key]["defect_ids"]:
                grouped[key]["defect_ids"].append(str(r["defect_id"]))
            if r.get("defect_name") and r["defect_name"] not in grouped[key]["defect_names"]:
                grouped[key]["defect_names"].append(r["defect_name"])
            if r.get("updated_at") and (not grouped[key]["base"].get("updated_at") or r["updated_at"] > grouped[key]["base"]["updated_at"]):
                grouped[key]["base"]["updated_at"] = r["updated_at"]

    results = []
    for g in grouped.values():
        base = g["base"]
        defect_ids = g["defect_ids"]
        defect_names = g["defect_names"]
        base["defect_id"] = defect_ids[0] if defect_ids else None
        base["defect_ids"] = defect_ids
        base["defect_name"] = ", ".join(defect_names) if defect_names else None
        base["defect_names"] = defect_names
        base["entry_ids"] = g["entry_ids"]
        results.append(_row_to_sqc_response(base))
    return results


# ---------------------------------------------------------------------------
# Employees Dropdown API
# ---------------------------------------------------------------------------

@router.get("/employees", response_model=List[EmployeeResponse])
def get_repacking_employees(
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_read(MODULE_QUALITY_CONTROL)),
):
    """Fetch employee names and IDs for Checker Name and QA-Shift Ex. dropdowns."""
    auth_users_table = _auth_table("users")
    stmt = text(f"""
        SELECT employee_id, employee_name
        FROM {auth_users_table}
        WHERE is_active = TRUE
        ORDER BY employee_name ASC
    """)
    rows = db.execute(stmt).mappings().all()
    return [EmployeeResponse(employee_id=r["employee_id"], employee_name=r["employee_name"]) for r in rows]


# ---------------------------------------------------------------------------
# NUMBERING APIs (sqc.repacking_numbering)
# ---------------------------------------------------------------------------

@router.get("/numbering", response_model=List[NumberingEntryResponse])
def get_numbering_entries(
    production_date: Optional[str] = None,
    machine_no: Optional[int] = None,
    job_id: Optional[str] = None,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_read(MODULE_QUALITY_CONTROL)),
):
    """Fetch numbering entries from sqc.repacking_numbering with optional filters."""
    num_table = _sqc_table("repacking_numbering")
    bottle_table = _production_table("bottle_master")
    defect_table = _hpr_table("defect_master")
    user_table = _auth_table("users")

    conditions = []
    params = {}

    if production_date:
        try:
            parsed_date = datetime.strptime(production_date.strip(), "%Y-%m-%d").date()
            conditions.append("n.production_date = :p_date")
            params["p_date"] = parsed_date
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format, use YYYY-MM-DD")

    if machine_no is not None:
        conditions.append("n.machine_no = :machine_no")
        params["machine_no"] = machine_no

    if job_id:
        conditions.append("n.job_id = :job_id")
        params["job_id"] = job_id.strip()

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    query = text(f"""
        SELECT 
            n.entry_id, n.production_date, n.machine_no, n.job_id,
            n.bottle_id, b.bottle_name,
            n.pack_type, n.shift, n.entry_time,
            n.pcs_per_pack, n.cartons, n.defective_bottles,
            n.defect_id, d.defect_name,
            n.mould, n.section_no,
            n.checker_id, cu.employee_name AS checker_name,
            n.qa_shift_ex_id, qu.employee_name AS qa_shift_ex_name,
            n.created_at, n.updated_at
        FROM {num_table} n
        LEFT JOIN {bottle_table} b ON b.bottle_id = n.bottle_id
        LEFT JOIN {defect_table} d ON d.defect_id = n.defect_id
        LEFT JOIN {user_table} cu ON cu.employee_id = n.checker_id
        LEFT JOIN {user_table} qu ON qu.employee_id = n.qa_shift_ex_id
        {where_clause}
        ORDER BY n.machine_no ASC, n.shift ASC, n.entry_time ASC, n.entry_id ASC
    """)

    results = db.execute(query, params).mappings().all()
    return _group_numbering_rows(results)


@router.post("/numbering", response_model=NumberingEntryResponse, status_code=status.HTTP_201_CREATED)
def create_numbering_entry(
    payload: NumberingEntryCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """Insert a new numbering entry into sqc.repacking_numbering."""
    num_table = _sqc_table("repacking_numbering")
    now_dt = datetime.now(timezone.utc)

    target_defects = []
    if payload.defect_ids and len(payload.defect_ids) > 0:
        target_defects = [d for d in payload.defect_ids if d is not None]
    elif payload.defect_id is not None:
        target_defects = [payload.defect_id]
    if not target_defects:
        target_defects = [None]

    first_entry_id = None
    try:
        for d_id in target_defects:
            insert_query = text(f"""
                INSERT INTO {num_table} (
                    production_date, machine_no, job_id, bottle_id, pack_type,
                    shift, entry_time, pcs_per_pack, cartons, defective_bottles,
                    defect_id, mould, section_no, checker_id, qa_shift_ex_id,
                    created_at, updated_at
                ) VALUES (
                    :production_date, :machine_no, :job_id, :bottle_id, :pack_type,
                    :shift, :entry_time, :pcs_per_pack, :cartons, :defective_bottles,
                    :defect_id, :mould, :section_no, :checker_id, :qa_shift_ex_id,
                    :created_at, :updated_at
                )
                RETURNING entry_id
            """)

            params = {
                "production_date": payload.production_date,
                "machine_no": payload.machine_no,
                "job_id": payload.job_id,
                "bottle_id": payload.bottle_id,
                "pack_type": payload.pack_type,
                "shift": payload.shift,
                "entry_time": _format_time_sql(payload.entry_time),
                "pcs_per_pack": payload.pcs_per_pack,
                "cartons": payload.cartons,
                "defective_bottles": payload.defective_bottles,
                "defect_id": d_id,
                "mould": payload.mould,
                "section_no": payload.section_no,
                "checker_id": payload.checker_id,
                "qa_shift_ex_id": payload.qa_shift_ex_id,
                "created_at": now_dt,
                "updated_at": now_dt,
            }
            new_id = db.execute(insert_query, params).scalar()
            if first_entry_id is None:
                first_entry_id = new_id

        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="CREATE_REPACKING_NUMBERING",
            details=f"Created numbering entry {first_entry_id} for machine {payload.machine_no} on {payload.production_date}",
        ))
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(f"Failed to create numbering entry: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to save numbering entry: {exc}")

    return _fetch_numbering_by_id(db, first_entry_id)


@router.put("/numbering/{entry_id}", response_model=NumberingEntryResponse)
def update_numbering_entry(
    entry_id: str,
    payload: NumberingEntryUpdate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """Update an existing numbering entry by entry_id."""
    try:
        e_id = int(entry_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid entry_id")

    num_table = _sqc_table("repacking_numbering")

    existing = db.execute(
        text(f"SELECT entry_id FROM {num_table} WHERE entry_id = :entry_id"),
        {"entry_id": e_id}
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Numbering entry not found")

    update_fields = []
    params = {"entry_id": e_id, "updated_at": datetime.now(timezone.utc)}

    payload_dict = payload.model_dump(exclude_unset=True)
    for field, val in payload_dict.items():
        if field == "entry_time":
            val = _format_time_sql(val)
        update_fields.append(f"{field} = :{field}")
        params[field] = val

    update_fields.append("updated_at = :updated_at")

    update_query = text(f"""
        UPDATE {num_table}
        SET {', '.join(update_fields)}
        WHERE entry_id = :entry_id
    """)

    try:
        db.execute(update_query, params)
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="UPDATE_REPACKING_NUMBERING",
            details=f"Updated numbering entry {e_id}",
        ))
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(f"Failed to update numbering entry {e_id}: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to update numbering entry: {exc}")

    return _fetch_numbering_by_id(db, e_id)


@router.delete("/numbering/{entry_id}")
def delete_numbering_entry(
    entry_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """Delete a numbering entry and companion defect records by entry_id."""
    try:
        e_id = int(entry_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid entry_id")

    num_table = _sqc_table("repacking_numbering")

    existing = db.execute(
        text(f"SELECT entry_id, machine_no, production_date, shift, entry_time, job_id FROM {num_table} WHERE entry_id = :entry_id"),
        {"entry_id": e_id}
    ).mappings().first()
    if not existing:
        raise HTTPException(status_code=404, detail="Numbering entry not found")

    time_str = _format_time_sql(existing["entry_time"])
    try:
        db.execute(
            text(f"""
                DELETE FROM {num_table}
                WHERE entry_id = :entry_id
                   OR (production_date = :p_date AND machine_no = :m_no AND shift = :shift AND entry_time = :e_time AND job_id = :job_id)
            """),
            {
                "entry_id": e_id,
                "p_date": existing["production_date"],
                "m_no": existing["machine_no"],
                "shift": existing["shift"],
                "e_time": time_str,
                "job_id": existing["job_id"],
            }
        )
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="DELETE_REPACKING_NUMBERING",
            details=f"Deleted numbering entry {e_id} and companions for machine {existing['machine_no']} on {existing['production_date']}",
        ))
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(f"Failed to delete numbering entry {e_id}: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to delete numbering entry: {exc}")

    return {"ok": True, "message": f"Deleted numbering entry {entry_id}"}


@router.post("/numbering/save", response_model=List[NumberingEntryResponse])
def save_numbering_batch(
    payload: NumberingSaveRequest,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """
    Atomic transaction save for newly added and modified numbering rows.
    Inserts new records and updates modified records in a single database transaction.
    """
    num_table = _sqc_table("repacking_numbering")
    affected_ids: List[int] = []
    now_dt = datetime.now(timezone.utc)

    try:
        # 1. Process Inserts (Multi-defect supported)
        for item in payload.inserts:
            d_ids = []
            if item.defect_ids and len(item.defect_ids) > 0:
                d_ids = [d for d in item.defect_ids if d is not None]
            elif item.defect_id is not None:
                d_ids = [item.defect_id]
            if not d_ids:
                d_ids = [None]

            for d_id in d_ids:
                insert_query = text(f"""
                    INSERT INTO {num_table} (
                        production_date, machine_no, job_id, bottle_id, pack_type,
                        shift, entry_time, pcs_per_pack, cartons, defective_bottles,
                        defect_id, mould, section_no, checker_id, qa_shift_ex_id,
                        created_at, updated_at
                    ) VALUES (
                        :production_date, :machine_no, :job_id, :bottle_id, :pack_type,
                        :shift, :entry_time, :pcs_per_pack, :cartons, :defective_bottles,
                        :defect_id, :mould, :section_no, :checker_id, :qa_shift_ex_id,
                        :created_at, :updated_at
                    )
                    RETURNING entry_id
                """)
                params = {
                    "production_date": item.production_date,
                    "machine_no": item.machine_no,
                    "job_id": item.job_id,
                    "bottle_id": item.bottle_id,
                    "pack_type": item.pack_type,
                    "shift": item.shift,
                    "entry_time": _format_time_sql(item.entry_time),
                    "pcs_per_pack": item.pcs_per_pack,
                    "cartons": item.cartons,
                    "defective_bottles": item.defective_bottles,
                    "defect_id": d_id,
                    "mould": item.mould,
                    "section_no": item.section_no,
                    "checker_id": item.checker_id,
                    "qa_shift_ex_id": item.qa_shift_ex_id,
                    "created_at": now_dt,
                    "updated_at": now_dt,
                }
                new_id = db.execute(insert_query, params).scalar()
                affected_ids.append(int(new_id))

        # 2. Process Updates (Multi-defect reconciliation supported)
        for item in payload.updates:
            e_id = int(item.entry_id)
            existing = db.execute(
                text(f"""
                    SELECT entry_id, production_date, machine_no, shift, entry_time, job_id, bottle_id,
                           pack_type, pcs_per_pack, cartons, defective_bottles, mould, section_no,
                           checker_id, qa_shift_ex_id
                    FROM {num_table}
                    WHERE entry_id = :entry_id
                """),
                {"entry_id": e_id}
            ).mappings().first()

            if not existing:
                continue

            companion_ids = [e_id]
            if item.entry_ids and len(item.entry_ids) > 0:
                for c_id in item.entry_ids:
                    try:
                        parsed_cid = int(c_id)
                        if parsed_cid not in companion_ids:
                            companion_ids.append(parsed_cid)
                    except ValueError:
                        pass
            else:
                time_str = _format_time_sql(existing["entry_time"])
                matches = db.execute(
                    text(f"""
                        SELECT entry_id FROM {num_table}
                        WHERE production_date = :p_date
                          AND machine_no = :machine_no
                          AND shift = :shift
                          AND entry_time = :entry_time
                          AND job_id = :job_id
                    """),
                    {
                        "p_date": existing["production_date"],
                        "machine_no": existing["machine_no"],
                        "shift": existing["shift"],
                        "entry_time": time_str,
                        "job_id": existing["job_id"],
                    }
                ).scalars().all()
                for mid in matches:
                    if int(mid) not in companion_ids:
                        companion_ids.append(int(mid))

            target_defect_ids = []
            if item.defect_ids is not None:
                target_defect_ids = [d for d in item.defect_ids if d is not None]
            elif item.defect_id is not None:
                target_defect_ids = [item.defect_id]

            if not target_defect_ids:
                target_defect_ids = [None]

            common_count = min(len(companion_ids), len(target_defect_ids))
            item_dict = item.model_dump(exclude={"entry_id", "entry_ids", "defect_ids", "defect_id"}, exclude_unset=True)

            for idx in range(common_count):
                curr_cid = companion_ids[idx]
                curr_defect_id = target_defect_ids[idx]
                fields = []
                params = {"entry_id": curr_cid, "updated_at": now_dt, "defect_id": curr_defect_id}
                for k, v in item_dict.items():
                    if k == "entry_time":
                        v = _format_time_sql(v)
                    fields.append(f"{k} = :{k}")
                    params[k] = v
                fields.append("defect_id = :defect_id")
                fields.append("updated_at = :updated_at")

                update_query = text(f"""
                    UPDATE {num_table}
                    SET {', '.join(fields)}
                    WHERE entry_id = :entry_id
                """)
                db.execute(update_query, params)
                affected_ids.append(curr_cid)

            if len(companion_ids) > len(target_defect_ids):
                for idx in range(common_count, len(companion_ids)):
                    del_cid = companion_ids[idx]
                    db.execute(text(f"DELETE FROM {num_table} WHERE entry_id = :entry_id"), {"entry_id": del_cid})

            if len(target_defect_ids) > len(companion_ids):
                base_insert = {
                    "production_date": item.production_date or existing["production_date"],
                    "machine_no": item.machine_no if item.machine_no is not None else existing["machine_no"],
                    "job_id": item.job_id or existing["job_id"],
                    "bottle_id": item.bottle_id if item.bottle_id is not None else existing["bottle_id"],
                    "pack_type": item.pack_type if item.pack_type is not None else existing["pack_type"],
                    "shift": item.shift if item.shift is not None else existing["shift"],
                    "entry_time": _format_time_sql(item.entry_time) or _format_time_sql(existing["entry_time"]),
                    "pcs_per_pack": item.pcs_per_pack if item.pcs_per_pack is not None else existing["pcs_per_pack"],
                    "cartons": item.cartons if item.cartons is not None else existing["cartons"],
                    "defective_bottles": item.defective_bottles if item.defective_bottles is not None else existing["defective_bottles"],
                    "mould": item.mould if item.mould is not None else existing["mould"],
                    "section_no": item.section_no if item.section_no is not None else existing["section_no"],
                    "checker_id": item.checker_id if item.checker_id is not None else existing["checker_id"],
                    "qa_shift_ex_id": item.qa_shift_ex_id if item.qa_shift_ex_id is not None else existing["qa_shift_ex_id"],
                    "created_at": now_dt,
                    "updated_at": now_dt,
                }
                for idx in range(common_count, len(target_defect_ids)):
                    curr_defect_id = target_defect_ids[idx]
                    new_params = {**base_insert, "defect_id": curr_defect_id}
                    ins_query = text(f"""
                        INSERT INTO {num_table} (
                            production_date, machine_no, job_id, bottle_id, pack_type,
                            shift, entry_time, pcs_per_pack, cartons, defective_bottles,
                            defect_id, mould, section_no, checker_id, qa_shift_ex_id,
                            created_at, updated_at
                        ) VALUES (
                            :production_date, :machine_no, :job_id, :bottle_id, :pack_type,
                            :shift, :entry_time, :pcs_per_pack, :cartons, :defective_bottles,
                            :defect_id, :mould, :section_no, :checker_id, :qa_shift_ex_id,
                            :created_at, :updated_at
                        )
                        RETURNING entry_id
                    """)
                    new_id = db.execute(ins_query, new_params).scalar()
                    affected_ids.append(int(new_id))

        if payload.inserts or payload.updates:
            db.add(AuditLog(
                user_id=current_user.employee_id,
                action="BATCH_SAVE_REPACKING_NUMBERING",
                details=f"Saved {len(payload.inserts)} new and {len(payload.updates)} updated numbering entries",
            ))

        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(f"Batch save numbering failed: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to save numbering entries: {exc}")

    if not affected_ids:
        return []

    return _fetch_numbering_by_ids(db, affected_ids)


# ---------------------------------------------------------------------------
# SQC/QC HOLD APIs (sqc.repacking_sqc_qc_hold)
# ---------------------------------------------------------------------------

@router.get("/sqc-qc-hold", response_model=List[SqcQcHoldEntryResponse])
def get_sqc_qc_hold_entries(
    production_date: Optional[str] = None,
    machine_no: Optional[int] = None,
    job_id: Optional[str] = None,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_read(MODULE_QUALITY_CONTROL)),
):
    """Fetch SQC/QC HOLD entries from sqc.repacking_sqc_qc_hold with optional filters."""
    sqc_table = _sqc_table("repacking_sqc_qc_hold")
    bottle_table = _production_table("bottle_master")
    defect_table = _hpr_table("defect_master")
    user_table = _auth_table("users")

    conditions = []
    params = {}

    if production_date:
        try:
            parsed_date = datetime.strptime(production_date.strip(), "%Y-%m-%d").date()
            conditions.append("s.production_date = :p_date")
            params["p_date"] = parsed_date
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format, use YYYY-MM-DD")

    if machine_no is not None:
        conditions.append("s.machine_no = :machine_no")
        params["machine_no"] = machine_no

    if job_id:
        conditions.append("s.job_id = :job_id")
        params["job_id"] = job_id.strip()

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    query = text(f"""
        SELECT 
            s.entry_id, s.production_date, s.machine_no, s.job_id,
            s.bottle_id, b.bottle_name,
            s.pack_type, s.lot_no, s.shift, s.entry_time,
            s.pcs_per_pack, s.cartons, s.defective_bottles,
            s.defect_id, d.defect_name,
            s.mould, s.section_no,
            s.checker_id, cu.employee_name AS checker_name,
            s.qa_shift_ex_id, qu.employee_name AS qa_shift_ex_name,
            s.created_at, s.updated_at
        FROM {sqc_table} s
        LEFT JOIN {bottle_table} b ON b.bottle_id = s.bottle_id
        LEFT JOIN {defect_table} d ON d.defect_id = s.defect_id
        LEFT JOIN {user_table} cu ON cu.employee_id = s.checker_id
        LEFT JOIN {user_table} qu ON qu.employee_id = s.qa_shift_ex_id
        {where_clause}
        ORDER BY s.machine_no ASC, s.shift ASC, s.entry_time ASC, s.entry_id ASC
    """)

    results = db.execute(query, params).mappings().all()
    return _group_sqc_rows(results)


@router.post("/sqc-qc-hold", response_model=SqcQcHoldEntryResponse, status_code=status.HTTP_201_CREATED)
def create_sqc_qc_hold_entry(
    payload: SqcQcHoldEntryCreate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """Insert a new SQC/QC HOLD entry into sqc.repacking_sqc_qc_hold."""
    sqc_table = _sqc_table("repacking_sqc_qc_hold")
    now_dt = datetime.now(timezone.utc)

    target_defects = []
    if payload.defect_ids and len(payload.defect_ids) > 0:
        target_defects = [d for d in payload.defect_ids if d is not None]
    elif payload.defect_id is not None:
        target_defects = [payload.defect_id]
    if not target_defects:
        target_defects = [None]

    first_entry_id = None
    try:
        for d_id in target_defects:
            insert_query = text(f"""
                INSERT INTO {sqc_table} (
                    production_date, machine_no, job_id, bottle_id, pack_type, lot_no,
                    shift, entry_time, pcs_per_pack, cartons, defective_bottles,
                    defect_id, mould, section_no, checker_id, qa_shift_ex_id,
                    created_at, updated_at
                ) VALUES (
                    :production_date, :machine_no, :job_id, :bottle_id, :pack_type, :lot_no,
                    :shift, :entry_time, :pcs_per_pack, :cartons, :defective_bottles,
                    :defect_id, :mould, :section_no, :checker_id, :qa_shift_ex_id,
                    :created_at, :updated_at
                )
                RETURNING entry_id
            """)

            params = {
                "production_date": payload.production_date,
                "machine_no": payload.machine_no,
                "job_id": payload.job_id,
                "bottle_id": payload.bottle_id,
                "pack_type": payload.pack_type,
                "lot_no": payload.lot_no,
                "shift": payload.shift,
                "entry_time": _format_time_sql(payload.entry_time),
                "pcs_per_pack": payload.pcs_per_pack,
                "cartons": payload.cartons,
                "defective_bottles": payload.defective_bottles,
                "defect_id": d_id,
                "mould": payload.mould,
                "section_no": payload.section_no,
                "checker_id": payload.checker_id,
                "qa_shift_ex_id": payload.qa_shift_ex_id,
                "created_at": now_dt,
                "updated_at": now_dt,
            }
            new_id = db.execute(insert_query, params).scalar()
            if first_entry_id is None:
                first_entry_id = new_id

        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="CREATE_REPACKING_SQC_QC_HOLD",
            details=f"Created SQC/QC HOLD entry {first_entry_id} for machine {payload.machine_no} on {payload.production_date}",
        ))
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(f"Failed to create SQC/QC HOLD entry: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to save SQC/QC HOLD entry: {exc}")

    return _fetch_sqc_by_id(db, first_entry_id)


@router.put("/sqc-qc-hold/{entry_id}", response_model=SqcQcHoldEntryResponse)
def update_sqc_qc_hold_entry(
    entry_id: str,
    payload: SqcQcHoldEntryUpdate,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """Update an existing SQC/QC HOLD entry by entry_id."""
    try:
        e_id = int(entry_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid entry_id")

    sqc_table = _sqc_table("repacking_sqc_qc_hold")

    existing = db.execute(
        text(f"SELECT entry_id FROM {sqc_table} WHERE entry_id = :entry_id"),
        {"entry_id": e_id}
    ).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="SQC/QC HOLD entry not found")

    update_fields = []
    params = {"entry_id": e_id, "updated_at": datetime.now(timezone.utc)}

    payload_dict = payload.model_dump(exclude_unset=True)
    for field, val in payload_dict.items():
        if field == "entry_time":
            val = _format_time_sql(val)
        update_fields.append(f"{field} = :{field}")
        params[field] = val

    update_fields.append("updated_at = :updated_at")

    update_query = text(f"""
        UPDATE {sqc_table}
        SET {', '.join(update_fields)}
        WHERE entry_id = :entry_id
    """)

    try:
        db.execute(update_query, params)
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="UPDATE_REPACKING_SQC_QC_HOLD",
            details=f"Updated SQC/QC HOLD entry {e_id}",
        ))
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(f"Failed to update SQC/QC HOLD entry {e_id}: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to update SQC/QC HOLD entry: {exc}")

    return _fetch_sqc_by_id(db, e_id)


@router.delete("/sqc-qc-hold/{entry_id}")
def delete_sqc_qc_hold_entry(
    entry_id: str,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """Delete an SQC/QC HOLD entry and companion defect records by entry_id."""
    try:
        e_id = int(entry_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid entry_id")

    sqc_table = _sqc_table("repacking_sqc_qc_hold")

    existing = db.execute(
        text(f"SELECT entry_id, machine_no, production_date, shift, entry_time, job_id FROM {sqc_table} WHERE entry_id = :entry_id"),
        {"entry_id": e_id}
    ).mappings().first()
    if not existing:
        raise HTTPException(status_code=404, detail="SQC/QC HOLD entry not found")

    time_str = _format_time_sql(existing["entry_time"])
    try:
        db.execute(
            text(f"""
                DELETE FROM {sqc_table}
                WHERE entry_id = :entry_id
                   OR (production_date = :p_date AND machine_no = :m_no AND shift = :shift AND entry_time = :e_time AND job_id = :job_id)
            """),
            {
                "entry_id": e_id,
                "p_date": existing["production_date"],
                "m_no": existing["machine_no"],
                "shift": existing["shift"],
                "e_time": time_str,
                "job_id": existing["job_id"],
            }
        )
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="DELETE_REPACKING_SQC_QC_HOLD",
            details=f"Deleted SQC/QC HOLD entry {e_id} and companions for machine {existing['machine_no']} on {existing['production_date']}",
        ))
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(f"Failed to delete SQC/QC HOLD entry {e_id}: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to delete SQC/QC HOLD entry: {exc}")

    return {"ok": True, "message": f"Deleted SQC/QC HOLD entry {entry_id}"}


@router.post("/sqc-qc-hold/save", response_model=List[SqcQcHoldEntryResponse])
def save_sqc_qc_hold_batch(
    payload: SqcQcHoldSaveRequest,
    db: Session = Depends(get_db),
    current_user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """
    Atomic transaction save for newly added and modified SQC/QC HOLD rows.
    Inserts new records and updates modified records in a single database transaction.
    """
    sqc_table = _sqc_table("repacking_sqc_qc_hold")
    affected_ids: List[int] = []
    now_dt = datetime.now(timezone.utc)

    try:
        # 1. Process Inserts (Multi-defect supported)
        for item in payload.inserts:
            d_ids = []
            if item.defect_ids and len(item.defect_ids) > 0:
                d_ids = [d for d in item.defect_ids if d is not None]
            elif item.defect_id is not None:
                d_ids = [item.defect_id]
            if not d_ids:
                d_ids = [None]

            for d_id in d_ids:
                insert_query = text(f"""
                    INSERT INTO {sqc_table} (
                        production_date, machine_no, job_id, bottle_id, pack_type, lot_no,
                        shift, entry_time, pcs_per_pack, cartons, defective_bottles,
                        defect_id, mould, section_no, checker_id, qa_shift_ex_id,
                        created_at, updated_at
                    ) VALUES (
                        :production_date, :machine_no, :job_id, :bottle_id, :pack_type, :lot_no,
                        :shift, :entry_time, :pcs_per_pack, :cartons, :defective_bottles,
                        :defect_id, :mould, :section_no, :checker_id, :qa_shift_ex_id,
                        :created_at, :updated_at
                    )
                    RETURNING entry_id
                """)
                params = {
                    "production_date": item.production_date,
                    "machine_no": item.machine_no,
                    "job_id": item.job_id,
                    "bottle_id": item.bottle_id,
                    "pack_type": item.pack_type,
                    "lot_no": item.lot_no,
                    "shift": item.shift,
                    "entry_time": _format_time_sql(item.entry_time),
                    "pcs_per_pack": item.pcs_per_pack,
                    "cartons": item.cartons,
                    "defective_bottles": item.defective_bottles,
                    "defect_id": d_id,
                    "mould": item.mould,
                    "section_no": item.section_no,
                    "checker_id": item.checker_id,
                    "qa_shift_ex_id": item.qa_shift_ex_id,
                    "created_at": now_dt,
                    "updated_at": now_dt,
                }
                new_id = db.execute(insert_query, params).scalar()
                affected_ids.append(int(new_id))

        # 2. Process Updates (Multi-defect reconciliation supported)
        for item in payload.updates:
            e_id = int(item.entry_id)
            existing = db.execute(
                text(f"""
                    SELECT entry_id, production_date, machine_no, shift, entry_time, job_id, bottle_id,
                           pack_type, lot_no, pcs_per_pack, cartons, defective_bottles, mould, section_no,
                           checker_id, qa_shift_ex_id
                    FROM {sqc_table}
                    WHERE entry_id = :entry_id
                """),
                {"entry_id": e_id}
            ).mappings().first()

            if not existing:
                continue

            companion_ids = [e_id]
            if item.entry_ids and len(item.entry_ids) > 0:
                for c_id in item.entry_ids:
                    try:
                        parsed_cid = int(c_id)
                        if parsed_cid not in companion_ids:
                            companion_ids.append(parsed_cid)
                    except ValueError:
                        pass
            else:
                time_str = _format_time_sql(existing["entry_time"])
                matches = db.execute(
                    text(f"""
                        SELECT entry_id FROM {sqc_table}
                        WHERE production_date = :p_date
                          AND machine_no = :machine_no
                          AND shift = :shift
                          AND entry_time = :entry_time
                          AND job_id = :job_id
                    """),
                    {
                        "p_date": existing["production_date"],
                        "machine_no": existing["machine_no"],
                        "shift": existing["shift"],
                        "entry_time": time_str,
                        "job_id": existing["job_id"],
                    }
                ).scalars().all()
                for mid in matches:
                    if int(mid) not in companion_ids:
                        companion_ids.append(int(mid))

            target_defect_ids = []
            if item.defect_ids is not None:
                target_defect_ids = [d for d in item.defect_ids if d is not None]
            elif item.defect_id is not None:
                target_defect_ids = [item.defect_id]

            if not target_defect_ids:
                target_defect_ids = [None]

            common_count = min(len(companion_ids), len(target_defect_ids))
            item_dict = item.model_dump(exclude={"entry_id", "entry_ids", "defect_ids", "defect_id"}, exclude_unset=True)

            for idx in range(common_count):
                curr_cid = companion_ids[idx]
                curr_defect_id = target_defect_ids[idx]
                fields = []
                params = {"entry_id": curr_cid, "updated_at": now_dt, "defect_id": curr_defect_id}
                for k, v in item_dict.items():
                    if k == "entry_time":
                        v = _format_time_sql(v)
                    fields.append(f"{k} = :{k}")
                    params[k] = v
                fields.append("defect_id = :defect_id")
                fields.append("updated_at = :updated_at")

                update_query = text(f"""
                    UPDATE {sqc_table}
                    SET {', '.join(fields)}
                    WHERE entry_id = :entry_id
                """)
                db.execute(update_query, params)
                affected_ids.append(curr_cid)

            if len(companion_ids) > len(target_defect_ids):
                for idx in range(common_count, len(companion_ids)):
                    del_cid = companion_ids[idx]
                    db.execute(text(f"DELETE FROM {sqc_table} WHERE entry_id = :entry_id"), {"entry_id": del_cid})

            if len(target_defect_ids) > len(companion_ids):
                base_insert = {
                    "production_date": item.production_date or existing["production_date"],
                    "machine_no": item.machine_no if item.machine_no is not None else existing["machine_no"],
                    "job_id": item.job_id or existing["job_id"],
                    "bottle_id": item.bottle_id if item.bottle_id is not None else existing["bottle_id"],
                    "pack_type": item.pack_type if item.pack_type is not None else existing["pack_type"],
                    "lot_no": item.lot_no if item.lot_no is not None else existing["lot_no"],
                    "shift": item.shift if item.shift is not None else existing["shift"],
                    "entry_time": _format_time_sql(item.entry_time) or _format_time_sql(existing["entry_time"]),
                    "pcs_per_pack": item.pcs_per_pack if item.pcs_per_pack is not None else existing["pcs_per_pack"],
                    "cartons": item.cartons if item.cartons is not None else existing["cartons"],
                    "defective_bottles": item.defective_bottles if item.defective_bottles is not None else existing["defective_bottles"],
                    "mould": item.mould if item.mould is not None else existing["mould"],
                    "section_no": item.section_no if item.section_no is not None else existing["section_no"],
                    "checker_id": item.checker_id if item.checker_id is not None else existing["checker_id"],
                    "qa_shift_ex_id": item.qa_shift_ex_id if item.qa_shift_ex_id is not None else existing["qa_shift_ex_id"],
                    "created_at": now_dt,
                    "updated_at": now_dt,
                }
                for idx in range(common_count, len(target_defect_ids)):
                    curr_defect_id = target_defect_ids[idx]
                    new_params = {**base_insert, "defect_id": curr_defect_id}
                    ins_query = text(f"""
                        INSERT INTO {sqc_table} (
                            production_date, machine_no, job_id, bottle_id, pack_type, lot_no,
                            shift, entry_time, pcs_per_pack, cartons, defective_bottles,
                            defect_id, mould, section_no, checker_id, qa_shift_ex_id,
                            created_at, updated_at
                        ) VALUES (
                            :production_date, :machine_no, :job_id, :bottle_id, :pack_type, :lot_no,
                            :shift, :entry_time, :pcs_per_pack, :cartons, :defective_bottles,
                            :defect_id, :mould, :section_no, :checker_id, :qa_shift_ex_id,
                            :created_at, :updated_at
                        )
                        RETURNING entry_id
                    """)
                    new_id = db.execute(ins_query, new_params).scalar()
                    affected_ids.append(int(new_id))

        if payload.inserts or payload.updates:
            db.add(AuditLog(
                user_id=current_user.employee_id,
                action="BATCH_SAVE_REPACKING_SQC_QC_HOLD",
                details=f"Saved {len(payload.inserts)} new and {len(payload.updates)} updated SQC/QC HOLD entries",
            ))

        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error(f"Batch save SQC/QC HOLD failed: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to save SQC/QC HOLD entries: {exc}")

    if not affected_ids:
        return []

    return _fetch_sqc_by_ids(db, affected_ids)


# ---------------------------------------------------------------------------
# Helper Query Functions
# ---------------------------------------------------------------------------

def _fetch_numbering_by_id(db: Session, entry_id: int) -> NumberingEntryResponse:
    num_table = _sqc_table("repacking_numbering")
    base_row = db.execute(
        text(f"SELECT production_date, machine_no, shift, entry_time, job_id FROM {num_table} WHERE entry_id = :entry_id"),
        {"entry_id": entry_id}
    ).mappings().first()
    if not base_row:
        raise HTTPException(status_code=404, detail="Numbering entry not found")

    time_str = _format_time_sql(base_row["entry_time"])
    all_cids = db.execute(
        text(f"""
            SELECT entry_id FROM {num_table}
            WHERE production_date = :p_date
              AND machine_no = :machine_no
              AND shift = :shift
              AND entry_time = :entry_time
              AND job_id = :job_id
        """),
        {
            "p_date": base_row["production_date"],
            "machine_no": base_row["machine_no"],
            "shift": base_row["shift"],
            "entry_time": time_str,
            "job_id": base_row["job_id"],
        }
    ).scalars().all()

    items = _fetch_numbering_by_ids(db, [int(x) for x in all_cids])
    if not items:
        raise HTTPException(status_code=404, detail="Numbering entry not found")
    return items[0]


def _fetch_numbering_by_ids(db: Session, entry_ids: List[int]) -> List[NumberingEntryResponse]:
    if not entry_ids:
        return []

    num_table = _sqc_table("repacking_numbering")
    bottle_table = _production_table("bottle_master")
    defect_table = _hpr_table("defect_master")
    user_table = _auth_table("users")

    query = text(f"""
        SELECT 
            n.entry_id, n.production_date, n.machine_no, n.job_id,
            n.bottle_id, b.bottle_name,
            n.pack_type, n.shift, n.entry_time,
            n.pcs_per_pack, n.cartons, n.defective_bottles,
            n.defect_id, d.defect_name,
            n.mould, n.section_no,
            n.checker_id, cu.employee_name AS checker_name,
            n.qa_shift_ex_id, qu.employee_name AS qa_shift_ex_name,
            n.created_at, n.updated_at
        FROM {num_table} n
        LEFT JOIN {bottle_table} b ON b.bottle_id = n.bottle_id
        LEFT JOIN {defect_table} d ON d.defect_id = n.defect_id
        LEFT JOIN {user_table} cu ON cu.employee_id = n.checker_id
        LEFT JOIN {user_table} qu ON qu.employee_id = n.qa_shift_ex_id
        WHERE n.entry_id IN :entry_ids
        ORDER BY n.machine_no ASC, n.shift ASC, n.entry_time ASC, n.entry_id ASC
    """).bindparams(bindparam("entry_ids", expanding=True))

    results = db.execute(query, {"entry_ids": list(entry_ids)}).mappings().all()
    return _group_numbering_rows(results)


def _fetch_sqc_by_id(db: Session, entry_id: int) -> SqcQcHoldEntryResponse:
    sqc_table = _sqc_table("repacking_sqc_qc_hold")
    base_row = db.execute(
        text(f"SELECT production_date, machine_no, shift, entry_time, job_id FROM {sqc_table} WHERE entry_id = :entry_id"),
        {"entry_id": entry_id}
    ).mappings().first()
    if not base_row:
        raise HTTPException(status_code=404, detail="SQC/QC HOLD entry not found")

    time_str = _format_time_sql(base_row["entry_time"])
    all_cids = db.execute(
        text(f"""
            SELECT entry_id FROM {sqc_table}
            WHERE production_date = :p_date
              AND machine_no = :machine_no
              AND shift = :shift
              AND entry_time = :entry_time
              AND job_id = :job_id
        """),
        {
            "p_date": base_row["production_date"],
            "machine_no": base_row["machine_no"],
            "shift": base_row["shift"],
            "entry_time": time_str,
            "job_id": base_row["job_id"],
        }
    ).scalars().all()

    items = _fetch_sqc_by_ids(db, [int(x) for x in all_cids])
    if not items:
        raise HTTPException(status_code=404, detail="SQC/QC HOLD entry not found")
    return items[0]


def _fetch_sqc_by_ids(db: Session, entry_ids: List[int]) -> List[SqcQcHoldEntryResponse]:
    if not entry_ids:
        return []

    sqc_table = _sqc_table("repacking_sqc_qc_hold")
    bottle_table = _production_table("bottle_master")
    defect_table = _hpr_table("defect_master")
    user_table = _auth_table("users")

    query = text(f"""
        SELECT 
            s.entry_id, s.production_date, s.machine_no, s.job_id,
            s.bottle_id, b.bottle_name,
            s.pack_type, s.lot_no, s.shift, s.entry_time,
            s.pcs_per_pack, s.cartons, s.defective_bottles,
            s.defect_id, d.defect_name,
            s.mould, s.section_no,
            s.checker_id, cu.employee_name AS checker_name,
            s.qa_shift_ex_id, qu.employee_name AS qa_shift_ex_name,
            s.created_at, s.updated_at
        FROM {sqc_table} s
        LEFT JOIN {bottle_table} b ON b.bottle_id = s.bottle_id
        LEFT JOIN {defect_table} d ON d.defect_id = s.defect_id
        LEFT JOIN {user_table} cu ON cu.employee_id = s.checker_id
        LEFT JOIN {user_table} qu ON qu.employee_id = s.qa_shift_ex_id
        WHERE s.entry_id IN :entry_ids
        ORDER BY s.machine_no ASC, s.shift ASC, s.entry_time ASC, s.entry_id ASC
    """).bindparams(bindparam("entry_ids", expanding=True))

    results = db.execute(query, {"entry_ids": list(entry_ids)}).mappings().all()
    return _group_sqc_rows(results)
