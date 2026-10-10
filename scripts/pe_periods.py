"""Confirm negative EPS using the financial period explicitly published for a trading day."""
from datetime import date
from decimal import Decimal
import re

from build_operating_leads import normalize_identity, company_short_alias, parse_number
from sources import DAILY

EPS_SOURCE = 'https://mopsfin.twse.com.tw/compare/data'


def report_period(value):
    match = re.fullmatch(r'(\d{3,4})(?:Q|/)([1-4])', str(value or '').strip())
    if not match:
        return None
    year = int(match[1])
    if year < 1911:
        year += 1911
    return f'{year}Q{match[2]}' if 2013 <= year <= date.today().year else None


def parse_eps(payload, companies):
    """Require explicit, unique identities, single-quarter EPS, and consolidated basis."""
    if payload.get('ylabel') != '元' or str(payload.get('qnumber')) != '1':
        raise ValueError('EPS 必須為元、單季資料')
    periods = payload.get('xaxisList') or []
    aliases = {code: {normalize_identity(code), normalize_identity(name)}
               for code, name in companies.items()}
    for field in ('checkedNameList', 'showNameList', 'displayCompanyId'):
        for label in payload.get(field) or []:
            match = re.match(r'^(\d{4})\s', str(label))
            if match and match[1] in aliases:
                aliases[match[1]].update((normalize_identity(label), company_short_alias(label)))
    result = {code: {} for code in companies}
    claimed = set()
    for series in payload.get('graphData') or []:
        candidates = [code for code in companies
                      if normalize_identity(series.get('label')) in aliases[code]]
        if len(candidates) != 1:
            continue
        code = candidates[0]
        if code in claimed:
            result[code] = {}
            continue
        claimed.add(code)
        seen = set()
        for point in series.get('data') or []:
            if not isinstance(point, list) or len(point) < 3 or point[2] != 'C':
                continue
            index = point[0]
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(periods):
                continue
            period = periods[index]
            if not re.fullmatch(r'\d{4}Q[1-4]', str(period)):
                continue
            # Duplicate points are ambiguous, even if their values happen to agree.
            result[code][period] = None if period in seen else parse_number(point[1])
            seen.add(period)
    return result


def negative_for_snapshot(code, snapshot_date, period_month, eps_data):
    """No filing-calendar assumptions: the exchange must identify the exact period/day."""
    try:
        day = date.fromisoformat(snapshot_date)
        if period_month.get('d') != snapshot_date or eps_data.get('source') != EPS_SOURCE:
            return False
        expected_urls = {
            DAILY['listed'].format(ymd=day.strftime('%Y%m%d')),
            DAILY['otc_pe'].format(roc=f'{day.year - 1911}/{day.month:02d}/{day.day:02d}'),
        }
        if not expected_urls.intersection(period_month.get('sources', {}).values()):
            return False
        period = period_month['stocks'][code]
        if report_period(period) != period:
            return False
        year, quarter = int(period[:4]), int(period[-1])
        # A report for a quarter that has not ended cannot support this snapshot.
        if (day.year, day.month) <= (year, quarter * 3):
            return False
        end = year * 4 + quarter - 1
        values = eps_data['stocks'][code]['quarters']
        total = Decimal(0)
        for index in range(end - 3, end + 1):
            value = values[f'{index // 4}Q{index % 4 + 1}']
            if value is None or isinstance(value, bool):
                return False
            number = Decimal(str(value))
            if not number.is_finite():
                return False
            total += number
        # Four EPS values rounded to cents can have a combined error of 0.02.
        return total < Decimal('-0.02')
    except (KeyError, TypeError, ValueError, ArithmeticError, AttributeError):
        return False


def with_period_evidence(values, code, snapshot_date, period_month, eps_data):
    result = list(values)
    if (len(result) == 4 and result[0] is None
            and any(value is not None for value in result[1:])
            and negative_for_snapshot(code, snapshot_date, period_month, eps_data)):
        result.append('negative_eps')
    return result
