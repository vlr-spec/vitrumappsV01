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
    RepackingDataResponse,
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


# ---------------------------------------------------------------------------
# Reference-data validation helpers
# ---------------------------------------------------------------------------

# VARCHAR(n) limits of the sqc.repacking_* tables (verified against the live
# schema) so oversized values fail with a readable message instead of a
# driver-level "value too long" error.
_STR_LENGTHS = {
    "job_id": 30,
    "pack_type": 30,
    "lot_no": 100,
    "mould": 100,
    "section_no": 30,
    "checker_id": 20,
}


def _clean_optional_str(value) -> Optional[str]:
    """Trim optional text columns; blank input becomes NULL."""
    if value is None:
        return None
    trimmed = str(value).strip()
    return trimmed or None


def _sanitize_text_fields(payload_dict: dict) -> dict:
    """Normalise the free-text columns of an insert/update payload."""
    for field in ("job_id", "pack_type", "lot_no", "mould", "section_no", "checker_id", "remarks"):
        if field in payload_dict:
            payload_dict[field] = _clean_optional_str(payload_dict[field])
    return payload_dict


def _validate_string_lengths(payload_dict: dict) -> None:
    for field, max_len in _STR_LENGTHS.items():
        value = payload_dict.get(field)
        if value is None:
            continue
        if len(str(value)) > max_len:
            raise HTTPException(
                status_code=400,
                detail=f"{field} must be at most {max_len} characters (received {len(str(value))}).",
            )


def _validate_references(
    db: Session,
    checker_id: Optional[str] = None,
    bottle_id: Optional[int] = None,
    defect_ids: Optional[List[Optional[int]]] = None,
) -> None:
    """Verify every foreign key against its master table before writing.

    checker_id  -> hpr.employee_master.employee_id
    bottle_id   -> production.bottle_master.bottle_id
    defect_id   -> hpr.defect_master.defect_id
    """
    if checker_id is not None:
        employee_table = _hpr_table("employee_master")
        found = db.execute(
            text(f"SELECT employee_id FROM {employee_table} WHERE employee_id = :id"),
            {"id": checker_id},
        ).fetchone()
        if not found:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid Checker ID '{checker_id}': no matching record in "
                    "hpr.employee_master. Please re-select the checker."
                ),
            )

    if bottle_id is not None:
        bottle_table = _production_table("bottle_master")
        found = db.execute(
            text(f"SELECT bottle_id FROM {bottle_table} WHERE bottle_id = :id"),
            {"id": bottle_id},
        ).fetchone()
        if not found:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid Bottle ID '{bottle_id}': not found in production.bottle_master.",
            )

    for d_id in defect_ids or []:
        if d_id is None:
            continue
        defect_table = _hpr_table("defect_master")
        found = db.execute(
            text(f"SELECT defect_id FROM {defect_table} WHERE defect_id = :id"),
            {"id": d_id},
        ).fetchone()
        if not found:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid Defect ID '{d_id}': not found in hpr.defect_master.",
            )


def _target_defect_ids(payload) -> List[Optional[int]]:
    """One row per defect: expand defect_ids, fall back to defect_id, else NULL."""
    ids: List[Optional[int]] = []
    if payload.defect_ids:
        ids = [d for d in payload.defect_ids if d is not None]
    elif payload.defect_id is not None:
        ids = [payload.defect_id]
    return ids or [None]


# Persistable columns of sqc.repacking_numbering / sqc.repacking_sqc_qc_hold.
# ``defect_id`` is appended per row (one row per defect) and ``entry_id`` is
# generated by the database.
_NUMBERING_INSERT_FIELDS = [
    "production_date", "machine_no", "job_id", "bottle_id", "pack_type",
    "shift", "entry_time", "pcs_per_pack", "cartons", "defective_bottles",
    "mould", "section_no", "checker_id", "remarks",
]

_SQC_INSERT_FIELDS = [
    "production_date", "machine_no", "job_id", "bottle_id", "pack_type", "lot_no",
    "shift", "entry_time", "pcs_per_pack", "cartons", "defective_bottles",
    "mould", "section_no", "checker_id", "remarks",
]


