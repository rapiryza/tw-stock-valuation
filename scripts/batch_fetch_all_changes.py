"""Batch fetch all remaining stocks with breakdown or large holding changes."""
import json
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

ROOT = Path("/Users/jingeer/.gemini/antigravity/scratch/tw-stock-valuation")
sys_path = ROOT / "scripts"
import sys
sys.path.insert(0, str(sys_path))

from mops_insider import fetch_mops_insider, parse_mops_records, CACHE_DIR

with open(ROOT / "docs" / "data" / "insider_flows.json", encoding="utf-8") as f:
    flows = json.load(f)

# Find all stocks with either breakdowns or monthly change > 500 lots in last 6 months
cached_files = set(f.stem for f in CACHE_DIR.glob("*.json"))

targets = set()
for code, s in flows.get("stocks", {}).items():
    series = s.get("holding", {}).get("series", [])
    for row in series[-6:]:
        month = row[0]
        delta = abs(row[2]) if row[2] is not None else 0
        bds = row[3] if len(row) > 3 else []
        if bds or delta > 500:
            yr = str(int(month[:4]) - 1911)
            mo = month[5:]
            targets.add((code, yr, mo))

# Filter out already cached
missing = [(c, y, m) for c, y, m in targets if f"{c}_{y}_{m}" not in cached_files]
print(f"Total missing MOPS reports to fetch: {len(missing)}")

s = requests.Session()
success = 0

def fetch_task(item):
    c, y, m = item
    time.sleep(0.04)
    data = fetch_mops_insider(c, y, m, session=s, use_cache=True)
    return c, y, m, data is not None

with ThreadPoolExecutor(max_workers=6) as executor:
    futures = {executor.submit(fetch_task, t): t for t in missing}
    done = 0
    for fut in as_completed(futures):
        done += 1
        c, y, m, ok = fut.result()
        if ok:
            success += 1
        if done % 50 == 0 or done == len(missing):
            print(f"Progress: {done}/{len(missing)} (success: {success})")

print(f"Batch fetch complete! Successfully fetched {success} reports.")
