from app.db.base import Base
from app.models.employee import EmployeeMaster
from app.models.repacking import RepackingNumbering, RepackingSqcQcHold


def test_employee_master_is_registered_for_repacking_foreign_keys():
    assert EmployeeMaster.__table__ in Base.metadata.sorted_tables
    assert "employee_master" in Base.metadata.tables

    for model in (RepackingNumbering, RepackingSqcQcHold):
        checker_fk = next(iter(model.__table__.c.checker_id.foreign_keys))
        assert checker_fk.column is EmployeeMaster.__table__.c.employee_id
