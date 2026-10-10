import copy
from datetime import date
import json
from pathlib import Path
import unittest

from build_pe_periods import dated_periods, daily_url
from pe_periods import EPS_SOURCE, parse_eps, report_period, with_period_evidence


class PeriodTests(unittest.TestCase):
    def setUp(self):
        self.day = '2026-10-08'
        self.month = {'d': self.day, 'stocks': {'4171': '2026Q2', '1101': '2026Q2'},
                      'sources': {'otc_pe': daily_url('otc_pe', date(2026, 10, 8))}}
        self.eps = {'source': EPS_SOURCE, 'stocks': {
            '4171': {'quarters': {'2025Q3': -.65, '2025Q4': .05, '2026Q1': -.09, '2026Q2': -.07}},
            '1101': {'quarters': {'2025Q3': -1.36, '2025Q4': -.32, '2026Q1': .1, '2026Q2': .29}},
        }}

    def test_exchange_period_formats_and_invalid_periods(self):
        for value in ('115Q2', '115/2', '2026Q2', '2026/2'):
            self.assertEqual(report_period(value), '2026Q2')
        for value in (None, '', '115', '115/0', '2026Q5', '2999Q2'):
            self.assertIsNone(report_period(value))

    def test_response_must_confirm_requested_date_and_each_company_period(self):
        payload = {'date': '20261008', 'fields': ['股票代號', '本益比', '財報年/季'],
                   'data': [['4171', 'N/A', '115Q2'], ['1101', '-', '115/2'],
                            ['1234', '12.3', '115Q2'], ['5678', '-', ''], ['9012', '0', '115Q2']]}
        self.assertEqual(dated_periods(payload, date(2026, 10, 8), 'otc_pe'), self.month['stocks'])
        for value in (None, '20261009', ''):
            payload['date'] = value
            with self.assertRaises(ValueError):
                dated_periods(payload, date(2026, 10, 8), 'otc_pe')

    def test_all_companies_with_negative_trailing_eps_are_flagged(self):
        for code in ('4171', '1101'):
            self.assertEqual(with_period_evidence([None, 1, 0, 20], code, self.day, self.month, self.eps),
                             [None, 1, 0, 20, 'negative_eps'])
        # A positive latest quarter alone does not erase the preceding losses.
        self.assertGreater(self.eps['stocks']['1101']['quarters']['2026Q2'], 0)

    def test_unknown_dates_reasons_and_normal_values_stay_unchanged(self):
        for values in ([12, 1, 0, 20], [0, 1, 0, 20], [None] * 4,
                       [None, 1, 0, 20, 'other_reason']):
            self.assertEqual(with_period_evidence(values, '4171', self.day, self.month, self.eps), values)
        for code, day, month in [('9999', self.day, self.month), ('4171', '2026-09-30', self.month),
                                  ('4171', self.day, {}), ('4171', None, self.month)]:
            values = [None, 1, 0, 20]
            self.assertEqual(with_period_evidence(values, code, day, month, self.eps), values)

    def test_missing_nonfinite_near_zero_and_positive_eps_do_not_flag(self):
        for change in ('missing', 'nan', 'bool', 'null', 'positive', 'rounding', 'future', 'source', 'date_source'):
            eps, month = copy.deepcopy(self.eps), copy.deepcopy(self.month)
            q = eps['stocks']['4171']['quarters']
            if change == 'missing': del q['2025Q3']
            if change == 'nan': q['2025Q3'] = float('nan')
            if change == 'bool': q['2025Q3'] = True
            if change == 'null': q['2025Q3'] = None
            if change == 'positive': q['2025Q3'] = 10
            if change == 'rounding': q.update(dict(zip(q, [-.01, 0, 0, 0])))
            if change == 'future': month['stocks']['4171'] = '2026Q4'
            if change == 'source': eps['source'] = 'https://example.com'
            if change == 'date_source': month['sources'] = {}
            values = [None, 1, 0, 20]
            self.assertEqual(with_period_evidence(values, '4171', self.day, month, eps), values, change)

    def test_eps_identity_unit_basis_and_duplicates(self):
        payload = {'ylabel': '元', 'qnumber': '1', 'xaxisList': ['2026Q1', '2026Q2'],
                   'graphData': [{'label': '瑞基', 'data': [[0, -.09, 'C'], [1, -.07, 'C']]},
                                 {'label': '台泥', 'data': [[0, .1, 'C'], [1, .29, 'C']]}]}
        names = {'1101': '台泥', '4171': '瑞基'}
        parsed = parse_eps(payload, names)
        self.assertEqual(parsed['4171'], {'2026Q1': -.09, '2026Q2': -.07})
        self.assertEqual(parsed['1101']['2026Q2'], .29)
        for field, value in [('ylabel', '仟元'), ('qnumber', '4')]:
            bad = copy.deepcopy(payload); bad[field] = value
            with self.assertRaises(ValueError): parse_eps(bad, names)
        payload['graphData'][0]['data'][1][2] = 'A'
        self.assertNotIn('2026Q2', parse_eps(payload, names)['4171'])
        payload['graphData'].append(payload['graphData'][0])
        self.assertEqual(parse_eps(payload, names)['4171'], {})

    def test_generated_stock_reasons_are_supported_by_dated_evidence(self):
        root = Path(__file__).resolve().parent.parent / 'docs/data'
        if not (root / 'pe_eps.json').exists():
            self.skipTest('historical collection not yet available')
        eps = json.loads((root / 'pe_eps.json').read_text())
        periods = json.loads((root / 'pe_report_periods.json').read_text())['months']
        for month, entry in periods.items():
            snapshot = json.loads((root / f'history/{month[:4]}.json').read_text())[month]
            self.assertEqual(entry['d'], snapshot['d'])
            for code in entry['stocks']:
                values = snapshot['s'].get(code)
                if values is None or not (root / f'stock/{code}.json').exists(): continue
                result = with_period_evidence(values, code, entry['d'], entry, eps)
                if len(result) == 5:
                    stock = json.loads((root / f'stock/{code}.json').read_text())
                    hist = {row[0]: row[1:] for row in stock['hist']}
                    self.assertEqual(hist[month], result, (code, month))


if __name__ == '__main__':
    unittest.main()
