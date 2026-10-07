import os
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Set test database before app imports
_TMP_DB = os.path.join(os.path.dirname(__file__), "test_auth.db")
if os.path.exists(_TMP_DB):
    try:
        os.remove(_TMP_DB)
    except OSError:
        pass
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP_DB}"

from app.main import app
from app.db.base import Base
from app.db.session import engine, get_db, SessionLocal
from app.models.auth import AuthBase, AuthUser

client = TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def setup_auth_db():
    Base.metadata.create_all(bind=engine)
    AuthBase.metadata.create_all(bind=engine)
    yield
    if os.path.exists(_TMP_DB):
        try:
            os.remove(_TMP_DB)
        except OSError:
            pass


def test_legacy_users_model_does_not_exist_in_base_metadata():
    """Verify legacy user table is completely absent from Base metadata."""
    table_names = list(Base.metadata.tables.keys())
    assert "users" not in table_names
    for name in table_names:
        assert not name.endswith(".users")


def test_signup_success():
    """Verify signup creates user in auth.users and returns 201."""
    payload = {
        "employee_id": "EMP001",
        "employee_name": "Alice Smith",
        "department": "Production",  # accepted, ignored
        "email": "alice@example.com",
        "phone_number": "9876543210",
        "password": "Password123!",
        "role": "Editor",  # accepted, ignored
    }
    response = client.post("/api/auth/signup", json=payload)
    assert response.status_code == 201
    assert response.json() == {"message": "Account created successfully"}

    # Verify user exists in AuthUser
    db = SessionLocal()
    try:
        user = db.get(AuthUser, "EMP001")
        assert user is not None
        assert user.employee_name == "Alice Smith"
        assert user.email == "alice@example.com"
        assert user.phone_number == "9876543210"
        assert user.password == "Password123!"
        assert user.is_active is True
        # Verify AuthUser has no department or role attributes
        assert not hasattr(user, "department")
        assert not hasattr(user, "role")
    finally:
        db.close()


def test_signup_duplicate_email_case_insensitive():
    """Verify signup with duplicate email in different casing returns 409."""
    payload = {
        "employee_id": "EMP002",
        "employee_name": "Bob Jones",
        "department": "Quality",
        "email": "ALICE@EXAMPLE.COM",  # duplicate of alice@example.com
        "phone_number": "9876543211",
        "password": "Password123!",
        "role": "Viewer",
    }
    response = client.post("/api/auth/signup", json=payload)
    assert response.status_code == 409
    assert response.json()["detail"] == "An account already exists for this email address"


def test_signup_duplicate_employee_id():
    """Verify signup with duplicate employee_id returns 409."""
    payload = {
        "employee_id": "EMP001",  # already exists
        "employee_name": "Alice Duplicate",
        "department": "Maintenance",
        "email": "alice.other@example.com",
        "phone_number": "9876543212",
        "password": "Password123!",
        "role": "Viewer",
    }
    response = client.post("/api/auth/signup", json=payload)
    assert response.status_code == 409
    assert response.json()["detail"] == "An account already exists for this employee ID"


def test_login_and_me():
    """Verify login and /me endpoint returns department '' and role 'Viewer'."""
    # Login with employee_id
    login_resp = client.post("/api/auth/login", json={
        "user_id": "EMP001",
        "password": "Password123!"
    })
    assert login_resp.status_code == 200
    login_data = login_resp.json()
    assert "token" in login_data
    token = login_data["token"]
    user_info = login_data["user"]
    assert user_info["employee_id"] == "EMP001"
    assert user_info["department"] == ""
    assert user_info["role"] == "Viewer"

    # Call /api/auth/me with Bearer token
    me_resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_resp.status_code == 200
    me_data = me_resp.json()
    assert me_data["employee_id"] == "EMP001"
    assert me_data["department"] == ""
    assert me_data["role"] == "Viewer"
    assert me_data["email"] == "alice@example.com"
    assert me_data["phone_number"] == "9876543210"


def test_change_password():
    """Verify change-password updates AuthUser password."""
    # Login first
    login_resp = client.post("/api/auth/login", json={
        "user_id": "EMP001",
        "password": "Password123!"
    })
    token = login_resp.json()["token"]

    # Change password
    change_resp = client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "current_password": "Password123!",
            "new_password": "NewSecretPassword456!"
        }
    )
    assert change_resp.status_code == 200
    assert change_resp.json() == {"message": "Password updated successfully"}

    # Old password fails
    old_login = client.post("/api/auth/login", json={
        "user_id": "EMP001",
        "password": "Password123!"
    })
    assert old_login.status_code == 401

    # New password succeeds
    new_login = client.post("/api/auth/login", json={
        "user_id": "EMP001",
        "password": "NewSecretPassword456!"
    })
    assert new_login.status_code == 200
