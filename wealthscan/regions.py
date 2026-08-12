"""The 13 in-scope counties, and resolving free text to one of them.

Geographic scope is enforced in code, not by convention: a record whose
location cannot be resolved is discarded rather than defaulted, so nothing
outside the advisor's patch ever enters the pipeline.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

REGIONS: tuple[str, ...] = (
    "Cornwall",
    "Devon",
    "Somerset",
    "Bristol",
    "Gloucestershire",
    "Wiltshire",
    "Dorset",
    "Hampshire",
    "West Sussex",
    "Surrey",
    "Berkshire",
    "Greater London",
    "Oxfordshire",
)


@dataclass(frozen=True)
class Region:
    name: str
    lat: float
    lon: float
    #: Districts and major towns, used both for matching and for search queries.
    places: tuple[str, ...]


REGION_DATA: dict[str, Region] = {
    "Cornwall": Region("Cornwall", 50.40, -4.80, (
        "Cornwall", "Truro", "Falmouth", "Newquay", "Penzance", "St Ives",
        "Bodmin", "Redruth", "Camborne", "Helston", "Launceston", "Bude",
        "St Austell", "Wadebridge", "Padstow", "Isles of Scilly",
    )),
    "Devon": Region("Devon", 50.72, -3.70, (
        "Devon", "Exeter", "Plymouth", "Torbay", "Torquay", "Paignton",
        "Barnstaple", "Newton Abbot", "Exmouth", "Tiverton", "Totnes",
        "Okehampton", "Bideford", "Dartmouth", "Ilfracombe", "Honiton",
        "Sidmouth", "South Hams", "Teignbridge", "Torridge",
    )),
    "Somerset": Region("Somerset", 51.13, -2.85, (
        "Somerset", "Taunton", "Yeovil", "Bath", "Bridgwater", "Wells",
        "Frome", "Glastonbury", "Weston-super-Mare", "Clevedon", "Portishead",
        "Street", "Shepton Mallet", "Minehead", "Mendip", "Sedgemoor",
    )),
    "Bristol": Region("Bristol", 51.4545, -2.5879, (
        "Bristol", "Clifton", "Bedminster", "Avonmouth", "Redcliffe",
    )),
    "Gloucestershire": Region("Gloucestershire", 51.83, -2.20, (
        "Gloucestershire", "Gloucester", "Cheltenham", "Cirencester", "Stroud",
        "Tewkesbury", "Cotswold", "Cotswolds", "Forest of Dean", "Tetbury",
        "Dursley", "Thornbury", "Yate", "Nailsworth", "South Gloucestershire",
    )),
    "Wiltshire": Region("Wiltshire", 51.35, -1.95, (
        "Wiltshire", "Swindon", "Salisbury", "Chippenham", "Trowbridge",
        "Devizes", "Marlborough", "Malmesbury", "Warminster", "Melksham",
    )),
    "Dorset": Region("Dorset", 50.75, -2.35, (
        "Dorset", "Bournemouth", "Poole", "Christchurch", "Dorchester",
        "Weymouth", "Bridport", "Sherborne", "Wareham", "Blandford",
        "Swanage", "Wimborne", "Sandbanks", "Purbeck", "Ferndown",
    )),
    "Hampshire": Region("Hampshire", 51.05, -1.31, (
        "Hampshire", "Southampton", "Portsmouth", "Winchester", "Basingstoke",
        "Andover", "Eastleigh", "Fareham", "Gosport", "Havant", "Aldershot",
        "Farnborough", "Romsey", "Petersfield", "Alton", "Lymington",
        "New Forest", "Test Valley", "Hart", "Rushmoor", "Whiteley",
    )),
    "West Sussex": Region("West Sussex", 50.94, -0.47, (
        "West Sussex", "Chichester", "Crawley", "Horsham", "Worthing",
        "Bognor Regis", "Littlehampton", "Shoreham", "Haywards Heath",
        "Burgess Hill", "East Grinstead", "Arun", "Adur", "Mid Sussex",
    )),
    "Surrey": Region("Surrey", 51.27, -0.44, (
        "Surrey", "Guildford", "Woking", "Epsom", "Esher", "Weybridge",
        "Cobham", "Leatherhead", "Dorking", "Farnham", "Godalming",
        "Camberley", "Staines", "Redhill", "Reigate", "Oxted", "Elmbridge",
        "Mole Valley", "Runnymede", "Waverley", "Tandridge",
    )),
    "Berkshire": Region("Berkshire", 51.45, -0.98, (
        "Berkshire", "Reading", "Newbury", "Maidenhead", "Slough", "Bracknell",
        "Windsor", "Wokingham", "Ascot", "Thatcham", "Sandhurst", "Hungerford",
        "Eton", "West Berkshire",
    )),
    "Greater London": Region("Greater London", 51.5074, -0.1278, (
        "London", "Greater London", "City of London", "Westminster", "Camden",
        "Islington", "Hackney", "Shoreditch", "Southwark", "Lambeth",
        "Wandsworth", "Kensington", "Chelsea", "Fulham", "Hammersmith",
        "Richmond upon Thames", "Kingston upon Thames", "Croydon", "Bromley",
        "Barnet", "Brent", "Ealing", "Enfield", "Greenwich", "Haringey",
        "Harrow", "Havering", "Hillingdon", "Hounslow", "Lewisham", "Merton",
        "Newham", "Redbridge", "Sutton", "Tower Hamlets", "Waltham Forest",
        "Bexley", "Barking and Dagenham", "Mayfair", "Canary Wharf",
    )),
    "Oxfordshire": Region("Oxfordshire", 51.77, -1.28, (
        "Oxfordshire", "Oxford", "Banbury", "Bicester", "Abingdon", "Witney",
        "Didcot", "Henley-on-Thames", "Thame", "Wallingford", "Cherwell",
        "Vale of White Horse", "Wantage", "Chipping Norton", "Harwell",
    )),
}

#: Ambiguous place names that appear in unrelated contexts and would otherwise
#: create false positives. Matched only with an explicit county nearby.
AMBIGUOUS_PLACES = frozenset({
    "Bath", "Reading", "Windsor", "Richmond upon Thames", "Chelsea",
    "Kensington", "Hart", "Street", "Wells", "Sutton", "Cornwall",
})

#: Terms that look like an in-scope place but are not.
NEGATIVE_TERMS = (
    "New London", "London Ontario", "Londonderry", "Bristol Connecticut",
    "Bristol Tennessee", "Bristol Virginia", "Reading Pennsylvania",
    "Chelsea FC", "Chelsea Football", "Hampshire College",
    "New Hampshire", "Windsor Ontario", "Richmond Virginia",
)


def _compile(places: tuple[str, ...]) -> re.Pattern[str]:
    alternatives = sorted((re.escape(p) for p in places), key=len, reverse=True)
    return re.compile(r"\b(" + "|".join(alternatives) + r")\b", re.IGNORECASE)


_PATTERNS: dict[str, re.Pattern[str]] = {
    name: _compile(region.places) for name, region in REGION_DATA.items()
}
_AMBIGUOUS_LOWER = {p.lower() for p in AMBIGUOUS_PLACES}


def resolve_region(text: str | None) -> tuple[str | None, str | None]:
    """Resolve free text to one of the 13 counties.

    Returns ``(region, matched_place)``. ``(None, None)`` means out of scope,
    which callers must treat as "discard", never as "assume London".

    An ambiguous place name on its own is not enough: "Bath" appears in far more
    articles about bathrooms than about Somerset, so a bare ambiguous match is
    only accepted when the county name also appears.
    """
    if not text:
        return None, None

    for negative in NEGATIVE_TERMS:
        if negative.lower() in text.lower():
            text = re.sub(re.escape(negative), " ", text, flags=re.IGNORECASE)

    best: tuple[str, str] | None = None
    for name, pattern in _PATTERNS.items():
        match = pattern.search(text)
        if not match:
            continue
        matched = match.group(1)

        if matched.lower() in _AMBIGUOUS_LOWER and matched.lower() != name.lower():
            # Require corroboration from the county name itself.
            if not re.search(r"\b" + re.escape(name) + r"\b", text, re.IGNORECASE):
                continue

        # An exact county-name match beats a town match.
        if matched.lower() == name.lower():
            return name, matched
        if best is None:
            best = (name, matched)

    return best if best else (None, None)


def region_centroid(name: str) -> tuple[float, float]:
    region = REGION_DATA[name]
    return region.lat, region.lon
