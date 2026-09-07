#!/usr/bin/env python3
"""
Scrapes currently-live Mainboard + SME IPO listings and their category-wise
subscription figures from chittorgarh.com, and writes a single JSON file
(data/ipos.json) that the static site reads. Meant to be run on a schedule
by a GitHub Action (see .github/workflows/scrape.yml) -- never by a visitor's
browser, so it stays polite (one crawl per interval, not one per pageview).

IMPORTANT -- read this before you rely on it:
This was written without the ability to test live requests against
chittorgarh.com (the dev sandbox that built it had no network access), so
table-matching is done defensively by *header text*, not brittle CSS
selectors -- but you should still:
  1. Check https://www.chittorgarh.com/robots.txt and their Terms of Use
     before turning on the scheduled workflow, and keep the interval long
     (20-30 min is plenty for IPO odds -- they don't need to be second-fresh).
  2. Run the workflow once by hand (Actions tab -> "Run workflow") and open
     data/ipos.json in the commit to sanity-check it before trusting it.
  3. If a field comes back null/empty for a live IPO, chittorgarh has likely
     tweaked their markup -- adjust the relevant _find_* helper below.
"""

import json
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional

import requests
import pandas as pd
from bs4 import BeautifulSoup

BASE = "https://www.chittorgarh.com"
HEADERS = {
    # A descriptive UA is more polite than pretending to be a browser.
    "User-Agent": "IPOAllotmentOddsBot/1.0 (+educational, low-frequency, "
                  "contact: set-your-contact-email-here)"
}
REQUEST_DELAY_SECONDS = 2  # be gentle between requests
TIMEOUT = 20

LIST_PAGES = {
    "Mainboard": f"{BASE}/report/ipo-in-india-list-main-board-sme/82/mainboard/",
    "SME": f"{BASE}/report/ipo-in-india-list-main-board-sme/82/sme/",
}

OUT_PATH = "data/ipos.json"


@dataclass
class CategoryFigure:
    label: str
    subscription_times: Optional[float] = None
    shares_offered: Optional[int] = None


@dataclass
class IpoRecord:
    name: str
    slug: str
    ipo_id: str
    type: str  # "Mainboard" | "SME"
    detail_url: str
    subscription_url: str
    open_date: Optional[str] = None
    close_date: Optional[str] = None
    price_band_min: Optional[float] = None
    price_band_max: Optional[float] = None
    lot_size: Optional[int] = None
    face_value: Optional[float] = None
    total_subscription_times: Optional[float] = None
    last_updated_text: Optional[str] = None
    categories: dict = field(default_factory=dict)  # key -> CategoryFigure(dict)
    notes: list = field(default_factory=list)  # scraper warnings, surfaced in UI


def _get(url: str) -> BeautifulSoup:
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    time.sleep(REQUEST_DELAY_SECONDS)
    return BeautifulSoup(resp.text, "html.parser")


def _get_tables(url: str):
    """Return every <table> on the page as a DataFrame, plus the raw soup
    (soup is needed separately because read_html drops links/hrefs)."""
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    time.sleep(REQUEST_DELAY_SECONDS)
    soup = BeautifulSoup(resp.text, "html.parser")
    try:
        dfs = pd.read_html(resp.text)
    except ValueError:
        dfs = []
    return dfs, soup


def discover_live_ipos() -> list:
    """Walk the two 'Current IPOs' list pages and pull out (name, slug, id, type)
    for every row that links to an /ipo/<slug>/<id>/ detail page."""
    found = {}
    for ipo_type, url in LIST_PAGES.items():
        try:
            soup = _get(url)
        except requests.RequestException as e:
            print(f"WARN: could not load {ipo_type} list page: {e}", file=sys.stderr)
            continue

        for a in soup.find_all("a", href=True):
            m = re.search(r"/ipo/([a-z0-9\-]+)/(\d+)/?$", a["href"])
            if not m:
                continue
            slug, ipo_id = m.group(1), m.group(2)
            name = a.get_text(strip=True) or slug.replace("-ipo", "").replace("-", " ").title()
            if len(name) < 2:
                continue
            found[(slug, ipo_id)] = {"name": name, "slug": slug, "ipo_id": ipo_id, "type": ipo_type}

    return list(found.values())


def _num(text) -> Optional[float]:
    if text is None:
        return None
    s = str(text)
    s = s.replace(",", "").replace("₹", "").strip()
    m = re.search(r"-?\d+(\.\d+)?", s)
    return float(m.group()) if m else None


def _find_row_value(dfs, label_pattern: str) -> Optional[str]:
    """Search every 2-column-ish table for a row whose first cell matches
    label_pattern, and return the adjacent cell's text."""
    pattern = re.compile(label_pattern, re.IGNORECASE)
    for df in dfs:
        if df.shape[1] < 2:
            continue
        for _, row in df.iterrows():
            first_cell = str(row.iloc[0])
            if pattern.search(first_cell):
                return str(row.iloc[1])
    return None


