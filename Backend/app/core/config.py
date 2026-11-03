# pyrefly: ignore [missing-import]
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    DATABASE_URL: str = "sqlite:///./vitrumglass.db"

    # Idle window before an untouched session is discarded. The application
    # deliberately does NOT log a user out while they are working: a session is
    # renewed on every authenticated request (see app/api/auth.py), so an
    # operator stays signed in for as long as they keep using the app and is
    # only signed out manually. This long default exists purely so abandoned
    # browser tabs do not accumulate valid tokens forever.
    SESSION_IDLE_TIMEOUT_DAYS: int = 30

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def normalized_database_url(self) -> str:
        if self.DATABASE_URL.startswith("postgres://"):
            return self.DATABASE_URL.replace("postgres://", "postgresql://", 1)
        return self.DATABASE_URL

    @property
    def is_sqlite(self) -> bool:
        return self.normalized_database_url.startswith("sqlite")

    @property
    def production_schema(self) -> str | None:
        return None if self.is_sqlite else "production"

    @property
    def hpr_schema(self) -> str | None:
        return None if self.is_sqlite else "hpr"

    @property
    def auth_schema(self) -> str | None:
        return None if self.is_sqlite else "auth"

    @property
    def sqc_schema(self) -> str | None:
        return None if self.is_sqlite else "sqc"


settings = Settings()
