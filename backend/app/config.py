from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application configuration loaded from environment variables.

    The defaults are suitable for local development. All fields are typed
    and will be validated by *pydantic* at runtime.
    """
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Aviaparser"
    # Use a clear name for the SQLite file path
    database_file: str = "data/aviaparser.db"
    travelpayouts_token: str = ""
    travelpayouts_marker: str = ""
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    telegram_proxy_url: str = ""
    extension_api_token: str = ""
    check_interval_minutes: int = 30
    telegram_drop_percent: float = 5.0
    error_fare_percent: float = 30.0
    error_fare_recheck_seconds: int = 45
    public_base_url: str = "http://localhost:8000"

    @property
    def database_path(self) -> Path:
        """Resolve the SQLite database path relative to the project root.

        ``database_file`` stores a relative string; this property returns a
        ``Path`` object that can be used directly with ``sqlite3``.
        """
        return Path(self.database_file).expanduser().resolve()


@lru_cache
def get_settings() -> Settings:
    """Cache the settings instance for the lifetime of the process."""
    return Settings()

