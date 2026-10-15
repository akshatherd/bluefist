"""Compatibility entrypoint: both `main:app` and `app.main:app` are canonical."""

from app.main import app

__all__ = ["app"]
