// Exercise the production SVG renderer and its real hover handler without a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../docs/assets/app.js'), 'utf8');
class Element {
  constructor() { this.attrs = {}; this.children = []; this.events = {}; this.style = {}; this.hidden = true; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(e) { this.children.push(e); }
  addEventListener(k, fn) { this.events[k] = fn; }
  getBoundingClientRect() { return {left: 0, top: 0, width: 900}; }
}
const ctx = vm.createContext({document: {createElementNS: () => new Element()}, fmt: v => v.toFixed(2), esc: s => s});
vm.runInContext(source.slice(source.indexOf('  function lineChart('), source.indexOf('  // ---------------------------------------------------------------- 迷你走勢線')), ctx);
const points = hist => ctx.peHistoryPoints(hist);
function render(hist) {
  const svg = new Element(), tip = new Element(); tip.parentElement = new Element(); tip.offsetWidth = 150;
  ctx.lineChart(svg, tip, [{name: '本益比', color: 'blue', points: points(hist)}], {unit: '倍'});
  return {svg, tip, paths: svg.children.filter(e => e.attrs.class === 'line'), hover: svg.children.find(e => e.attrs.class === 'hit')?.events.mousemove};
}
test('only confirmed negative periods become zero; positive, zero, and unknown retain prior behavior', () => {
  const result = JSON.parse(JSON.stringify(points([
    ['2020-01', 12], ['2020-02', null], ['2020-03', 0],
    ['2020-04', null, null, null, null, 'negative_eps'], ['2020-05', -2],
    ['2020-06', 15, null, null, null, 'negative_eps'], ['2020-07', null, null, null, null, 'missing']
  ])));
  assert.deepEqual(result, [['2020-01',12,false],['2020-03',0,false],['2020-04',0,true],['2020-05',0,true],['2020-06',15,false]]);
});
test('isolated negative month draws dashed zero and breaks the solid path', () => {
  const {paths, hover, tip} = render([['2020-01',10],['2020-02',-1],['2020-03',20]]);
  assert.equal(paths.filter(p => p.attrs['stroke-dasharray']).length, 1);
  const solid = paths.find(p => !p.attrs['stroke-dasharray']);
  assert.equal((solid.attrs.d.match(/M/g) || []).length, 2);
  assert.ok(!solid.attrs.d.includes('L'));
  hover({clientX:437,clientY:100});
  assert.match(tip.innerHTML, /該期間 EPS 為負，不予顯示/);
  hover({clientX:44,clientY:100});
  assert.match(tip.innerHTML, /10.00倍/);
  assert.doesNotMatch(tip.innerHTML, /EPS 為負/);
});
test('all negative and single negative histories remain visible and hoverable', () => {
  for (const hist of [[['2020-01',-1]], [['2020-01',-1],['2020-02',-2]]]) {
    const {paths, hover, tip} = render(hist);
    assert.equal(paths.length, hist.length);
    assert.ok(paths.every(p => p.attrs['stroke-dasharray']));
    hover({clientX:44,clientY:100});
    assert.equal(tip.hidden, false);
    assert.match(tip.innerHTML, /該期間 EPS 為負，不予顯示/);
  }
});
test('unconfirmed gaps keep original filtering and have no dashed path', () => {
  const {paths} = render([['2020-01',10],['2020-02',null],['2020-03',20]]);
  assert.equal(paths.length, 1);
  assert.ok(!paths[0].attrs['stroke-dasharray']);
  assert.match(paths[0].attrs.d, /L/);
  assert.equal(render([['2020-01',null]]).paths.length, 0);
});

test('negative months separated by unknown or absent months never get a continuous dashed line', () => {
  for (const hist of [
    [['2020-01', -1], ['2020-02', null], ['2020-03', -1]],
    [['2020-01', -1], ['2020-03', -1]],
  ]) {
    const {paths} = render(hist);
    assert.equal(paths.length, 2);
    const endX = path => Number(path.attrs.d.match(/ L([0-9.]+),/)[1]);
    const startX = path => Number(path.attrs.d.match(/^M([0-9.]+),/)[1]);
    assert.ok(endX(paths[0]) < startX(paths[1]));
  }
});
test('confirmed consecutive negative months form a zero baseline across year boundaries', () => {
  const {paths} = render([['2020-12', -1], ['2021-01', -1]]);
  assert.equal(paths.length, 2);
  assert.equal(paths[0].attrs.d.split(' L')[1], paths[1].attrs.d.slice(1).split(' L')[0]);
});

test('瑞基 reaches the latest snapshot and uses the corrected EPS tooltip', () => {
  const hist = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'fixtures/pe_4171_202610.json'), 'utf8')).hist;
  const last = points(hist).at(-1);
  assert.equal(last[0], hist.at(-1)[0]);
  assert.equal(last[1], 0);
  assert.equal(last[2], true);
  const {hover, tip} = render(hist);
  hover({clientX:838,clientY:100});
  assert.match(tip.innerHTML, new RegExp(hist.at(-1)[0]));
  assert.match(tip.innerHTML, /該期間 EPS 為負，不予顯示/);
});
