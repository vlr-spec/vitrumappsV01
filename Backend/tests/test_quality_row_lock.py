"""Row-lock tests for the Quality Module.

The lock is a database column (hourly_production.is_locked) and the write APIs
themselves enforce it, so these tests drive the endpoints directly — exactly
what a client that bypassed the frontend checkbox would do.
"""
import os

# Force a local temp SQLite DB BEFORE any app module imports the real engine.
_TMP_DB = "./test_quality_row_lock.db"
if os.path.exists(_TMP_DB):
    os.remove(_TMP_DB)
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP_DB}"

from datetime import date, datetime
from decimal import Decimal

from fastapi import HTTPException

from app.db.base import Base
from app.db.session import SessionLocal, engine
# Imported so hourly_production's foreign keys (machine_master, bottle_master)
# resolve during create_all — the tables are registered on Base.metadata here.
from app.models.machine import MachineMaster  # noqa: F401
from app.models.product import BottleMaster  # noqa: F401
from app.models.quality import HourlyProduction, HourlyProductionReport
from app.api.production.quality_daily import (
    LOCKED_ROW_DETAIL,
    get_daily_quality,
    save_daily_quality,
    set_row_lock,
)
from app.schemas.quality import QualityDailyRequest, QualityRowLockRequest

DATE = "2026-10-06"
DAY = date(2026, 10, 6)
MACHINE = "1"
TIME = "10:00 AM"
SPLIT_TIME = "10:25 AM"


def setup_module():
    Base.metadata.create_all(bind=engine)


def teardown_module():
    engine.dispose()
    if os.path.exists(_TMP_DB):
        os.remove(_TMP_DB)


def _clear():
    db = SessionLocal()
    try:
        db.query(HourlyProduction).delete()
        db.query(HourlyProductionReport).delete()
        db.commit()
    finally:
        db.close()


def _seed_row(db, production_time, *, is_locked=False):
    """One saved hourly row, exactly as save_daily_quality would have written it."""
    report = db.query(HourlyProductionReport).filter_by(production_date=DAY).first()
    if report is None:
        report = HourlyProductionReport(production_date=DAY)
        db.add(report)
        db.flush()
    row = HourlyProduction(
        report_id=report.report_id,
        machine_no=1,
        shift_id=1,
        production_time=production_time,
        bottle_id=111,
        weight_front=Decimal("52.50"),
        speed_per_min=Decimal("88.00"),
        packing_category="ST, SN",
        packing_size=500,
        cartons=12,
        sqc=1,
        qc_hold=0,
        num=3,
        remarks="seeded",
        job_id="V1-06102026",
        is_locked=is_locked,
    )
    db.add(row)
    db.commit()
    return int(row.entry_id)


def _row(db, entry_id):
    return db.query(HourlyProduction).filter_by(entry_id=entry_id).first()


def _payload(db, deleted_splits=None):
    """The exact payload the grid sends: the day as GET returned it."""
    resp = get_daily_quality(DATE, db=db)
    return QualityDailyRequest(
        production_date=DATE,
        hourly=resp.hourly,
        shift_assignments=resp.shift_assignments,
        **({"deleted_splits": deleted_splits} if deleted_splits else {}),
    )


def _lock(db, is_locked, production_time=TIME, machine_no=1):
    return set_row_lock(
        QualityRowLockRequest(
            production_date=DATE,
            machine_no=machine_no,
            production_time=production_time,
            is_locked=is_locked,
        ),
        db=db,
    )


def test_lock_endpoint_writes_only_the_flag():
    _clear()
    db = SessionLocal()
    try:
        entry_id = _seed_row(db, datetime(2026, 10, 6, 10, 0))
        before = vars(_row(db, entry_id)).copy()

        res = _lock(db, True)
        assert res.is_locked is True
        assert res.production_time == TIME

        after = vars(_row(db, entry_id))
        assert after["is_locked"] is True
        # Nothing but the flag moved — one request persists one checkbox.
        for key, value in before.items():
            if key in ("is_locked", "_sa_instance_state"):
                continue
            assert after[key] == value, f"{key} changed under a lock toggle"

        # The grid reads the lock straight from this GET.
        resp = get_daily_quality(DATE, db=db)
        assert resp.hourly[MACHINE][TIME].is_locked is True
    finally:
        db.close()


def test_locking_a_blank_slot_stores_the_row():
    _clear()
    db = SessionLocal()
    try:
        res = _lock(db, True, production_time="3:00 PM", machine_no=2)
        assert res.is_locked is True

        resp = get_daily_quality(DATE, db=db)
        assert resp.hourly["2"]["3:00 PM"].is_locked is True
        assert resp.hourly["2"]["3:00 PM"].bottle_id is None
    finally:
        db.close()


def test_unlock_of_a_missing_row_is_rejected():
    _clear()
    db = SessionLocal()
    try:
        try:
            _lock(db, False, production_time="11:00 AM", machine_no=3)
            raise AssertionError("expected HTTPException")
        except HTTPException as exc:
            assert exc.status_code == 404
    finally:
        db.close()


def test_bypassed_client_editing_a_locked_row_is_rejected():
    _clear()
    db = SessionLocal()
    try:
        entry_id = _seed_row(db, datetime(2026, 10, 6, 10, 0), is_locked=True)
        payload = _payload(db)
        payload.hourly[MACHINE][TIME].weight_front = 99.99

        try:
            save_daily_quality(payload, db=db)
            raise AssertionError("expected HTTPException")
        except HTTPException as exc:
            assert exc.status_code == 409
            assert exc.detail == LOCKED_ROW_DETAIL
            assert exc.detail == "This row is locked and cannot be edited."

        db.rollback()
        row = _row(db, entry_id)
        assert float(row.weight_front) == 52.5
        assert row.is_locked is True
    finally:
        db.close()


def test_unchanged_locked_row_saves_without_touching_it():
    _clear()
    db = SessionLocal()
    try:
        entry_id = _seed_row(db, datetime(2026, 10, 6, 10, 0), is_locked=True)
        payload = _payload(db)

        resp = save_daily_quality(payload, db=db)

        row = _row(db, entry_id)
        assert row.is_locked is True
        assert float(row.weight_front) == 52.5
        assert row.job_id == "V1-06102026"
        assert resp.hourly[MACHINE][TIME].is_locked is True
    finally:
        db.close()


def test_unlock_makes_the_row_editable_again():
    _clear()
    db = SessionLocal()
    try:
        entry_id = _seed_row(db, datetime(2026, 10, 6, 10, 0), is_locked=True)
        assert _lock(db, False).is_locked is False

        payload = _payload(db)
        payload.hourly[MACHINE][TIME].weight_front = 61.25
        save_daily_quality(payload, db=db)

        row = _row(db, entry_id)
        assert float(row.weight_front) == 61.25
        assert row.is_locked is False
    finally:
        db.close()


def test_deleting_a_locked_split_row_is_rejected():
    _clear()
    db = SessionLocal()
    try:
        entry_id = _seed_row(db, datetime(2026, 10, 6, 10, 25), is_locked=True)
        payload = _payload(db, deleted_splits={MACHINE: [SPLIT_TIME]})

        try:
            save_daily_quality(payload, db=db)
            raise AssertionError("expected HTTPException")
        except HTTPException as exc:
            assert exc.status_code == 409
            assert exc.detail == LOCKED_ROW_DETAIL

        db.rollback()
        assert _row(db, entry_id) is not None
    finally:
        db.close()
