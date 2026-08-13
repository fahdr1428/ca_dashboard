"""Markets: where to look for prospects.

Replaces the original 13-UK-county model. A market is any geography worth
searching as a unit — a English county, a US state or metro, a Gulf emirate, a
European financial centre. Each carries the place names that identify it in text,
its currency, and a coordinate so it can be mapped.

Markets are grouped so a non-technical user can pick "United Kingdom" or
"Middle East" as a whole rather than ticking sixty boxes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Market:
    key: str
    name: str
    group: str
    country: str
    currency: str
    lat: float
    lon: float
    #: Place names that identify this market in article text, and that get used
    #: verbatim in search queries.
    places: tuple[str, ...] = ()
    #: True for the advisor's original core patch, so it can be preselected.
    core: bool = False


GROUP_UK = "United Kingdom"
GROUP_US = "United States"
GROUP_ME = "Middle East"
GROUP_EU = "Europe"
GROUP_APAC = "Asia-Pacific"
GROUP_OTHER = "Rest of world"

GROUP_ORDER = (GROUP_UK, GROUP_US, GROUP_ME, GROUP_EU, GROUP_APAC, GROUP_OTHER)


def _m(key, name, group, country, currency, lat, lon, places, core=False) -> Market:
    return Market(key, name, group, country, currency, lat, lon, tuple(places), core)


# ---------------------------------------------------------------------------
# United Kingdom — the original 13 counties first, then the rest of the UK
# ---------------------------------------------------------------------------

_UK: list[Market] = [
    _m("uk-cornwall", "Cornwall", GROUP_UK, "United Kingdom", "GBP", 50.40, -4.80, [
        "Cornwall", "Truro", "Falmouth", "Newquay", "Penzance", "St Ives", "Bodmin",
        "Redruth", "Camborne", "Helston", "Launceston", "Bude", "St Austell", "Padstow",
    ], True),
    _m("uk-devon", "Devon", GROUP_UK, "United Kingdom", "GBP", 50.72, -3.70, [
        "Devon", "Exeter", "Plymouth", "Torbay", "Torquay", "Paignton", "Barnstaple",
        "Newton Abbot", "Exmouth", "Tiverton", "Totnes", "Okehampton", "Bideford",
        "Dartmouth", "Ilfracombe", "Honiton", "Sidmouth",
    ], True),
    _m("uk-somerset", "Somerset", GROUP_UK, "United Kingdom", "GBP", 51.13, -2.85, [
        "Somerset", "Taunton", "Yeovil", "Bath", "Bridgwater", "Wells", "Frome",
        "Glastonbury", "Weston-super-Mare", "Clevedon", "Portishead", "Shepton Mallet",
        "Minehead", "Mendip",
    ], True),
    _m("uk-bristol", "Bristol", GROUP_UK, "United Kingdom", "GBP", 51.4545, -2.5879, [
        "Bristol", "Clifton", "Bedminster", "Avonmouth", "Redcliffe",
    ], True),
    _m("uk-gloucestershire", "Gloucestershire", GROUP_UK, "United Kingdom", "GBP", 51.83, -2.20, [
        "Gloucestershire", "Gloucester", "Cheltenham", "Cirencester", "Stroud",
        "Tewkesbury", "Cotswolds", "Forest of Dean", "Tetbury", "Thornbury", "Yate",
    ], True),
    _m("uk-wiltshire", "Wiltshire", GROUP_UK, "United Kingdom", "GBP", 51.35, -1.95, [
        "Wiltshire", "Swindon", "Salisbury", "Chippenham", "Trowbridge", "Devizes",
        "Marlborough", "Malmesbury", "Warminster", "Melksham",
    ], True),
    _m("uk-dorset", "Dorset", GROUP_UK, "United Kingdom", "GBP", 50.75, -2.35, [
        "Dorset", "Bournemouth", "Poole", "Christchurch", "Dorchester", "Weymouth",
        "Bridport", "Sherborne", "Wareham", "Blandford", "Swanage", "Wimborne",
        "Sandbanks", "Ferndown",
    ], True),
    _m("uk-hampshire", "Hampshire", GROUP_UK, "United Kingdom", "GBP", 51.05, -1.31, [
        "Hampshire", "Southampton", "Portsmouth", "Winchester", "Basingstoke", "Andover",
        "Eastleigh", "Fareham", "Gosport", "Havant", "Aldershot", "Farnborough",
        "Romsey", "Petersfield", "Alton", "Lymington", "New Forest",
    ], True),
    _m("uk-west-sussex", "West Sussex", GROUP_UK, "United Kingdom", "GBP", 50.94, -0.47, [
        "West Sussex", "Chichester", "Crawley", "Horsham", "Worthing", "Bognor Regis",
        "Littlehampton", "Shoreham", "Haywards Heath", "Burgess Hill", "East Grinstead",
        "Mid Sussex",
    ], True),
    _m("uk-surrey", "Surrey", GROUP_UK, "United Kingdom", "GBP", 51.27, -0.44, [
        "Surrey", "Guildford", "Woking", "Epsom", "Esher", "Weybridge", "Cobham",
        "Leatherhead", "Dorking", "Farnham", "Godalming", "Camberley", "Staines",
        "Redhill", "Reigate", "Oxted", "Elmbridge", "Virginia Water",
    ], True),
    _m("uk-berkshire", "Berkshire", GROUP_UK, "United Kingdom", "GBP", 51.45, -0.98, [
        "Berkshire", "Reading", "Newbury", "Maidenhead", "Slough", "Bracknell",
        "Windsor", "Wokingham", "Ascot", "Thatcham", "Sandhurst", "Hungerford", "Eton",
    ], True),
    _m("uk-london", "Greater London", GROUP_UK, "United Kingdom", "GBP", 51.5074, -0.1278, [
        "London", "Greater London", "City of London", "Westminster", "Mayfair",
        "Knightsbridge", "Belgravia", "Chelsea", "Kensington", "Canary Wharf",
        "Shoreditch", "Camden", "Islington", "Hackney", "Southwark", "Richmond upon Thames",
        "Kingston upon Thames", "Hampstead", "Notting Hill", "Fulham", "Wandsworth",
    ], True),
    _m("uk-oxfordshire", "Oxfordshire", GROUP_UK, "United Kingdom", "GBP", 51.77, -1.28, [
        "Oxfordshire", "Oxford", "Banbury", "Bicester", "Abingdon", "Witney", "Didcot",
        "Henley-on-Thames", "Thame", "Wallingford", "Chipping Norton", "Harwell",
    ], True),
    # Rest of the UK — off by default, available when the advisor widens the net.
    _m("uk-home-counties", "Home Counties (Bucks, Herts, Kent, Essex)", GROUP_UK, "United Kingdom", "GBP", 51.6, -0.4, [
        "Buckinghamshire", "Hertfordshire", "Kent", "Essex", "Beaconsfield",
        "Gerrards Cross", "St Albans", "Sevenoaks", "Tunbridge Wells", "Chelmsford",
        "Milton Keynes", "Watford", "Amersham", "Marlow", "Henley",
    ]),
    _m("uk-east-anglia", "East Anglia", GROUP_UK, "United Kingdom", "GBP", 52.4, 1.0, [
        "Norfolk", "Suffolk", "Cambridgeshire", "Cambridge", "Norwich", "Ipswich",
        "Peterborough", "Bury St Edmunds",
    ]),
    _m("uk-midlands", "Midlands", GROUP_UK, "United Kingdom", "GBP", 52.5, -1.5, [
        "Birmingham", "West Midlands", "Warwickshire", "Leicestershire", "Nottingham",
        "Derby", "Coventry", "Solihull", "Stratford-upon-Avon", "Northamptonshire",
    ]),
    _m("uk-north-west", "North West", GROUP_UK, "United Kingdom", "GBP", 53.5, -2.6, [
        "Manchester", "Cheshire", "Liverpool", "Lancashire", "Alderley Edge",
        "Wilmslow", "Knutsford", "Preston", "Chester",
    ]),
    _m("uk-yorkshire", "Yorkshire & North East", GROUP_UK, "United Kingdom", "GBP", 53.9, -1.4, [
        "Yorkshire", "Leeds", "Sheffield", "York", "Harrogate", "Newcastle",
        "Durham", "Hull", "Bradford", "Wetherby",
    ]),
    _m("uk-scotland", "Scotland", GROUP_UK, "United Kingdom", "GBP", 56.0, -4.0, [
        "Scotland", "Edinburgh", "Glasgow", "Aberdeen", "Dundee", "Perth", "Stirling",
        "St Andrews",
    ]),
    _m("uk-wales", "Wales", GROUP_UK, "United Kingdom", "GBP", 52.1, -3.8, [
        "Wales", "Cardiff", "Swansea", "Newport", "Wrexham", "Bridgend",
    ]),
]

# ---------------------------------------------------------------------------
# United States — the metros where private wealth concentrates
# ---------------------------------------------------------------------------

_US: list[Market] = [
    _m("us-nyc", "New York", GROUP_US, "United States", "USD", 40.7128, -74.0060, [
        "New York", "Manhattan", "Brooklyn", "NYC", "New York City", "Hamptons",
        "Westchester", "Long Island",
    ]),
    _m("us-connecticut", "Connecticut & Tri-State", GROUP_US, "United States", "USD", 41.1, -73.4, [
        "Connecticut", "Greenwich", "Stamford", "Darien", "New Canaan", "Westport",
    ]),
    _m("us-bay-area", "San Francisco Bay Area", GROUP_US, "United States", "USD", 37.7749, -122.4194, [
        "San Francisco", "Silicon Valley", "Palo Alto", "Menlo Park", "Bay Area",
        "San Jose", "Atherton", "Mountain View", "Cupertino", "Oakland",
    ]),
    _m("us-la", "Los Angeles & Southern California", GROUP_US, "United States", "USD", 34.0522, -118.2437, [
        "Los Angeles", "Beverly Hills", "Malibu", "Santa Monica", "Orange County",
        "Newport Beach", "San Diego", "Pasadena", "Bel Air",
    ]),
    _m("us-florida", "Florida", GROUP_US, "United States", "USD", 26.1224, -80.1373, [
        "Florida", "Miami", "Palm Beach", "West Palm Beach", "Naples", "Fort Lauderdale",
        "Tampa", "Orlando", "Boca Raton", "Jacksonville", "Sarasota",
    ]),
    _m("us-texas", "Texas", GROUP_US, "United States", "USD", 32.7767, -96.7970, [
        "Texas", "Dallas", "Houston", "Austin", "Fort Worth", "San Antonio", "Plano",
    ]),
    _m("us-chicago", "Chicago & Midwest", GROUP_US, "United States", "USD", 41.8781, -87.6298, [
        "Chicago", "Illinois", "Winnetka", "Lake Forest", "Michigan", "Detroit",
        "Minneapolis", "Minnesota", "Ohio", "Cleveland", "Columbus", "Indianapolis",
    ]),
    _m("us-boston", "Boston & New England", GROUP_US, "United States", "USD", 42.3601, -71.0589, [
        "Boston", "Massachusetts", "Cambridge Massachusetts", "Wellesley", "Newton",
        "Rhode Island", "New Hampshire", "Maine", "Vermont",
    ]),
    _m("us-seattle", "Seattle & Pacific Northwest", GROUP_US, "United States", "USD", 47.6062, -122.3321, [
        "Seattle", "Washington state", "Bellevue", "Medina", "Portland Oregon", "Oregon",
    ]),
    _m("us-denver", "Denver & Mountain West", GROUP_US, "United States", "USD", 39.7392, -104.9903, [
        "Denver", "Colorado", "Aspen", "Boulder", "Vail", "Utah", "Salt Lake City",
        "Park City", "Jackson Hole", "Wyoming", "Montana",
    ]),
    _m("us-atlanta", "Atlanta & Southeast", GROUP_US, "United States", "USD", 33.7490, -84.3880, [
        "Atlanta", "Georgia", "North Carolina", "Charlotte", "Raleigh", "Nashville",
        "Tennessee", "South Carolina", "Charleston", "Alabama", "Birmingham Alabama",
    ]),
    _m("us-arizona-nevada", "Arizona & Nevada", GROUP_US, "United States", "USD", 33.4484, -112.0740, [
        "Arizona", "Phoenix", "Scottsdale", "Paradise Valley", "Nevada", "Las Vegas",
        "Reno",
    ]),
    _m("us-dc", "Washington DC & Mid-Atlantic", GROUP_US, "United States", "USD", 38.9072, -77.0369, [
        "Washington DC", "Virginia", "McLean", "Arlington Virginia", "Maryland",
        "Bethesda", "Potomac", "Philadelphia", "Pennsylvania", "New Jersey",
    ]),
]

# ---------------------------------------------------------------------------
# Middle East
# ---------------------------------------------------------------------------

_ME: list[Market] = [
    _m("ae-dubai", "Dubai", GROUP_ME, "United Arab Emirates", "AED", 25.2048, 55.2708, [
        "Dubai", "DIFC", "Jumeirah", "Palm Jumeirah", "Emirates Hills", "Dubai Hills",
        "Business Bay",
    ]),
    _m("ae-abu-dhabi", "Abu Dhabi", GROUP_ME, "United Arab Emirates", "AED", 24.4539, 54.3773, [
        "Abu Dhabi", "ADGM", "Saadiyat", "Al Reem", "Masdar",
    ]),
    _m("ae-other", "Sharjah & northern Emirates", GROUP_ME, "United Arab Emirates", "AED", 25.35, 55.39, [
        "Sharjah", "Ajman", "Ras Al Khaimah", "Fujairah", "Umm Al Quwain",
    ]),
    _m("sa-riyadh", "Riyadh", GROUP_ME, "Saudi Arabia", "SAR", 24.7136, 46.6753, [
        "Riyadh", "King Abdullah Financial District", "KAFD",
    ]),
    _m("sa-jeddah", "Jeddah & Western Province", GROUP_ME, "Saudi Arabia", "SAR", 21.4858, 39.1925, [
        "Jeddah", "Mecca", "Medina", "NEOM", "Red Sea Global",
    ]),
    _m("sa-eastern", "Saudi Eastern Province", GROUP_ME, "Saudi Arabia", "SAR", 26.4207, 50.0888, [
        "Dammam", "Khobar", "Dhahran", "Eastern Province",
    ]),
    _m("qa-doha", "Qatar", GROUP_ME, "Qatar", "QAR", 25.2854, 51.5310, [
        "Qatar", "Doha", "Lusail", "West Bay",
    ]),
    _m("kw-kuwait", "Kuwait", GROUP_ME, "Kuwait", "KWD", 29.3759, 47.9774, [
        "Kuwait", "Kuwait City", "Salmiya",
    ]),
    _m("bh-bahrain", "Bahrain", GROUP_ME, "Bahrain", "BHD", 26.0667, 50.5577, [
        "Bahrain", "Manama",
    ]),
    _m("om-oman", "Oman", GROUP_ME, "Oman", "OMR", 23.5880, 58.3829, [
        "Oman", "Muscat", "Salalah",
    ]),
    _m("il-tel-aviv", "Israel", GROUP_ME, "Israel", "ILS", 32.0853, 34.7818, [
        "Israel", "Tel Aviv", "Herzliya", "Jerusalem", "Haifa",
    ]),
    _m("tr-istanbul", "Türkiye", GROUP_ME, "Türkiye", "TRY", 41.0082, 28.9784, [
        "Turkey", "Türkiye", "Istanbul", "Ankara", "Izmir",
    ]),
    _m("eg-cairo", "Egypt", GROUP_ME, "Egypt", "EGP", 30.0444, 31.2357, [
        "Egypt", "Cairo", "Alexandria", "New Administrative Capital",
    ]),
    _m("jo-lb", "Jordan & Lebanon", GROUP_ME, "Jordan", "JOD", 31.9539, 35.9106, [
        "Jordan", "Amman", "Lebanon", "Beirut",
    ]),
]

# ---------------------------------------------------------------------------
# Europe
# ---------------------------------------------------------------------------

_EU: list[Market] = [
    _m("ch-zurich", "Switzerland", GROUP_EU, "Switzerland", "CHF", 47.3769, 8.5417, [
        "Switzerland", "Zurich", "Zug", "Geneva", "Basel", "Lausanne", "Lugano", "Bern",
    ]),
    _m("mc-monaco", "Monaco", GROUP_EU, "Monaco", "EUR", 43.7384, 7.4246, [
        "Monaco", "Monte Carlo",
    ]),
    _m("de-germany", "Germany", GROUP_EU, "Germany", "EUR", 50.1109, 8.6821, [
        "Germany", "Munich", "München", "Frankfurt", "Berlin", "Hamburg", "Düsseldorf",
        "Stuttgart", "Cologne",
    ]),
    _m("fr-france", "France", GROUP_EU, "France", "EUR", 48.8566, 2.3522, [
        "France", "Paris", "Lyon", "Nice", "Cannes", "Bordeaux", "Saint-Tropez",
        "Marseille",
    ]),
    _m("it-italy", "Italy", GROUP_EU, "Italy", "EUR", 45.4642, 9.1900, [
        "Italy", "Milan", "Milano", "Rome", "Roma", "Turin", "Florence", "Lake Como",
    ]),
    _m("es-spain", "Spain", GROUP_EU, "Spain", "EUR", 40.4168, -3.7038, [
        "Spain", "Madrid", "Barcelona", "Marbella", "Mallorca", "Ibiza", "Valencia",
    ]),
    _m("nl-benelux", "Netherlands & Belgium", GROUP_EU, "Netherlands", "EUR", 52.3676, 4.9041, [
        "Netherlands", "Amsterdam", "Rotterdam", "The Hague", "Belgium", "Brussels",
        "Antwerp", "Luxembourg",
    ]),
    _m("ie-ireland", "Ireland", GROUP_EU, "Ireland", "EUR", 53.3498, -6.2603, [
        "Ireland", "Dublin", "Cork", "Galway", "Limerick",
    ]),
    _m("nordics", "Nordics", GROUP_EU, "Sweden", "SEK", 59.3293, 18.0686, [
        "Sweden", "Stockholm", "Denmark", "Copenhagen", "Norway", "Oslo", "Finland",
        "Helsinki", "Iceland", "Reykjavik",
    ]),
    _m("at-cee", "Austria & Central Europe", GROUP_EU, "Austria", "EUR", 48.2082, 16.3738, [
        "Austria", "Vienna", "Poland", "Warsaw", "Czech", "Prague", "Hungary", "Budapest",
    ]),
    _m("pt-portugal", "Portugal", GROUP_EU, "Portugal", "EUR", 38.7223, -9.1393, [
        "Portugal", "Lisbon", "Porto", "Algarve", "Cascais",
    ]),
]

# ---------------------------------------------------------------------------
# Asia-Pacific and rest of world
# ---------------------------------------------------------------------------

_APAC: list[Market] = [
    _m("sg-singapore", "Singapore", GROUP_APAC, "Singapore", "SGD", 1.3521, 103.8198, [
        "Singapore", "Sentosa", "Orchard Road",
    ]),
    _m("hk-hong-kong", "Hong Kong", GROUP_APAC, "Hong Kong", "HKD", 22.3193, 114.1694, [
        "Hong Kong", "Kowloon", "Central Hong Kong", "Repulse Bay",
    ]),
    _m("au-australia", "Australia", GROUP_APAC, "Australia", "AUD", -33.8688, 151.2093, [
        "Australia", "Sydney", "Melbourne", "Brisbane", "Perth Australia", "Adelaide",
        "Gold Coast",
    ]),
    _m("nz-new-zealand", "New Zealand", GROUP_APAC, "New Zealand", "NZD", -36.8485, 174.7633, [
        "New Zealand", "Auckland", "Wellington", "Queenstown",
    ]),
    _m("jp-japan", "Japan", GROUP_APAC, "Japan", "JPY", 35.6762, 139.6503, [
        "Japan", "Tokyo", "Osaka", "Kyoto", "Yokohama",
    ]),
    _m("in-india", "India", GROUP_APAC, "India", "INR", 19.0760, 72.8777, [
        "India", "Mumbai", "Bengaluru", "Bangalore", "Delhi", "New Delhi", "Hyderabad",
        "Chennai", "Pune", "Gurugram",
    ]),
    _m("kr-korea", "South Korea", GROUP_APAC, "South Korea", "KRW", 37.5665, 126.9780, [
        "South Korea", "Seoul", "Busan", "Gangnam",
    ]),
    _m("sea-other", "Southeast Asia", GROUP_APAC, "Malaysia", "MYR", 3.1390, 101.6869, [
        "Malaysia", "Kuala Lumpur", "Indonesia", "Jakarta", "Thailand", "Bangkok",
        "Vietnam", "Ho Chi Minh City", "Philippines", "Manila",
    ]),
]

_OTHER: list[Market] = [
    _m("ca-canada", "Canada", GROUP_OTHER, "Canada", "CAD", 43.6532, -79.3832, [
        "Canada", "Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa",
    ]),
    _m("za-south-africa", "South Africa", GROUP_OTHER, "South Africa", "ZAR", -26.2041, 28.0473, [
        "South Africa", "Johannesburg", "Cape Town", "Durban", "Stellenbosch",
    ]),
    _m("br-brazil", "Brazil & Latin America", GROUP_OTHER, "Brazil", "BRL", -23.5505, -46.6333, [
        "Brazil", "São Paulo", "Sao Paulo", "Rio de Janeiro", "Mexico", "Mexico City",
        "Argentina", "Buenos Aires", "Chile", "Santiago",
    ]),
    _m("ng-africa", "West & East Africa", GROUP_OTHER, "Nigeria", "NGN", 6.5244, 3.3792, [
        "Nigeria", "Lagos", "Abuja", "Kenya", "Nairobi", "Ghana", "Accra", "Egypt Cairo",
    ]),
]

ALL_MARKETS: tuple[Market, ...] = tuple(_UK + _US + _ME + _EU + _APAC + _OTHER)
MARKET_BY_KEY: dict[str, Market] = {m.key: m for m in ALL_MARKETS}
MARKET_BY_NAME: dict[str, Market] = {m.name: m for m in ALL_MARKETS}

CORE_MARKET_KEYS: tuple[str, ...] = tuple(m.key for m in ALL_MARKETS if m.core)

#: Preset selections offered in the UI, so nobody has to tick sixty boxes.
PRESETS: dict[str, tuple[str, ...]] = {
    "Core patch (13 southern English counties)": CORE_MARKET_KEYS,
    "All United Kingdom": tuple(m.key for m in ALL_MARKETS if m.group == GROUP_UK),
    "UK + United States": tuple(
        m.key for m in ALL_MARKETS if m.group in (GROUP_UK, GROUP_US)
    ),
    "UK + US + Middle East": tuple(
        m.key for m in ALL_MARKETS if m.group in (GROUP_UK, GROUP_US, GROUP_ME)
    ),
    "Everywhere": tuple(m.key for m in ALL_MARKETS),
}

DEFAULT_PRESET = "UK + US + Middle East"


def markets_in_group(group: str) -> list[Market]:
    return [m for m in ALL_MARKETS if m.group == group]


def countries() -> list[str]:
    """Every country represented, in group order."""
    seen: list[str] = []
    for market in ALL_MARKETS:
        if market.country not in seen:
            seen.append(market.country)
    return seen


#: Google News locale per country. `gl` decides which publishers Google surfaces,
#: so searching Dubai with gl=GB quietly hides most of the Gulf press.
_LOCALE: dict[str, tuple[str, str]] = {
    "United Kingdom": ("en-GB", "GB"),
    "Ireland": ("en-IE", "IE"),
    "United States": ("en-US", "US"),
    "Canada": ("en-CA", "CA"),
    "United Arab Emirates": ("en-AE", "AE"),
    "Saudi Arabia": ("en-SA", "SA"),
    "Qatar": ("en-QA", "QA"),
    "Kuwait": ("en-KW", "KW"),
    "Bahrain": ("en-BH", "BH"),
    "Oman": ("en-OM", "OM"),
    "Israel": ("en-IL", "IL"),
    "Türkiye": ("en-TR", "TR"),
    "Egypt": ("en-EG", "EG"),
    "Jordan": ("en-JO", "JO"),
    "Switzerland": ("en-CH", "CH"),
    "Germany": ("en-DE", "DE"),
    "France": ("en-FR", "FR"),
    "Italy": ("en-IT", "IT"),
    "Spain": ("en-ES", "ES"),
    "Netherlands": ("en-NL", "NL"),
    "Portugal": ("en-PT", "PT"),
    "Austria": ("en-AT", "AT"),
    "Sweden": ("en-SE", "SE"),
    "Monaco": ("en-FR", "FR"),
    "Singapore": ("en-SG", "SG"),
    "Hong Kong": ("en-HK", "HK"),
    "Australia": ("en-AU", "AU"),
    "New Zealand": ("en-NZ", "NZ"),
    "Japan": ("en-JP", "JP"),
    "India": ("en-IN", "IN"),
    "South Korea": ("en-KR", "KR"),
    "Malaysia": ("en-MY", "MY"),
    "South Africa": ("en-ZA", "ZA"),
    "Brazil": ("en-BR", "BR"),
    "Nigeria": ("en-NG", "NG"),
}


def locale_for(key: str) -> tuple[str, str]:
    """``(hl, gl)`` for a market's Google News edition. Defaults to en-GB/GB."""
    market = MARKET_BY_KEY.get(key)
    if market is None:
        return ("en-GB", "GB")
    return _LOCALE.get(market.country, ("en-GB", "GB"))


