import unittest
from datetime import date, timedelta
from build_performance import calculate, targets
from fetch_performance import parse

class PerformanceTest(unittest.TestCase):
    def test_leap_month_ytd(self):
        t=targets(date(2024,2,29))
        self.assertEqual(str(t['y1']),'2023-02-28')
        self.assertEqual(str(t['ytd']),'2023-12-31')
        self.assertEqual(str(targets(date(2024,3,31))['m1']),'2024-02-29')
        self.assertEqual(str(t['y3']),'2021-02-28')
    def test_weekend_preceding_not_future(self):
        p={'dates':['2025-02-28','2025-03-03','2025-03-10'],'p':{'1234':[100,150,200]}}
        x=calculate(p,{},[{'c':'1234','m':'listed'}])['stocks']['1234']
        self.assertEqual(x['returns']['w1'],33.33)
        self.assertIsNone(x['returns']['y5'])
        self.assertIsNone(x['fromHigh52'])
    def test_calendar_month_weekend(self):
        p={'dates':['2025-03-28','2025-03-31','2025-04-30'],'p':{'1234':[100,150,200]}}
        x=calculate(p,{},[{'c':'1234','m':'listed'}])['stocks']['1234']
        self.assertEqual(x['returns']['m1'],100)
        self.assertEqual(x['bases']['m1'],'2025-03-28')
    def test_full_range_and_missing_day(self):
        end=date(2025,3,10);start=end-timedelta(weeks=52);cache={}
        d=start
        while d<=end:
            if d.weekday()<5:cache[str(d)]={'listed':{'1234':[100,120,80]}}
            d+=timedelta(days=1)
        p={'dates':[str(end)],'p':{'1234':[100]}}
        row=[{'c':'1234','m':'listed'}]
        x=calculate(p,cache,row)['stocks']['1234']
        self.assertEqual(x['fromLow52'],25)
        self.assertEqual(x['fromHigh52'],-16.67)
        cache.pop('2024-08-01')
        self.assertIsNone(calculate(p,cache,row)['stocks']['1234']['fromLow52'])
    def test_null_and_zero(self):
        x=calculate({'dates':['2025-03-10'],'p':{'1234':[0]}},{},[{'c':'1234','m':'esb'}])['stocks']['1234']
        self.assertTrue(all(v is None for v in x['returns'].values()))
    def test_one_day_weekend_and_missing_previous_quote(self):
        p={'dates':['2025-03-06','2025-03-07','2025-03-10'],
           'p':{'1234':[90,100,110], '5678':[90,None,110]}}
        x=calculate(p,{},[{'c':c,'m':'listed'} for c in p['p']])['stocks']
        self.assertEqual(x['1234']['returns']['d1'],10)
        self.assertEqual(x['1234']['bases']['d1'],'2025-03-07')
        self.assertIsNone(x['5678']['returns']['d1'])
    def test_field_mapping(self):
        p={'tables':[{'fields':['證券代號','最高價','收盤價','最低價'],'data':[['1234','120','100','80'],['0050','12','10','8']]}]}
        self.assertEqual(parse(p,'listed'),{'1234':[100,120,80],'0050':[10,12,8]})
if __name__=='__main__':unittest.main()
