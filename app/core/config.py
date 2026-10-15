"""Runtime configuration for the Bluefist prototype."""

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _csv_env(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    github_token: str = os.getenv("GITHUB_TOKEN", "")
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    api_token: str = os.getenv("BLUEFIST_API_TOKEN", "")
    environment: str = os.getenv("BLUEFIST_ENV", "development").lower()
    twilio_account_sid: str = os.getenv("TWILIO_ACCOUNT_SID", "")
    twilio_auth_token: str = os.getenv("TWILIO_AUTH_TOKEN", "")
    twilio_whatsapp_number: str = os.getenv("TWILIO_WHATSAPP_NUMBER", "")
    user_whatsapp_number: str = os.getenv("USER_WHATSAPP_NUMBER", "")
    cors_origins: list[str] = field(default_factory=lambda: _csv_env(
        "BLUEFIST_CORS_ORIGINS",
        "" if os.getenv("BLUEFIST_ENV", "development").lower() == "production"
        else "http://localhost:3000,http://127.0.0.1:3000",
    ))
    sandbox_mode: str = os.getenv("BLUEFIST_SANDBOX", "docker").lower()

    def __post_init__(self) -> None:
        if self.environment == "production":
            if not self.api_token:
                raise RuntimeError("BLUEFIST_API_TOKEN is required when BLUEFIST_ENV=production")
            if self.sandbox_mode != "docker":
                raise RuntimeError("Production requires BLUEFIST_SANDBOX=docker")
            if not self.cors_origins or "*" in self.cors_origins:
                raise RuntimeError("Production requires explicit BLUEFIST_CORS_ORIGINS")
            if any("localhost" in origin or "127.0.0.1" in origin for origin in self.cors_origins):
                raise RuntimeError("Production CORS origins cannot point to localhost")


settings = Settings()
