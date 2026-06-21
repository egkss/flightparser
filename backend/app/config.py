from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Aviaparser"
    database_path: str = "data/aviaparser.db"
    travelpayouts_token: str = ""
    travelpayouts_marker: str = ""
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    check_interval_minutes: int = 30
    telegram_drop_percent: float = 3.0
    error_fare_percent: float = 30.0
    public_base_url: str = "http://localhost:8000"

    @property
    def database_file(self) -> Path:
        return Path(self.database_path)


@lru_cache
def get_settings() -> Settings:
    return Settings()
