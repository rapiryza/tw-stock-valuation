"""日曆期間價格漲跌幅（未還原權息）及 52 週盤中高低點距離。"""
from datetime import date, timedelta
from calendar import monthrange
from math import isfinite
from util import DATA_DIR, read_json, write_json


def shift_months(day, months):
    n = day.year * 12 + day.month - 1 + months
    year, month = divmod(n, 12)
    return date(year, month + 1, min(day.day, monthrange(year, month + 1)[1]))


def targets(day):
    return {'d1': day - timedelta(days=1), 'y5': shift_months(day, -60), 'y3': shift_months(day, -36), 'y1': shift_months(day, -12),
            'ytd': date(day.year, 1, 1) - timedelta(days=1),
            'm3': shift_months(day, -3), 'm1': shift_months(day, -1),
            'w1': day - timedelta(days=7)}


def positive(value):
    return isinstance(value, (int, float)) and isfinite(value) and value > 0


def calculate(prices, candles, rows):
    dates = prices.get('dates', [])
    if not dates:
        return {'asOf': None, 'stocks': {}}
    asof = date.fromisoformat(dates[-1]); cut = asof - timedelta(weeks=52)
    bases = targets(asof)
    # 一日以全市場前一個有行情的交易日比較；停牌缺報價不能退回更早日期。
    trading_days = set(d for d in dates if d < asof.isoformat())
    trading_days.update(d for d, markets in candles.items()
                        if d < asof.isoformat() and any(markets.values()))
    if trading_days:
        bases['d1'] = date.fromisoformat(max(trading_days))
    output = {'asOf': asof.isoformat(), 'basis': 'unadjusted-price',
              'targets': {k: v.isoformat() for k, v in bases.items()}, 'stocks': {}}
    # official candles: {date: {market: {code: [close, high, low]}}}
    series = {}
    for day, markets in candles.items():
        if day > asof.isoformat(): continue
        for market, stocks in markets.items():
            for code, values in stocks.items():
                series.setdefault(code, {})[day] = values
    for row in rows:
        code = row['c']; history = dict(series.get(code, {}))
        for day, value in zip(dates, prices.get('p', {}).get(code, [])):
            if positive(value) and day <= asof.isoformat():
                history.setdefault(day, [value, None, None])
        current = history.get(asof.isoformat(), [None])[0]
        item = {'date': asof.isoformat(), 'returns': {}, 'bases': {}, 'low52': None, 'high52': None,
                'fromLow52': None, 'fromHigh52': None}
        for key, target in bases.items():
            # Holiday/weekend: nearest preceding observed close, never a later price.
            eligible = [(d, v[0]) for d, v in history.items()
                        if (target - timedelta(days=14)).isoformat() <= d <= target.isoformat() and positive(v[0])
                        and (key != 'd1' or d == target.isoformat())]
            base = max(eligible, default=None)
            item['returns'][key] = round((current / base[1] - 1) * 100, 2) if positive(current) and base else None
            item['bases'][key] = base[0] if base else None
        window = [(d, v) for d, v in series.get(code, {}).items()
                  if cut.isoformat() <= d <= asof.isoformat() and all(positive(x) for x in v)]
        window.sort()
        # Require a full-year span, enough trading observations and the latest day's OHLC.
        # New listings, suspended names and incomplete backfills must not masquerade as 52-week ranges.
        calendar_days = [cut + timedelta(days=i) for i in range((asof-cut).days+1)]
        complete_market = all(row['m'] in candles.get(d.isoformat(), {})
                              for d in calendar_days if d.weekday() < 5)
        if (complete_market and positive(current) and len(window) >= 220
                and window[0][0] <= (cut + timedelta(days=14)).isoformat()
                and window[-1][0] == asof.isoformat()):
            low = min(v[2] for _, v in window); high = max(v[1] for _, v in window)
            if low <= current <= high:
                item.update(low52=low, high52=high, fromLow52=round((current / low - 1) * 100, 2),
                            fromHigh52=round((current / high - 1) * 100, 2))
        output['stocks'][code] = item
    return output


def main():
    result = calculate(read_json(DATA_DIR / 'prices.json', {}),
                       read_json(DATA_DIR / 'performance_history.json', {}),
                       read_json(DATA_DIR / 'latest.json', []))
    write_json(DATA_DIR / 'performance.json', result)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
