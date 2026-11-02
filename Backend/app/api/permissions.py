# pyrefly: ignore [missing-import]
"""
Module-level permission dependencies.

GET/view endpoints depend on ``require_module_read(<Module Name>)``.
POST/PUT/PATCH/DELETE endpoints depend on ``require_module_edit(<Module Name>)``.

Rules (mirrored by the frontend):
  - can_read == False  -> no access to the module at all.
  - can_read + can_edit == True -> full access.
  - can_read + can_edit == False -> view-only (all mutations return 403).

The module names below are ONLY identifiers that must match a row in
``auth.module_master``; they are never resolved to ids or permission values in
code.  Every decision is read from the employee-permission table at request
time, so permission edits take effect immediately without a redeploy.  Modules
that do not exist in module_master fail closed (no permission row -> no access).
"""
from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.access import load_modules, load_permissions
from app.api.auth import get_current_user
from app.db.session import get_db
from app.models.auth import AuthUser

MODULE_PRODUCTION_PLANNING = "Production Planning"
MODULE_QUALITY_CONTROL = "Quality Control"
MODULE_BOTTLE_MASTER = "Bottle Master"
MODULE_HOLIDAY_MASTER = "Holiday Master"


def _deny(module: str, action: str):
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"Forbidden: {action} access to {module} is required.",
    )


def _check(user: AuthUser, db: Session, modules: list[str], action: str) -> AuthUser:
    """
    Shared check.  ``edit`` always requires read first: can_edit alone can
    never grant access to a module whose can_read is false.
    """
    permissions = load_permissions(user.employee_id, db)

    if action == "read":
        allowed = any(permissions.get(m, {}).get("read") for m in modules)
    else:
        allowed = any(
            permissions.get(m, {}).get("read") and permissions.get(m, {}).get("edit")
            for m in modules
        )

    if not allowed:
        _deny(" or ".join(modules), action)
    return user


def require_module_read(module: str):
    """Allow the request only when the employee has can_read on ``module``."""
    def dependency(
        user: AuthUser = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        return _check(user, db, [module], "read")

    return dependency


def require_module_edit(module: str):
    """Allow the request only when the employee has can_read AND can_edit."""
    def dependency(
        user: AuthUser = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        return _check(user, db, [module], "edit")

    return dependency


def require_any_module_read(modules: list[str]):
    """
    Allow a read/view endpoint when the user may read ANY of the listed modules.
    Used by reference data that several modules consume (e.g. bottle master and
    machine master are read by both Production Planning and Master Management).
    """
    def dependency(
        user: AuthUser = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        return _check(user, db, list(modules), "read")

    return dependency


def require_any_module_edit(modules: list[str]):
    """
    Allow a write endpoint when the user may edit ANY of the listed modules.
    Edit twin of ``require_any_module_read`` (e.g. the Packaging Master panel,
    which is part of Master Management and reuses its child modules'
    permissions).  ``_check`` still requires read first, so ``can_edit`` alone
    never grants access to a module the employee cannot read.
    """
    def dependency(
        user: AuthUser = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        return _check(user, db, list(modules), "edit")

    return dependency


def require_any_active_module_read():
    """
    Generic guard for endpoints whose data does not belong to a single module
    (e.g. the cross-module audit/notification feed): allowed when the employee
    can read at least one active module in module_master.  Fully dynamic --
    new modules are picked up automatically.
    """
    def dependency(
        user: AuthUser = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> AuthUser:
        modules = [m["module_name"] for m in load_modules(db)]
        if not modules:
            _deny("any module", "read")
        return _check(user, db, modules, "read")

    return dependency
