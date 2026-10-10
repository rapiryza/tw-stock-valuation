import copy
import json
import unittest
import tempfile
from unittest.mock import patch
import rebuild_history
from util import write_json
from pathlib import Path
from pe_evidence import confirmed_negative, with_pe_evidence

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = json.loads((ROOT / 'docs/data/pe_evidence.json').read_text())


class EvidenceTests(unittest.TestCase):
    def test_reviewed_snapshot_dates_match_source_and_generated_stock(self):
        stock = json.loads((ROOT / 'docs/data/stock/2409.json').read_text())
        hist = {row[0]: row[1:] for row in stock['hist']}
        for record in EVIDENCE['2409']:
            for day in record['snapshotDates']:
                source = json.loads((ROOT / f'docs/data/history/{day[:4]}.json').read_text())[day[:7]]
                self.assertEqual(day, source['d'])
                values = source['s']['2409']
                self.assertIsNone(values[0])
                self.assertTrue(confirmed_negative(record, day))
                self.assertEqual(hist[day[:7]], with_pe_evidence(values, '2409', day, EVIDENCE))
                self.assertEqual(hist[day[:7]][:4], values[:4])
                self.assertEqual(hist[day[:7]][4], 'negative_eps')

    def test_unknown_dates_codes_and_normal_values_are_unchanged(self):
        for code, day, values in [
            ('2409', '2019-08-29', [None, 1, 2, 10]),
            ('1234', '2019-08-30', [None, 1, 2, 10]),
            ('2409', '2019-08-30', [12, 1, 2, 10]),
            ('2409', '2019-08-30', [0, 1, 2, 10]),
            ('2409', '2019-08-30', [None, None, None, None]),
        ]:
            self.assertEqual(with_pe_evidence(values, code, day, EVIDENCE), values)
        self.assertFalse(confirmed_negative({}, '2019-08-30'))

    def test_announcements_must_precede_snapshot_and_next_report_follows(self):
        for change in ('same_day', 'future', 'no_date', 'no_source', 'next_report'):
            record = copy.deepcopy(EVIDENCE['2409'][0])
            row = record['quarters'][-1]
            if change == 'same_day': row['announcedOn'] = '2019-08-30'
            if change == 'future': row['announcedOn'] = '2019-08-31'
            if change == 'no_date': del row['announcedOn']
            if change == 'no_source': del row['source']
            if change == 'next_report': record['nextAnnouncement']['date'] = '2019-08-30'
            self.assertFalse(confirmed_negative(record, '2019-08-30'), change)

    def test_complete_consecutive_negative_four_quarters_required(self):
        for change in ('missing', 'nonconsecutive', 'positive_eps', 'zero_eps', 'positive_income', 'nan'):
            record = copy.deepcopy(EVIDENCE['2409'][0])
            if change == 'missing': record['quarters'].pop()
            if change == 'nonconsecutive': record['quarters'][0]['period'] = '2018Q1'
            if change == 'positive_eps': record['quarters'][-1]['eps'] = 10
            if change == 'zero_eps':
                for row in record['quarters']: row['eps'] = 0
            if change == 'positive_income': record['quarters'][-1]['netIncomeBillionTwd'] = 100
            if change == 'nan': record['quarters'][-1]['eps'] = float('nan')
            self.assertFalse(confirmed_negative(record, '2019-08-30'), change)

    def test_daily_rebuild_reapplies_evidence_from_unchanged_raw_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_json(root / 'latest.json', [{'c': '2409', 'm': 'listed'}])
            write_json(root / 'pe_evidence.json', EVIDENCE)
            write_json(root / 'history/2019.json', {'2019-08': {
                'd': '2019-08-30', 's': {'2409': [None, .41, 6.11, 8.18]}}})
            with patch.object(rebuild_history, 'DATA_DIR', root), \
                 patch.object(rebuild_history, 'HIST_DIR', root / 'history'), \
                 patch.object(rebuild_history, 'STOCK_DIR', root / 'stock'), \
                 patch.object(rebuild_history, 'PS_HISTORY', root / 'ps.json'), \
                 patch.object(rebuild_history, 'load_reconstructed', return_value={}):
                rebuild_history.main()
                first = (root / 'stock/2409.json').read_bytes()
                rebuild_history.main()
                self.assertEqual(first, (root / 'stock/2409.json').read_bytes())
                self.assertEqual(json.loads(first)['hist'][0][-1], 'negative_eps')
            raw = json.loads((root / 'history/2019.json').read_text())
            self.assertEqual(len(raw['2019-08']['s']['2409']), 4)

    def test_actual_same_day_and_return_to_profit_are_preserved(self):
        stock = json.loads((ROOT / 'docs/data/stock/2409.json').read_text())
        hist = {row[0]: row[1:] for row in stock['hist']}
        for month in ('2020-04', '2021-02'):
            snapshot = json.loads((ROOT / f'docs/data/history/{month[:4]}.json').read_text())[month]
            values = snapshot['s']['2409']
            self.assertEqual(with_pe_evidence(values, '2409', snapshot['d'], EVIDENCE), values)
            # Manual announcement-date evidence still fails closed. The exchange's
            # dated report-period evidence may independently establish the period.
            from pe_periods import with_period_evidence
            periods = json.loads((ROOT / 'docs/data/pe_report_periods.json').read_text())['months'] if (ROOT / 'docs/data/pe_report_periods.json').exists() else {}
            eps = json.loads((ROOT / 'docs/data/pe_eps.json').read_text()) if (ROOT / 'docs/data/pe_eps.json').exists() else {}
            self.assertEqual(hist[month], with_period_evidence(values, '2409', snapshot['d'], periods.get(month, {}), eps))
        self.assertEqual(hist['2021-02'][0], 52.5)

    def test_actual_last_four_quarters_can_be_negative_despite_latest_profit(self):
        record = EVIDENCE['2409'][-1]
        self.assertGreater(record['quarters'][-1]['eps'], 0)
        self.assertGreater(record['quarters'][-1]['netIncomeBillionTwd'], 0)
        self.assertTrue(confirmed_negative(record, '2021-01-29'))
