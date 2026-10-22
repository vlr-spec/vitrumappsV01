# pyrefly: ignore [missing-import]
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import select
from datetime import datetime, date, time as dtime, timedelta
from typing import Dict, Any, List, Optional, Tuple

from app.db.session import get_db
from app.models.quality import (
    HourlyProductionReport, ShiftAssignment, HourlyProduction,
    DefectMaster, HourlyProductionDefect, HprJob
)
from app.schemas.quality import QualityDailyRequest, QualityDailyResponse, QualityHourlyEntrySchema, QualityShiftAssignmentSchema, QualityJobRowSchema, QualityRowLockRequest, QualityRowLockResponse
from app.api.permissions import require_module_read, require_module_edit, MODULE_QUALITY_CONTROL
from app.models.auth import AuthUser

logger = logging.getLogger(__name__)

router = APIRouter()

# Rejected by every write path that touches a locked hourly row. The wording is
# part of the contract: the frontend surfaces this string verbatim to the user.
LOCKED_ROW_DETAIL = "This row is locked and cannot be edited."

PRODUCTION_TIMES = [
    {'time': '9:00 AM', 'shift_id': 1}, {'time': '10:00 AM', 'shift_id': 1},
    {'time': '11:00 AM', 'shift_id': 1}, {'time': '12:00 PM', 'shift_id': 1},
    {'time': '1:00 PM', 'shift_id': 1}, {'time': '2:00 PM', 'shift_id': 1},
    {'time': '3:00 PM', 'shift_id': 1}, {'time': '4:00 PM', 'shift_id': 1},
    {'time': '5:00 PM', 'shift_id': 2}, {'time': '6:00 PM', 'shift_id': 2},
    {'time': '7:00 PM', 'shift_id': 2}, {'time': '8:00 PM', 'shift_id': 2},
    {'time': '9:00 PM', 'shift_id': 2}, {'time': '10:00 PM', 'shift_id': 2},
    {'time': '11:00 PM', 'shift_id': 2}, {'time': '12:00 AM', 'shift_id': 2},
    {'time': '1:00 AM', 'shift_id': 3}, {'time': '2:00 AM', 'shift_id': 3},
    {'time': '3:00 AM', 'shift_id': 3}, {'time': '4:00 AM', 'shift_id': 3},
    {'time': '5:00 AM', 'shift_id': 3}, {'time': '6:00 AM', 'shift_id': 3},
    {'time': '7:00 AM', 'shift_id': 3}, {'time': '8:00 AM', 'shift_id': 3},
]

MACHINES = [1, 2, 3, 4]
SHIFTS = [1, 2, 3]

