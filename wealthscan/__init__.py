"""Wealth advisor lead intelligence — research engine.

A weekly sweep of public news and (optionally) the Companies House register,
looking for people in 13 southern English counties who have recently come into
significant wealth.
"""

from .config import APP_NAME, APP_SUBTITLE, MODEL_VERSION

__all__ = ["APP_NAME", "APP_SUBTITLE", "MODEL_VERSION"]