def _insert_repacking_rows(
    db: Session,
    table: str,
    fields: List[str],
    base_params: dict,
    defect_ids: List[Optional[int]],
) -> List[int]:
    """INSERT one row per defect inside the caller's open transaction.

    The generated ``entry_id`` values are read back with RETURNING so callers
    can answer with the exact rows they created.
    """
    columns = ", ".join(fields + ["defect_id", "created_at", "updated_at"])
    values = ", ".join(f":{f}" for f in fields) + ", :defect_id, :created_at, :updated_at"
    insert_query = text(f"INSERT INTO {table} ({columns}) VALUES ({values}) RETURNING entry_id")

    entry_ids: List[int] = []
    for d_id in defect_ids:
        params = dict(base_params)
        params["defect_id"] = d_id
        new_id = db.execute(insert_query, params).scalar()
        entry_ids.append(int(new_id))
    return entry_ids


def _prepare_insert_params(payload, fields: List[str], now_dt: datetime) -> dict:
    """Sanitised, length-checked column values ready for INSERT."""
    data = _sanitize_text_fields(payload.model_dump())
    if not data.get("job_id"):
        raise HTTPException(status_code=400, detail="Job ID is required.")
    _validate_string_lengths(data)

    params = {f: data.get(f) for f in fields}
    params["entry_time"] = _format_time_sql(data.get("entry_time"))
    params["created_at"] = now_dt
    params["updated_at"] = now_dt
    return params


