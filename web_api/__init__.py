"""Small, local FastAPI facade for OpenMontage asynchronous video tasks."""

from .app import app, create_app

__all__ = ["app", "create_app"]
