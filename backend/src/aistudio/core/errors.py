"""Domain errors. The API layer maps these to HTTP responses (see ``api/app.py``)."""

from __future__ import annotations


class StudioError(Exception):
    """Base class for expected, user-facing errors."""

    status_code = 400
    code = "studio_error"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFound(StudioError):
    status_code = 404
    code = "not_found"


class Conflict(StudioError):
    status_code = 409
    code = "conflict"


class PermissionDenied(StudioError):
    status_code = 403
    code = "permission_denied"


class ValidationFailed(StudioError):
    status_code = 422
    code = "validation_failed"


class Unavailable(StudioError):
    """A dependency (CLI, remote host, provider) is not reachable or not set up."""

    status_code = 503
    code = "unavailable"
