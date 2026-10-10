"""Collect dated exchange report periods and official quarterly EPS for all stocks.

Historical dates come from the existing monthly snapshots. Missing period fields,
responses for another date, and failed requests never turn null P/E into zero.
"""
from datetime import date, datetime, timezone
import argparse

from build_operating_leads import Http, common_fields, chunks
from pe_periods import EPS_SOURCE, parse_eps, report_period
from sources import DAILY
from util import DATA_DIR, get_json, rows_from_fields, read_json, write_json, log, num


def daily_url(market, day):
    return DAILY[market].format(ymd=day.strftime('%Y%m%d'),
                               roc=f'{day.year - 1911}/{day.month:02d}/{day.day:02d}')


def dated_periods(payload, day, market):
    """A requested URL alone does not establish the date of a response."""
    if payload.get('date') != day.strftime('%Y%m%d'):
        raise ValueError('交易所回應日期與快照日期不符')
    out = {}
    for row in rows_from_fields(payload):
        code = str(row.get('證券代號') or row.get('股票代號') or '').strip()
        pe = num(row.get('本益比'))
        period = report_period(row.get('財報年/季'))
        if len(code) == 4 and code.isdigit() and period and pe is None:
            out[code] = period
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='重新查詢已快取的日期與 EPS')
    args = parser.parse_args()
    periods_path, eps_path = DATA_DIR / 'pe_report_periods.json', DATA_DIR / 'pe_eps.json'
    periods = read_json(periods_path, {'months': {}})
    eps = read_json(eps_path, {'source': EPS_SOURCE, 'stocks': {}})
    meta = {row['c']: row for row in read_json(DATA_DIR / 'latest.json', [])}
    wanted = set()
    today = date.today()
    for path in sorted((DATA_DIR / 'history').glob('*.json')):
        for month, snapshot in sorted(read_json(path, {}).items()):
            day_text = snapshot.get('d')
            try:
                day = date.fromisoformat(day_text)
            except (TypeError, ValueError):
                continue
            if day > today or day_text[:7] != month:
                continue
            cached = periods['months'].get(month, {})
            if args.refresh or cached.get('d') != day_text or not cached.get('complete'):
                entry = {'d': day_text, 'sources': {}, 'stocks': {}}
                complete = True
                for market in ('listed', 'otc_pe'):
                    url = daily_url(market, day)
                    try:
                        payload = get_json(url, tries=2)
                        entry['stocks'].update(dated_periods(payload, day, market))
                        entry['sources'][market] = url
                    except Exception as exc:
                        complete = False
                        log(f'[P/E 日期證據] {month} {market} 保留原樣：{exc}')
                # Cache a fully checked date, including older dates with no period field.
                # Incomplete dates are retried next run; successful partial evidence is usable.
                entry['complete'] = complete
                periods['months'][month] = entry
                write_json(periods_path, periods)
                log(f'[P/E 日期證據] {month}: {len(entry["stocks"])} 筆明確財報年季')
            for code, values in snapshot.get('s', {}).items():
                if (code in meta and len(values) == 4 and values[0] is None
                        and any(v is not None for v in values[1:])
                        and code in periods['months'].get(month, {}).get('stocks', {})):
                    wanted.add(code)
    http = Http()
    refresh_codes = []
    for code in sorted(wanted):
        cached = eps['stocks'].get(code, {})
        try:
            age = (today - date.fromisoformat(cached.get('retrievedOn', ''))).days
        except ValueError:
            age = 999
        needed = {entry['stocks'][code] for entry in periods['months'].values()
                  if code in entry.get('stocks', {})}
        if args.refresh or age >= 7 or not needed.issubset(cached.get('quarters', {})):
            refresh_codes.append(code)
    for batch in chunks(refresh_codes, 10):
        names = {code: meta[code].get('n', '') for code in batch}
        fields = common_fields('EPS', '元')
        fields.extend(('companyId', f'{code} {names[code]}') for code in batch)
        try:
            parsed = parse_eps(http.post('/compare/data', fields).json(), names)
            for code, quarters in parsed.items():
                if quarters:
                    eps['stocks'][code] = {'name': names[code], 'retrievedOn': today.isoformat(),
                                           'quarters': quarters}
            eps['retrievedAt'] = datetime.now(timezone.utc).isoformat()
            write_json(eps_path, eps)
            log(f'[P/E 季 EPS] {batch[0]}–{batch[-1]}: {sum(bool(q) for q in parsed.values())} 檔')
        except Exception as exc:
            log(f'[P/E 季 EPS] {batch} 無法確認，保留原樣：{exc}')
    log(f'[P/E] 已檢查 {len(periods["months"])} 個月份、{len(wanted)} 檔候選股票')


if __name__ == '__main__':
    main()
