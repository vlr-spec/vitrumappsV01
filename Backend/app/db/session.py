from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.core.config import settings

SQLALCHEMY_DATABASE_URL = settings.normalized_database_url

# SQLite requires specific arguments that Postgres does not
if settings.is_sqlite:
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
    )
else:
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
        pool_recycle=1800,
        pool_timeout=30,
    )

# 2. Create the Session Factory
# When a user hits our API, we want to open a "session" (a temporary connection),
# do our database work, and then safely close it.
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# 3. Create a Dependency to get the Database
# We will use this function in our API endpoints to talk to the DB.
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