def _update_entry_group(
    db: Session,
    table: str,
    e_id: int,
    payload,
    allowed_fields: List[str],
    not_found_detail: str,
    group_ids_fn,
    now_dt: datetime,
) -> List[int]:
    """Update EVERY physical row of the logical entry rooted at ``e_id``.

    Rows are stored one-per-defect, so a logical entry is a group of physical
    rows that share every column except ``defect_id``. Updating only the row
    that happens to carry the clicked ``entry_id`` would leave its siblings on
    the old values and the group would split in two the next time it is read.
    This helper therefore rewrites the whole group (resolved from the database,
    never from a client-supplied guess) and reconciles the defect rows:

      * only the columns actually present in the payload are written,
      * defect rows are only touched when ``defect_id(s)`` was sent —
        fewer defects than stored rows deletes the surplus rows, more defects
        inserts the missing rows, otherwise each row keeps its own defect,
      * an unknown ``entry_id`` raises 404 before anything is written.

    Shared by the single-entry PUT endpoints and the batch ``/save`` updates so
    both behave identically. Returns the affected ``entry_id``s.
    """
    existing_row = db.execute(
        text(f"SELECT * FROM {table} WHERE entry_id = :entry_id"),
        {"entry_id": e_id},
    ).mappings().first()
    if not existing_row:
        raise HTTPException(status_code=404, detail=not_found_detail)

    group_ids = [int(x) for x in (group_ids_fn(db, e_id) or [])] or [e_id]

    raw = payload.model_dump(exclude_unset=True)
    had_defect_ids = "defect_ids" in raw
    had_defect_id = "defect_id" in raw
    for key in ("entry_id", "entry_ids", "defect_ids", "defect_id"):
        raw.pop(key, None)

    data = _sanitize_text_fields(raw)
    if "job_id" in data and not data["job_id"]:
        raise HTTPException(status_code=400, detail="Job ID cannot be empty.")
    # The update schema makes every column optional, so an explicit null would
    # otherwise reach the database and come back as a driver-level error.
    for required in ("production_date", "machine_no", "shift", "entry_time"):
        if required in data and data[required] in (None, ""):
            raise HTTPException(status_code=400, detail=f"{required} cannot be empty.")
    _validate_string_lengths(data)

    # Validate the foreign keys that are part of this update.
    defect_targets: Optional[List[Optional[int]]] = None
    if had_defect_ids or had_defect_id:
        defect_targets = _target_defect_ids(payload)
    checker_id = data["checker_id"] if "checker_id" in data else None
    bottle_id = data["bottle_id"] if "bottle_id" in data else None
    _validate_references(db, checker_id=checker_id, bottle_id=bottle_id, defect_ids=defect_targets or [])

    update_fields = {k: v for k, v in data.items() if k in allowed_fields}
    if not update_fields and defect_targets is None:
        return list(group_ids)

    common = len(group_ids) if defect_targets is None else min(len(group_ids), len(defect_targets))

    # 1. Rewrite the shared columns of every row of the group.
    for idx in range(common):
        assignments = ["updated_at = :updated_at"]
        params: dict = {"entry_id": group_ids[idx], "updated_at": now_dt}
        if defect_targets is not None:
            assignments.append("defect_id = :defect_id")
            params["defect_id"] = defect_targets[idx]
        for field, value in update_fields.items():
            if field == "entry_time":
                value = _format_time_sql(value)
            assignments.append(f"{field} = :{field}")
            params[field] = value
        db.execute(
            text(f"UPDATE {table} SET {', '.join(assignments)} WHERE entry_id = :entry_id"),
            params,
        )
    affected_ids = group_ids[:common]

    if defect_targets is None:
        return affected_ids

    # 2. Fewer defects than stored rows -> drop the surplus rows.
    if len(group_ids) > len(defect_targets):
        surplus = group_ids[len(defect_targets):]
        db.execute(
            text(f"DELETE FROM {table} WHERE entry_id IN :ids").bindparams(
                bindparam("ids", expanding=True)
            ),
            {"ids": surplus},
        )

    # 3. More defects than stored rows -> add the missing rows in place.
    if len(defect_targets) > len(group_ids):
        base_insert = {
            f: update_fields[f] if f in update_fields else existing_row.get(f)
            for f in allowed_fields
        }
        base_insert["entry_time"] = (
            _format_time_sql(update_fields.get("entry_time"))
            or _format_time_sql(existing_row["entry_time"])
        )
        base_insert["created_at"] = now_dt
        base_insert["updated_at"] = now_dt
        affected_ids.extend(
            _insert_repacking_rows(
                db, table, allowed_fields, base_insert, defect_targets[len(group_ids):]
            )
        )

    return affected_ids


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
        qa_shift_ex_id=None,
        qa_shift_ex_name=None,
        remarks=r.get("remarks"),
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
        qa_shift_ex_id=None,
        qa_shift_ex_name=None,
        remarks=r.get("remarks"),
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
            r.get("remarks"),
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
            r.get("remarks"),
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
# SELECT builders — one place so GET, fetch-by-id and delete always agree on
# the columns, the master joins (bottle / defect / checker) and the ordering.
# ---------------------------------------------------------------------------

def _numbering_select(where_clause: str = "") -> str:
    num_table = _sqc_table("repacking_numbering")
    bottle_table = _production_table("bottle_master")
    defect_table = _hpr_table("defect_master")
    employee_table = _hpr_table("employee_master")
    return f"""
        SELECT
            n.entry_id, n.production_date, n.machine_no, n.job_id,
            n.bottle_id, b.bottle_name,
            n.pack_type, n.shift, n.entry_time,
            n.pcs_per_pack, n.cartons, n.defective_bottles,
            n.defect_id, d.defect_name,
            n.mould, n.section_no,
            n.checker_id, cu.employee_name AS checker_name,
            n.remarks,
            n.created_at, n.updated_at
        FROM {num_table} n
        LEFT JOIN {bottle_table} b ON b.bottle_id = n.bottle_id
        LEFT JOIN {defect_table} d ON d.defect_id = n.defect_id
        LEFT JOIN {employee_table} cu ON cu.employee_id = n.checker_id
        {where_clause}
        ORDER BY n.machine_no ASC, n.shift ASC, n.entry_time ASC, n.entry_id ASC
    """


