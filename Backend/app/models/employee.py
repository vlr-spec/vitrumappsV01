from sqlalchemy import Boolean, Column, String

from app.db.base import Base, hpr_table_args


class EmployeeMaster(Base):
    """Minimal mapping for the existing HPR employee master table.

    This mapping registers the table in ``Base.metadata`` so foreign keys from
    repacking models can be resolved during schema creation. The employee
    master remains the source of truth in the HPR schema.
    """

    __tablename__ = "employee_master"
    __table_args__ = (hpr_table_args(),)

    employee_id = Column(String, primary_key=True)
    employee_name = Column(String, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
