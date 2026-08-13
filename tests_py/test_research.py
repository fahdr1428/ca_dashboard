"""Tests for the research engine.

Written with unittest so there is no extra dependency to install:

    python -m unittest discover -s tests_py -v

The tests that matter most are the ones asserting what the app *refuses* to do:
inventing a person, guessing a figure, claiming something is verified when it is
not, or filing someone in a country they have nothing to do with. Those are the
failures that would make this tool dangerous rather than merely wrong.

Second in importance are the yield tests. An extractor that discards a perfectly
good £64m exit because the 200-character snippet didn't repeat the county name is
not "cautious", it is broken — that bug is what limited the first version of this
app to a single result, and `test_inherits_market_from_the_query` pins the fix.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wealthscan.extract import (  # noqa: E402
    classify, extract_company, extract_event, extract_people, parse_money,
)
from wealthscan.markets import (  # noqa: E402
    ALL_MARKETS, CORE_MARKET_KEYS, GROUP_ORDER, MARKET_BY_KEY, PRESETS,
    expand_selection, locale_for, most_specific_place, resolve_market,
)
from wealthscan.queries import (  # noqa: E402
    DEPTHS, EVENT_TEMPLATES, build_search_matrix, google_news_url, place_blocks,
    plan_sweep,
)
from wealthscan.report import fmt_gbp, week_bounds  # noqa: E402
from wealthscan.scoring import (  # noqa: E402
    band_for, cohort_for, estimate_from_event, score_confidence,
)

UK = tuple(m.key for m in ALL_MARKETS if m.country == "United Kingdom")


class TestMarkets(unittest.TestCase):
    def test_resolves_market_and_town(self):
        for text, expected in [
            ("Exeter engineering firm sold", "Devon"),
            ("Truro hotelier expands", "Cornwall"),
            ("a Weybridge founder exits", "Surrey"),
            ("Canary Wharf fund manager", "Greater London"),
            ("Cirencester food group grows", "Gloucestershire"),
            ("Palo Alto software group acquired", "San Francisco Bay Area"),
            ("DIFC founder sells stake", "Dubai"),
            ("Riyadh family office launched", "Riyadh"),
            ("Zug commodities house sold", "Switzerland"),
        ]:
            match = resolve_market(text)
            self.assertIsNotNone(match, text)
            self.assertEqual(match.market_name, expected, text)
            self.assertEqual(match.source, "text")

    def test_unlocatable_text_is_none(self):
        """None, never a default. A wrong location puts a prospect in front of an
        advisor who has no business contacting them."""
        for text in ["a factory was sold", "revenue rose sharply", "", None]:
            self.assertIsNone(resolve_market(text), repr(text))

    def test_ambiguous_place_needs_corroboration(self):
        # "Bath" appears in far more articles about bathrooms than about Somerset.
        self.assertIsNone(resolve_market("luxury bath and shower fittings"))
        self.assertEqual(resolve_market("Bath, Somerset firm sold").market_name, "Somerset")

    def test_negative_phrases_are_stripped(self):
        # A Connecticut town called Bristol is not the English city.
        self.assertIsNone(resolve_market("Bristol Connecticut manufacturer sold"))
        self.assertIsNone(resolve_market("London Ontario firm expands"))

    def test_preference_beats_a_later_exact_match(self):
        """The market that found the article wins ties, or a Devon founder ends up
        filed in Manhattan because the buyer happened to be American."""
        text = "The Exeter firm was bought by a New York group"
        self.assertEqual(resolve_market(text, prefer="uk-devon").market_name, "Devon")
        # Without the preference the decisive exact-name match takes it.
        self.assertEqual(resolve_market(text).market_name, "New York")

    def test_most_specific_place_prefers_the_town(self):
        self.assertEqual(
            most_specific_place("Newton Abbot engineering group in Devon", "uk-devon"),
            "Newton Abbot",
        )
        # Only the market name present means there is no locality to add.
        self.assertIsNone(most_specific_place("a Devon business", "uk-devon"))

    def test_every_market_is_well_formed(self):
        self.assertEqual(len(CORE_MARKET_KEYS), 13, "the original patch is still a preset")
        for market in ALL_MARKETS:
            self.assertTrue(market.places, market.key)
            self.assertIn(market.group, GROUP_ORDER, market.key)
            self.assertTrue(market.country and market.currency, market.key)
            # Some markets carry an editorial label ("Home Counties", "Connecticut
            # & Tri-State"). Searching for the label finds nothing, so the first
            # place must be a real, searchable name.
            leading = market.places[0]
            self.assertTrue(leading and leading[0].isupper(), market.key)
            self.assertNotIn("&", leading, market.key)
            self.assertNotIn("(", leading, market.key)

    def test_presets_resolve_to_real_markets(self):
        for name, keys in PRESETS.items():
            self.assertTrue(keys, name)
            for key in keys:
                self.assertIn(key, MARKET_BY_KEY, f"{name} → {key}")

    def test_expand_selection_accepts_groups_and_presets(self):
        self.assertEqual(
            set(expand_selection(["United Kingdom"])),
            {m.key for m in ALL_MARKETS if m.group == "United Kingdom"},
        )
        self.assertEqual(
            set(expand_selection(["Everywhere"])), {m.key for m in ALL_MARKETS}
        )
        # Empty means everywhere, not nowhere.
        self.assertEqual(len(expand_selection(None)), len(ALL_MARKETS))

    def test_locale_follows_the_country(self):
        # gl decides which publishers Google surfaces at all.
        self.assertEqual(locale_for("uk-devon"), ("en-GB", "GB"))
        self.assertEqual(locale_for("us-texas"), ("en-US", "US"))
        self.assertEqual(locale_for("ae-dubai"), ("en-AE", "AE"))


class TestMoney(unittest.TestCase):
    def test_units(self):
        self.assertEqual(parse_money("sold for £40m"), 40_000_000)
        self.assertEqual(parse_money("a £1.2bn valuation"), 1_200_000_000)
        self.assertEqual(parse_money("nets £4.5 million"), 4_500_000)
        self.assertEqual(parse_money("£750k seed round"), 750_000)
        self.assertEqual(parse_money("worth £1,250,000"), 1_250_000)

    def test_converts_foreign_currency(self):
        for text in ("raises $30m", "sold for AED 300m", "a SAR 200m deal",
                     "₹1,400 crore stake sale"):
            value = parse_money(text)
            self.assertIsNotNone(value, text)
            self.assertGreater(value, 0, text)

        # A Gulf headline must not be read as though the figure were sterling.
        self.assertLess(parse_money("sold for AED 2.4bn"), 2_400_000_000)
        self.assertLess(parse_money("raises $30m"), 30_000_000)

    def test_trailing_currency_words(self):
        self.assertEqual(parse_money("a deal worth 40 million pounds"), 40_000_000)

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

    def test_subject_of_a_wealth_verb(self):
        """"Name has sold…" is the commonest headline shape and used to be missed
        entirely, which cost the app most of its yield."""
        people = extract_people("Gareth Halberton has sold the business he founded")
        self.assertEqual(people[0].name, "Gareth Halberton")

    def test_names_with_honorifics_and_particles(self):
        self.assertEqual(
            extract_people("Sheikh Faisal Al Marwan has agreed the sale")[0].name,
            "Faisal Al Marwan",
        )
        self.assertEqual(
            extract_people("Owner Matthias von Hallwyl has agreed the sale")[0].name,
            "Matthias von Hallwyl",
        )

    def test_acquired_by_is_not_a_person(self):
        # "acquired by" nearly always takes a company, and treating the acquirer
        # as an individual would fabricate a prospect.
        self.assertEqual(extract_people("acquired by German rival Schmidt AG"), [])

    def test_places_are_not_people(self):
        """Every market's place names are excluded, or "Palm Beach has sold" becomes
        a person with an estimated net worth."""
        self.assertEqual(extract_people("Palm Beach has sold the site"), [])
        self.assertEqual(extract_people("Hong Kong has raised its target"), [])

    def test_refuses_to_invent_people(self):
        for text in ["The Company Limited announced results",
                     "Business Live reports strong growth",
                     "founder Smith said",
                     "revenue rose sharply this year"]:
            self.assertEqual(extract_people(text), [], text)

    def test_title_case_headlines_do_not_produce_people(self):
        """Capitalised common nouns are the classic false positive: "US Firm Sold
        for £40m" must not become a prospect named US Firm with £17m to invest."""
        for text in ["US Firm Sold for £40m", "Devon Group Sells Stake",
                     "Family Office Launched in Dubai", "Tech Startup Raises $30m"]:
            self.assertEqual(extract_people(text), [], text)

    def test_job_titles_are_not_part_of_the_name(self):
        people = extract_people("Chief Executive Officer Anna Fairweather nets £12m")
        self.assertEqual(people[0].name, "Anna Fairweather")
        self.assertEqual(len(people), 1, "the same person must not appear twice")

    def test_names_with_apostrophes_and_accents(self):
        self.assertEqual(
            extract_people("Co-founder Declan O'Loughlin retains a stake")[0].name,
            "Declan O'Loughlin",
        )
        self.assertEqual(
            extract_people("Founder Céline Duforêt has sold her stake")[0].name,
            "Céline Duforêt",
        )
        self.assertEqual(
            extract_people("Founder Emre Yıldırım has sold shares")[0].name,
            "Emre Yıldırım",
        )

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
            query_market_key="uk-devon", allowed_markets=UK,
        )
        self.assertIsNotNone(event)
        self.assertEqual(event.market_name, "Devon")
        self.assertEqual(event.country, "United Kingdom")
        self.assertEqual(event.market_source, "text")
        self.assertEqual(event.locality, "Exeter")
        self.assertEqual(event.amount_gbp, 64_000_000)
        self.assertEqual(event.people[0].name, "Gareth Halberton")
        self.assertIn("Devon", event.rationale)

    def test_inherits_market_from_the_query(self):
        """The bug that limited the first version to a single result.

        A Devon search returns a perfect Devon story naming a person and a £64m
        exit; the 200-character snippet simply never repeats the word "Devon".
        Discarding that threw away nearly everything.
        """
        event = extract_event(
            title="Precision engineering group sold to German rival for £64m",
            summary="Chairman Gareth Halberton has sold the business he founded in 1999.",
            url="https://example.invalid/b", publisher="BusinessLive",
            published_at=None, query_event_key="acquisition",
            query_market_key="uk-devon", allowed_markets=UK,
        )
        self.assertIsNotNone(event, "an unlocated article must not be discarded")
        self.assertEqual(event.market_name, "Devon")
        # …but the inference has to be visible, not laundered into a fact.
        self.assertEqual(event.market_source, "query")
        self.assertIn("does not name the place", event.rationale)

    def test_rejects_articles_positively_about_another_market(self):
        """An inherited market is a guess about a silent article. An article that
        names somewhere else is not silent, and must be thrown away."""
        event = extract_event(
            title="Manchester firm sold for £20m",
            summary="The chief executive Alan Fothergill has sold the business.",
            url="u", publisher="p", published_at=None,
            query_event_key="acquisition",
            query_market_key="uk-devon", allowed_markets=CORE_MARKET_KEYS,
        )
        self.assertIsNone(event)

    def test_rejects_non_events(self):
        self.assertIsNone(extract_event(
            title="Exeter council opens a new library", summary="", url="u",
            publisher="p", published_at=None, query_market_key="uk-devon"))

    def test_rejects_when_nothing_locates_it(self):
        self.assertIsNone(extract_event(
            title="A company was sold for £20m", summary="", url="u",
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

    def test_inferred_location_costs_confidence(self):
        """Keeping an unlocated article is right. Scoring it as though the source
        named the place would be laundering an inference into a fact."""
        stated = score_confidence(
            publisher="BBC", has_named_person=True, amount_disclosed=True,
            source_count=1, event_weight=85, location_from_text=True,
        )
        inferred = score_confidence(
            publisher="BBC", has_named_person=True, amount_disclosed=True,
            source_count=1, event_weight=85, location_from_text=False,
        )
        self.assertGreater(stated.score, inferred.score)
        location = next(d for d in inferred.dimensions if d.key == "location")
        self.assertIn("inferred", location.explanation)

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
                                 estimate_is_none=True, location_from_text=False)
        self.assertLessEqual(best.score, 100)
        self.assertGreaterEqual(worst.score, 0)


class TestQueries(unittest.TestCase):
    def test_matrix_covers_every_market_and_event(self):
        matrix = build_search_matrix(market_keys=["uk-devon", "us-texas"], depth="standard")
        self.assertEqual({q.market_key for q in matrix}, {"uk-devon", "us-texas"})
        self.assertEqual({q.event_key for q in matrix}, {t.key for t in EVENT_TEMPLATES})

    def test_query_url_carries_the_market_locale(self):
        uk = google_news_url('"Devon" (acquired)', days=7, market_key="uk-devon")
        self.assertIn("news.google.com/rss/search", uk)
        self.assertIn("when%3A7d", uk)
        self.assertIn("gl=GB", uk)

        gulf = google_news_url('"Dubai" (acquired)', days=7, market_key="ae-dubai")
        self.assertIn("gl=AE", gulf)

    def test_towns_are_or_ed_rather_than_searched_separately(self):
        """Recall without a request per town — the whole reason a deep sweep is
        affordable at all."""
        blocks = place_blocks("uk-devon", places=6, block_size=7)
        self.assertEqual(len(blocks), 1)
        self.assertIn('"Devon"', blocks[0])
        self.assertIn(" OR ", blocks[0])
        self.assertIn('"Exeter"', blocks[0])

    def test_market_name_only_when_no_towns_requested(self):
        self.assertEqual(place_blocks("uk-devon", places=0, block_size=7), ['"Devon"'])

    def test_depth_changes_the_amount_of_work(self):
        counts = [
            len(build_search_matrix(market_keys=["uk-devon"], depth=d.key))
            for d in DEPTHS
        ]
        self.assertEqual(counts, sorted(counts), "depths must be monotonically heavier")
        self.assertLess(counts[0], counts[-1])

    def test_plan_is_honest_about_the_cost(self):
        plan = plan_sweep(market_keys=PRESETS["UK + US + Middle East"], depth="deep")
        self.assertGreater(plan.queries, 500, "a deep multi-market sweep is a big job")
        self.assertGreater(plan.seconds, 60)
        self.assertIn("minutes", plan.human_time)

    def test_can_narrow_the_matrix(self):
        matrix = build_search_matrix(
            market_keys=["uk-devon"], depth="quick", event_keys=["business_exit"]
        )
        self.assertEqual(len(matrix), 1)
        self.assertEqual(matrix[0].market_key, "uk-devon")
        self.assertEqual(matrix[0].event_key, "business_exit")


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


class TestPeopleFirst(unittest.TestCase):
    """The app exists to find people, not deals. These pin the difference."""

    def test_both_names_in_a_pair_are_found(self):
        """"Alice and Ruth have sold" is two prospects. Only the second sits next
        to the verb, so the first used to be dropped silently."""
        for text in [
            "Co-founders Alice Marchmont and Ruth Pelling have sold the business.",
            "The company was founded by Alice Marchmont and Ruth Pelling in 2009.",
        ]:
            names = [p.name for p in extract_people(text)]
            self.assertIn("Alice Marchmont", names, text)
            self.assertIn("Ruth Pelling", names, text)

    def test_co_principals_split_the_assumed_stake(self):
        """Storing every named person is right; giving each of them the whole
        founder stake would report the same £60m two or three times over."""
        solo = estimate_from_event(
            event_key="business_exit", amount_gbp=60_000_000,
            text="sold", has_named_person=True)
        pair = estimate_from_event(
            event_key="business_exit", amount_gbp=60_000_000,
            text="sold", has_named_person=True, co_principals=2)
        self.assertEqual(pair.gross_mid_gbp * 2, solo.gross_mid_gbp)
        self.assertTrue(any("split equally" in c for c in pair.caveats))
        self.assertFalse(any("split equally" in c for c in solo.caveats))

    def test_a_filed_stake_is_never_divided(self):
        """A PSC band is that person's actual shareholding, not a share of one."""
        alone = estimate_from_event(
            event_key="business_exit", amount_gbp=60_000_000, text="sold",
            has_named_person=True, known_stake_band="50–75%")
        among_three = estimate_from_event(
            event_key="business_exit", amount_gbp=60_000_000, text="sold",
            has_named_person=True, known_stake_band="50–75%", co_principals=3)
        self.assertEqual(alone.gross_mid_gbp, among_three.gross_mid_gbp)

    def test_unnamed_transactions_are_kept_as_a_worklist(self):
        """A £30m disposal with no name is not waste — the register knows whose
        it was. Discarding it threw away the best raw material the sweep has."""
        import tempfile
        from wealthscan import db

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "leads.db"
            db.init_db(path)
            with db.connect(path) as conn:
                self.assertTrue(db.record_company_lead(conn, {
                    "company": "Plymouth Robotics Ltd", "market_key": "uk-devon",
                    "market_name": "Devon", "country": "United Kingdom",
                    "amount_gbp": 30_000_000, "title": "Plymouth robotics firm sold",
                    "url": "https://example.invalid/a", "event_key": "acquisition",
                }))
                # The same article must not queue the same company twice.
                self.assertFalse(db.record_company_lead(conn, {
                    "company": "Plymouth Robotics Ltd", "title": "dup",
                    "url": "https://example.invalid/a",
                }))
                open_leads = db.company_leads(conn, unresolved_only=True)
                self.assertEqual(len(open_leads), 1)
                self.assertEqual(open_leads[0]["amount_gbp"], 30_000_000)

                db.resolve_company_lead(
                    conn, int(open_leads[0]["id"]),
                    note="2 principals found", people_found=2)
                self.assertEqual(len(db.company_leads(conn, unresolved_only=True)), 0)

    def test_filed_names_are_made_readable(self):
        """Companies House files "SMITH, John Andrew" in block capitals. Left as
        filed it sorts wrongly and never matches the press spelling."""
        from wealthscan.sources import _titlecase_filed_name
        self.assertEqual(_titlecase_filed_name("SMITH, John Andrew"), "John Andrew Smith")
        self.assertEqual(_titlecase_filed_name("O'BRIEN, Mary"), "Mary O'Brien")
        self.assertEqual(_titlecase_filed_name("SMITH-JONES, Peter"), "Peter Smith-Jones")


class TestScreening(unittest.TestCase):
    """What the book refuses to contain.

    These matter as much as the extraction tests. A prospecting list is judged by
    what it keeps out: every celebrity, every billionaire and every aggregator
    guess in it costs the advisor the time it takes to work out why it is useless.
    """

    def test_sport_and_entertainment_are_excluded(self):
        from wealthscan.exclusions import screen
        for text in [
            "Former Premier League footballer sells his Surrey property empire for £40m",
            "The actor, who starred in three Bond films, has sold his Dorset estate",
            "Chart-topping singer buys Cotswolds manor after album sales surge",
            "BBC presenter and broadcaster sells production company for £12m",
        ]:
            refusal = screen(text=text)
            self.assertIsNotNone(refusal, text)
            self.assertEqual(refusal.rule, "celebrity", text)

    def test_a_genuine_business_owner_is_not_excluded(self):
        """The screen must not eat the actual target. A manufacturer who sponsors
        a football club is still a manufacturer."""
        from wealthscan.exclusions import screen
        for text in [
            "Exeter engineering group acquired for £64m; chairman Gareth Halberton sold up",
            "Wiltshire estate sells 1,200 acres of farmland for £14.8m",
            "Bristol plc chief executive's total remuneration reaches £2.4m",
            "Cheltenham software founder sells her stake in an £88m secondary",
        ]:
            self.assertIsNone(screen(text=text), text)

    def test_aggregator_sources_are_refused_on_the_domain(self):
        """Refused for the source, not the content — an aggregator page can look
        like perfectly good evidence, which is exactly the problem."""
        from wealthscan.exclusions import screen
        refusal = screen(
            text="Gloucestershire haulage boss sold his stake in the Cheltenham firm",
            url="https://www.celebritynetworth.com/richest/desmond-wraycott/",
        )
        self.assertIsNotNone(refusal)
        self.assertEqual(refusal.rule, "banned-source")
        # Subdomains count as the same publisher.
        self.assertIsNotNone(screen(text="x", url="https://uk.celebritynetworth.com/a"))
        # A legitimate publisher on the same subject is untouched.
        self.assertIsNone(screen(
            text="Gloucestershire haulage boss sold his stake",
            url="https://www.insidermedia.com/news/south-west/haulage-sale",
        ))

    def test_mega_wealth_is_out_of_scope_at_the_top(self):
        from wealthscan.exclusions import screen, MEGA_WEALTH_CEILING_GBP
        refusal = screen(text="Industrialist sells up", gross_wealth_gbp=19_000_000_000)
        self.assertIsNotNone(refusal)
        self.assertEqual(refusal.rule, "mega-wealth")
        # The target band is untouched.
        self.assertIsNone(screen(text="Owner sells up", gross_wealth_gbp=12_000_000))
        self.assertIsNone(screen(
            text="Owner sells up", gross_wealth_gbp=MEGA_WEALTH_CEILING_GBP))

    def test_every_refusal_carries_a_reason(self):
        from wealthscan.exclusions import screen
        refusal = screen(text="Premier League footballer sells his business")
        self.assertTrue(len(refusal.reason) > 40, "a rule you cannot read is a bug")


class TestEvidenceGrading(unittest.TestCase):
    """Confidence tied to how *direct* the source is, per the research brief."""

    def test_grades_follow_source_directness(self):
        from wealthscan.evidence import classify_source
        cases = [
            ("https://find-and-update.company-information.service.gov.uk/company/07890123",
             "Companies House", "High"),
            ("https://www.londonstockexchange.com/news-article/RNS", "RNS", "High"),
            ("https://www.gov.uk/search-property-information-land-registry",
             "Land Registry", "High"),
            ("https://www.insidermedia.com/news/south-west/deal", "Insider Media", "Medium"),
            ("https://example.invalid/rich-list-2026", "Sunday Times Rich List", "Low"),
        ]
        for url, publisher, expected in cases:
            tier = classify_source(url=url, publisher=publisher)
            self.assertEqual(tier.grade, expected, f"{publisher} → {tier.label}")

    def test_the_strongest_source_sets_the_grade(self):
        """One filing beats any amount of commentary."""
        from wealthscan.evidence import grade_record
        grade, why = grade_record([
            {"url": "https://example.invalid/x", "publisher": "Sunday Times Rich List",
             "title": "Rich list 2026"},
            {"url": "https://find-and-update.company-information.service.gov.uk/company/1",
             "publisher": "Companies House", "title": "PSC register"},
        ])
        self.assertEqual(grade, "High")
        self.assertIn("companies house", why.lower())

    def test_no_sources_is_low_not_high(self):
        from wealthscan.evidence import grade_record
        self.assertEqual(grade_record([])[0], "Low")


class TestIncomeRoute(unittest.TestCase):
    """£1m+/year qualifies independently of assets — a different person, found a
    different way, and reachable years before any exit."""

    def test_disclosed_executive_pay_is_income_not_net_worth(self):
        estimate = estimate_from_event(
            event_key="exec_comp", amount_gbp=2_400_000,
            text="total remuneration of £2.4m", has_named_person=True,
        )
        self.assertEqual(estimate.annual_income_gbp, 2_400_000)
        self.assertIsNone(estimate.investable_mid_gbp,
                          "pay does not evidence accumulated capital")
        self.assertIn("Stated, not modelled", estimate.annual_income_basis)

    def test_dividend_produces_an_attributable_income(self):
        estimate = estimate_from_event(
            event_key="large_dividend", amount_gbp=4_050_000,
            text="record dividend", has_named_person=True,
        )
        self.assertIsNotNone(estimate.annual_income_gbp)
        self.assertLess(estimate.annual_income_gbp, 4_050_000, "only their share")
        self.assertIn("assumed", estimate.annual_income_basis)

    def test_income_qualifies_without_assets(self):
        self.assertEqual(cohort_for(None, None, 2_400_000), "High income")
        self.assertEqual(cohort_for(None, None, 400_000), "Below threshold")
        # Assets still win where both apply.
        self.assertEqual(cohort_for(20_000_000, 40_000_000, 2_400_000), "Qualifying")

    def test_land_events_are_split_by_whether_money_moved(self):
        sale = estimate_from_event(
            event_key="land_sale", amount_gbp=14_800_000,
            text="1,200 acres sold", has_named_person=True)
        holding = estimate_from_event(
            event_key="landholding", amount_gbp=None,
            text="3,400-acre tenanted estate", has_named_person=True)
        self.assertIsNotNone(sale.investable_mid_gbp, "a land sale is realised cash")
        self.assertTrue(sale.is_realised)
        self.assertIsNone(holding.investable_mid_gbp, "owning land is not selling it")
        self.assertIsNotNone(holding.not_estimated_reason)


class TestStorage(unittest.TestCase):
    """The database has to survive the move from counties to markets with the
    records intact, because a user's book is the one thing here that is theirs."""

    def _legacy_database(self, path: Path) -> None:
        import sqlite3
        conn = sqlite3.connect(path, isolation_level=None)
        conn.executescript(
            """
            CREATE TABLE prospects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT UNIQUE NOT NULL,
                full_name TEXT NOT NULL,
                job_title TEXT,
                company TEXT,
                region TEXT NOT NULL,
                matched_place TEXT,
                investable_mid_gbp INTEGER,
                wealth_band TEXT NOT NULL DEFAULT 'Not estimated',
                cohort TEXT NOT NULL DEFAULT 'Research lead',
                confidence INTEGER NOT NULL DEFAULT 0,
                confidence_band TEXT NOT NULL DEFAULT 'Low',
                status TEXT NOT NULL DEFAULT 'New',
                relationship_stage TEXT NOT NULL DEFAULT 'Unaware',
                notes TEXT,
                first_seen TEXT NOT NULL,
                last_updated TEXT NOT NULL,
                first_seen_week TEXT NOT NULL,
                suppressed_at TEXT,
                suppression_reason TEXT
            );
            CREATE INDEX idx_prospects_region ON prospects(region);
            CREATE TABLE sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prospect_id INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
                url TEXT NOT NULL, title TEXT NOT NULL, retrieved_at TEXT NOT NULL,
                UNIQUE (prospect_id, url)
            );
            INSERT INTO prospects
              (slug, full_name, region, matched_place, investable_mid_gbp, notes,
               first_seen, last_updated, first_seen_week)
            VALUES
              ('a-devon', 'A Person', 'Devon', 'Exeter', 12000000, 'called back Tuesday',
               '2026-01-01T00:00:00', '2026-01-01T00:00:00', '2026-W01');
            INSERT INTO sources (prospect_id, url, title, retrieved_at)
            VALUES (1, 'https://example.invalid/x', 'A headline', '2026-01-01T00:00:00');
            """
        )
        conn.close()

    def test_legacy_region_database_is_migrated(self):
        import tempfile
        from wealthscan import db

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "legacy.db"
            self._legacy_database(path)
            db.init_db(path)

            with db.connect(path) as conn:
                row = conn.execute("SELECT * FROM prospects").fetchone()
                self.assertEqual(row["market_key"], "uk-devon")
                self.assertEqual(row["market_name"], "Devon")
                self.assertEqual(row["country"], "United Kingdom")
                self.assertEqual(row["investable_mid_gbp"], 12_000_000)
                self.assertEqual(row["notes"], "called back Tuesday",
                                 "the advisor's own notes must survive")
                # The citations must survive too: dropping the parent table with
                # foreign keys on would have cascaded them away.
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) AS n FROM sources").fetchone()["n"], 1
                )
                self.assertIsNotNone(conn.execute(
                    "SELECT name FROM sqlite_master WHERE name = 'idx_prospects_market'"
                ).fetchone())

            # Idempotent: running it again must not duplicate or destroy anything.
            db.init_db(path)
            with db.connect(path) as conn:
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) AS n FROM prospects").fetchone()["n"], 1
                )

    def test_suppression_hides_a_record_without_deleting_it(self):
        import tempfile
        from wealthscan import db

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "book.db"
            db.init_db(path)
            with db.connect(path) as conn:
                prospect_id, created = db.upsert_prospect(conn, {
                    "slug": "x", "full_name": "A Person", "market_key": "uk-devon",
                    "market_name": "Devon", "country": "United Kingdom",
                    "first_seen": db.now_iso(), "last_updated": db.now_iso(),
                    "first_seen_week": db.iso_week(),
                })
                self.assertTrue(created)
                db.suppress_prospect(conn, prospect_id, "objected by email")
                self.assertEqual(len(db.all_prospects(conn)), 0)
                self.assertEqual(len(db.all_prospects(conn, include_suppressed=True)), 1)

                # A later sweep must not resurrect the estimate.
                db.upsert_prospect(conn, {
                    "slug": "x", "full_name": "A Person", "market_key": "uk-devon",
                    "market_name": "Devon", "country": "United Kingdom",
                    "investable_mid_gbp": 99_000_000, "confidence": 90,
                    "first_seen": db.now_iso(), "last_updated": db.now_iso(),
                    "first_seen_week": db.iso_week(),
                })
                row = db.prospect(conn, prospect_id)
                self.assertIsNone(row["investable_mid_gbp"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
