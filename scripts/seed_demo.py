#!/usr/bin/env python3
"""Load a demonstration dataset.

    python scripts/seed_demo.py

IMPORTANT: every person, company and article below is FICTIONAL. This app builds
profiles of identifiable living people when it runs for real, so demonstration
data must never contain unverified claims about actual individuals.

The records are produced by running the *real* extraction, estimation and
confidence code over invented articles, so what you see is exactly what the
pipeline does on live news — not hand-written numbers. That is the point of it:
if the estimate looks wrong here, the estimate is wrong there too.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import json  # noqa: E402

from wealthscan import db  # noqa: E402
from wealthscan.exclusions import screen  # noqa: E402
from wealthscan.extract import extract_event  # noqa: E402
from wealthscan.report import generate_and_store  # noqa: E402
from wealthscan.research import _store_event  # noqa: E402
from wealthscan.scoring import cohort_for, estimate_from_event, score_confidence  # noqa: E402
from wealthscan.sources import Fetcher  # noqa: E402

NOW = datetime.now(timezone.utc)


def days_ago(n: int) -> datetime:
    return NOW - timedelta(days=n)


# (title, summary, publisher, days_ago, query_event_key, query_market_key)
Article = tuple[str, str, str, int, str | None, str | None]

ARTICLES: list[Article] = [
    # ---------------------------------------------------------------- United Kingdom
    (
        "Exeter engineering group Halberton Precision Ltd acquired by German rival for £64m",
        "Chairman Gareth Halberton has sold the business he founded in 1999. The Devon "
        "manufacturer employs 380 people at its Marsh Barton site. Corporate finance "
        "advice was provided by Ashfords Corporate Finance. Legal advice from Osborne "
        "Clarke LLP.",
        "BusinessLive South West", 2, "acquisition", "uk-devon",
    ),
    (
        "Marlborough Clinical Holdings Ltd sold to Ardenhall for £210m",
        "Founder Alastair Wren completes sale of the Wiltshire diagnostics group after "
        "fourteen years. PKF Francis Clark advised the shareholders, with tax advice "
        "from Grant Thornton.",
        "Insider Media South West", 4, "business_exit", "uk-wiltshire",
    ),
    (
        "Shoreditch Creative Holdings Ltd: founder nets £96m as Havas Lane takes majority",
        "Nathaniel Osei, founder of the London agency group, has sold his stake in a deal "
        "completed this month.",
        "The Times", 5, "business_exit", "uk-london",
    ),
    (
        "Reading fintech Thameside Payments Ltd raises £62m Series C",
        "Co-founder and CEO Yusuf Karadag said the Berkshire company would use the round "
        "to expand into Europe. Northgate Capital led the investment round.",
        "UKTN", 3, "venture_funding", "uk-berkshire",
    ),
    (
        "Oxford biotech Wytham Bio Ltd secures £54m Series B",
        "Chief Scientific Officer Eleanor Wytham co-founded the Oxfordshire company in 2020. "
        "The funding round was co-led by Wellcome Growth.",
        "UKTN", 6, "venture_funding", "uk-oxfordshire",
    ),
    (
        "Falmouth marine group declares £4.05m dividend to shareholders",
        "Trevanning Marine Systems Ltd, the Cornwall boatbuilder led by founder Imogen "
        "Trevanning, reported a record year. The director dividend is its largest to date.",
        "BusinessLive South West", 8, "large_dividend", "uk-cornwall",
    ),
    (
        "Sandbanks developer buys Dorset waterfront estate",
        "Marianne Delacroix, director of Sandbanks Property Partners Ltd, has acquired the "
        "site for an undisclosed sum.",
        "The Business Magazine", 9, "property", "uk-dorset",
    ),
    (
        "Guildford diagnostics chief steps down after twelve years",
        "Anita Rajaram, chief executive of the Surrey group, will hand over in the autumn as "
        "part of a planned succession.",
        "Insider Media South East", 11, "succession", "uk-surrey",
    ),
    (
        "Wiltshire family investment company registered by Marlborough entrepreneur",
        "A new family office has been established by Alastair Wren following the sale of his "
        "clinical diagnostics group.",
        "Insider Media South West", 1, "family_office", "uk-wiltshire",
    ),
    (
        "Somerset renewables group Quantock Renewables Group Ltd backed by private equity",
        "Meridian Growth Partners has taken a minority stake in the Taunton company valued at "
        "£118m. Founder Priya Nadkarni retains control.",
        "Insider Media South West", 12, "private_equity", "uk-somerset",
    ),
    (
        "Hampshire chip designer Solent Semiconductor Ltd eyes £280m AIM listing",
        "Founder Rowan Fitzhugh has appointed brokers ahead of a possible flotation on the "
        "London market.",
        "UKTN", 7, "ipo", "uk-hampshire",
    ),
    (
        "Bristol logistics group reports record profits",
        "Avonmouth Logistics Holdings Ltd saw turnover rise to £128m. Managing director "
        "Duncan Avonmouth said the year had been the strongest in the company's history.",
        "BusinessLive South West", 14, "company_growth", "uk-bristol",
    ),
    (
        "West Sussex chemicals firm sold in management buyout",
        "Horsham Speciality Chemicals Ltd has been acquired by its management team for £41m. "
        "Chief executive Beatrice Haldane led the buyout.",
        "Insider Media South East", 10, "management_buyout", "uk-west-sussex",
    ),
    (
        "Gloucestershire food group turnover climbs",
        "Cotswold Provisions Group Ltd, based in Cirencester, grew sales again this year.",
        "BusinessLive South West", 16, "company_growth", "uk-gloucestershire",
    ),
    (
        "Cheltenham software founder sells stake in £88m secondary",
        "Rhiannon Talgarth, founder of Regency Data Systems Ltd, has sold her stake to "
        "Broadwell Capital. She founded the Gloucestershire company in 2011.",
        "Insider Media South West", 5, "business_exit", "uk-gloucestershire",
    ),
    (
        "Knutsford medical devices group acquired by US buyer for £147m",
        "Owner Stephen Ashbourne has agreed the sale of Ashbourne Medical Holdings Ltd to a "
        "Boston-listed group. The Cheshire business employs 210 people.",
        "BusinessLive National", 6, "acquisition", "uk-north-west",
    ),
    (
        "Edinburgh asset manager floats on London market at £430m",
        "Co-founder Fiona Lamond will retain a substantial holding after the listing of "
        "Lamond Capital Partners.",
        "Sky News Business", 13, "ipo", "uk-scotland",
    ),
    (
        "Cambridge AI group Girton Intelligence Ltd raises £71m Series B",
        "Chief executive Devraj Chandran said the round values the company at close to £400m. "
        "The Cambridgeshire business was founded in 2019.",
        "UKTN", 4, "venture_funding", "uk-east-anglia",
    ),
    # ---------------------------------------------------------------- United States
    (
        "Palo Alto software group Alderwood Systems Inc acquired for $840m",
        "Co-founder and chief executive Marisol Vantrease has agreed the sale of the Bay Area "
        "company to a strategic buyer. She founded the business in 2014.",
        "TechCrunch", 3, "acquisition", "us-bay-area",
    ),
    (
        "Greenwich hedge fund founder sells minority stake for $340m",
        "Connecticut-based Ellsworth Ridge Capital has sold a stake to a sovereign investor. "
        "Founder Charles Ellsworth retains control.",
        "Axios Pro Rata", 8, "private_equity", "us-connecticut",
    ),
    (
        "Austin logistics group Brazos Freight Holdings LLC sold for $360m",
        "Chairman Tobias Marchetti has sold the business he started in 2006. The Texas "
        "company operates 40 terminals.",
        "Reuters Deals", 5, "business_exit", "us-texas",
    ),
    (
        "Miami healthcare founder nets $220m as Biscayne Health Group Inc is acquired",
        "Founder Elena Castellanos-Ruiz has sold her stake to a national operator. The Florida "
        "business was founded in 2010.",
        "Reuters Deals", 6, "business_exit", "us-florida",
    ),
    (
        "Manhattan family office launched by former private equity partner",
        "A single family office has been established by Jonathan Reisberg following his "
        "departure from a New York buyout firm.",
        "Family Capital", 2, "family_office", "us-nyc",
    ),
    (
        "Scottsdale construction group sold in $190m management buyout",
        "Chief executive Marguerite Delano led the buyout of Paradise Valley Building Group "
        "Inc from its founding family in Arizona.",
        "Axios Pro Rata", 12, "management_buyout", "us-arizona-nevada",
    ),
    (
        "Boston biotech Wellesley Therapeutics Inc raises $310m Series C",
        "Chief scientific officer Anneke Vandermolen co-founded the Massachusetts company in "
        "2018. The round was led by a crossover investor.",
        "TechCrunch", 9, "venture_funding", "us-boston",
    ),
    (
        "Seattle cloud group founder sells shares worth $64m",
        "Bellevue-based Rainier Cloud Systems Inc disclosed the share sale in a filing. "
        "Founder Peter Okonkwo remains chairman.",
        "Reuters Deals", 7, "share_sale", "us-seattle",
    ),
    (
        "Aspen resort group acquired for $275m",
        "Owner Whitney Calderwood has agreed the sale of Roaring Fork Hospitality LLC. The "
        "Colorado business owns four properties.",
        "Reuters Deals", 15, "acquisition", "us-denver",
    ),
    (
        "Atlanta payments group Peachtree Settlement Inc files for $520m IPO",
        "Founder Darnell Whitcombe will retain a significant stake after the Georgia "
        "company's initial public offering.",
        "Axios Pro Rata", 11, "ipo", "us-atlanta",
    ),
    (
        "Chicago industrials family sells manufacturer for $410m",
        "Winnetka-based Lakeshore Industrial Holdings Inc has been acquired by a European "
        "group. Chairman Gordon Rasmussen led the sale.",
        "Reuters Deals", 10, "business_exit", "us-chicago",
    ),
    (
        "Beverly Hills media group founder pockets $130m in secondary sale",
        "Sienna Marchbanks, founder of the Los Angeles studio group, has reduced her stake.",
        "Reuters Deals", 4, "share_sale", "us-la",
    ),
    (
        "McLean defence software group acquired for $600m",
        "Virginia-based Potomac Signals Inc has been bought by a listed prime contractor. "
        "Chief executive Harold Bramwell founded the company in 2009.",
        "Reuters Deals", 14, "acquisition", "us-dc",
    ),
    # ---------------------------------------------------------------- Middle East
    (
        "Dubai logistics group Jebel Freight PJSC sold for AED 2.4bn",
        "Founder Sheikh Faisal Al Marwan has agreed the sale of the DIFC-headquartered "
        "business to a regional investor.",
        "Arabian Business", 3, "business_exit", "ae-dubai",
    ),
    (
        "Abu Dhabi family office established by industrial group founder",
        "A family investment company has been set up by Hamda Al Suwaidi following a partial "
        "sale of her manufacturing interests.",
        "The National Business", 6, "family_office", "ae-abu-dhabi",
    ),
    (
        "Riyadh healthcare group raises SAR 1.1bn from sovereign wealth fund",
        "Chief executive Nawaf Al Qahtani said the growth capital would fund expansion. The "
        "Saudi company was founded in 2015.",
        "Zawya Deals", 5, "private_equity", "sa-riyadh",
    ),
    (
        "Jeddah contracting group founder nets SAR 780m as stake is sold",
        "Owner Majid Bin Rashid Al Harbi has sold his shareholding in the Western Province "
        "business to a Gulf buyer.",
        "Zawya Deals", 9, "business_exit", "sa-jeddah",
    ),
    (
        "Doha technology group lists on the Qatar exchange at QAR 3.2bn",
        "Founder Abdulaziz Al Thani will retain a majority holding after the flotation of the "
        "Lusail-based company.",
        "Gulf Business", 11, "ipo", "qa-doha",
    ),
    (
        "Dubai property developer Emirates Hills Holdings buys AED 900m portfolio",
        "Chairman Rashid Al Falasi confirmed the acquisition of the residential portfolio.",
        "Arabian Business", 7, "property", "ae-dubai",
    ),
    (
        "Kuwait investment house founder sells stake for KWD 96m",
        "Salmiya-based Al Sabahiya Investment Company has been partially acquired. Founder "
        "Yousef Al Ansari remains a director.",
        "Zawya Deals", 13, "business_exit", "kw-kuwait",
    ),
    (
        "Manama fintech secures BHD 42m growth round",
        "Chief executive Layla Al Khalifa said the Bahrain company would expand across the "
        "Gulf. The round was led by a regional fund.",
        "Gulf Business", 15, "venture_funding", "bh-bahrain",
    ),
    (
        "Muscat energy services group sold in OMR 68m management buyout",
        "Managing director Saif Al Balushi led the buyout of the Oman business from its "
        "founding shareholders.",
        "Zawya Deals", 12, "management_buyout", "om-oman",
    ),
    (
        "Istanbul consumer group founder reduces stake in $210m placing",
        "Founder Emre Yıldırım has sold shares in the Türkiye-listed retailer.",
        "Reuters Deals", 8, "share_sale", "tr-istanbul",
    ),
    # ---------------------------------------------------------------- Europe
    (
        "Zug commodities group founder sells business for CHF 640m",
        "Owner Matthias von Hallwyl has agreed the sale of the Switzerland-based trading "
        "house to a private equity buyer.",
        "Private Equity Wire", 5, "business_exit", "ch-zurich",
    ),
    (
        "Monaco yachting group acquired for €220m",
        "Founder Céline Duforêt has sold her stake in the Monte Carlo brokerage.",
        "Private Equity Wire", 10, "business_exit", "mc-monaco",
    ),
    (
        "Munich industrial software group raises €180m Series C",
        "Chief executive Konrad Wesselmann co-founded the Germany-based company in 2016.",
        "TechCrunch", 6, "venture_funding", "de-germany",
    ),
    (
        "Milan fashion group founder nets €340m as Italy business is sold",
        "Founder Alessandra Beneventi has completed the sale of her Milan-based label.",
        "Reuters Deals", 12, "business_exit", "it-italy",
    ),
    (
        "Dublin payments group Liffey Settlement Ltd floats at €1.1bn",
        "Co-founder Declan O'Loughlin retains a stake after the Ireland company's listing.",
        "Reuters Deals", 9, "ipo", "ie-ireland",
    ),
    (
        "Stockholm gaming founder sells shares worth SEK 900m",
        "Founder Annika Lindqvist has reduced her holding in the Sweden-listed studio.",
        "Reuters Deals", 14, "share_sale", "nordics",
    ),
    # ---------------------------------------------------------------- Asia-Pacific
    (
        "Singapore logistics group founder sells stake for SGD 480m",
        "Owner Terence Chua-Lim has agreed the disposal of his shareholding in the "
        "Singapore-based operator.",
        "Reuters Deals", 7, "business_exit", "sg-singapore",
    ),
    (
        "Hong Kong asset manager acquired for HKD 3.6bn",
        "Founder Winston Cheung-Lai has sold the business he established in 2003.",
        "Reuters Deals", 11, "acquisition", "hk-hong-kong",
    ),
    (
        "Sydney healthcare group raises AUD 260m growth round",
        "Chief executive Harriet Blackwood said the Australia business would expand into Asia.",
        "Reuters Deals", 13, "venture_funding", "au-australia",
    ),
    (
        "Mumbai speciality chemicals founder nets ₹1,400 crore in India stake sale",
        "Founder Rohan Deshmukh has sold his shareholding to a strategic investor.",
        "Reuters Deals", 8, "business_exit", "in-india",
    ),
    # ------------------------- Land, estate and listed-company pay -------------
    # The two sources a news-driven tool would otherwise never surface.
    (
        "Wiltshire estate sells 1,200 acres of farmland for £14.8m",
        "The Chalke Valley land has been sold by owner Hugh Fanshawe-Barrow, whose "
        "family have farmed near Salisbury since the 1920s.",
        "Insider Media South West", 5, "land_sale", "uk-wiltshire",
    ),
    (
        "Dorset landowner puts tenanted estate into a family partnership",
        "Landowner Verity Crabbe has restructured the 3,400-acre estate near Blandford "
        "ahead of a generational handover. No figures were disclosed.",
        "The Business Magazine", 9, "landholding", "uk-dorset",
    ),
    (
        "Bristol plc chief executive's pay package reaches £2.4m",
        "The remuneration report shows chief executive Fenella Rooksby received a "
        "£640,000 salary, an annual bonus and long-term incentive awards. Avon Gorge "
        "Utilities PLC also disclosed her director shareholding.",
        "Insider Media South West", 3, "exec_comp", "uk-bristol",
    ),
    # ------------------------------------------------------- Deliberate non-prospects
    # A real transaction with no individual named. The pipeline must record it as a
    # company lead, not invent a person.
    (
        "Plymouth robotics company acquired for £30m",
        "The Devon business has been bought by an international group. Terms were disclosed "
        "but no individual shareholders were named.",
        "BusinessLive South West", 6, "acquisition", "uk-devon",
    ),
    # Positively about a market outside any sensible selection, found by a UK query.
    # Must be rejected rather than filed under the county that surfaced it.
    (
        "Wellington council approves new library",
        "The New Zealand city has agreed funding for the building.",
        "BusinessLive National", 3, "acquisition", "uk-somerset",
    ),
    # Two names, one prospect. The founder sold; the private equity partner
    # bought and was quoted. Extracting both is what makes a list feel random.
    (
        "Taunton renewables group Quantock Energy Ltd sold to Meridian for £73m",
        "Founder Priya Nadkarni has sold her stake in the Somerset business. Partner "
        "at Meridian Capital James Fowler said the company had strong fundamentals.",
        "Insider Media South West", 3, "business_exit", "uk-somerset",
    ),
    # A genuine £40m transaction attached to a genuine named person — and still
    # not a prospect, because sport and entertainment wealth is not a realistic
    # introduction. The screening must catch this, not the advisor.
    (
        "Former Premier League footballer sells Surrey property empire for £40m",
        "Striker Callum Aldridge-Vane, who signed for Chelsea FC in 2011, has sold "
        "the business he built after retiring from the game.",
        "Sky News Business", 4, "business_exit", "uk-surrey",
    ),
]

#: URLs override the demo's placeholder host, to exercise the banned-source rule.
SOURCE_URL_OVERRIDES: dict[int, str] = {}


def _register_banned_source_example() -> int:
    """Add one article whose *source* is disqualifying, whatever it says.

    An aggregator "net worth" page can look like perfectly good evidence — a
    name, a county, a figure. Refusing it on the domain rather than the content
    is the only rule that holds.
    """
    ARTICLES.append((
        "Gloucestershire haulage boss net worth revealed at £22 million",
        "Owner Desmond Wraycott has sold his stake in the Cheltenham firm, "
        "according to estimates.",
        "Celebrity Net Worth", 6, "business_exit", "uk-gloucestershire",
    ))
    index = len(ARTICLES) - 1
    SOURCE_URL_OVERRIDES[index] = (
        "https://www.celebritynetworth.com/richest-businessmen/desmond-wraycott-net-worth/"
    )
    return index


_register_banned_source_example()


def verify_demo_record(
    *, name: str, company_number: str, company_name: str, officer_name: str,
    ownership_band: str, registered_office: str, amount_gbp: int, publisher: str,
) -> None:
    """Apply a Companies House verification the way a real run would.

    The estimate is *recomputed* from the filed band rather than patched —
    otherwise the record would claim the stake is confirmed while still showing a
    figure derived from the assumption, and its caveats would contradict its own
    header.
    """
    estimate = estimate_from_event(
        event_key="business_exit",
        amount_gbp=amount_gbp,
        text="sold the business",
        has_named_person=True,
        known_stake_band=ownership_band,
    )
    confidence = score_confidence(
        publisher=publisher, has_named_person=True, amount_disclosed=True,
        source_count=1, event_weight=95,
        stake_verified=True, companies_house_verified=True,
    )

    with db.connect() as conn:
        row = conn.execute(
            "SELECT id FROM prospects WHERE full_name = ?", (name,)
        ).fetchone()
        if not row:
            return
        conn.execute(
            """UPDATE prospects SET
                   ch_company_number = ?, ch_company_name = ?, ch_officer_name = ?,
                   ch_ownership_band = ?, ch_registered_office = ?, ch_profile_url = ?,
                   ch_verified_at = ?, address = ?,
                   verification_state = 'Confirmed', legitimacy_score = 100,
                   sector = 'Manufacturing & engineering', sector_basis = 'filed',
                   sector_detail = 'From the company''s filed SIC code 25620.',
                   sic_codes = '["25620"]',
                   gross_low_gbp = ?, gross_mid_gbp = ?, gross_high_gbp = ?,
                   investable_low_gbp = ?, investable_mid_gbp = ?, investable_high_gbp = ?,
                   wealth_band = ?, cohort = ?, estimate_method = ?, estimate_caveats = ?,
                   confidence = ?, confidence_band = ?, confidence_detail = ?,
                   next_action = ?, last_updated = ?
               WHERE id = ?""",
            (
                company_number, company_name, officer_name, ownership_band,
                registered_office,
                f"https://find-and-update.company-information.service.gov.uk/company/{company_number}",
                db.now_iso(), registered_office,
                estimate.gross_low_gbp, estimate.gross_mid_gbp, estimate.gross_high_gbp,
                estimate.investable_low_gbp, estimate.investable_mid_gbp,
                estimate.investable_high_gbp,
                estimate.band,
                cohort_for(estimate.investable_mid_gbp, estimate.gross_mid_gbp),
                estimate.method, json.dumps(estimate.caveats),
                confidence.score, confidence.band,
                json.dumps([
                    {"label": d.label, "score": d.score, "weight": d.weight, "why": d.explanation}
                    for d in confidence.dimensions
                ]),
                confidence.next_action, db.now_iso(), row["id"],
            ),
        )
        db.add_event(
            conn, int(row["id"]), "verified",
            f"Shareholding confirmed on the Companies House PSC register: "
            f"{ownership_band} of {company_name}. The estimate has been re-derived "
            f"from the filed band.",
            f"https://find-and-update.company-information.service.gov.uk/company/{company_number}",
        )


def main() -> int:
    db.init_db()
    fetcher = Fetcher(delay=0.0)  # nothing is fetched; the articles are inline

    created = updated = leads = skipped = excluded = 0
    # The markets a real sweep would have had selected. Passing it exercises the
    # out-of-scope guard, so the New Zealand story below is rejected rather than
    # filed under the county whose query surfaced it.
    selected = tuple(sorted({key for *_, key in ARTICLES if key}))

    for index, (title, summary, publisher, ago, event_key, market_key) in enumerate(ARTICLES):
        event = extract_event(
            title=title,
            summary=summary,
            url=SOURCE_URL_OVERRIDES.get(index, f"https://example.invalid/demo/{index}"),
            publisher=publisher,
            published_at=days_ago(ago),
            query_event_key=event_key,
            query_market_key=market_key,
            allowed_markets=selected,
        )
        if event is None:
            skipped += 1
            print(f"  · rejected (no market or no wealth event): {title[:58]}")
            continue

        refusal = screen(
            text=f"{event.title} {event.summary}",
            person_name=event.people[0].name if event.people else None,
            job_title=event.people[0].title if event.people else None,
            url=event.url,
        )
        if refusal is not None:
            excluded += 1
            with db.connect() as conn:
                db.record_exclusion(conn, {
                    "rule": refusal.rule, "reason": refusal.reason,
                    "person_name": event.people[0].name if event.people else None,
                    "company": event.company, "title": event.title,
                    "url": event.url, "publisher": event.publisher,
                })
            print(f"  ✕ excluded ({refusal.rule}): {title[:52]}")
            continue

        outcome = _store_event(event, fetcher=fetcher, verify_ch=False)
        kind = outcome["kind"]
        if kind == "new":
            created += 1
            print(f"  + {str(outcome['name'])[:24]:24} {event.market_name[:20]:20} "
                  f"{event.event_label}")
        elif kind == "updated":
            updated += 1
            print(f"  ~ {str(outcome['name'])[:24]:24} corroborated with {event.event_label}")
        else:
            leads += 1
            print(f"  · company-level lead only (no individual named): {title[:44]}")

    # One record verified against Companies House, so the difference between an
    # assumed stake and a filed one is visible in the UI.
    verify_demo_record(
        name="Gareth Halberton",
        company_number="07890123",
        company_name="HALBERTON PRECISION ENGINEERING LIMITED",
        officer_name="HALBERTON, Gareth John",
        ownership_band="50–75%",
        registered_office="Unit 14, Marsh Barton Trading Estate, Exeter, Devon, EX2 8QW",
        amount_gbp=64_000_000,
        publisher="BusinessLive South West",
    )

    with db.connect() as conn:
        run_id = db.start_run(conn, "demo-seed", depth="deep",
                             markets=sorted({a[5] for a in ARTICLES if a[5]}),
                             queries_planned=len(ARTICLES))
        db.finish_run(
            conn, run_id, status="success", queries_run=len(ARTICLES),
            articles_seen=len(ARTICLES), events_kept=created + updated,
            new_prospects=created, updated_prospects=updated, company_leads=leads,
            warnings=[], log=[f"Demonstration dataset — {created} fictional prospects"],
        )

    payload, _ = generate_and_store()

    print()
    print(f"Created {created} prospects, corroborated {updated}, "
          f"{leads} company-level lead(s), {skipped} rejected, {excluded} excluded by screening.")
    print(f"Research document written for {payload['week']}.")
    print()
    print("Every person and company in this dataset is FICTIONAL.")
    print("Start the dashboard with:  streamlit run streamlit_app.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
