"""Regression tests: Numbering persistence must not touch ``defective_bottles``.

The live ``sqc.repacking_numbering`` table no longer has that column, while
``sqc.repacking_sqc_qc_hold`` still does. These tests run INSERT / UPDATE /
FETCH against an in-memory table without that column, so any stale reference
fails immediately. Both schema-qualified and unqualified table names are
created because the test suite as a whole may switch ``DATABASE_URL`` to
SQLite, which disables schema prefixes in the API helpers.
"""
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.api.production.repacking import (
    _NUMBERING_INSERT_FIELDS,
    _SQC_INSERT_FIELDS,
    _numbering_select,
    create_numbering_entry,
    create_sqc_qc_hold_entry,
    get_numbering_entries,
    save_numbering_batch,
    update_numbering_entry,
)
from app.models.auth import AuthUser
from app.schemas.repacking import (
    NumberingEntryCreate,
    NumberingEntryResponse,
    NumberingEntryUpdate,
    NumberingEntryUpdateWithId,
    NumberingSaveRequest,
    SqcQcHoldEntryCreate,
)


def _ddls(prefix: str) -> list[str]:
    """CREATE TABLE statements for one naming convention (schema or no schema)."""
    return [
        # Numbering deliberately has NO defective_bottles column.
        f'''CREATE TABLE {prefix}repacking_numbering (
            entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
            production_date DATE NOT NULL,
            machine_no SMALLINT NOT NULL,
            job_id VARCHAR NOT NULL,
            bottle_id INTEGER,
            pack_type VARCHAR,
            shift SMALLINT NOT NULL,
            entry_time TIME NOT NULL,
            pcs_per_pack INTEGER,
            cartons INTEGER,
            defect_id BIGINT,
            mould VARCHAR,
            section_no VARCHAR,
            checker_id VARCHAR,
            remarks TEXT,
            created_at DATETIME,
            updated_at DATETIME
        )''',
        # SQC/QC HOLD keeps its defective_bottles column.
        f'''CREATE TABLE {prefix}repacking_sqc_qc_hold (
            entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
            production_date DATE NOT NULL,
            machine_no SMALLINT NOT NULL,
            job_id VARCHAR NOT NULL,
            bottle_id INTEGER,
            pack_type VARCHAR,
            lot_no VARCHAR,
            shift SMALLINT NOT NULL,
            entry_time TIME NOT NULL,
            pcs_per_pack INTEGER,
            cartons INTEGER,
            defective_bottles INTEGER,
            defect_id BIGINT,
            mould VARCHAR,
            section_no VARCHAR,
            checker_id VARCHAR,
            remarks TEXT,
            created_at DATETIME,
            updated_at DATETIME
        )''',
        f'''CREATE TABLE {prefix}bottle_master (
            bottle_id INTEGER PRIMARY KEY, bottle_name VARCHAR NOT NULL
        )''',
        f'''CREATE TABLE {prefix}defect_master (
            defect_id INTEGER PRIMARY KEY, defect_name VARCHAR NOT NULL
        )''',
        f'''CREATE TABLE {prefix}employee_master (
            employee_id VARCHAR PRIMARY KEY, employee_name VARCHAR NOT NULL
        )''',
        f'''CREATE TABLE {prefix}audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id VARCHAR,
            action VARCHAR NOT NULL,
            details VARCHAR,
            timestamp DATETIME
        )''',
    ]


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    with engine.connect() as conn:
        for schema in ("sqc", "hpr", "production", "auth"):
            conn.execute(text(f"ATTACH DATABASE ':memory:' AS {schema}"))

        for ddl in _ddls('"sqc".'):
            conn.execute(text(ddl))
        for ddl in _ddls('"hpr".'):
            conn.execute(text(ddl))
        for ddl in _ddls('"production".'):
            conn.execute(text(ddl))
        for ddl in _ddls('"auth".'):
            conn.execute(text(ddl))
        for ddl in _ddls(''):
            conn.execute(text(ddl))

        for prefix in ('"production".', '"hpr".', ''):
            conn.execute(
                text(f"INSERT INTO {prefix}bottle_master (bottle_id, bottle_name) VALUES (1, :name)"),
                {"name": "Test Bottle"},
            )
            conn.execute(
                text(f"INSERT INTO {prefix}defect_master (defect_id, defect_name) VALUES (1, :name)"),
                {"name": "Chipped"},
            )
            conn.execute(
                text(f"INSERT INTO {prefix}employee_master (employee_id, employee_name) VALUES (:eid, :name)"),
                {"eid": "E1", "name": "Checker One"},
            )
        conn.commit()

    session = sessionmaker(bind=engine)()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture()
