"""Configuration and thresholds.

Everything tunable lives here so an advisor can change the model's assumptions
without reading the algorithm. Values are read from the environment where it
makes sense to override them per-deployment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "Lead Intelligence"
APP_SUBTITLE = "Private wealth prospecting · UK · US · Middle East"
MODEL_VERSION = "3.0.0"

# --- Storage ---------------------------------------------------------------
# SQLite, so there is no database server to install or configure. Override with
# WEALTHSCAN_DB to keep the file somewhere backed up.
DB_PATH = Path(os.environ.get("WEALTHSCAN_DB", Path(__file__).resolve().parent.parent / "wealthscan.db"))

# --- Qualifying thresholds -------------------------------------------------
QUALIFYING_THRESHOLD_GBP = 7_500_000
PRIORITY_THRESHOLD_GBP = 15_000_000

# --- Networking ------------------------------------------------------------
# Identify honestly so publishers can block us if they wish, and stay slow
# enough to be a good citizen.
USER_AGENT = os.environ.get(
    "WEALTHSCAN_USER_AGENT",
    "WealthAdvisorLeadIntelligence/2.0 (research; +contact: set WEALTHSCAN_CONTACT)",
)
REQUEST_TIMEOUT_SECONDS = 20
# Google's RSS endpoint tolerates a steady rate. 0.5s is the floor at which a
# thousand-query deep sweep still finishes inside about fifteen minutes without
# looking like an attack; the whole design assumes patience rather than volume
# per second.
REQUEST_DELAY_SECONDS = float(os.environ.get("WEALTHSCAN_DELAY", "0.5"))
MAX_RETRIES = 3

# --- Companies House (optional bonus, not required) ------------------------
COMPANIES_HOUSE_API_KEY = os.environ.get("COMPANIES_HOUSE_API_KEY", "").strip()
COMPANIES_HOUSE_BASE = "https://api.company-information.service.gov.uk"


@dataclass(frozen=True)
class WealthModel:
    """Assumptions behind every monetary estimate.

    These are priors, not measurements. The Methodology page renders them
    verbatim so nothing here is hidden from the person relying on it.
    """

    # Share of a disclosed transaction value that reaches a founder-owner, when
    # their exact stake is unknown. Founder-led private companies at exit are
    # commonly 40-70% founder-held.
    assumed_founder_stake_low: float = 0.35
    assumed_founder_stake_mid: float = 0.55
    assumed_founder_stake_high: float = 0.75

    # Effective capital gains tax on a business disposal (blend of Business
    # Asset Disposal Relief band and the main rate).
    exit_tax_rate: float = 0.22
    # Additional-rate dividend tax.
    dividend_tax_rate: float = 0.3935
    # Share of post-tax proceeds assumed retained rather than spent.
    retention_rate: float = 0.75

    # Founder equity in a funded but unexited company is paper wealth. Only a
    # small slice is investable today.
    liquidity_unrealised: float = 0.05
    liquidity_realised: float = 0.95
    liquidity_dividend: float = 0.90

    # Typical founder dilution after institutional rounds, applied when
    # estimating a stake from a post-money valuation.
    founder_share_after_seed: float = 0.55
    founder_share_after_series_a: float = 0.35
    founder_share_after_series_b: float = 0.22
    founder_share_after_later: float = 0.15

    # Rough FX to GBP, for headlines quoted in other currencies.
    fx_to_gbp: dict[str, float] = field(
        default_factory=lambda: {"£": 1.0, "$": 0.78, "€": 0.85}
    )


MODEL = WealthModel()

ASSUMPTION_NOTES: dict[str, str] = {
    "assumed_founder_stake_mid": "Where a stake is unknown, a founder is assumed to hold 55% (range 35-75%).",
    "exit_tax_rate": "22% effective capital gains tax applied to disposal proceeds.",
    "dividend_tax_rate": "39.35% additional-rate dividend tax applied to distributions.",
    "retention_rate": "75% of post-tax proceeds assumed retained rather than spent.",
    "liquidity_unrealised": "Only 5% of unrealised founder equity counts as investable today.",
    "liquidity_realised": "Realised proceeds are treated as 95% investable.",
    "liquidity_dividend": "Retained dividend income is treated as 90% investable.",
    "founder_share_after_series_b": "After a Series B, a founder is assumed to retain about 22%.",
}
