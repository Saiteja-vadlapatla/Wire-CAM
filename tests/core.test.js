// Unit tests for the WireCAM core (geometry, DXF, chaining, G-code, solver). Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WC = require('../app/js/core.js');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'latin1');
const rect = (x0, y0, x1, y1) => [WC.segL({ x: x0, y: y0 }, { x: x1, y: y0 }), WC.segL({ x: x1, y: y0 }, { x: x1, y: y1 }), WC.segL({ x: x1, y: y1 }, { x: x0, y: y1 }), WC.segL({ x: x0, y: y1 }, { x: x0, y: y0 })];
const codeLines = (t) => t.split(/\r?\n/).filter(l => l && !l.startsWith(';'));

// Rebuild an ELCam program from its own contour and compare line by line
function regenerate(file) {
  const txt = fx(file); const r = WC.parseWC(txt);
  const cont = r.moves.filter(m => m.type === 'cut' && m.dIdx > 0).map(WC.moveSeg);
  const closed = WC.pathIsClosed(cont, 1e-4);
  const job = { kind: 'hole', segs: cont, closed, entry: cont[0].p0, start: { x: 0, y: 0 }, end: null, dir: WC.orientationCCW(cont) ? 'ccw' : 'cw', side: 'auto', passes: [{ d: r.dtab[1] }], slug: 'none', overcut: 0, taper: { mode: 'none' } };
  const g = WC.generateProgram({ settings: { stamp: false }, jobs: [job] });
  return { orig: codeLines(txt), gen: codeLines(g.text) };
}

test('ELCam sample programs are reproduced exactly', () => {
  for (const f of ['EMT0130.WC', 'EMT0107.WC']) { const { orig, gen } = regenerate(f); assert.deepEqual(gen, orig, f); }
});

test('sample programs parse without arc errors', () => {
  for (const f of ['EMT0130.WC', 'EMT0107.WC']) assert.equal(WC.parseWC(fx(f)).warnings.length, 0);
});

test('DXF write → read round trip and duplicate removal', () => {
  const ents = [WC.mkLine({ x: 0, y: 0 }, { x: 10, y: 0 }), WC.mkArc({ x: 5, y: 5 }, 3, 0, Math.PI), WC.mkCircle({ x: 1, y: 1 }, 2)];
  const back = WC.parseDXF(WC.writeDXF(ents.concat([WC.mkLine({ x: 10, y: 0 }, { x: 0, y: 0 })])));
  const d = WC.dedupeEntities(back.entities);
  assert.equal(d.entities.length, 3); assert.equal(d.removed, 1);
});

test('chaining from the lead-in point asks at junctions (incl. T-junctions)', () => {
  const ents = rect(0, 0, 20, 10).map(s => WC.segToEnt(s)).concat([WC.mkLine({ x: 10, y: 0 }, { x: 10, y: 10 })]);
  const ch = WC.Chainer.fromPoint(ents, { x: 5, y: 0 }, 0.005);
  let r = ch.run(false); assert.equal(r.state, 'junction'); assert.equal(r.cands.length, 2);
  ch.choose(r.cands.find(id => ch.candSeg(id).p1.x > 5)); r = ch.run(false);
  assert.equal(r.state, 'junction'); assert.equal(r.cands.length, 2); // T-junction at (10,0)
});

test('closed loop passes continue around the loop; open path passes go back with G41/G42 swapped', () => {
  const base = { ordered: true, start: { x: 5, y: -5 }, leadPt: { x: 5, y: -2 }, passes: [{ d: 0.1 }, { d: 0.05 }], slug: 'none', endMode: 'start', overcut: 0, taper: { mode: 'none' } };
  const loop = WC.generateProgram({ settings: { stamp: false, originPt: base.leadPt }, jobs: [Object.assign({}, base, { kind: 'part', segs: rect(0, 0, 20, 10), closed: true, entry: { x: 0, y: 0 }, side: 'right' })] });
  assert.equal(loop.text.split('G0 ').length - 1, 1, 'one lead-in only'); assert.match(loop.text, /G42 D2 ;D2=0.05/);
  const open = WC.generateProgram({ settings: { stamp: false }, jobs: [Object.assign({}, base, { kind: 'open', segs: [WC.segL({ x: 0, y: 0 }, { x: 20, y: 0 })], closed: false, entry: { x: 0, y: 0 }, side: 'left' })] });
  assert.match(open.text, /G41 D1/); assert.match(open.text, /G42 D2/); assert.match(open.text, /BACKWARD/);
});

test('break points: HOLD adds M0, STOP ends the cut there', () => {
  const job = { ordered: true, kind: 'part', segs: rect(0, 0, 20, 10), closed: true, start: { x: 5, y: -5 }, entry: { x: 0, y: 0 }, side: 'right', passes: [{ d: 0.1 }], slug: 'none', endMode: 'stay', overcut: 0, taper: { mode: 'none' },
    breaks: [{ pt: { x: 20, y: 5 }, type: 'hold' }, { pt: { x: 10, y: 10 }, type: 'stop' }] };
  const g = WC.generateProgram({ settings: { stamp: false }, jobs: [job] });
  const lines = codeLines(g.text); const iM = lines.indexOf('G1 X15 Y10');
  assert.equal(lines[iM + 1], 'M0'); assert.ok(lines.includes('G1 X5 Y15')); assert.ok(!lines.includes('G1 X-5 Y15'));
});

test('taper result: Ø10, 2°, 10 mm thick → Ø10.698 on top', () => {
  const job = { ordered: true, segs: [WC.segA({ x: 5, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 0 }, true, true)], closed: true, entry: { x: 5, y: 0 }, start: { x: 8, y: 0 }, side: 'right', taper: { mode: 'angle', angle: 2, thick: 10, top: 'bigger', W: 0 } };
  const g = WC.taperSurfaces(job); assert.ok(!g.error);
  assert.ok(Math.abs(WC.shapeSize(g.top, true).d - 10.698415) < 1e-5);
});

test('gear outline is closed', () => {
  const g = WC.gearSegs({ module: 2, teeth: 20, pa: 20 });
  assert.ok(!g.error); assert.ok(WC.pathIsClosed(g.segs, 1e-6));
  for (let i = 1; i < g.segs.length; i++) assert.ok(WC.V.dist(g.segs[i - 1].p1, g.segs[i].p0) < 1e-6);
});

test('constraint solver satisfies rules and reports conflicts', () => {
  const L1 = WC.mkLine({ x: 0, y: 0 }, { x: 10, y: 0.5 }), L2 = WC.mkLine({ x: 10.2, y: 0.3 }, { x: 11, y: 8 });
  const cons = [{ id: 1, type: 'horizontal', refs: [{ e: L1.id }] }, { id: 2, type: 'coincident', refs: [{ e: L1.id, p: 'b' }, { e: L2.id, p: 'a' }] }, { id: 3, type: 'perpendicular', refs: [{ e: L1.id }, { e: L2.id }] }, { id: 4, type: 'length', refs: [{ e: L2.id }], val: 6 }];
  const r = WC.solveConstraints([L1, L2], cons, {}); assert.ok(r.ok);
  const r2 = WC.solveConstraints([L1, L2], cons.concat([{ id: 5, type: 'vertical', refs: [{ e: L1.id }] }]), {}); assert.ok(!r2.ok);
});