def _sqc_select(where_clause: str = "") -> str:
    sqc_table = _sqc_table("repacking_sqc_qc_hold")
    bottle_table = _production_table("bottle_master")
    defect_table = _hpr_table("defect_master")
    employee_table = _hpr_table("employee_master")
    return f"""
        SELECT
            s.entry_id, s.production_date, s.machine_no, s.job_id,
            s.bottle_id, b.bottle_name,
            s.pack_type, s.lot_no, s.shift, s.entry_time,
            s.pcs_per_pack, s.cartons, s.defective_bottles,
            s.defect_id, d.defect_name,
            s.mould, s.section_no,
            s.checker_id, cu.employee_name AS checker_name,
            s.remarks,
            s.created_at, s.updated_at
        FROM {sqc_table} s
        LEFT JOIN {bottle_table} b ON b.bottle_id = s.bottle_id
        LEFT JOIN {defect_table} d ON d.defect_id = s.defect_id
        LEFT JOIN {employee_table} cu ON cu.employee_id = s.checker_id
        {where_clause}
        ORDER BY s.machine_no ASC, s.shift ASC, s.entry_time ASC, s.entry_id ASC
    """


def _numbering_group_entry_ids(db: Session, entry_id: int) -> List[int]:
    """All ``entry_id``s that belong to the same logical entry as ``entry_id``.

    Rows are stored one-per-defect, so a logical entry spans several physical
    rows that share every column except ``defect_id``. The group is resolved
    through the same grouping used by the GET endpoint, which keeps DELETE and
    the single-entry fetch consistent with what the UI sees.
    """
    num_table = _sqc_table("repacking_numbering")
    base = db.execute(
        text(f"SELECT production_date, machine_no FROM {num_table} WHERE entry_id = :entry_id"),
        {"entry_id": entry_id},
    ).mappings().first()
    if not base:
        return []

    results = db.execute(
        text(_numbering_select("WHERE n.production_date = :p_date AND n.machine_no = :m_no")),
        {"p_date": base["production_date"], "m_no": base["machine_no"]},
    ).mappings().all()

    for group in _group_numbering_rows(results):
        ids = group.entry_ids or [group.entry_id]
        if str(entry_id) in ids:
            return [int(x) for x in ids]
    return []


def _sqc_group_entry_ids(db: Session, entry_id: int) -> List[int]:
    """SQC/QC HOLD twin of :func:`_numbering_group_entry_ids`."""
    sqc_table = _sqc_table("repacking_sqc_qc_hold")
    base = db.execute(
        text(f"SELECT production_date, machine_no FROM {sqc_table} WHERE entry_id = :entry_id"),
        {"entry_id": entry_id},
    ).mappings().first()
    if not base:
        return []

    results = db.execute(
        text(_sqc_select("WHERE s.production_date = :p_date AND s.machine_no = :m_no")),
        {"p_date": base["production_date"], "m_no": base["machine_no"]},
    ).mappings().all()

    for group in _group_sqc_rows(results):
        ids = group.entry_ids or [group.entry_id]
        if str(entry_id) in ids:
            return [int(x) for x in ids]
    return []


# ---------------------------------------------------------------------------
# Employees Dropdown API
# ---------------------------------------------------------------------------