def expand_selection(selection: tuple[str, ...] | list[str] | None) -> tuple[str, ...]:
    """Accept market keys, group names or preset names and return market keys.

    The UI offers presets and whole groups; the engine only understands keys.
    Resolving that here keeps the two ends from having to agree on a format.
    """
    if not selection:
        return tuple(m.key for m in ALL_MARKETS)

    keys: list[str] = []
    for item in selection:
        if item in MARKET_BY_KEY:
            keys.append(item)
        elif item in PRESETS:
            keys.extend(PRESETS[item])
        elif item in GROUP_ORDER:
            keys.extend(m.key for m in markets_in_group(item))
        elif item in MARKET_BY_NAME:
            keys.append(MARKET_BY_NAME[item].key)
    # Preserve declaration order and drop duplicates.
    ordered = [m.key for m in ALL_MARKETS if m.key in set(keys)]
    return tuple(ordered)


# ---------------------------------------------------------------------------
# Resolving text to a market
# ---------------------------------------------------------------------------

#: Place names too ambiguous to accept on their own — they need the country or
#: region name nearby, or they generate constant false positives.
AMBIGUOUS = frozenset({
    "bath", "reading", "windsor", "chelsea", "kensington", "hart", "street",
    "wells", "sutton", "cornwall", "washington state", "orange county",
    "cambridge massachusetts", "birmingham alabama", "perth australia",
    "portland oregon", "arlington virginia", "central hong kong", "egypt cairo",
})

