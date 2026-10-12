from sqlalchemy import Column, Integer, String, DateTime
from sqlalchemy.sql import func
from app.db.base import Base, auth_table_args

class AuditLog(Base):
    __tablename__ = "audit_logs"
    # Audit trails are written for the authenticated employee, whose identity
    # lives in auth.users. The matching audit_logs table therefore lives in the
    # auth schema (auth.audit_logs, DB-level FK -> auth.users.employee_id);
    # pointing the model at production.audit_logs wrote to a table whose FK
    # targets the empty production.users, so every audited write raised a
    # ForeignKeyViolation (surfaced as a 500 on bottle rename / config saves).
    #
    # auth.users is mapped on the separate AuthBase (never created/altered by
    # Base.metadata.create_all), so the relationship is intentionally not
    # declared as an ORM ForeignKey -- the existing database constraint still
    # enforces referential integrity on every insert.
    __table_args__ = auth_table_args()

    id = Column(Integer, primary_key=True, index=True)
    
    # Who made the change? References auth.users.employee_id (enforced by the DB).
    user_id = Column(String)
    
    # What did they do? (e.g., "UPDATED JOB")
    action = Column(String, nullable=False) 
    
    # Specific details (e.g., "Changed required_bottles from 100 to 500")
    details = Column(String) 
    
    # Automatically records the exact time the change happened
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