@router.get("/employees", response_model=List[EmployeeResponse])
def get_repacking_employees(
    role: Optional[str] = None,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_read(MODULE_QUALITY_CONTROL)),
):
    """Employees available for the Checker / QA Executive dropdowns.

    Source of truth:
      * ``hpr.employee_master``  - employee_id (FK used by the repacking rows)
                                   and employee_name (shown in the UI).
      * ``sqc.sqc_role``         - which ACTIVE role each employee holds.

    Only employees that are active in BOTH tables are returned, and each item
    carries its active ``roles`` (CHECKER / QA_EXECUTIVE). Pass
    ``?role=CHECKER`` or ``?role=QA_EXECUTIVE`` to restrict the list to a
    single dropdown.
    """
    employee_table = _hpr_table("employee_master")
    role_table = _sqc_table("sqc_role")

    conditions = ["r.is_active = TRUE", "e.is_active = TRUE"]
    params: dict = {}
    if role:
        conditions.append("r.role_code = :role")
        params["role"] = role.strip().upper()

    stmt = text(f"""
        SELECT e.employee_id, e.employee_name, r.role_code
        FROM {employee_table} e
        JOIN {role_table} r ON r.employee_id = e.employee_id
        WHERE {' AND '.join(conditions)}
        ORDER BY e.employee_name ASC, e.employee_id ASC
    """)
    rows = db.execute(stmt, params).mappings().all()

    # employee_id stays a string end-to-end so leading zeros ("0003") survive.
    by_employee: dict = {}
    for r in rows:
        employee_id = str(r["employee_id"])
        item = by_employee.get(employee_id)
        if item is None:
            item = EmployeeResponse(
                employee_id=employee_id,
                employee_name=r["employee_name"],
                roles=[],
            )
            by_employee[employee_id] = item
        role_code = r["role_code"]
        if role_code and role_code not in item.roles:
            item.roles.append(role_code)
    return list(by_employee.values())


# ---------------------------------------------------------------------------
# Combined repacking data fetch
# ---------------------------------------------------------------------------