def _parse_time_string(time_str: str) -> dtime:
    """Parse a grid label ("9:00 AM") into a normalized time-of-day.

    The canonical 12-hour label is tried first, then the common variants a
    client may send ("09:00", "09:00:00", "9:00am"), so a single reformatted
    label can never abort an entire save. Seconds and microseconds are always
    dropped so every key built from the result compares equal.
    """
    raw = (time_str or "").strip().upper()
    for fmt in ("%I:%M %p", "%I:%M%p", "%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).time().replace(second=0, microsecond=0)
        except ValueError:
            continue
    raise ValueError(f"Unrecognised production time {time_str!r}")


def _slot_time(time_str: str) -> dtime:
    """Like `_parse_time_string` but reports a 400 instead of a 500."""
    try:
        return _parse_time_string(time_str)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid production time: {time_str!r}")


def _norm_time(value: Any) -> Optional[dtime]:
    """Normalize a stored/incoming `production_time` to a time-of-day.

    `hpr.hourly_production.production_time` is declared as a DATETIME column,
    but depending on the driver, the column type actually provisioned, or how a
    row was written, the value read back may be a `datetime`, a plain `time`
    (TIME column) or a string. Every entry-map key must be built from the same
    normalized time-of-day on both sides — otherwise an existing row is never
    matched, the save inserts a duplicate (or trips `uq_hpr_machine_hour` and
    rolls the whole request back) and the previously saved `bottle_id` is lost.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.time().replace(second=0, microsecond=0)
    if isinstance(value, dtime):
        return value.replace(second=0, microsecond=0)
    raw = str(value).strip()
    # A driver may hand back the whole date-time as a string; without a date
    # part none of the grid-label formats below match, the row is skipped and
    # the next save inserts a duplicate for a slot that already exists.
    try:
        return datetime.fromisoformat(raw).time().replace(second=0, microsecond=0)
    except ValueError:
        pass
    try:
        return _parse_time_string(raw)
    except ValueError:
        return None


def _entry_key(machine_no: int, production_time: Any) -> Tuple[int, Optional[dtime]]:
    """The single canonical identity of an hourly row: machine + time-of-day."""
    return (machine_no, _norm_time(production_time))


# Clock time -> owning shift, precomputed from the same PRODUCTION_TIMES grid
# the UI renders, so a row created outside the save path (the lock endpoint)
# always lands in the shift the grid already displays for that slot.
SLOT_SHIFT_IDS: Dict[dtime, int] = {_parse_time_string(pt["time"]): pt["shift_id"] for pt in PRODUCTION_TIMES}


def _shift_id_for_slot(slot: Optional[dtime]) -> int:
    """Shift of a clock time; a minute-granularity split inherits its hour."""
    if slot is None:
        return 1
    direct = SLOT_SHIFT_IDS.get(slot)
    if direct is not None:
        return direct
    return SLOT_SHIFT_IDS.get(slot.replace(minute=0, second=0, microsecond=0)) or 1


def _norm_lock_value(value: Any, blank_zero: bool = False) -> Any:
    """Normalizes one column value for the locked-row comparison.

    A stored NULL and the grid's empty value (``None`` / ``""``) must compare
    equal, and numbers must compare numerically — a Numeric column read back as
    ``Decimal("52.50")`` has to match the ``52.5`` the client echoes. The grid
    writes ``qc_hold`` as ``0`` rather than NULL, so a stored NULL there means 0.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return 0.0 if blank_zero else None
    if isinstance(value, bool):
        return value
    try:
        return round(float(value), 6)
    except (TypeError, ValueError):
        return str(value).strip()


def _norm_lock_parts(value: Any) -> Tuple[str, ...]:
    """Splits a packing value (stored string or client list) into its items."""
    if value is None:
        return ()
    parts = value if isinstance(value, (list, tuple)) else str(value).split(",")
    return tuple(str(p).strip() for p in parts if str(p).strip())


def _locked_payload_differs(entry: HourlyProduction, data: QualityHourlyEntrySchema) -> bool:
    """True when the incoming row would CHANGE the stored data of a locked row.

    Only the fields an operator can actually edit are compared. ``weight_avg``,
    ``bottles_in_nos`` and ``efficiency_percentage`` are deliberately excluded:
    the grid recomputes all three from the fields below on every save, so their
    stored value can never tell an edit apart from a recomputation. Excluding
    them is safe because a locked row is never written at all — the save skips
    it entirely once this check passes, so nothing can be smuggled past the lock.
    """
    numeric = (
        (entry.bottle_id, data.bottle_id, False),
        (entry.weight_front, data.weight_front, False),
        (entry.weight_middle, data.weight_middle, False),
        (entry.weight_rear, data.weight_rear, False),
        (entry.speed_per_min, data.speed_per_min, False),
        (entry.weight_efficiency, data.weight_efficiency, False),
        (entry.packing_size, data.packing_size, False),
        (entry.cartons, data.cartons, False),
        (entry.sqc, data.sqc, False),
        (entry.qc_hold, data.qc_hold, True),
        (entry.num, data.num, False),
    )
    for stored, incoming, blank_zero in numeric:
        if _norm_lock_value(stored, blank_zero) != _norm_lock_value(incoming, blank_zero):
            return True
    if _norm_lock_value(entry.remarks) != _norm_lock_value(data.remarks):
        return True
    if _norm_lock_parts(entry.packing_category) != _norm_lock_parts(data.packing_category):
        return True
    if _norm_lock_value(entry.job_id) != _norm_lock_value(data.job_id):
        return True
    if _norm_lock_value(getattr(entry, "split_group_id", None)) != _norm_lock_value(data.split_group_id):
        return True
    stored_defects = tuple(sorted(str(d.defect_name) for d in entry.defects))
    incoming_defects = tuple(sorted(str(n) for n in (data.defect_ids or []) if str(n).strip()))
    return stored_defects != incoming_defects


def _physical_dt(production_date: date, value: Any) -> Optional[datetime]:
    """Timeline position of one hourly row inside the 9 AM production day.

    A production day runs 9:00 AM -> 8:59 AM of the NEXT calendar day, but the
    12:00 AM - 8:59 AM slots are stored under the report date. On this internal
    timeline those overnight slots are pushed one day forward so they sort
    AFTER the same report date's evening slots — used only to order jobs and to
    pick a job's first row. The DATE shown to the user is always the row's
    production date (a 1:00 AM start belongs to the previous production date).
    """
    slot = _norm_time(value)
    if slot is None or production_date is None:
        return None
    base = datetime.combine(production_date, slot)
    if slot.hour < 9:
        base += timedelta(days=1)
    return base


def _timeline_minutes(slot: dtime) -> int:
    """Minutes since the 9 AM production-day start (9:00 AM = 0 … 8:59 AM next day)."""
    mins = slot.hour * 60 + slot.minute
    nine_am = 9 * 60
    return mins + 24 * 60 - nine_am if mins < nine_am else mins - nine_am


def _slot_from_timeline_minutes(mins: int) -> dtime:
    """Clock time of a production-timeline minute offset (9:00 AM = 0)."""
    total = (9 * 60 + mins) % (24 * 60)
    return dtime(total // 60, total % 60)


def _label_from_timeline_minutes(mins: int) -> str:
    """Canonical 12-hour grid label of a production-timeline minute offset,
    including negative offsets of the day's first row ("8:00 AM", "7:10 AM")."""
    total = (9 * 60 + mins) % (24 * 60)
    hour = total // 60
    return f"{hour % 12 or 12}:{total % 60:02d} {'AM' if hour < 12 else 'PM'}"


# Sanity ceiling of a row's directly stored period (12 hours) — every valid
# Layer Out Time adjustment, split segment and third-shift carry-in stays well
# inside it. Periods long enough only to occur on a production day's FIRST row
# (a previous day's third shift extended beyond its 8 AM key by 61-119 minutes
# spans 1381-1439 minutes) cannot fit the microsecond field and are stored
# with the _PERIOD_MINUTES_OVERFLOW marker offset instead.
_PERIOD_MINUTES_MAX = 720
_PERIOD_MINUTES_OVERFLOW = 1320  # encoded value => period = value + 1320
_PERIOD_MINUTES_HARD_MAX = 1440


def _period_minutes_from_labels(
    period_start: Optional[str],
    period_end: Optional[str],
) -> Optional[int]:
    """Duration (minutes) of the period the payload row covers, parsed from the
    frontend's period_start / period_end labels; None when absent or invalid.

    This is the ONLY place the adjusted timeline of a save reaches the
    database: the duration is embedded into the row's own production_time
    timestamp (see _encoded_entry_dt) so the Layer Out Time of every shift
    survives Save, Refresh and Reload without any schema change and without
    storing the value separately.
    """
    if not period_start or not period_end:
        return None
    raw = str(period_start).strip()
    raw_end = str(period_end).strip()
    if not raw or not raw_end:
        return None
    try:
        start = _timeline_minutes(_parse_time_string(raw))
        end = _timeline_minutes(_parse_time_string(raw_end))
    except ValueError:
        return None
    diff = end - start
    # A first row ("8:00 AM" -> "9:00 AM") and every midnight transition wrap;
    # one production day forward repairs both.
    if diff <= 0:
        diff += 24 * 60
    # 1440 = degenerate zero-length wrap (start label == end label) -> no info.
    if diff <= 0 or diff >= _PERIOD_MINUTES_HARD_MAX:
        return None
    return diff


def _encoded_entry_dt(
    production_date: date,
    slot: dtime,
    period_minutes: Optional[int],
) -> datetime:
    """The production_time datetime this row is persisted under.

    Unadjusted rows keep their historical shape unchanged: production date +
    the grid's time-of-day key (seconds and microseconds zero). When the row's
    actual covered period is NOT the plain full hour — a Layer Out Time
    adjustment, a split segment or the previous day's carried-in third-shift
    interval — the period's real duration in minutes is embedded in the
    timestamp's MICROSECOND field (minutes*1000, or an overflow-marker encoding
    minutes*1000+500 for periods beyond one microsecond field).

    Embedding it there instead of adding a column keeps the database schema
    unchanged, keeps the row identity (machine + normalized time-of-day) that
    the upsert, the lock endpoint and the unique constraint rely on, and keeps
    every existing read path correct: they all normalize the timestamp to the
    minute (via _norm_time) and never observe the embedded duration. The value
    is therefore not stored separately — it rides inside the row's own saved
    start/end timestamp.
    """
    key_dt = datetime.combine(production_date, slot).replace(second=0, microsecond=0)
    if period_minutes is None or (
        period_minutes == 60 and period_minutes < _PERIOD_MINUTES_HARD_MAX
    ):
        return key_dt
    minutes = int(period_minutes)
    if minutes <= 0 or minutes >= _PERIOD_MINUTES_HARD_MAX:
        return key_dt
    if minutes <= _PERIOD_MINUTES_MAX:
        # Plain duration, always a multiple of 1000 microseconds.
        return key_dt.replace(microsecond=minutes * 1000)
    # Beyond the microsecond field: period value - overflow marker (the +500
    # half-microsecond marks the offset encoding; the plain encoding is always
    # a whole multiple of 1000, so the two can never be confused).
    encoded = minutes - _PERIOD_MINUTES_OVERFLOW
    if encoded <= 0 or encoded >= _PERIOD_MINUTES_HARD_MAX:
        return key_dt
    return key_dt.replace(microsecond=encoded * 1000 + 500)


def _stored_period_minutes(production_time: Any) -> Optional[int]:
    """Period duration (minutes) embedded in one row's persisted
    production_time — the inverse of _encoded_entry_dt; None for plain rows
    and for timestamp shapes nothing here wrote (default-shaped rows)."""
    us: Optional[int] = None
    if isinstance(production_time, datetime):
        us = production_time.microsecond
    elif isinstance(production_time, dtime):
        us = production_time.microsecond
    else:
        raw = str(production_time).strip()
        if not raw:
            return None
        try:
            us = datetime.fromisoformat(raw).microsecond
        except ValueError:
            return None
    if us <= 0:
        return None
    if us % 1000 == 500:
        minutes = (us - 500) // 1000 + _PERIOD_MINUTES_OVERFLOW
    elif us % 1000 == 0:
        minutes = us // 1000
    else:
        return None
    if minutes <= 0 or minutes >= _PERIOD_MINUTES_HARD_MAX:
        return None
    return minutes


# Time-of-day keys of the shifts' LAST hourly row (4 PM = shift 1, 12 AM =
# shift 2, 8 AM = shift 3). Only these rows' periods end past their own key
# when a Layer Out Time adjustment is embedded: their interval anchors at the
# previous displayed key, while every other row anchors at its own key.
_SHIFT_END_SLOTS = {
    dtime(16, 0),
    dtime(0, 0),
    dtime(8, 0),
}


def _machine_period_slots(
    entries: List[HourlyProduction],
) -> Dict[Tuple[int, dtime], Tuple[str, str]]:
    """Re-derived actual period labels of every hourly row, per machine.

    Walks the machine's rows in production-timeline order and chains each row's
    start to the previous row's end; a row whose persisted timestamp embeds a
    duration (Layer Out Time adjustment, split segment, previous-day carry-in)
    ends that duration after its start, every other row ends at its own grid
    key. The result reproduces exactly the adjusted timeline the frontend
    built: a 3:00 PM hour entered with 40 Layer Out minutes reads back as
    3:00 PM -> 3:40 PM and the next row starts at 3:40 PM — from the saved
    timestamps alone, with no additional storage.
    """
    out: Dict[Tuple[int, dtime], Tuple[str, str]] = {}
    by_machine: Dict[int, List[Tuple[dtime, Optional[int]]]] = {}
    for entry in entries:
        slot = _norm_time(entry.production_time)
        if slot is None:
            continue
        by_machine.setdefault(int(entry.machine_no), []).append(
            (slot, _stored_period_minutes(entry.production_time))
        )
    for machine_no, row_list in by_machine.items():
        row_list.sort(key=lambda item: _timeline_minutes(item[0]))
        prev_end: Optional[int] = None
        for slot, minutes in row_list:
            key = _timeline_minutes(slot)
            if prev_end is None:
                # No earlier row to chain from. An isolated shift-ending row
                # anchors at the previous hour key and covers its adjusted
                # duration there ([3:00 PM, 3:40 PM] for 40 minutes) — the
                # labels the complete grid stamps; every other key's period is
                # exactly as long as its embedded duration, ending at own key
                # ([8:10 AM, 9:00 AM] for the previous day's carry-in).
                start = key - 60 if (minutes is not None and slot in _SHIFT_END_SLOTS) else (
                    key - minutes if minutes is not None else key - 60
                )
                end = start + minutes if minutes is not None else key
            else:
                start = prev_end
                end = start + minutes if minutes is not None else key
            out[(machine_no, slot)] = (
                _label_from_timeline_minutes(start),
                _label_from_timeline_minutes(end),
            )
            prev_end = end
    return out


def _period_start_stamp(
    db: Session,
    stamp: datetime,
    machine_no: int,
    split_cache: Dict[Tuple[date, int], List[dtime]],
) -> datetime:
    """Start of the period the hourly row stamped by ``stamp`` actually covers.

    The Quality Table's Time column shows every row as ``previous key – own
    key``: an hourly row keyed 10:00 AM covers 9:00–10:00 AM, and after a
    manual split at 12:35 the row keyed 1:00 PM covers 12:35–1:00 PM. The
    previous key is therefore the row's ACTUAL start — never the shift start,
    the report date or any other default — and it is what the job-wise summary
    must report.

    The previous key is the previous hourly label of the 24-slot grid unless a
    manual split sits inside that hour, in which case the split's own
    minute-level key wins (so a job starting at 12:35 reports 12:35, not 12:00).
    The day's very first row has no earlier period, so its own time is kept.
    ``split_cache`` memoises each (production date, machine) split key set for
    the request, since several rows of one date usually share it.
    """
    own = stamp.time().replace(second=0, microsecond=0)
    timeline = _timeline_minutes(own)
    if timeline == 0:
        return stamp
    best = ((timeline - 1) // 60) * 60
    cache_key = (stamp.date(), machine_no)
    if cache_key not in split_cache:
        splits: List[dtime] = []
        report = db.query(HourlyProductionReport).filter_by(production_date=stamp.date()).first()
        if report is not None:
            for row in db.query(HourlyProduction).filter_by(
                report_id=report.report_id, machine_no=machine_no
            ).all():
                slot = _norm_time(row.production_time)
                if slot is not None and slot not in SLOT_SHIFT_IDS:
                    splits.append(slot)
        split_cache[cache_key] = splits
    for split in split_cache[cache_key]:
        split_timeline = _timeline_minutes(split)
        if best < split_timeline < timeline:
            best = split_timeline
    # Date part stays the row's PRODUCTION date and only the clock time moves —
    # the same "production date + slot clock time" rule the summary's other
    # timestamps and the frontend's parseSlotDate() use, so an overnight row's
    # 11:00 PM period start reads as 11:00 PM of the same production date and
    # never slips onto the previous calendar day.
    return datetime.combine(stamp.date(), _slot_from_timeline_minutes(best))


def _entry_units(entry: HourlyProduction) -> int:
    """Actual bottles of one hourly row — identical to the frontend's
    hourlyUnits(): packing size x cartons when both are positive, otherwise the
    stored bottles-in-nos value. Never a planned or speed-based quantity."""
    packing = entry.packing_size or 0
    cartons = entry.cartons or 0
    if packing > 0 and cartons > 0:
        return int(packing) * int(cartons)
    bottles = entry.bottles_in_nos or 0
    return int(bottles) if bottles > 0 else 0


def _format_job_remarks(entries: List[Tuple[HourlyProduction, date]], for_date: Optional[date] = None) -> Optional[str]:
    """Numbered, multi-line remark list for one machine + Job ID segment.

    Remarks are read from the hourly production rows themselves — the
    ``hourly_production.remarks`` an operator types in the Quality Table's
    Remarks column — and grouped machine-wise and job-wise, so remarks from
    different machines or jobs are never mixed. The rows are walked in
    production-timeline order, so the ``1.``, ``2.``, ``3.`` … numbering
    follows the order the remarks apply; blank remarks are skipped, an
    identical remark repeated on several hourly rows is listed once, and each
    remark's text is preserved exactly as entered (``"\\n"`` separates the
    lines within the single summary cell). A job with no remarks returns
    ``None``, so its summary cell stays blank.
    """
    ordered = sorted(
        entries,
        key=lambda item: _physical_dt(item[1], item[0].production_time) or datetime.max,
    )
    texts: List[str] = []
    seen: set = set()
    for entry, production_date in ordered:
        if for_date is not None and production_date != for_date:
            continue
        text = (entry.remarks or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        texts.append(text)
    if not texts:
        return None
    return "\n".join(f"{index}. {text}" for index, text in enumerate(texts, start=1))


def _quality_job_id(machine_no: int, production_date: date) -> str:
    """Build the Quality Module Job ID for a brand-new job.

    Format: ``V{MachineNumber}-{DDMMYYYY}`` (e.g. machine 1 on 06/10/2026
    becomes ``V1-06102026``). The machine number comes from the job's own
    machine and the date is the production/report date the Quality Module
    already uses for that job. A continuing job (hourly entries, extended
    entries, next-day continuation) keeps its existing ID — this helper is
    only called when no reusable ID exists.
    """
    return f"V{int(machine_no)}-{production_date.strftime('%d%m%Y')}"


def get_default_shape(date_str: str) -> QualityDailyResponse:
    hourly = {str(m): {} for m in MACHINES}
    for m in MACHINES:
        for pt in PRODUCTION_TIMES:
            hourly[str(m)][pt['time']] = QualityHourlyEntrySchema(
                entry_id="",
                report_id=date_str,
                machine_no=m,
                shift_id=pt['shift_id'],
                production_time=pt['time'],
                bottle_id=None,
                weight_front=None,
                weight_middle=None,
                weight_rear=None,
                weight_avg=None,
                speed_per_min=None,
                packing_category=[],
                packing_size=None,
                cartons=None,
                bottles_in_nos=None,
                efficiency_percentage=None,
                weight_efficiency=None,
                sqc=None,
                qc_hold=None,
                num=None,
                remarks=None,
                defect_ids=[],
                job_id=None,
                split_group_id=None,
                is_locked=False
            )
    
    shifts = {str(s): QualityShiftAssignmentSchema(supervisor="", executive="") for s in SHIFTS}
    
    return QualityDailyResponse(hourly=hourly, shift_assignments=shifts)


@router.get("/", response_model=QualityDailyResponse)
def get_daily_quality(date: str, db: Session = Depends(get_db), _user: AuthUser = Depends(require_module_read(MODULE_QUALITY_CONTROL))):
    try:
        query_date = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")

    report = db.query(HourlyProductionReport).filter_by(production_date=query_date).first()
    if not report:
        return get_default_shape(date)

    response = get_default_shape(date)

    # Load shift assignments
    assignments = db.query(ShiftAssignment).filter_by(report_id=report.report_id).all()
    for assignment in assignments:
        response.shift_assignments[str(assignment.shift_id)] = QualityShiftAssignmentSchema(
            supervisor=assignment.supervisor or "",
            executive=assignment.executive or ""
        )

    # Load hourly entries with defects eagerly loaded
    entries = db.query(HourlyProduction).options(
        selectinload(HourlyProduction.defects)
    ).filter_by(report_id=report.report_id).all()

    # The persisted row keys plus the durations embedded in their
    # production_time timestamps reconstruct the adjusted timeline: after
    # loading saved records, period_start / period_end are returned per row
    # (Layer Out Time adjustments included) so the frontend can rebuild the
    # schedule and its Leher Out inputs without any additional storage.
    period_slots = _machine_period_slots(entries)

    for entry in entries:
        m = str(entry.machine_no)
        response.hourly.setdefault(m, {})

        # Reconstruct the canonical grid label ("9:00 AM", "10:00 PM", ...)
        # straight from the normalized time-of-day. Building it ourselves keeps
        # the key identical to the labels the UI renders regardless of locale or
        # driver quirks, so a saved row can never land under a second, unknown
        # key that the grid would show as an empty slot.
        slot = _norm_time(entry.production_time)
        if slot is None:
            continue
        pt_time = f"{slot.hour % 12 or 12}:{slot.minute:02d} {'AM' if slot.hour < 12 else 'PM'}"

        # packing_category is stored as comma separated string? Frontend expects array
        pc = entry.packing_category.split(",") if entry.packing_category else []
        pc = [x.strip() for x in pc if x.strip()]

        period_start, period_end = period_slots.get((entry.machine_no, slot), (None, None))

        candidate = QualityHourlyEntrySchema(
            entry_id=str(entry.entry_id),
            report_id=str(report.report_id),
            machine_no=entry.machine_no,
            shift_id=entry.shift_id,
            production_time=pt_time,
            bottle_id=entry.bottle_id,
            weight_front=entry.weight_front,
            weight_middle=entry.weight_middle,
            weight_rear=entry.weight_rear,
            weight_avg=entry.weight_avg,
            speed_per_min=entry.speed_per_min,
            packing_category=pc,
            packing_size=entry.packing_size,
            cartons=entry.cartons,
            bottles_in_nos=entry.bottles_in_nos,
            efficiency_percentage=float(entry.efficiency_percent) if entry.efficiency_percent is not None else None,
            weight_efficiency=float(entry.weight_efficiency) if getattr(entry, 'weight_efficiency', None) is not None else None,
            sqc=entry.sqc,
            qc_hold=int(entry.qc_hold) if entry.qc_hold is not None else None,
            num=entry.num,
            remarks=entry.remarks,
            defect_ids=[d.defect_name for d in entry.defects],
            job_id=entry.job_id,
            split_group_id=getattr(entry, 'split_group_id', None),
            is_locked=bool(getattr(entry, 'is_locked', False)),
            period_start=period_start,
            period_end=period_end,
        )

        # If duplicate historical rows map onto the same slot, keep whichever
        # carries data instead of letting a later, emptier row hide a saved
        # bottle selection.
        existing_slot = response.hourly[m].get(pt_time)
        if existing_slot is not None and _has_meaningful_data(existing_slot) and not _has_meaningful_data(candidate):
            continue
        response.hourly[m][pt_time] = candidate

    return response


def _has_meaningful_data(entry_data: QualityHourlyEntrySchema) -> bool:
    fields = [
        entry_data.bottle_id,
        entry_data.weight_front,
        entry_data.weight_middle,
        entry_data.weight_rear,
        entry_data.weight_avg,
        entry_data.speed_per_min,
        entry_data.packing_size,
        entry_data.cartons,
        entry_data.bottles_in_nos,
        entry_data.efficiency_percentage,
        entry_data.sqc,
        entry_data.num,
        entry_data.remarks,
    ]
    for val in fields:
        if val is not None and str(val).strip():
            return True
    if entry_data.qc_hold is not None and entry_data.qc_hold != 0:
        return True
    if entry_data.packing_category and any(str(x).strip() for x in entry_data.packing_category if x):
        return True
    if entry_data.defect_ids and any(str(d).strip() for d in entry_data.defect_ids if d):
        return True
    return False


@router.get("/jobs/", response_model=List[QualityJobRowSchema])
def get_daily_jobs(
    date: str,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_read(MODULE_QUALITY_CONTROL)),
):
    """Job-wise production summary for one production date (read-only).

    The day's job sequence is reconstructed per machine from that date's own
    hourly rows in production-timeline order (9 AM -> 8:59 AM next calendar
    day) — the exact sequence the Daily Production Performance Report renders.
    Consecutive rows of one job form that job's day segment; a different job
    starts the next segment, i.e. the job change. A machine without a change
    yields its single continuing job; a change yields both the previous job
    (with its original start) and the new job (with its actual start). A
    machine with no job rows on the date yields nothing, so a still-active job
    from an earlier date never appears on its own.

    One summary row maps to one report job/bottle row: day rows are partitioned
    by (machine, job, bottle produced that day), so two bottles are never
    merged into one row even if they share a job id, and a job with zero actual
    production on the date is not listed at all. The bottle shown is the one
    produced on the selected day; history/meta are only a fallback when the
    day rows carry no bottle.

    Each row's production is that job's ACTUAL bottles accumulated from the
    job's true start (its earliest known hourly row) through the selected
    report date — earlier days of a still-running job keep adding up instead
    of resetting at midnight, and a job (or bottle) change on the date splits
    the total at the change: the previous segment stops at the change time,
    the new segment starts from it, and the two are never combined. A segment
    with zero actual production in its whole run is not listed at all.

    ``job_start_time`` is the start of the PERIOD the segment's first entry
    covers — the previous displayed key of that machine's production-timeline
    grid, manual splits included — exactly the start the Quality Table's Time
    column shows for the same row: a first entry recorded in 9:00–10:00 AM
    starts at 9:00 AM, and a first entry recorded in 12:35–1:00 PM after a
    12:35 split starts at 12:35 PM. It is derived from the earliest hourly row
    of that machine + Job ID (+ bottle when one job id covers several bottles),
    never from a shift start, the report date or any other default, and it is
    read fresh on every request — later entries, extensions, refreshes and date
    changes can never overwrite a job's original start.

    Start/end, item and status are derived from the SAME hpr hourly rows
    and hpr_job table the Quality Module already writes — no new tables and no
    change to any existing endpoint.
    """
    try:
        query_date = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")

    # 1. This date's hourly rows per machine, in production-timeline order —
    #    the same order the Daily Production Performance Report walks when it
    #    detects bottle/job changes. Rows without a Job ID belong to no job
    #    and are skipped exactly as in the report's own job grouping.
    day_rows: Dict[int, List[HourlyProduction]] = {}
    for entry, _production_date in (
        db.query(HourlyProduction, HourlyProductionReport.production_date)
        .join(
            HourlyProductionReport,
            HourlyProduction.report_id == HourlyProductionReport.report_id,
        )
        .filter(
            HourlyProductionReport.production_date == query_date,
            HourlyProduction.job_id.isnot(None),
            HourlyProduction.job_id != "",
        )
        .all()
    ):
        if not str(entry.job_id or "").strip():
            continue
        day_rows.setdefault(int(entry.machine_no), []).append(entry)
    for rows in day_rows.values():
        rows.sort(
            key=lambda e: _physical_dt(query_date, e.production_time)
            or datetime.max
        )

    # 2. Reconstruct each machine's job sequence for the date by walking its
    #    timeline: previous continuing job -> job change -> new job. Day rows
    #    are partitioned by (machine, job, bottle produced that day) so two
    #    bottles are never merged into one row even if they share a job id;
    #    distinct (job, bottle) pairs in first-appearance order are the summary
    #    candidates, so both jobs are included only when the change actually
    #    happened on this selected date — never from history alone.
    day_sequences: Dict[int, List[str]] = {}
    day_rows_by_jb: Dict[Tuple[int, str, Optional[int]], List[HourlyProduction]] = {}
    for machine_no in sorted(day_rows):
        seq: List[str] = []
        for entry in day_rows[machine_no]:
            jid = str(entry.job_id or "").strip()
            if not jid:
                continue
            bkey = int(entry.bottle_id) if entry.bottle_id is not None else None
            day_rows_by_jb.setdefault((machine_no, jid, bkey), []).append(entry)
            if not seq or seq[-1] != jid:
                seq.append(jid)
        day_sequences[machine_no] = seq
    # Candidates follow each machine's timeline sequence; bottle splits of one
    # job keep the order their day rows first appeared in.
    candidates: List[Tuple[int, str, Optional[int]]] = []
    seen_jb: set = set()
    for machine_no in sorted(day_sequences):
        for jid in day_sequences[machine_no]:
            for key in day_rows_by_jb:
                if (key[0], key[1]) == (machine_no, jid) and key not in seen_jb:
                    seen_jb.add(key)
                    candidates.append(key)

    if not candidates:
        return []

    # 3. History of those Job IDs up to the selected report date — used for
    #    each job's true start/end, bottle fallback AND the cumulative
    #    production sums below (a still-running job accumulates from its
    #    original start instead of restarting every day).
    candidate_jobs = {(m, jid) for m, jid, _ in candidates}
    job_ids = list(dict.fromkeys(jid for _, jid, _ in candidates))
    rows_by_job: Dict[Tuple[int, str], List[Tuple[HourlyProduction, datetime.date]]] = {}
    for entry, production_date in (
        db.query(HourlyProduction, HourlyProductionReport.production_date)
        .join(
            HourlyProductionReport,
            HourlyProduction.report_id == HourlyProductionReport.report_id,
        )
        .filter(
            HourlyProduction.job_id.in_(job_ids),
            HourlyProductionReport.production_date <= query_date,
        )
        .all()
    ):
        key = (int(entry.machine_no), str(entry.job_id or "").strip())
        if key in candidate_jobs:
            rows_by_job.setdefault(key, []).append((entry, production_date))

    job_meta = {
        str(job.job_id).strip(): job
        for job in db.query(HprJob).filter(HprJob.job_id.in_(job_ids)).all()
    }

    # A job id shared across bottles on this date is several summary rows, so
    # each bottle segment starts from its OWN earliest hourly row (across the
    # job's whole history, so a bottle that began on an earlier date keeps that
    # start); every other job starts from the job's true history start below,
    # which keeps a continuing job's original start. All of those starts are
    # then converted to the start of the period the first row covers (see
    # _period_start_stamp), never to the row's own label.
    bottles_per_job: Dict[Tuple[int, str], set] = {}
    for (m2, j2, b2) in candidates:
        if b2 is not None:
            bottles_per_job.setdefault((m2, j2), set()).add(b2)

    # Cumulative-production windows, one per candidate segment. Candidates
    # follow each machine's timeline, so a job's bottle segments are listed in
    # the order the changes happened: the first segment runs from the job's
    # true start, every later segment from its own first day row, and each
    # segment ends where the next one begins — two segments (or the previous
    # job and the new job on a change day) never double-count a bottle.
    seg_order: Dict[Tuple[int, str], List[Optional[int]]] = {}
    seg_day_start: Dict[Tuple[int, str, Optional[int]], Optional[datetime]] = {}
    job_true_start: Dict[Tuple[int, str], Optional[datetime]] = {}
    for machine_no, jid, bkey in candidates:
        seg_order.setdefault((machine_no, jid), []).append(bkey)
        first_phys = None
        for day_entry in day_rows_by_jb.get((machine_no, jid, bkey), []):
            phys = _physical_dt(query_date, day_entry.production_time)
            if phys is not None and (first_phys is None or phys < first_phys):
                first_phys = phys
        seg_day_start[(machine_no, jid, bkey)] = first_phys
    for (machine_no, jid), hist_rows in rows_by_job.items():
        true_start = None
        for entry, production_date in hist_rows:
            phys = _physical_dt(production_date, entry.production_time)
            if phys is not None and (true_start is None or phys < true_start):
                true_start = phys
        job_true_start[(machine_no, jid)] = true_start

    # 4. One row per candidate (machine, job, day-bottle). Production is the
    #    segment's ACTUAL bottles accumulated from its window start (the job's
    #    true start for the first segment, the segment's own start after a
    #    bottle change) through the selected report date — a still-running job
    #    keeps accumulating from its original start instead of resetting at
    #    midnight; the bottle shown is the one produced that day, while
    #    start/end come from the job's full history (each bottle segment's own
    #    rows when one job id covers several bottles) so a previous job on a
    #    job-change day still shows its true bottle, start date and time. A
    #    segment with zero actual production in its whole run is not listed.
    split_cache: Dict[Tuple[datetime.date, int], List[dtime]] = {}
    built: List[Tuple[datetime, QualityJobRowSchema]] = []
    for machine_no, jid, bkey in candidates:
        entries = rows_by_job.get((machine_no, jid), [])
        if not entries:
            # No hourly row for this job on or before the date — never
            # rendered as a blank row.
            continue
        meta = job_meta.get(jid)

        start_phys: Optional[datetime] = None
        start_stamp: Optional[datetime] = None
        end_phys: Optional[datetime] = None
        end_stamp: Optional[datetime] = None
        # The bottle produced on the selected day decides the row's item —
        # exactly what the report row for this segment shows. History/meta are
        # only a fallback when the day rows carry no bottle.
        bottle_id: Optional[int] = bkey

        # One job id shared by several bottles on the date is several summary
        # rows, so each row starts with the earliest row that ran ITS bottle —
        # across the job's whole history, so a bottle that began on an earlier
        # date keeps that original start instead of restarting at the selected
        # date's first row. A single-bottle job keeps the job's history start.
        seg_entries = entries
        if len(bottles_per_job.get((machine_no, jid), set())) > 1:
            if bkey is None:
                same_bottle = [(e, d) for e, d in entries if e.bottle_id is None]
            else:
                same_bottle = [
                    (e, d) for e, d in entries
                    if e.bottle_id is not None and int(e.bottle_id) == bkey
                ]
            if same_bottle:
                seg_entries = same_bottle

        for entry, production_date in seg_entries:
            phys = _physical_dt(production_date, entry.production_time)
            if phys is None:
                continue
            # Display stamp = production date + the slot's clock time (the
            # production-day date rule), never the shifted timeline value.
            stamp = datetime.combine(production_date, phys.time())
            if start_phys is None or phys < start_phys:
                start_phys, start_stamp = phys, stamp

        if start_phys is None and seg_entries is not entries:
            # None of this segment's own rows carried a usable timestamp — the
            # job's history start is the next source, never a blank/default one.
            for entry, production_date in entries:
                phys = _physical_dt(production_date, entry.production_time)
                if phys is None:
                    continue
                stamp = datetime.combine(production_date, phys.time())
                if start_phys is None or phys < start_phys:
                    start_phys, start_stamp = phys, stamp

        for entry, production_date in entries:
            if bottle_id is None and entry.bottle_id is not None:
                bottle_id = int(entry.bottle_id)
            phys = _physical_dt(production_date, entry.production_time)
            if phys is None:
                continue
            end_stamp_candidate = datetime.combine(production_date, phys.time())
            if end_phys is None or phys > end_phys:
                end_phys, end_stamp = phys, end_stamp_candidate

        if start_phys is None or start_stamp is None:
            # Every timestamp of the job failed to parse — the job table's own
            # start (production date + clock time) is the only source left.
            if meta is None or meta.job_start_time is None:
                continue
            start_stamp = meta.job_start_time
        if meta is not None and bottle_id is None and meta.bottle_id is not None:
            bottle_id = int(meta.bottle_id)

        # Time of Starting = the start of the period the first entry covers,
        # exactly what the Quality Table's Time column shows for that row, so a
        # job first recorded in 9:00–10:00 reports 9:00 AM and a job first
        # recorded in 12:35–1:00 reports 12:35 PM — never the shift start, the
        # report date or a rounded hour.
        start_stamp = _period_start_stamp(db, start_stamp, machine_no, split_cache)

        # Cumulative production over this segment's window of the job's full
        # history through the selected date: the job's rows from its true
        # start for the first segment, from this segment's own start after a
        # bottle change, ending where the next segment begins. A job still
        # running keeps accumulating from its original start instead of
        # resetting at midnight; a job (or bottle) change on the date splits
        # the total at the change time, so the previous segment and the new
        # one are never combined.
        segs = seg_order.get((machine_no, jid)) or [bkey]
        try:
            seg_idx = segs.index(bkey)
        except ValueError:
            seg_idx = 0
        lower = (
            job_true_start.get((machine_no, jid))
            if seg_idx == 0
            else seg_day_start.get((machine_no, jid, bkey))
        )
        upper = (
            seg_day_start.get((machine_no, jid, segs[seg_idx + 1]))
            if seg_idx + 1 < len(segs)
            else None
        )
        units = 0
        for entry, production_date in entries:
            phys = _physical_dt(production_date, entry.production_time)
            if phys is None:
                continue
            if lower is not None and phys < lower:
                continue
            if upper is not None and phys >= upper:
                continue
            units += _entry_units(entry)
        if units <= 0:
            # No actual production anywhere in this segment's run — not a
            # summary row.
            continue

        built.append((
            start_phys if start_phys is not None else start_stamp,
            QualityJobRowSchema(
                machine_no=machine_no,
                job_id=jid,
                bottle_id=bottle_id,
                job_start_time=start_stamp,
                job_end_time=end_stamp,
                status=(meta.status if meta is not None else "") or "",
                # All remarks of this machine + Job ID, read from the hourly
                # production rows and numbered (1., 2., 3. …) in timeline order
                # — never the (always empty) job-table remark.
                remarks=_format_job_remarks(entries, for_date=query_date),
                production_units=int(units),
            ),
        ))

    # Machine order first, then the newest job first inside each machine.
    built.sort(key=lambda item: item[0], reverse=True)
    built.sort(key=lambda item: item[1].machine_no)
    return [row for _, row in built]


@router.post("/lock/", response_model=QualityRowLockResponse)
def set_row_lock(
    payload: QualityRowLockRequest,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL)),
):
    """Lock or unlock exactly ONE hourly row — the checkbox of that row.

    The request writes ``hourly_production.is_locked`` for a single
    (production date, machine, time-of-day) row and nothing else: no other
    field, no other row and no reload of the day, so ticking the checkbox can
    never disturb any other part of the Quality Module.

    This is the ONLY API allowed to change the flag; every other write path
    rejects a locked row with LOCKED_ROW_DETAIL. That is what makes the
    database — not the frontend checkbox — the source of truth for locking.
    """
    try:
        p_date = datetime.strptime(payload.production_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")

    slot = _slot_time(payload.production_time)
    machine_no = int(payload.machine_no)
    slot_label = f"{slot.hour % 12 or 12}:{slot.minute:02d} {'AM' if slot.hour < 12 else 'PM'}"

    try:
        report = db.query(HourlyProductionReport).filter_by(production_date=p_date).first()
        entry = None
        if report is not None:
            # Match on the normalized time-of-day, exactly like the save path, so
            # a row stored by a different driver or an older schema is still found
            # instead of a second row being created next to it.
            entry = next(
                (
                    candidate
                    for candidate in db.query(HourlyProduction).filter_by(
                        report_id=report.report_id, machine_no=machine_no
                    ).all()
                    if _norm_time(candidate.production_time) == slot
                ),
                None,
            )

        if entry is None:
            if not payload.is_locked:
                raise HTTPException(
                    status_code=404,
                    detail="Row not found for the given date, machine and time.",
                )
            # Locking a slot that was never saved stores the (still empty) row
            # first, so the checkbox state survives Refresh and the next
            # session exactly like any other saved row. It carries no data, so
            # there is nothing to protect yet — but there is now a row to lock.
            # The report is created only here: a failed unlock must leave no
            # empty report row behind for a date that never had one.
            if report is None:
                report = HourlyProductionReport(production_date=p_date)
                db.add(report)
                db.flush()
            entry = HourlyProduction(
                report_id=report.report_id,
                machine_no=machine_no,
                shift_id=_shift_id_for_slot(slot),
                production_time=datetime.combine(p_date, slot),
                job_id="",
                is_locked=True,
            )
            db.add(entry)
        else:
            entry.is_locked = bool(payload.is_locked)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception(
            "Row lock update failed for %s machine %s at %s — transaction rolled back",
            payload.production_date, payload.machine_no, payload.production_time,
        )
        raise HTTPException(
            status_code=500,
            detail=f"The row lock was NOT saved (the transaction was rolled back): {exc}",
        )

    return QualityRowLockResponse(
        entry_id=entry.entry_id,
        machine_no=machine_no,
        production_time=slot_label,
        is_locked=bool(entry.is_locked),
    )


@router.post("/", response_model=QualityDailyResponse)
def save_daily_quality(
    payload: QualityDailyRequest,
    db: Session = Depends(get_db),
    _user: AuthUser = Depends(require_module_edit(MODULE_QUALITY_CONTROL))
):
    try:
        p_date = datetime.strptime(payload.production_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    try:
        # Step 1: Get or Create Report
        report = db.query(HourlyProductionReport).filter_by(production_date=p_date).first()
        if not report:
            report = HourlyProductionReport(production_date=p_date)
            db.add(report)
            db.flush() # get report_id

        # Step 2: Upsert Shift Assignments
        existing_assignments = db.query(ShiftAssignment).filter_by(report_id=report.report_id).all()
        sa_map = {sa.shift_id: sa for sa in existing_assignments}

        for shift_id_str, sa_data in payload.shift_assignments.items():
            s_id = int(shift_id_str)
            if s_id in sa_map:
                sa_map[s_id].supervisor = sa_data.supervisor
                sa_map[s_id].executive = sa_data.executive
            else:
                new_sa = ShiftAssignment(
                    report_id=report.report_id,
                    shift_id=s_id,
                    supervisor=sa_data.supervisor,
                    executive=sa_data.executive
                )
                db.add(new_sa)

        # Pre-load defects to resolve names -> IDs
        # Gather all unique defect names from the payload
        all_defect_names = set()
        for m_dict in payload.hourly.values():
            for entry_data in m_dict.values():
                all_defect_names.update(entry_data.defect_ids)

        defect_map = {}
        if all_defect_names:
            db_defects = db.query(DefectMaster).filter(DefectMaster.defect_name.in_(all_defect_names)).all()
            defect_map = {d.defect_name: d for d in db_defects}
            
            # Check for any unresolvable defect names
            missing_defects = all_defect_names - set(defect_map.keys())
            if missing_defects:
                raise HTTPException(status_code=400, detail=f"Unresolvable defect names: {', '.join(missing_defects)}")

        # Step 3: Upsert Hourly Entries
        existing_entries = db.query(HourlyProduction).options(
            selectinload(HourlyProduction.defects)
        ).filter_by(report_id=report.report_id).all()

        # Rows are identified by (machine_no, NORMALIZED time-of-day) — never by
        # the raw production_time object. The column is a DATETIME, but depending
        # on the driver / the column actually provisioned / how a row was written
        # the value read back may be a datetime, a plain time or a string. If the
        # key built from the database and the key built from the request are not
        # normalized identically, an existing row is never matched: the save then
        # inserts a duplicate (or trips uq_hpr_machine_hour and rolls the whole
        # request back), and the previously saved bottle_id is lost.
        entry_map: Dict[Tuple[int, Optional[dtime]], HourlyProduction] = {}
        for e in existing_entries:
            key = _entry_key(e.machine_no, e.production_time)
            current = entry_map.get(key)
            # If legacy duplicates map onto one slot, keep the row that carries a
            # bottle so we update the meaningful row instead of an empty one.
            if current is None or (current.bottle_id is None and e.bottle_id is not None):
                entry_map[key] = e

        # Snapshot of the OLD (job_id, bottle_id) pairs, taken from the SAME rows
        # entry_map resolved to, before any mutations occur, so Step 4.5 can
        # reuse a job id only when it still belongs to the same bottle.
        old_job_snapshot: Dict[Tuple[int, Optional[dtime]], Tuple[Optional[str], Optional[int]]] = {
            key: (e.job_id.strip() if e.job_id and e.job_id.strip() else None, e.bottle_id)
            for key, e in entry_map.items()
        }

        for machine_str, m_dict in payload.hourly.items():
            machine_no = int(machine_str)
            for time_str, entry_data in m_dict.items():
                parsed_time = _slot_time(time_str)
                # handle overnight shifts
                # Shift 3 is 1am to 9am, it actually belongs to the next calendar day
                # But typically production_date stays the same for the whole shift
                # We combine it directly:
                entry_dt = datetime.combine(p_date, parsed_time)
                map_key = (machine_no, parsed_time)

                # The actual period this row covers (Layer Out Time adjustment,
                # split segment or previous-day third-shift carry-in) rides in
                # the timestamp itself: the real duration is embedded into
                # production_time's microsecond field, so the adjusted
                # timeline is restored straight from the saved timestamps on
                # the next load — with no schema change and no value stored
                # separately. Row identity stays (machine, time-of-day to the
                # minute), so upsert matching, lock matching and the unique
                # constraint are untouched.
                entry_dt = _encoded_entry_dt(
                    p_date,
                    parsed_time,
                    _period_minutes_from_labels(
                        entry_data.period_start, entry_data.period_end
                    ),
                )

                # Check if it exists
                entry = entry_map.get(map_key)

                # ── Row lock ──────────────────────────────────────────────
                # A locked row owns its own data. The payload must echo it
                # back unchanged or the WHOLE save is rejected with a clear
                # 409 (one request carries the entire day, so a silent skip
                # would hide the failed edit until the next refresh). On a
                # match nothing is written either: the stored row stays
                # exactly as it is, and only the /lock/ endpoint can flip the
                # flag — so unlocking is the only way to make it editable.
                if entry is not None and bool(getattr(entry, "is_locked", False)):
                    if _locked_payload_differs(entry, entry_data):
                        raise HTTPException(status_code=409, detail=LOCKED_ROW_DETAIL)
                    continue

                incoming_has_data = _has_meaningful_data(entry_data)
                # The frontend stamps every row it read from the database with a
                # synthetic entry_id. A row WITHOUT one was invented locally by a
                # blank slot and must never blank out a stored row. An empty row
                # that DOES carry an entry_id is an explicit clear ("−" button /
                # "— Select bottle") and is still applied.
                # Manual split rows (minute-granularity times) are the exception:
                # a split row continues the previous row's job (it inherits the
                # bottle/Job ID), and even a split whose parent hour was blank
                # must still be created so the row structure persists after
                # Save/Refresh/reload. Hourly rows keep the existing rule unchanged.
                incoming_is_known_row = bool(str(entry_data.entry_id or "").strip())
                is_split_time = parsed_time.minute != 0 or parsed_time.second != 0

                if not incoming_has_data and (entry is None or not incoming_is_known_row) and not is_split_time:
                    # Nothing to create and nothing the operator could have
                    # deliberately cleared — leave the stored row untouched.
                    continue

                stored_bottle_id = entry.bottle_id if entry is not None else None

                # prepare field values
                b_id = entry_data.bottle_id
                w_f = entry_data.weight_front
                w_m = entry_data.weight_middle
                w_r = entry_data.weight_rear
                w_a = entry_data.weight_avg
                s_p_m = entry_data.speed_per_min
                p_c = (", ".join(entry_data.packing_category) if entry_data.packing_category else None) if isinstance(entry_data.packing_category, list) else (entry_data.packing_category or None)
                p_s = entry_data.packing_size
                ctns = entry_data.cartons
                binos = entry_data.bottles_in_nos
                eff = entry_data.efficiency_percentage
                if eff is not None:
                    try:
                        eff = round(min(max(float(eff), 0.0), 999.99), 2)
                    except (ValueError, TypeError):
                        eff = None
                weff = entry_data.weight_efficiency
                if weff is not None:
                    try:
                        weff = round(float(weff), 2)
                    except (ValueError, TypeError):
                        weff = None
                sq = entry_data.sqc
                qch = entry_data.qc_hold
                n_val = entry_data.num
                rmk = entry_data.remarks

                if entry is None:
                    entry = HourlyProduction(
                        report_id=report.report_id,
                        machine_no=machine_no,
                        shift_id=entry_data.shift_id,
                        production_time=entry_dt,
                        bottle_id=b_id,
                        weight_front=w_f, weight_middle=w_m, weight_rear=w_r, weight_avg=w_a,
                        speed_per_min=s_p_m, packing_category=p_c, packing_size=p_s,
                        cartons=ctns, bottles_in_nos=binos, efficiency_percent=eff,
                        weight_efficiency=weff,
                        sqc=sq, qc_hold=qch, num=n_val, remarks=rmk,
                        # hourly_production.job_id is a NOT NULL column. A row that
                        # does not belong to a job yet must be stored as an empty id
                        # — writing NULL raises an IntegrityError, the transaction
                        # rolls back and EVERY row for the day is silently lost.
                        job_id=entry_data.job_id or "",
                        # Split-group identifier is grouping/history only: it is
                        # stored verbatim and never influences any job,
                        # scheduling or calculation logic below.
                        split_group_id=(entry_data.split_group_id or "").strip() or None,
                    )
                    db.add(entry)
                    entry_map[map_key] = entry
                else:
                    entry.bottle_id = b_id
                    entry.weight_front = w_f
                    # The timestamp always mirrors the CURRENT save: a plain
                    # period (60-minute hour) rewrites the stored value without
                    # an embedded duration, so a Layer Out Time the operator
                    # removed since the last save cannot leak back into the
                    # next reconstruction. Identity (minute key) is unchanged.
                    entry.production_time = entry_dt
                    entry.weight_middle = w_m
                    entry.weight_rear = w_r
                    entry.weight_avg = w_a
                    entry.speed_per_min = s_p_m
                    entry.packing_category = p_c
                    entry.packing_size = p_s
                    entry.cartons = ctns
                    entry.bottles_in_nos = binos
                    entry.efficiency_percent = eff
                    if getattr(entry, 'weight_efficiency', None) is not None or weff is not None:
                        entry.weight_efficiency = weff
                    elif 'weff' in locals():
                        entry.weight_efficiency = weff
                    entry.sqc = sq
                    entry.qc_hold = qch
                    entry.num = n_val
                    entry.remarks = rmk
                    # The split-group identifier mirrors the frontend state
                    # verbatim (grouping/history only). An empty value clears a
                    # stale group — e.g. the next hourly row after its split was
                    # deleted — while rows outside any split simply stay NULL.
                    try:
                        entry.split_group_id = (entry_data.split_group_id or "").strip() or None
                    except AttributeError:
                        pass
                    if entry_data.job_id:
                        entry.job_id = entry_data.job_id
                    elif b_id is None and stored_bottle_id is not None:
                        # The bottle was cleared on this row, so its job
                        # reference no longer applies. The column is NOT NULL,
                        # so the cleared state is an empty id, never NULL.
                        entry.job_id = ""
                    # Otherwise keep the stored job_id: a client that simply did
                    # not echo it back must never blank a valid id.

                # Step 4: Replace all defects
                # hpr.hourly_production_defect has PRIMARY KEY (entry_id, defect_id),
                # so a repeated defect name in one row would be two inserts of the
                # same key: an IntegrityError that rolls back the WHOLE day. The
                # set of names is already validated above; dedup here.
                entry.defects = list({dname: defect_map[dname] for dname in entry_data.defect_ids}.values())

        # Step 3.4: Explicitly deleted rows (manual split rows and rows the
        # "-" button removes). The frontend drops the key locally (which
        # restores the next row's original period by ordering) and lists it
        # here so the DB row is deleted and the delete persists after
        # Save/Refresh/reload. Only the listed machine + time keys are
        # deleted — every other row, Job ID and shift assignment is untouched.
        deleted_splits = getattr(payload, 'deleted_splits', None) or {}
        for del_machine_str, del_times in deleted_splits.items():
            try:
                del_machine_no = int(del_machine_str)
            except (TypeError, ValueError):
                continue
            for del_time_str in del_times or []:
                try:
                    del_parsed = _slot_time(del_time_str)
                except HTTPException:
                    continue
                del_entry = entry_map.get((del_machine_no, del_parsed))
                if del_entry is None:
                    # Match on the normalized time-of-day, never on the exact
                    # datetime: a row whose timestamp embeds a period duration
                    # (Layer Out Time adjustment) otherwise escapes the exact
                    # equality and the delete silently misses it.
                    for candidate in db.query(HourlyProduction).filter_by(
                        report_id=report.report_id,
                        machine_no=del_machine_no,
                    ).all():
                        if _norm_time(candidate.production_time) == del_parsed:
                            del_entry = candidate
                            break
                if del_entry is not None:
                    # Deleting is a modification too: a locked row can never be
                    # dropped from a save payload, however the client got here.
                    if bool(getattr(del_entry, "is_locked", False)):
                        raise HTTPException(status_code=409, detail=LOCKED_ROW_DETAIL)
                    try:
                        del_entry.defects = []
                    except Exception:
                        pass
                    db.delete(del_entry)
                    entry_map.pop((del_machine_no, del_parsed), None)
        db.flush()

        # Step 3.5: Cross-day job continuation
        # Look at the previous production day's last entry (8 AM) for each machine.
        # If the current day's first entry (9 AM) has the same bottle, add the
        # previous day's Job ID to old_job_snapshot so the existing algorithm
        # reuses it instead of generating a new one.
        prev_date = p_date - timedelta(days=1)
        prev_report = db.query(HourlyProductionReport).filter_by(production_date=prev_date).first()
        if prev_report:
            prev_entries = db.query(HourlyProduction).filter(
                HourlyProduction.report_id == prev_report.report_id,
                HourlyProduction.bottle_id.isnot(None)
            ).all()
            for prev_entry in prev_entries:
                prev_time = _norm_time(prev_entry.production_time)
                if prev_time and prev_time.hour == 8 and prev_time.minute == 0:
                    current_9am_key = (prev_entry.machine_no, dtime(9, 0))
                    current_9am_entry = entry_map.get(current_9am_key)
                    if current_9am_entry and current_9am_entry.bottle_id == prev_entry.bottle_id:
                        old_job_snapshot[current_9am_key] = (prev_entry.job_id, prev_entry.bottle_id)

        # Step 4.5: Compute canonical job_id and upsert HPR Job rows
        # Brand-new jobs use the machine-wise date-based format
        # V{MachineNumber}-{DDMMYYYY} (see _quality_job_id). Continuing jobs
        # keep their existing ID via old_job_snapshot / payload reuse below,
        # so a job stays identical across hourly entries, extensions and
        # production-day continuations. No sequential J-counter is used.

        for machine_str, m_dict in payload.hourly.items():
            machine_no = int(machine_str)

            # 2. Build time-sorted list of entries with non-null bottle_id
            entries = []
            for time_str, entry_data in m_dict.items():
                if entry_data.bottle_id is None:
                    continue

                parsed_time = _slot_time(time_str)
                entry_dt = datetime.combine(p_date, parsed_time)
                old_jid, old_bottle_id = old_job_snapshot.get((machine_no, parsed_time), (None, None))

                entries.append({
                    "time_str": time_str,
                    "production_time": entry_dt,
                    "map_key": (machine_no, parsed_time),
                    "bottle_id": entry_data.bottle_id,
                    "old_job_id": old_jid,
                    "old_bottle_id": old_bottle_id,
                    "payload_job_id": (entry_data.job_id or "").strip() if entry_data.job_id else "",
                })

            if not entries:
                continue

            # Sort chronologically by production_time
            entries.sort(key=lambda x: x["production_time"])

            # 3. Group into CONTIGUOUS runs where bottle_id is the same as immediately preceding entry
            runs = []
            current_run = []
            current_bottle_id = None
            for item in entries:
                if item["bottle_id"] == current_bottle_id:
                    current_run.append(item)
                else:
                    if current_run:
                        runs.append(current_run)
                    current_bottle_id = item["bottle_id"]
                    current_run = [item]
            if current_run:
                runs.append(current_run)

            # 4, 5, 6. Determine canonical job_id, overwrite ORM entries, and compute run metadata
            computed_runs = []
            for run in runs:
                run_bottle_id = run[0]["bottle_id"]
                # Reuse an old job id ONLY when it still belongs to this same
                # bottle. A row whose bottle changed starts a fresh job, so the
                # hpr_job row always describes the bottle actually running.
                old_jids = [
                    item["old_job_id"] for item in run
                    if item["old_job_id"] and item["old_bottle_id"] == run_bottle_id
                ]
                unique_old_jids = list(dict.fromkeys(old_jids))

                if unique_old_jids:
                    # 4a. Existing run: agree or chronologically earliest
                    canonical_job_id = unique_old_jids[0]
                    if len(unique_old_jids) > 1:
                        logger.warning(
                            f"Run on machine {machine_no} spans multiple distinct old job_ids: {unique_old_jids}. "
                            f"Using chronologically earliest '{canonical_job_id}' as canonical."
                        )
                else:
                    # Try to reuse job_id from payload (frontend-copied rows) if consistent
                    payload_jids = [
                        item.get("payload_job_id", "")
                        for item in run
                        if item.get("payload_job_id")
                    ]
                    unique_payload_jids = list(dict.fromkeys(payload_jids))
                    if len(unique_payload_jids) == 1 and (
                        unique_payload_jids[0].startswith("V") or unique_payload_jids[0].startswith("J")
                    ):
                        canonical_job_id = unique_payload_jids[0]
                    else:
                        # 4b. Brand-new run: machine-wise date-based job_id.
                        # Format is 'V{MachineNumber}-{DDMMYYYY}'
                        # (e.g. V1-06102026). The date is this save's
                        # production/report date; continuation runs reuse the
                        # existing ID above and never reach this branch.
                        canonical_job_id = _quality_job_id(machine_no, p_date)

                # 5. Overwrite job_id on every ORM entry in this run
                for item in run:
                    orm_entry = entry_map.get(item["map_key"])
                    # A locked row keeps the job it already has: it is never
                    # written by this save, so its Job ID can never be
                    # reassigned by a run a neighbouring row created.
                    if orm_entry and not bool(getattr(orm_entry, "is_locked", False)):
                        orm_entry.job_id = canonical_job_id

                # 6. Compute job_start_time, job_end_candidate, and bottle_id
                job_start_time = min(e["production_time"] for e in run)
                job_end_candidate = max(e["production_time"] for e in run)
                bottle_id = run_bottle_id

                computed_runs.append({
                    "canonical_job_id": canonical_job_id,
                    "job_start_time": job_start_time,
                    "job_end_candidate": job_end_candidate,
                    "bottle_id": bottle_id,
                })

            # 6. Per machine, the run with the latest job_start_time is RUNNING; all others COMPLETED
            latest_start = max(r["job_start_time"] for r in computed_runs)
            for r in computed_runs:
                if r["job_start_time"] == latest_start:
                    r["status"] = "RUNNING"
                    r["job_end_time"] = None
                else:
                    r["status"] = "COMPLETED"
                    r["job_end_time"] = r["job_end_candidate"]

            # 6.5 Retire the job that is still marked RUNNING for this machine.
            # hpr.hpr_job carries a partial unique index,
            # uq_production_job_one_running_per_machine (machine_no) WHERE
            # status = 'RUNNING', so the database allows only ONE running job per
            # machine. A run that starts on a machine whose previous job was never
            # closed (e.g. V1-05102026 from an earlier day) would be rejected outright,
            # and because everything commits together the WHOLE day's data would
            # be rolled back. Close the stale job first, and flush that close so
            # it reaches the database before the new row is inserted.
            running_ids = [r["canonical_job_id"] for r in computed_runs if r["status"] == "RUNNING"]
            if running_ids:
                new_job_start = min(
                    r["job_start_time"] for r in computed_runs if r["status"] == "RUNNING"
                )
                stale_jobs = (
                    db.query(HprJob)
                    .filter(
                        HprJob.machine_no == machine_no,
                        HprJob.status == "RUNNING",
                        HprJob.job_id.notin_(running_ids),
                    )
                    .all()
                )
                for stale_job in stale_jobs:
                    stale_job.status = "COMPLETED"
                    if stale_job.job_end_time is None and new_job_start >= stale_job.job_start_time:
                        stale_job.job_end_time = new_job_start
                if stale_jobs:
                    db.flush()

            # 7. Upsert into hpr_job by canonical_job_id
            for r in computed_runs:
                c_job_id = r["canonical_job_id"]
                existing_job = db.query(HprJob).filter_by(job_id=c_job_id).first()
                if not existing_job:
                    new_job = HprJob(
                        job_id=c_job_id,
                        machine_no=machine_no,
                        bottle_id=r["bottle_id"],
                        job_start_time=r["job_start_time"],
                        job_end_time=r["job_end_time"],
                        status=r["status"],
                        remarks=None,
                    )
                    db.add(new_job)
                else:
                    if existing_job.machine_no == machine_no and existing_job.bottle_id == r["bottle_id"]:
                        existing_job.job_start_time = min(existing_job.job_start_time, r["job_start_time"])
                        existing_job.status = r["status"]
                        existing_job.job_end_time = r["job_end_time"]
                    else:
                        logger.warning(
                            f"Job ID collision for job_id '{c_job_id}': "
                            f"existing (machine={existing_job.machine_no}, bottle={existing_job.bottle_id}) vs "
                            f"conflicting (machine={machine_no}, bottle={r['bottle_id']}). Skipping update."
                        )

        # Step 4.6: Automatic next-day continuation
        # After saving the current day, check if the 8 AM entry has a bottle.
        # If so, automatically create the next day's 9 AM entry with the same
        # bottle and Job ID. This ensures a running job continues into the next
        # production day without manual intervention.
        continuation_data = None
        next_date = p_date + timedelta(days=1)
        next_report = db.query(HourlyProductionReport).filter_by(production_date=next_date).first()
        if not next_report:
            next_report = HourlyProductionReport(production_date=next_date)
            db.add(next_report)
            db.flush()

        continuation_entries = []
        for machine_str, m_dict in payload.hourly.items():
            machine_no = int(machine_str)
            entry_8am = None
            for time_str, entry_data in m_dict.items():
                parsed_time = _slot_time(time_str)
                if parsed_time.hour == 8 and parsed_time.minute == 0:
                    entry_8am = entry_map.get((machine_no, parsed_time))
                    break

            if entry_8am and entry_8am.bottle_id:
                next_9am_dt = datetime.combine(next_date, dtime(9, 0))
                next_9am_entry = db.query(HourlyProduction).filter_by(
                    report_id=next_report.report_id,
                    machine_no=machine_no,
                    production_time=next_9am_dt
                ).first()

                if not next_9am_entry:
                    new_entry = HourlyProduction(
                        report_id=next_report.report_id,
                        machine_no=machine_no,
                        shift_id=1,
                        production_time=next_9am_dt,
                        bottle_id=entry_8am.bottle_id,
                        job_id=entry_8am.job_id,
                        weight_front=entry_8am.weight_front,
                        weight_middle=entry_8am.weight_middle,
                        weight_rear=entry_8am.weight_rear,
                        weight_avg=entry_8am.weight_avg,
                        speed_per_min=entry_8am.speed_per_min,
                        packing_category=entry_8am.packing_category,
                        packing_size=entry_8am.packing_size,
                        cartons=entry_8am.cartons,
                        bottles_in_nos=entry_8am.bottles_in_nos,
                        efficiency_percent=entry_8am.efficiency_percent,
                        weight_efficiency=getattr(entry_8am, 'weight_efficiency', None),
                        sqc=entry_8am.sqc,
                        qc_hold=entry_8am.qc_hold,
                        num=entry_8am.num,
                        remarks=entry_8am.remarks,
                    )
                    db.add(new_entry)
                    continuation_entries.append(new_entry)

        if continuation_entries:
            db.flush()
            continuation_data = {}
            for entry in continuation_entries:
                m = str(entry.machine_no)
                continuation_data.setdefault(m, {})
                slot = _norm_time(entry.production_time)
                pt_time = f"{slot.hour % 12 or 12}:{slot.minute:02d} {'AM' if slot.hour < 12 else 'PM'}"
                pc = entry.packing_category.split(",") if entry.packing_category else []
                pc = [x.strip() for x in pc if x.strip()]
                continuation_data[m][pt_time] = QualityHourlyEntrySchema(
                    entry_id=str(entry.entry_id),
                    report_id=str(next_date),
                    machine_no=entry.machine_no,
                    shift_id=entry.shift_id,
                    production_time=pt_time,
                    bottle_id=entry.bottle_id,
                    weight_front=entry.weight_front,
                    weight_middle=entry.weight_middle,
                    weight_rear=entry.weight_rear,
                    weight_avg=entry.weight_avg,
                    speed_per_min=entry.speed_per_min,
                    packing_category=pc,
                    packing_size=entry.packing_size,
                    cartons=entry.cartons,
                    bottles_in_nos=entry.bottles_in_nos,
                    efficiency_percentage=float(entry.efficiency_percent) if entry.efficiency_percent is not None else None,
                    weight_efficiency=float(getattr(entry, 'weight_efficiency', None)) if getattr(entry, 'weight_efficiency', None) is not None else None,
                    sqc=entry.sqc,
                    qc_hold=int(entry.qc_hold) if entry.qc_hold is not None else None,
                    num=entry.num,
                    remarks=entry.remarks,
                    defect_ids=[d.defect_name for d in entry.defects],
                    job_id=entry.job_id,
                    split_group_id=getattr(entry, 'split_group_id', None),
                    is_locked=bool(getattr(entry, 'is_locked', False)),
                )

        # Step 5: Single Commit
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        # Nothing was persisted — roll back first, then log the full failure
        # server-side and tell the caller exactly what happened so the UI can
        # report it instead of pretending the day was saved.
        db.rollback()
        logger.exception(
            "Quality save failed for %s — transaction rolled back, no rows persisted",
            payload.production_date,
        )
        raise HTTPException(
            status_code=500,
            detail=(
                f"Quality data for {payload.production_date} was NOT saved "
                f"(the transaction was rolled back): {e}"
            ),
        )

    # Return using explicit re-query
    response = get_daily_quality(payload.production_date, db)
    response.continuation = continuation_data
    return response