def parse_detail_page(rec: IpoRecord, dfs) -> None:
    """Pull Price Band / Lot Size / Face Value / Open-Close dates from the
    main IPO detail page's info table(s)."""
    price_band_raw = _find_row_value(dfs, r"price\s*band")
    if price_band_raw:
        nums = re.findall(r"[\d,]+(?:\.\d+)?", price_band_raw)
        nums = [float(n.replace(",", "")) for n in nums]
        if len(nums) == 1:
            rec.price_band_min = rec.price_band_max = nums[0]
        elif len(nums) >= 2:
            rec.price_band_min, rec.price_band_max = nums[0], nums[-1]
    else:
        rec.notes.append("Price band not found on detail page; check manually.")

    lot_raw = _find_row_value(dfs, r"lot\s*size")
    if lot_raw:
        lot_num = _num(lot_raw)
        rec.lot_size = int(lot_num) if lot_num else None
    else:
        rec.notes.append("Lot size not found on detail page; check manually.")

    face_raw = _find_row_value(dfs, r"face\s*value")
    rec.face_value = _num(face_raw) if face_raw else None

    open_raw = _find_row_value(dfs, r"(ipo\s*open|bid.*open|open\s*date)")
    close_raw = _find_row_value(dfs, r"(ipo\s*close|bid.*close|close\s*date)")
    rec.open_date = open_raw.strip() if open_raw else None
    rec.close_date = close_raw.strip() if close_raw else None


CATEGORY_KEY_MAP = [
    # (regex to match the row label, output key)
    (r"^retail", "retail"),
    (r"^individual\s*investor", "retail"),  # SME's post-2025 "Individual Investor" bucket
    (r"^non[\s-]*institutional", "nii_total"),
    (r"^b[\s-]*nii|>\s*.?10\s*l", "bhni"),
    (r"^s[\s-]*nii|<\s*.?10\s*l", "shni"),
    (r"^qualified\s*institutional|^qib", "qib"),
    (r"^employee", "employee"),
    (r"^total", "total"),
]


def parse_subscription_page(rec: IpoRecord, dfs, soup: BeautifulSoup) -> None:
    """Find the 'Investor Category -> Subscription (times)' table and the
    'Category -> Shares Offered' table, and fold both into rec.categories."""
    sub_table = None
    for df in dfs:
        cols = [str(c).lower() for c in df.columns]
        if any("subscription" in c for c in cols) or (
            df.shape[1] == 2 and df.iloc[:, 0].astype(str).str.contains(
                "Institutional|Retail|Individual", case=False, regex=True).any()
        ):
            sub_table = df
            break

    if sub_table is not None:
        for _, row in sub_table.iterrows():
            label = str(row.iloc[0]).strip()
            value = _num(row.iloc[1]) if sub_table.shape[1] > 1 else None
            for pattern, key in CATEGORY_KEY_MAP:
                if re.search(pattern, label, re.IGNORECASE):
                    if key == "total":
                        rec.total_subscription_times = value
                    else:
                        rec.categories.setdefault(key, {"label": label})
                        rec.categories[key]["subscription_times"] = value
                    break
    else:
        rec.notes.append("Subscription-times table not found; check manually.")

    # Shares-offered table (category / shares offered / amount / size %)
    shares_table = None
    for df in dfs:
        cols = [str(c).lower() for c in df.columns]
        if any("shares offered" in c or "shares\noffered" in c for c in cols):
            shares_table = df
            break

    if shares_table is not None:
        for _, row in shares_table.iterrows():
            label = str(row.iloc[0]).strip()
            shares = _num(row.get("Shares Offered", row.iloc[1] if shares_table.shape[1] > 1 else None))
            for pattern, key in CATEGORY_KEY_MAP:
                if re.search(pattern, label, re.IGNORECASE) and key != "total":
                    rec.categories.setdefault(key, {"label": label})
                    rec.categories[key]["shares_offered"] = int(shares) if shares else None
                    break

    # "subscribed X.XXx as of <date time>" -- grab the freshest timestamp text
    text = soup.get_text(" ", strip=True)
    m = re.search(r"as of ([A-Za-z]{3,9} \d{1,2}, \d{4}[^.,]*\d{2}:\d{2})", text)
    if m:
        rec.last_updated_text = m.group(1)


def scrape_one(ipo_stub: dict) -> Optional[IpoRecord]:
    slug, ipo_id, ipo_type = ipo_stub["slug"], ipo_stub["ipo_id"], ipo_stub["type"]
    detail_url = f"{BASE}/ipo/{slug}/{ipo_id}/"
    sub_url = f"{BASE}/ipo_subscription/{slug}/{ipo_id}/"

    rec = IpoRecord(
        name=ipo_stub["name"],
        slug=slug,
        ipo_id=ipo_id,
        type=ipo_type,
        detail_url=detail_url,
        subscription_url=sub_url,
    )

    try:
        dfs, _ = _get_tables(detail_url)
        parse_detail_page(rec, dfs)
    except requests.RequestException as e:
        rec.notes.append(f"Could not load detail page: {e}")

    try:
        dfs, soup = _get_tables(sub_url)
        parse_subscription_page(rec, dfs, soup)
    except requests.RequestException as e:
        rec.notes.append(f"Could not load subscription page: {e}")
        return rec  # still return what we have

    # Only keep IPOs that actually have a subscription table -- anything else
    # is likely upcoming/closed-and-delisted-from-the-live-list already.
    if not rec.categories:
        return None

    return rec


def main():
    stubs = discover_live_ipos()
    print(f"Discovered {len(stubs)} candidate IPO(s) from list pages.")

    records = []
    for stub in stubs:
        print(f"Scraping {stub['name']} ({stub['type']})...")
        try:
            rec = scrape_one(stub)
        except Exception as e:  # noqa: BLE001 -- keep the run going for other IPOs
            print(f"  ERROR scraping {stub['name']}: {e}", file=sys.stderr)
            continue
        if rec:
            records.append(asdict(rec))

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "chittorgarh.com (scraped)",
        "count": len(records),
        "ipos": records,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(records)} IPO(s) to {OUT_PATH}")


if __name__ == "__main__":
    main()