#: Phrases that look like an in-scope place but are somewhere else entirely.
NEGATIVE = (
    "new london", "london ontario", "londonderry", "bristol connecticut",
    "bristol tennessee", "bristol virginia", "reading pennsylvania",
    "chelsea fc", "chelsea football", "hampshire college", "windsor ontario",
    "richmond virginia", "boston lincolnshire", "paris texas", "cairo illinois",
)


def _pattern_for(market: Market) -> re.Pattern[str]:
    alts = sorted((re.escape(p) for p in market.places), key=len, reverse=True)
    return re.compile(r"\b(" + "|".join(alts) + r")\b", re.IGNORECASE)


_PATTERNS: dict[str, re.Pattern[str]] = {m.key: _pattern_for(m) for m in ALL_MARKETS}


@dataclass(frozen=True)
class MarketMatch:
    market_key: str
    market_name: str
    matched_place: str
    #: "text" when the article itself names the place; "query" when we are
    #: relying on the search that surfaced it. The distinction is recorded so
    #: confidence can reflect it honestly.
    source: str


def _scrub(text: str) -> str:
    """Remove phrases that look in-scope but name somewhere else entirely."""
    cleaned = text
    lowered = text.lower()
    for phrase in NEGATIVE:
        if phrase in lowered:
            cleaned = re.sub(re.escape(phrase), " ", cleaned, flags=re.IGNORECASE)
    return cleaned