def user():
    return AuthUser(employee_id="T1", employee_name="Tester", password="x")


def _create_payload(**overrides):
    data = dict(
        production_date="2026-11-17",
        machine_no=1,
        job_id="JOB-1",
        bottle_id=1,
        pack_type="BOX",
        shift=1,
        entry_time="10:30",
        pcs_per_pack=24,
        cartons=5,
        defect_ids=[1],
        mould="M-1",
        section_no="S-1",
        checker_id="E1",
        remarks="initial",
    )
    data.update(overrides)
    return NumberingEntryCreate(**data)


def test_numbering_mappings_no_longer_reference_defective_bottles():
    assert "defective_bottles" not in _NUMBERING_INSERT_FIELDS
    assert "defective_bottles" not in _numbering_select()
    assert "defective_bottles" not in NumberingEntryCreate.model_fields
    assert "defective_bottles" not in NumberingEntryUpdate.model_fields
    assert "defective_bottles" not in NumberingEntryResponse.model_fields

    # SQC/QC HOLD is a separate table and must stay untouched.
    assert "defective_bottles" in _SQC_INSERT_FIELDS


def test_numbering_insert_and_fetch(db, user):
    created = create_numbering_entry(_create_payload(), db, user)
    assert created.entry_id
    assert created.cartons == 5
    assert not hasattr(created, "defective_bottles")

    rows = get_numbering_entries(production_date="2026-11-17", db=db, _user=user)
    assert len(rows) == 1
    assert rows[0].entry_id == created.entry_id
    assert rows[0].cartons == 5
    assert not hasattr(rows[0], "defective_bottles")


def test_numbering_update(db, user):
    created = create_numbering_entry(_create_payload(), db, user)
    updated = update_numbering_entry(
        created.entry_id,
        NumberingEntryUpdate(cartons=9, remarks="updated"),
        db,
        user,
    )
    assert updated.cartons == 9
    assert updated.remarks == "updated"
    assert not hasattr(updated, "defective_bottles")

    rows = get_numbering_entries(production_date="2026-11-17", db=db, _user=user)
    assert rows[0].cartons == 9


def test_numbering_batch_save_insert_and_update(db, user):
    saved = save_numbering_batch(
        NumberingSaveRequest(inserts=[_create_payload(machine_no=2, job_id="JOB-2")]),
        db,
        user,
    )
    assert len(saved) == 1

    updated = save_numbering_batch(
        NumberingSaveRequest(
            updates=[
                NumberingEntryUpdateWithId(
                    entry_id=saved[0].entry_id, cartons=12, remarks="batch updated"
                )
            ]
        ),
        db,
        user,
    )
    assert len(updated) == 1
    assert updated[0].cartons == 12

    rows = get_numbering_entries(production_date="2026-11-17", db=db, _user=user)
    assert len(rows) == 1
    assert rows[0].cartons == 12
    assert not hasattr(rows[0], "defective_bottles")


def test_sqc_qc_hold_still_persists_defective_bottles(db, user):
    created = create_sqc_qc_hold_entry(
        SqcQcHoldEntryCreate(
            production_date="2026-11-17",
            machine_no=3,
            job_id="JOB-3",
            bottle_id=1,
            pack_type="BOX",
            lot_no="LOT-1",
            shift=1,
            entry_time="11:00",
            pcs_per_pack=12,
            cartons=3,
            defective_bottles=7,
            defect_ids=[1],
            checker_id="E1",
        ),
        db,
        user,
    )
    assert created.defective_bottles == 7
