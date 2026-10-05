import os

_TMP_DB = os.path.join(os.path.dirname(__file__), "test_jobs_date_filter.db")
if os.path.exists(_TMP_DB):
    os.remove(_TMP_DB)
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP_DB}"

import pytest
from datetime import date, datetime
from decimal import Decimal

from fastapi.testclient import TestClient

from app.main import app
from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.models.job import JobMaster, ProductionJob, JobPackaging
from app.models.machine import MachineMaster
from app.models.product import BottleMaster, BottleConfiguration
from app.models.auth import AuthUser
from app.api.auth import get_current_user
from app.api.permissions import MODULE_PRODUCTION_PLANNING
import app.api.permissions as perms_module
from sqlalchemy import BigInteger

client = TestClient(app)

# Dummy test user with full planning permissions
test_user = AuthUser(
    employee_id="TEST01",
    employee_name="Test Operator",
    email="test@vitrum.com",
    password="hash",
    is_active=True,
)


@pytest.fixture(autouse=True)
def override_auth(monkeypatch):
    app.dependency_overrides[get_current_user] = lambda: test_user
    monkeypatch.setattr(
        perms_module,
        "load_permissions",
        lambda emp_id, db: {MODULE_PRODUCTION_PLANNING: {"read": True, "edit": True}},
    )
    yield
    app.dependency_overrides.clear()


@pytest.fixture(scope="module", autouse=True)
def setup_database():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if not db.query(MachineMaster).filter_by(machine_no=1).first():
            db.add(MachineMaster(machine_no=1, gob_type=3, max_section=8))
        if not db.query(BottleMaster).filter_by(bottle_id=111).first():
            db.add(BottleMaster(bottle_id=111, bottle_name="Test Bottle", weight=Decimal("200.00")))
        if not db.query(BottleConfiguration).filter_by(machine_no=1, bottle_id=111, section=8).first():
            db.add(BottleConfiguration(
                machine_no=1, bottle_id=111, section=8, weight=Decimal("200.00"), speeds=Decimal("100.00")
            ))
        db.commit()
    finally:
        db.close()
    yield
    engine.dispose()
    if os.path.exists(_TMP_DB):
        os.remove(_TMP_DB)


@pytest.fixture(autouse=True)
def seed_jobs():
    db = SessionLocal()
    try:
        db.query(JobPackaging).delete()
        db.query(ProductionJob).delete()
        db.query(JobMaster).delete()
        db.commit()

        # Seed 3 jobs: Sep 20, Sep 25, Oct 10
        for jid, pdate in [(101, date(2026, 9, 20)), (102, date(2026, 9, 25)), (103, date(2026, 10, 10))]:
            db.add(JobMaster(job_id=jid))
            db.flush()
            db.add(ProductionJob(
                job_id=jid,
                plan_date=pdate,
                machine_no=1,
                start_time=datetime(pdate.year, pdate.month, pdate.day, 7, 0, 0),
                bottle_id=111,
                section=8,
                weight=Decimal("200.00"),
                speeds=Decimal("100.00"),
                draw=Decimal("100.00"),
                quantity=Decimal("500000"),
                required_bottles=Decimal("500000"),
                status="Planned",
            ))
        db.commit()
    finally:
        db.close()


def test_jobmaster_model_column_is_biginteger():
    """Verify JobMaster.job_id is BigInteger to match Postgres bigint."""
    assert isinstance(JobMaster.job_id.type, BigInteger)


def test_get_jobs_no_params():
    """GET /jobs/ without params returns 200 and all seeded jobs."""
    res = client.get("/api/production/jobs/")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 3
    # Check ISO format YYYY-MM-DD preservation
    assert all("plan_date" in j and len(j["plan_date"]) == 10 for j in data)


def test_get_jobs_date_range_valid():
    """GET /jobs/?from_date=2026-09-25&to_date=2026-10-25 returns 200 and matching jobs."""
    res = client.get("/api/production/jobs/?from_date=2026-09-25&to_date=2026-10-25")
    assert res.status_code == 200
    data = res.json()
    dates = [j["plan_date"] for j in data]
    assert "2026-09-25" in dates
    assert "2026-10-10" in dates
    assert "2026-09-20" not in dates


def test_get_jobs_same_day_range():
    """Narrow range (same day) works and returns 200."""
    res = client.get("/api/production/jobs/?from_date=2026-09-25&to_date=2026-09-25")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 1
    assert data[0]["plan_date"] == "2026-09-25"


def test_get_jobs_invalid_date_returns_422():
    """from_date=abc returns 422, not 500."""
    res = client.get("/api/production/jobs/?from_date=abc&to_date=2026-10-25")
    assert res.status_code == 422


def test_get_jobs_inverted_date_range_returns_422():
    """from_date later than to_date returns 422."""
    res = client.get("/api/production/jobs/?from_date=2026-10-25&to_date=2026-09-25")
    assert res.status_code == 422
    assert "from_date must be less than or equal to to_date" in res.json().get("detail", "")


def test_bulk_save_and_bulk_delete():
    """Verify bulk save and bulk delete endpoints work as expected."""
    db = SessionLocal()
    try:
        db.add(JobMaster(job_id=104))
        db.commit()
    finally:
        db.close()

    # Create new job via bulk
    bulk_payload = {
        "jobs": [
            {
                "job_id": 104,
                "plan_date": "2026-10-15",
                "machine_no": 1,
                "start_time": "2026-10-15T07:00:00",
                "bottle_id": 111,
                "section": 8,
                "weight": 200.0,
                "speeds": 100.0,
                "changeover_minutes": 0,
            }
        ]
    }
    save_res = client.post("/api/production/jobs/bulk/", json=bulk_payload)
    assert save_res.status_code == 200
    created = save_res.json()
    assert len(created) == 1
    assert created[0]["plan_date"] == "2026-10-15"

    # Delete via bulk-delete
    del_payload = {
        "keys": [
            {
                "plan_date": "2026-10-15",
                "machine_no": 1,
                "start_time": "07:00",
                "job_id": 104,
                "section": 8,
            }
        ]
    }
    del_res = client.post("/api/production/jobs/bulk-delete/", json=del_payload)
    assert del_res.status_code == 200
    assert del_res.json()["deleted"] == 1