def _match_one(market: Market, cleaned: str) -> MarketMatch | None:
    match = _PATTERNS[market.key].search(cleaned)
    if not match:
        return None
    place = match.group(1)

    if place.lower() in AMBIGUOUS and place.lower() != market.name.lower():
        # Needs the market or country name nearby to corroborate it.
        corroborated = re.search(
            r"\b(" + re.escape(market.name) + r"|" + re.escape(market.country) + r")\b",
            cleaned, re.IGNORECASE,
        )
        if not corroborated:
            return None

    return MarketMatch(market.key, market.name, place, "text")


def resolve_market(
    text: str | None,
    *,
    limit_to: tuple[str, ...] | list[str] | None = None,
    prefer: str | None = None,
) -> MarketMatch | None:
    """Find which market an article is about, from its text.

    ``prefer`` is the market whose search surfaced the article, and it is tested
    first. That ordering matters: "the Exeter firm was bought by a New York
    group" mentions two markets, and without a preference the decisive
    exact-name match on New York would relocate a Devon prospect to Manhattan.

    ``limit_to`` restricts matching to a set of markets. Note that callers who
    want to *reject* out-of-scope articles should resolve globally and check the
    result instead — limiting the search makes an article that positively names
    another country look merely unlocated, which is a different thing.
    """
    if not text:
        return None

    cleaned = _scrub(text)

    if prefer:
        preferred = MARKET_BY_KEY.get(prefer)
        if preferred is not None and (not limit_to or prefer in limit_to):
            hit = _match_one(preferred, cleaned)
            if hit is not None:
                return hit

    candidates = limit_to or list(MARKET_BY_KEY)
    best: MarketMatch | None = None

    for key in candidates:
        market = MARKET_BY_KEY.get(key)
        if market is None:
            continue
        hit = _match_one(market, cleaned)
        if hit is None:
            continue
        # An exact market-name match is decisive; a town match is provisional.
        if hit.matched_place.lower() == market.name.lower():
            return hit
        if best is None:
            best = hit

    return best