@router.get("/", response_model=RepackingDataResponse)
def get_repacking_data(
    production_date: Optional[str] = None,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_read(MODULE_QUALITY_CONTROL)),
):
    """Fetch both numbering and SQC/QC HOLD entries for a production date in one request.

    Replaces two separate GET /numbering and GET /sqc-qc-hold calls with a single
    round-trip, returning both datasets together for the given date.
    """
    conditions = []
    params = {}

    if production_date:
        try:
            parsed_date = datetime.strptime(production_date.strip(), "%Y-%m-%d").date()
            conditions.append("n.production_date = :p_date")
            params["p_date"] = parsed_date
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format, use YYYY-MM-DD")

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    numbering_results = db.execute(text(_numbering_select(where_clause)), params).mappings().all()
    sqc_results = db.execute(text(_sqc_select(where_clause)), params).mappings().all()

    return RepackingDataResponse(
        numbering=_group_numbering_rows(numbering_results),
        sqc_qc_hold=_group_sqc_rows(sqc_results),
    )


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

    results = db.execute(text(_numbering_select(where_clause)), params).mappings().all()
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

    target_defects = _target_defect_ids(payload)
    base_params = _prepare_insert_params(payload, _NUMBERING_INSERT_FIELDS, now_dt)
    _validate_references(
        db,
        checker_id=base_params.get("checker_id"),
        bottle_id=base_params.get("bottle_id"),
        defect_ids=target_defects,
    )

    try:
        entry_ids = _insert_repacking_rows(
            db, num_table, _NUMBERING_INSERT_FIELDS, base_params, target_defects
        )
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="CREATE_REPACKING_NUMBERING",
            details=f"Created numbering entry {entry_ids[0]} for machine {payload.machine_no} on {payload.production_date}",
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.error(f"Failed to create numbering entry: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to save numbering entry: {exc}")

    return _fetch_numbering_by_id(db, entry_ids[0])


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

    try:
        affected_ids = _update_entry_group(
            db, num_table, e_id, payload, _NUMBERING_INSERT_FIELDS,
            not_found_detail="Numbering entry not found",
            group_ids_fn=_numbering_group_entry_ids,
            now_dt=datetime.now(timezone.utc),
        )
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="UPDATE_REPACKING_NUMBERING",
            details=f"Updated numbering entry {e_id} ({len(affected_ids)} row(s))",
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
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

    # Delete exactly the rows of this logical entry (one row per defect) —
    # never other entries that merely share the same job / time slot.
    group_ids = _numbering_group_entry_ids(db, e_id)
    if not group_ids:
        raise HTTPException(status_code=404, detail="Numbering entry not found")

    try:
        db.execute(
            text(f"DELETE FROM {num_table} WHERE entry_id IN :entry_ids").bindparams(
                bindparam("entry_ids", expanding=True)
            ),
            {"entry_ids": group_ids},
        )
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="DELETE_REPACKING_NUMBERING",
            details=f"Deleted numbering entry {e_id} ({len(group_ids)} row(s))",
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
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
    Inserts new records and updates modified records in a single database
    transaction; anything that fails rolls the whole save back.
    """
    num_table = _sqc_table("repacking_numbering")
    affected_ids: List[int] = []
    now_dt = datetime.now(timezone.utc)

    try:
        # 1. Process Inserts (multi-defect supported: one row per defect)
        for item in payload.inserts:
            d_ids = _target_defect_ids(item)
            base_params = _prepare_insert_params(item, _NUMBERING_INSERT_FIELDS, now_dt)
            _validate_references(
                db,
                checker_id=base_params.get("checker_id"),
                bottle_id=base_params.get("bottle_id"),
                defect_ids=d_ids,
            )
            affected_ids.extend(
                _insert_repacking_rows(db, num_table, _NUMBERING_INSERT_FIELDS, base_params, d_ids)
            )

        # 2. Process Updates — every row of the logical entry is rewritten in
        #    place (never re-inserted), so a save can not duplicate rows.
        for item in payload.updates:
            try:
                e_id = int(item.entry_id)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid entry_id: {item.entry_id!r}.",
                )
            affected_ids.extend(
                _update_entry_group(
                    db,
                    num_table,
                    e_id,
                    item,
                    _NUMBERING_INSERT_FIELDS,
                    not_found_detail=(
                        f"Numbering entry {e_id} no longer exists. "
                        "Please refresh the page and try again."
                    ),
                    group_ids_fn=_numbering_group_entry_ids,
                    now_dt=now_dt,
                )
            )

        if payload.inserts or payload.updates:
            db.add(AuditLog(
                user_id=current_user.employee_id,
                action="BATCH_SAVE_REPACKING_NUMBERING",
                details=f"Saved {len(payload.inserts)} new and {len(payload.updates)} updated numbering entries",
            ))

        db.commit()
    except HTTPException:
        db.rollback()
        raise
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

    results = db.execute(text(_sqc_select(where_clause)), params).mappings().all()
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

    target_defects = _target_defect_ids(payload)
    base_params = _prepare_insert_params(payload, _SQC_INSERT_FIELDS, now_dt)
    _validate_references(
        db,
        checker_id=base_params.get("checker_id"),
        bottle_id=base_params.get("bottle_id"),
        defect_ids=target_defects,
    )

    try:
        entry_ids = _insert_repacking_rows(
            db, sqc_table, _SQC_INSERT_FIELDS, base_params, target_defects
        )
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="CREATE_REPACKING_SQC_QC_HOLD",
            details=f"Created SQC/QC HOLD entry {entry_ids[0]} for machine {payload.machine_no} on {payload.production_date}",
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.error(f"Failed to create SQC/QC HOLD entry: {exc}")
        raise HTTPException(status_code=400, detail=f"Failed to save SQC/QC HOLD entry: {exc}")

    return _fetch_sqc_by_id(db, entry_ids[0])


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

    try:
        affected_ids = _update_entry_group(
            db, sqc_table, e_id, payload, _SQC_INSERT_FIELDS,
            not_found_detail="SQC/QC HOLD entry not found",
            group_ids_fn=_sqc_group_entry_ids,
            now_dt=datetime.now(timezone.utc),
        )
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="UPDATE_REPACKING_SQC_QC_HOLD",
            details=f"Updated SQC/QC HOLD entry {e_id} ({len(affected_ids)} row(s))",
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
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

    # Delete exactly the rows of this logical entry (one row per defect).
    group_ids = _sqc_group_entry_ids(db, e_id)
    if not group_ids:
        raise HTTPException(status_code=404, detail="SQC/QC HOLD entry not found")

    try:
        db.execute(
            text(f"DELETE FROM {sqc_table} WHERE entry_id IN :entry_ids").bindparams(
                bindparam("entry_ids", expanding=True)
            ),
            {"entry_ids": group_ids},
        )
        db.add(AuditLog(
            user_id=current_user.employee_id,
            action="DELETE_REPACKING_SQC_QC_HOLD",
            details=f"Deleted SQC/QC HOLD entry {e_id} ({len(group_ids)} row(s))",
        ))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
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
    Inserts new records and updates modified records in a single database
    transaction; anything that fails rolls the whole save back.
    """
    sqc_table = _sqc_table("repacking_sqc_qc_hold")
    affected_ids: List[int] = []
    now_dt = datetime.now(timezone.utc)

    try:
        # 1. Process Inserts (multi-defect supported: one row per defect)
        for item in payload.inserts:
            d_ids = _target_defect_ids(item)
            base_params = _prepare_insert_params(item, _SQC_INSERT_FIELDS, now_dt)
            _validate_references(
                db,
                checker_id=base_params.get("checker_id"),
                bottle_id=base_params.get("bottle_id"),
                defect_ids=d_ids,
            )
            affected_ids.extend(
                _insert_repacking_rows(db, sqc_table, _SQC_INSERT_FIELDS, base_params, d_ids)
            )

        # 2. Process Updates — every row of the logical entry is rewritten in
        #    place (never re-inserted), so a save can not duplicate rows.
        for item in payload.updates:
            try:
                e_id = int(item.entry_id)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid entry_id: {item.entry_id!r}.",
                )
            affected_ids.extend(
                _update_entry_group(
                    db,
                    sqc_table,
                    e_id,
                    item,
                    _SQC_INSERT_FIELDS,
                    not_found_detail=(
                        f"SQC/QC HOLD entry {e_id} no longer exists. "
                        "Please refresh the page and try again."
                    ),
                    group_ids_fn=_sqc_group_entry_ids,
                    now_dt=now_dt,
                )
            )

        if payload.inserts or payload.updates:
            db.add(AuditLog(
                user_id=current_user.employee_id,
                action="BATCH_SAVE_REPACKING_SQC_QC_HOLD",
                details=f"Saved {len(payload.inserts)} new and {len(payload.updates)} updated SQC/QC HOLD entries",
            ))

        db.commit()
    except HTTPException:
        db.rollback()
        raise
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
    group_ids = _numbering_group_entry_ids(db, entry_id)
    if not group_ids:
        raise HTTPException(status_code=404, detail="Numbering entry not found")

    items = _fetch_numbering_by_ids(db, group_ids)
    for item in items:
        if str(entry_id) in (item.entry_ids or [item.entry_id]):
            return item
    raise HTTPException(status_code=404, detail="Numbering entry not found")


