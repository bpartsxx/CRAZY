from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    google_api_key: str = ""

    slack_token: str = ""
    slack_client_id: str = ""
    slack_client_secret: str = ""
    slack_redirect_uri: str = "http://localhost:8000/auth/slack/callback"

    database_url: str = "sqlite:///./inbox.db"
    frontend_origin: str = "http://localhost:5173"
    slack_poll_interval_seconds: int = 8


settings = Settings()