def most_specific_place(text: str | None, market_key: str) -> str | None:
    """The narrowest place named in the text — a town rather than the county.

    "Devon" locates a prospect to a market; "Newton Abbot" is a location an
    advisor can actually use. Returns None when only the market name appears,
    because repeating it as a locality would add nothing.
    """
    market = MARKET_BY_KEY.get(market_key)
    if not text or market is None:
        return None

    cleaned = _scrub(text)
    # `places[0]` stands in for the market itself — several markets carry an
    # editorial label ("Connecticut & Tri-State") whose leading place is the real
    # name. Reporting it as a locality would render "Connecticut, Connecticut &
    # Tri-State".
    broad = {market.name.lower(), market.country.lower(), market.places[0].lower()}
    found: list[str] = []
    for place in market.places:
        if place.lower() in broad:
            continue
        if re.search(r"\b" + re.escape(place) + r"\b", cleaned, re.IGNORECASE):
            if place.lower() in AMBIGUOUS and not re.search(
                r"\b(" + re.escape(market.name) + r"|" + re.escape(market.country) + r")\b",
                cleaned, re.IGNORECASE,
            ):
                continue
            found.append(place)
    if not found:
        return None
    # The longest match is the most specific ("Weston-super-Mare" over "Weston").
    return max(found, key=len)


def market_coordinates(key: str) -> tuple[float, float] | tuple[None, None]:
    market = MARKET_BY_KEY.get(key)
    return (market.lat, market.lon) if market else (None, None)