def _fetch_numbering_by_ids(db: Session, entry_ids: List[int]) -> List[NumberingEntryResponse]:
    if not entry_ids:
        return []

    unique_ids = sorted({int(x) for x in entry_ids})
    query = text(_numbering_select("WHERE n.entry_id IN :entry_ids")).bindparams(
        bindparam("entry_ids", expanding=True)
    )
    results = db.execute(query, {"entry_ids": unique_ids}).mappings().all()
    return _group_numbering_rows(results)


def _fetch_sqc_by_id(db: Session, entry_id: int) -> SqcQcHoldEntryResponse:
    group_ids = _sqc_group_entry_ids(db, entry_id)
    if not group_ids:
        raise HTTPException(status_code=404, detail="SQC/QC HOLD entry not found")

    items = _fetch_sqc_by_ids(db, group_ids)
    for item in items:
        if str(entry_id) in (item.entry_ids or [item.entry_id]):
            return item
    raise HTTPException(status_code=404, detail="SQC/QC HOLD entry not found")


def _fetch_sqc_by_ids(db: Session, entry_ids: List[int]) -> List[SqcQcHoldEntryResponse]:
    if not entry_ids:
        return []

    unique_ids = sorted({int(x) for x in entry_ids})
    query = text(_sqc_select("WHERE s.entry_id IN :entry_ids")).bindparams(
        bindparam("entry_ids", expanding=True)
    )
    results = db.execute(query, {"entry_ids": unique_ids}).mappings().all()
    return _group_sqc_rows(results)
