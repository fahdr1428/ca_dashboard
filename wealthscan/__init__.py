"""Wealth advisor lead intelligence — research engine.

A repeatable sweep of public news and (optionally) the Companies House register,
looking for people across 70 markets — the UK, the United States, the Middle
East and beyond — who have recently come into significant wealth.
"""

from .config import APP_NAME, APP_SUBTITLE, MODEL_VERSION

__all__ = ["APP_NAME", "APP_SUBTITLE", "MODEL_VERSION"]
