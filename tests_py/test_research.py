"""Tests for the research engine.

Written with unittest so there is no extra dependency to install:

    python -m unittest discover -s tests_py -v

The tests that matter most are the ones asserting what the app *refuses* to do:
inventing a person, guessing a figure, or claiming something is verified when it
is not. Those are the failures that would make this tool dangerous rather than
merely wrong.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wealthscan.extract import (  # noqa: E402
    classify, extract_company, extract_event, extract_people, parse_money,
)
from wealthscan.queries import EVENT_TEMPLATES, build_search_matrix, google_news_url  # noqa: E402
from wealthscan.regions import REGIONS, resolve_region  # noqa: E402
from wealthscan.report import fmt_gbp, week_bounds  # noqa: E402
from wealthscan.scoring import (  # noqa: E402
    band_for, cohort_for, estimate_from_event, score_confidence,
)


class TestRegions(unittest.TestCase):
    def test_resolves_county_and_town(self):
        for text, expected in [
            ("Exeter engineering firm sold", "Devon"),
            ("Truro hotelier expands", "Cornwall"),
            ("a Weybridge founder exits", "Surrey"),
            ("Canary Wharf fund manager", "Greater London"),
            ("Cirencester food group grows", "Gloucestershire"),
        ]:
            self.assertEqual(resolve_region(text)[0], expected, text)

    def test_discards_out_of_scope(self):
        """Out of scope must be None, never a default. A wrong county puts a
        prospect in front of an advisor who has no business contacting them."""
        for text in ["Manchester tech firm raises £10m", "Edinburgh founder sells up",
                     "Londonderry business", "New Hampshire startup", "", None]:
            self.assertIsNone(resolve_region(text)[0], repr(text))

    def test_ambiguous_place_needs_corroboration(self):
        # "Bath" appears in far more articles about bathrooms than about Somerset.
        self.assertIsNone(resolve_region("luxury bath and shower fittings")[0])
        self.assertEqual(resolve_region("Bath, Somerset firm sold")[0], "Somerset")

    def test_every_region_has_data(self):
        from wealthscan.regions import REGION_DATA
        self.assertEqual(len(REGIONS), 13)
        for name in REGIONS:
            self.assertIn(name, REGION_DATA)
            self.assertTrue(REGION_DATA[name].places)


class TestMoney(unittest.TestCase):
    def test_units(self):
        self.assertEqual(parse_money("sold for £40m"), 40_000_000)
        self.assertEqual(parse_money("a £1.2bn valuation"), 1_200_000_000)
        self.assertEqual(parse_money("nets £4.5 million"), 4_500_000)
        self.assertEqual(parse_money("£750k seed round"), 750_000)
        self.assertEqual(parse_money("worth £1,250,000"), 1_250_000)

    def test_converts_foreign_currency(self):
        usd = parse_money("raises $30m")
        self.assertIsNotNone(usd)
        self.assertLess(usd, 30_000_000, "USD should be discounted to GBP")

    def test_takes_the_largest_figure(self):
        # The deal value matters, not the turnover mentioned in passing.
        self.assertEqual(parse_money("£40m deal for the £8m-turnover firm"), 40_000_000)

    def test_ignores_non_amounts(self):
        self.assertIsNone(parse_money("the 2026 results"))
        self.assertIsNone(parse_money("shares at £2.40 each"))
        self.assertIsNone(parse_money("no figures here"))


class TestPeople(unittest.TestCase):
    def test_title_then_name(self):
        people = extract_people("chairman Gareth Halberton has sold the business")
        self.assertEqual(people[0].name, "Gareth Halberton")
        self.assertEqual(people[0].title, "Chairman")

    def test_name_then_title(self):
        people = extract_people("Imogen Trevanning, CEO of the marine group")
        self.assertEqual(people[0].name, "Imogen Trevanning")
        self.assertEqual(people[0].title, "Chief Executive")

    def test_agent_verb_without_a_title(self):
        people = extract_people("a family office established by Alastair Wren")
        self.assertEqual(people[0].name, "Alastair Wren")
        self.assertEqual(people[0].title, "", "no title was stated, so none is invented")

    def test_acquired_by_is_not_a_person(self):
        # "acquired by" nearly always takes a company, and treating the acquirer
        # as an individual would fabricate a prospect.
        self.assertEqual(extract_people("acquired by German rival Schmidt AG"), [])

    def test_refuses_to_invent_people(self):
        for text in ["The Company Limited announced results",
                     "Business Live reports strong growth",
                     "founder Smith said",
                     "revenue rose sharply this year"]:
            self.assertEqual(extract_people(text), [], text)

    def test_company_extraction(self):
        self.assertEqual(
            extract_company("Halberton Precision Engineering Ltd was sold"),
            "Halberton Precision Engineering Ltd",
        )
        self.assertIsNone(extract_company("no company mentioned here"))


class TestClassification(unittest.TestCase):
    def test_identifies_events(self):
        self.assertIn("acquisition", classify("Exeter firm acquired by rival"))
        self.assertIn("business_exit", classify("Founder sold his stake"))
        self.assertIn("ipo", classify("company floats on AIM"))
        self.assertIn("management_buyout", classify("completed a management buyout"))

    def test_full_extraction(self):
        event = extract_event(
            title="Exeter group Halberton Precision Ltd acquired for £64m",
            summary="Chairman Gareth Halberton has sold the business.",
            url="https://example.invalid/a", publisher="BusinessLive",
            published_at=None, query_event_key="acquisition",
        )
        self.assertIsNotNone(event)
        self.assertEqual(event.region, "Devon")
        self.assertEqual(event.amount_gbp, 64_000_000)
        self.assertEqual(event.people[0].name, "Gareth Halberton")
        self.assertIn("Devon", event.rationale)

    def test_rejects_out_of_region_and_non_events(self):
        self.assertIsNone(extract_event(
            title="Manchester firm sold for £20m", summary="", url="u",
            publisher="p", published_at=None))
        self.assertIsNone(extract_event(
            title="Exeter council opens a new library", summary="", url="u",
            publisher="p", published_at=None))


class TestEstimates(unittest.TestCase):
    def test_realised_exit_produces_investable_assets(self):
        estimate = estimate_from_event(
            event_key="business_exit", amount_gbp=64_000_000,
            text="sold the business", has_named_person=True,
        )
        self.assertIsNotNone(estimate.investable_mid_gbp)
        self.assertTrue(estimate.is_realised)
        # 55% stake, less 22% CGT, 75% retained, 95% liquid.
        self.assertAlmostEqual(
            estimate.gross_mid_gbp, int(64_000_000 * 0.55 * 0.78), delta=2
        )
        self.assertLess(estimate.gross_low_gbp, estimate.gross_mid_gbp)
        self.assertGreater(estimate.gross_high_gbp, estimate.gross_mid_gbp)
        # The assumed stake must be disclosed, not buried.
        self.assertTrue(any("shareholding" in c for c in estimate.caveats))

    def test_funding_round_is_mostly_paper_wealth(self):
        estimate = estimate_from_event(
            event_key="venture_funding", amount_gbp=62_000_000,
            text="raises £62m Series C", has_named_person=True,
        )
        self.assertIsNotNone(estimate.gross_mid_gbp)
        self.assertFalse(estimate.is_realised)
        # The whole point: a funded founder is rich on paper and illiquid in fact.
        self.assertLess(estimate.investable_mid_gbp, estimate.gross_mid_gbp * 0.1)
        self.assertTrue(any("paper wealth" in c for c in estimate.caveats))

    def test_no_amount_means_no_figure_and_a_reason(self):
        estimate = estimate_from_event(
            event_key="business_exit", amount_gbp=None,
            text="sold the business", has_named_person=True,
        )
        self.assertIsNone(estimate.investable_mid_gbp, "must be None, never zero")
        self.assertIsNotNone(estimate.not_estimated_reason)
        self.assertIn("No monetary value", estimate.not_estimated_reason)

    def test_unnamed_individual_means_no_attribution(self):
        estimate = estimate_from_event(
            event_key="acquisition", amount_gbp=30_000_000,
            text="company acquired", has_named_person=False,
        )
        self.assertIsNone(estimate.investable_mid_gbp)
        self.assertIn("no individual was", estimate.not_estimated_reason)

    def test_indicative_events_carry_no_figure(self):
        for key in ("property", "succession", "family_office", "company_growth"):
            estimate = estimate_from_event(
                event_key=key, amount_gbp=5_000_000,
                text="bought an estate", has_named_person=True,
            )
            self.assertIsNone(estimate.investable_mid_gbp, key)
            self.assertIsNotNone(estimate.not_estimated_reason, key)

    def test_bands_and_cohorts(self):
        self.assertEqual(band_for(None), "Not estimated")
        self.assertEqual(band_for(7_499_999), "Below £7.5m")
        self.assertEqual(band_for(7_500_000), "£7.5m – £15m")
        self.assertEqual(band_for(250_000_000), "£100m+")

        self.assertEqual(cohort_for(20_000_000, 40_000_000), "Qualifying")
        self.assertEqual(cohort_for(2_000_000, 40_000_000), "Pre-liquidity founder")
        self.assertEqual(cohort_for(None, None), "Research lead")
        self.assertEqual(cohort_for(1_000_000, 2_000_000), "Below threshold")


class TestConfidence(unittest.TestCase):
    def test_unverified_stake_is_the_weak_link(self):
        confidence = score_confidence(
            publisher="BusinessLive", has_named_person=True, amount_disclosed=True,
            source_count=1, event_weight=85,
        )
        ownership = next(d for d in confidence.dimensions if d.key == "ownership")
        self.assertLess(ownership.score, 40)
        # The suggested action must target the biggest available gain, which for
        # a news-derived record is always the unevidenced shareholding.
        self.assertIn("PSC register", confidence.next_action)

    def test_verification_raises_the_score(self):
        base = score_confidence(
            publisher="BusinessLive", has_named_person=True, amount_disclosed=True,
            source_count=1, event_weight=85,
        )
        verified = score_confidence(
            publisher="BusinessLive", has_named_person=True, amount_disclosed=True,
            source_count=1, event_weight=85,
            stake_verified=True, companies_house_verified=True,
        )
        self.assertGreater(verified.score, base.score + 15)

    def test_unknown_publisher_scores_lower(self):
        known = score_confidence(publisher="BBC", has_named_person=True,
                                 amount_disclosed=True, source_count=1, event_weight=80)
        unknown = score_confidence(publisher="somebodysblog.example",
                                   has_named_person=True, amount_disclosed=True,
                                   source_count=1, event_weight=80)
        self.assertGreater(known.score, unknown.score)

    def test_corroboration_helps(self):
        one = score_confidence(publisher="BBC", has_named_person=True,
                               amount_disclosed=True, source_count=1, event_weight=80)
        three = score_confidence(publisher="BBC", has_named_person=True,
                                 amount_disclosed=True, source_count=3, event_weight=80)
        self.assertGreater(three.score, one.score)

    def test_score_stays_in_range(self):
        best = score_confidence(publisher="BBC", has_named_person=True,
                                amount_disclosed=True, source_count=9, event_weight=95,
                                stake_verified=True, companies_house_verified=True)
        worst = score_confidence(publisher="", has_named_person=False,
                                 amount_disclosed=False, source_count=1, event_weight=40,
                                 estimate_is_none=True)
        self.assertLessEqual(best.score, 100)
        self.assertGreaterEqual(worst.score, 0)


class TestQueries(unittest.TestCase):
    def test_matrix_covers_every_county_and_event(self):
        matrix = build_search_matrix(days=7)
        self.assertEqual(len(matrix), len(REGIONS) * len(EVENT_TEMPLATES))
        self.assertEqual({q.region for q in matrix}, set(REGIONS))

    def test_query_url_is_well_formed(self):
        url = google_news_url('"Devon" (acquired)', days=7)
        self.assertIn("news.google.com/rss/search", url)
        self.assertIn("when%3A7d", url)
        self.assertIn("gl=GB", url)

    def test_can_narrow_the_matrix(self):
        matrix = build_search_matrix(days=7, regions=["Devon"], event_keys=["business_exit"])
        self.assertEqual(len(matrix), 1)
        self.assertEqual(matrix[0].region, "Devon")


class TestFormatting(unittest.TestCase):
    def test_none_is_a_dash_not_zero(self):
        """A missing figure must never render as £0 — that reads as a fact."""
        self.assertEqual(fmt_gbp(None), "—")
        self.assertEqual(fmt_gbp(0), "£0")
        self.assertEqual(fmt_gbp(7_500_000), "£7.5m")
        self.assertEqual(fmt_gbp(1_240_000_000), "£1.24bn")

    def test_week_bounds_run_monday_to_sunday(self):
        start, end = week_bounds("2026-W33")
        self.assertEqual(start.weekday(), 0, "starts on a Monday")
        self.assertEqual(end.weekday(), 6, "ends on a Sunday")


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestOwnershipBands(unittest.TestCase):
    """A filed PSC band replaces the assumed stake, which is the single most
    valuable thing verification does to a record."""

    def test_parses_ranges_and_exact_values(self):
        from wealthscan.scoring import parse_ownership_band
        self.assertEqual(parse_ownership_band("50–75%"), (0.5, 0.625, 0.75))
        self.assertEqual(parse_ownership_band("25–50%"), (0.25, 0.375, 0.5))
        # A decimal must be read as one number, not two.
        self.assertEqual(parse_ownership_band("12.5%"), (0.125, 0.125, 0.125))
        self.assertIsNone(parse_ownership_band(None))
        self.assertIsNone(parse_ownership_band("no numbers"))

    def test_filed_band_changes_the_figure_and_the_caveat(self):
        assumed = estimate_from_event(
            event_key="business_exit", amount_gbp=64_000_000,
            text="sold", has_named_person=True)
        filed = estimate_from_event(
            event_key="business_exit", amount_gbp=64_000_000,
            text="sold", has_named_person=True, known_stake_band="50–75%")

        self.assertIn("assumed to hold", assumed.method)
        self.assertIn("filed PSC register", filed.method)
        # The contradictory "stake is an assumption" caveat must be gone.
        self.assertFalse(any("is an assumption" in c for c in filed.caveats))
        self.assertTrue(any("is an assumption" in c for c in assumed.caveats))
        # 62.5% filed midpoint beats the 55% default, so the figure moves up.
        self.assertGreater(filed.gross_mid_gbp, assumed.gross_mid_gbp)
