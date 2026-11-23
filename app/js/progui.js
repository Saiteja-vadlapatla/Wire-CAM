/* WireCAM – PROGRAM mode: generate, check, view, simulate, save .WC */
(function () {
'use strict';
const { V } = WC; const { S, $, esc, r3, num, toast, hint, cfg } = App;

App.invalidateProgram = () => { S.gen = null; };
function settings() { const O = App.progOrigin && App.progOrigin(); return { decimals: cfg.decimals, endCode: cfg.endCode, thread: cfg.thread, title: S.prog.title, eCode: cfg.eCode, maxArc: cfg.maxArc, stamp: true, originPt: O ? O.pt : null }; }
function generate() {
  try { S.gen = WC.generateProgram({ settings: settings(), jobs: S.jobs.filter(j => App.jobReady(j)).map(j => Object.assign({}, j, { end: j.endMode === 'point' && j.end ? j.end : null })) }); }
  catch (e) { console.error(e); S.gen = { text: '', errors: ['Internal error while making the program: ' + e.message], warnings: [] }; }
  const notReady = S.jobs.filter(j => j.enabled !== false && !App.jobReady(j));
  notReady.forEach(j => S.gen.warnings.unshift('"' + j.name + '" is not finished (' + App.jobMissing(j) + ') and is NOT in the program.'));
  S.gen.parsed = S.gen.text ? WC.parseWC(S.gen.text) : null;
  if (S.gen.parsed && S.gen.parsed.warnings.length) S.gen.errors.push(...S.gen.parsed.warnings.map(w => 'Check: ' + w));
  resetSim();
}
function cur() { if (S.viewer) return { text: S.viewer.text, parsed: S.viewer.parsed, errors: [], warnings: S.viewer.parsed.warnings, viewing: true }; if (!S.gen) generate(); return S.gen; }

// ------------------------------------------------------------------ simulation
const sim = S.sim; let simSegs = []; let simTotal = 0; let raf = null; let lastT = 0;
function resetSim() {
  sim.playing = false; cancelAnimationFrame(raf); simSegs = []; simTotal = 0; sim.pos = 0;
  const g = S.viewer ? S.viewer : S.gen; const P = g && g.parsed; if (!P) return;
  for (const m of P.moves) { if (m.type === 'stop') { simSegs.push({ stop: true, m: m.m, line: m.line, at: simTotal }); continue; } const s = WC.moveSeg(m); const L = Math.max(WC.segLen(s), 1e-6); simSegs.push({ s, top: WC.moveTopSeg(m), m, L, at: simTotal }); simTotal += L; }
}
function simState(pos) { // -> {pt, top, line, i}
  let last = null; for (let i = 0; i < simSegs.length; i++) { const k = simSegs[i]; if (k.stop) continue; last = { k, i }; if (pos <= k.at + k.L) { const t = Math.max(0, Math.min(1, (pos - k.at) / k.L)); return { pt: WC.segPoint(k.s, t), top: k.top ? WC.segPoint(k.top, t) : null, line: k.m.line, i, k }; } }
  if (last) return { pt: last.k.s.p1, top: last.k.top ? last.k.top.p1 : null, line: last.k.m.line, i: last.i, k: last.k }; return null;
}
function play() { if (!simTotal) return; if (sim.pos >= simTotal - 1e-9) sim.pos = 0; sim.playing = true; lastT = performance.now(); tick(); renderSimBar(); }
function pause() { sim.playing = false; cancelAnimationFrame(raf); renderSimBar(); }
function tick() {
  if (!sim.playing) return; const now = performance.now(); const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  const rate = simTotal / 25 * (sim.speed || 1); // whole program ~25 s at 1x
  const prev = sim.pos; sim.pos = Math.min(simTotal, sim.pos + rate * dt);
  // stop at M0
  const stopAt = simSegs.find(k => k.stop && k.at > prev + 1e-9 && k.at <= sim.pos + 1e-9 && (k.m === 0 || k.m === 1));
  if (stopAt && $('#simStops') && $('#simStops').checked) { sim.pos = stopAt.at; sim.playing = false; toast('M' + stopAt.m + ' – program stop (line ' + (stopAt.line + 1) + '). Press Play to continue.', 'w', 3000); }
  if (sim.pos >= simTotal) sim.playing = false;
  updateSimUI(); App.redraw(); if (sim.playing) raf = requestAnimationFrame(tick); else renderSimBar();
}
function stepBlock() { pause(); const st = simState(sim.pos + 1e-6); if (!st) return; const k = st.k; sim.pos = sim.pos >= k.at + k.L - 1e-6 ? (simSegs.slice(st.i + 1).find(x => !x.stop) || k).at + ((simSegs.slice(st.i + 1).find(x => !x.stop) || k).L) : k.at + k.L; updateSimUI(); App.redraw(); }
function updateSimUI() {
  const r = $('#simRange'); if (r) r.value = simTotal ? Math.round(sim.pos / simTotal * 1000) : 0;
  const st = simState(sim.pos); const code = $('#code'); if (!code) return;
  code.querySelectorAll('.ln.cur').forEach(e => e.classList.remove('cur'));
  if (st) { const el = code.querySelector('.ln[data-l="' + st.line + '"]'); if (el) { el.classList.add('cur'); const top = el.offsetTop - code.clientHeight / 2; if (sim.playing || Math.abs(code.scrollTop - top) > code.clientHeight / 2) code.scrollTop = top; } const p = $('#simPos'); if (p) p.textContent = 'X ' + r3(st.pt.x - 0) + '  Y ' + r3(st.pt.y) + (st.top ? '   U ' + r3(st.top.x) + '  V ' + r3(st.top.y) : ''); }
}
function renderSimBar() { const b = $('#simPlay'); if (b) b.innerHTML = (sim.playing ? ICONS.pause + ' Pause' : ICONS.play + ' Play'); }

// ------------------------------------------------------------------ drawing in program mode
App.progHandlers = {
  click(p) { },
  right() { }, escape() { if (sim.playing) pause(); }, typed() { return false; }, key(e) { if (e.key === ' ') { sim.playing ? pause() : play(); return true; } return false; },
  hover() { S.hover = null; }, wantsSnap() { return false; },
  draw() {
    const g = cur(); const P = g && g.parsed; if (!P) return; const c = App.ctx;
    // offset origin: the program coordinates are relative to program zero; draw in drawing coordinates for generated programs
    const org = S.viewer ? { x: 0, y: 0 } : (S.gen.origin || { x: 0, y: 0 });
    const T = (s) => { if (!s) return s; const f = (q) => V.add(q, org); const o = WC.cloneSeg(s); o.p0 = f(s.p0); o.p1 = f(s.p1); if (s.c) o.c = f(s.c); return o; };
    if (!S.viewer) { c.globalAlpha = 0.25; S.ents.filter(e => !S.hidden.has(e.layer)).forEach(e => App.strokePath([WC.entSeg(e)], '#aab', 1)); c.globalAlpha = 1; }
    const pos = sim.pos;
    for (const k of simSegs) {
      if (k.stop) continue; const s = T(k.s); const done = k.at + k.L <= pos + 1e-9;
      const col = k.m.type === 'rapid' ? '#8896a6' : (k.m.dIdx > 0 ? '#35c46f' : '#5fb0ff');
      const w = k.m.type === 'rapid' ? 1 : 2.2;
      App.strokePath([s], col, w, k.m.type === 'rapid' ? [6, 5] : []);
      if (k.top) App.strokePath([T(k.top)], '#ff5ad1', 1.3, [6, 4]);
      if (!done && k.at < pos) { const t = (pos - k.at) / k.L; const part = WC.segSplit(k.s, Math.max(1e-6, Math.min(1, t)))[0]; App.strokePath([T(part)], '#ffe14d', 3.2); }
      else if (done && pos > 0) App.strokePath([s], '#ffe14d', 3.2);
    }
    // arrows on cut moves
    simSegs.forEach(k => { if (!k.stop && k.m.type === 'cut' && k.L * S.view.scale > 60) App.drawArrow(T(k.s) && WC.segPoint(T(k.s), 0.5), WC.segTan(k.s, 0.5), k.m.dIdx > 0 ? '#35c46f' : '#5fb0ff', 7); });
    // stops
    simSegs.forEach(k => { if (k.stop) { const st = simState(k.at); if (st) { const p = V.add(st.pt, org); App.label(p, 'M' + k.m, '#fff', 8, 18, k.m === 2 ? '#555' : '#a33'); } } });
    // program zero
    App.dot(org, 6, '#fff', true); App.label(org, 'X0 Y0', '#fff', 8, -8, '#333');
    const st = simState(pos); if (st) { const p = V.add(st.pt, org); App.dot(p, 7, '#ffe14d'); if (st.top) { const q = V.add(st.top, org); App.dot(q, 5, '#ff5ad1'); App.strokePath([WC.segL(p, q)], '#ff5ad1', 1.5); } }
  },
};

// ------------------------------------------------------------------ code view
function codeHTML(text) {
  return text.split(/\r?\n/).map((l, i) => {
    if (l === '' && i === text.split(/\r?\n/).length - 1) return '';
    let h = esc(l); const ci = l.indexOf(';');
    if (ci === 0) h = '<span class="cm">' + h + '</span>';
    else { const pre = ci > 0 ? esc(l.slice(0, ci)) : h, post = ci > 0 ? '<span class="cm">' + esc(l.slice(ci)) + '</span>' : '';
      h = pre.replace(/\b(G\d+)/g, '<span class="g">$1</span>').replace(/\b(M\d+)/g, '<span class="m">$1</span>').replace(/\b(D\d+(=[\d.]+)?)/g, '<span class="d">$1</span>') + post; }
    return '<span class="ln" data-l="' + i + '"><i>' + (i + 1) + '</i>' + h + '</span>';
  }).join('');
}
function msgList(g) {
  const ic = { e: ICONS.warn, w: ICONS.warn, i: ICONS.check };
  let h = ''; (g.errors || []).forEach(m => h += `<div class="msg e">${ic.e}<span>${esc(m)}</span></div>`); (g.warnings || []).forEach(m => h += `<div class="msg w">${ic.w}<span>${esc(m)}</span></div>`);
  if (!g.viewing && !(g.errors || []).length && g.text) h += `<div class="msg i">${ic.i}<span>Program checked – no problems found.</span></div>`;
  return h;
}
function renderProgramPanel() {
  const P = $('#panel-program'); if (S.mode !== 'program') return;
  const g = cur();
  let html = '';
  if (S.viewer) {
    html += `<div class="card active"><div class="ch">📄 Viewing file <span class="sum">${esc(S.viewer.name)}</span></div><div class="cb"><div class="note">This is an existing program opened for checking. Green = cut with offset, blue = cut without offset, grey dashed = rapid move. Pink = top (UV) path.</div>
      <div class="kv"><span>D values</span><span>${Object.entries(S.viewer.parsed.dtab).map(([k, v]) => 'D' + k + '=' + v).join('  ') || '—'}</span><span>Cut length</span><span>${r3(S.viewer.parsed.moves.filter(m => m.type === 'cut').reduce((a, m) => a + WC.segLen(WC.moveSeg(m)), 0))} mm</span></div>
      <div class="row"><button class="btn" data-a="closeViewer">Close file – back to my program</button></div></div></div>`;
  } else {
    html += `<div class="card"><div class="ch">Program settings</div><div class="cb">
      <div class="row"><span class="lbl">Program name</span><input class="fld" data-s="name" value="${esc(S.prog.name)}" style="width:120px"><span class="note">.WC</span></div>
      <div class="row"><span class="lbl">Title (comment)</span><input class="fld" data-s="title" value="${esc(S.prog.title || '')}" style="flex:1"></div>
      <div class="row"><span class="lbl">Cutting condition E</span><input class="fld" data-c="eCode" value="${esc(cfg.eCode)}" placeholder="optional" style="width:90px"><span class="note">e.g. 1683 (empty = none)</span></div>
      <div class="row"><span class="lbl">Program end code</span><select class="fld" data-c="endCode"><option ${cfg.endCode === 'M0' ? 'selected' : ''}>M0</option><option ${cfg.endCode === 'M2' ? 'selected' : ''}>M2</option></select></div>
      ${S.jobs.length > 1 ? `<div class="row"><span class="lbl">Between cuts</span><select class="fld" data-c="thread"><option value="manual" ${cfg.thread !== 'auto' ? 'selected' : ''}>M0 – stop, operator cuts & threads wire</option><option value="auto" ${cfg.thread === 'auto' ? 'selected' : ''}>M20 / M21 – automatic cut & thread</option></select></div>` : ''}
    </div></div>`;
    const info = g.info; const jobs = S.jobs.filter(j => App.jobReady(j) && j.enabled !== false);
    if (info && g.text) html += `<div class="card"><div class="ch">Summary</div><div class="cb"><div class="kv"><span>Cuts</span><span>${jobs.length}</span><span>Cut length</span><span>${r3(info.cutLength)} mm (all passes)</span><span>Offsets</span><span>${(g.dvals || []).map((v, i) => 'D' + i + '=' + v).join('  ')}</span><span>Program zero</span><span>X0 Y0 = LEAD-IN point of cut 1 – set the machine zero there</span><span>Wire starts at</span><span>${(() => { const O = App.progOrigin(); return O ? 'X ' + r3(O.job.start.x - O.pt.x) + '  Y ' + r3(O.job.start.y - O.pt.y) + ' (start point)' : '—'; })()}</span></div></div></div>`;
  }
  html += `<div class="msgs">${msgList(g)}</div>`;
  if (!S.viewer) html += `<div class="row"><button class="btn big ${g.errors && g.errors.length ? '' : 'ok'}" data-a="save" ${g.text ? '' : 'disabled'} style="flex:1;justify-content:center">💾 SAVE PROGRAM (.WC)</button><button class="btn" data-a="copy" ${g.text ? '' : 'disabled'}>Copy</button></div>`;
  html += `<div class="card"><div class="ch">Simulation <span class="sum" id="simPos"></span></div><div class="cb">
    <div class="simbar"><button class="btn pri" id="simPlay" data-a="play"></button><button class="btn" data-a="restart" title="Back to start">${ICONS.restart}</button><button class="btn" data-a="step" title="Next block">${ICONS.step}</button><input type="range" id="simRange" min="0" max="1000" value="0"></div>
    <div class="row"><span class="lbl">Speed</span><select class="fld" id="simSpeed">${[0.25, 0.5, 1, 2, 4, 8].map(v => `<option value="${v}" ${sim.speed === v ? 'selected' : ''}>${v}×</option>`).join('')}</select><label class="chk note"><input type="checkbox" id="simStops" checked> pause at M0</label></div>
    <div class="note">Yellow = already cut. Space bar = play / pause.</div></div></div>`;
  html += `<div id="code">${codeHTML(g.text || '')}</div><div style="height:30px"></div>`;
  P.innerHTML = html; renderSimBar(); updateSimUI();
  P.querySelectorAll('[data-a]').forEach(el => el.onclick = () => act(el.dataset.a));
  P.querySelectorAll('[data-s]').forEach(el => el.onchange = () => { S.prog[el.dataset.s] = el.value.trim(); if (el.dataset.s === 'name') S.prog.name = S.prog.name.replace(/\.wc$/i, '').replace(/[\\/:*?"<>|]/g, ''); App.markChanged(); });
  P.querySelectorAll('[data-c]').forEach(el => el.onchange = () => { cfg[el.dataset.c] = el.value.trim(); App.saveCfg(); App.markChanged(); });
  const rng = $('#simRange'); rng.oninput = () => { pause(); sim.pos = simTotal * rng.value / 1000; updateSimUI(); App.redraw(); };
  $('#simSpeed').onchange = (e) => { sim.speed = parseFloat(e.target.value); };
  $('#code').addEventListener('click', e => { const ln = e.target.closest('.ln'); if (!ln) return; const l = +ln.dataset.l; const k = simSegs.find(x => !x.stop && x.m.line === l); if (k) { pause(); sim.pos = k.at + k.L; updateSimUI(); App.redraw(); } });
  hint(S.viewer ? 'Viewing ' + S.viewer.name + '. Press Play to see the wire move.' : (g.errors && g.errors.length ? 'Please read the RED messages before saving.' : 'Program ready. Press PLAY to check the wire movement, then SAVE PROGRAM.'), g.errors && g.errors.length);
}
async function act(a) {
  const g = cur();
  if (a === 'play') { sim.playing ? pause() : play(); }
  if (a === 'restart') { pause(); sim.pos = 0; updateSimUI(); App.redraw(); }
  if (a === 'step') stepBlock();
  if (a === 'closeViewer') { S.viewer = null; resetSim(); App.refreshPanels(); App.fit(); }
  if (a === 'copy') { try { await navigator.clipboard.writeText(g.text); toast('Program copied', 'o'); } catch (e) { toast('Copy not allowed here – use Save', 'w'); } }
  if (a === 'save') {
    if (g.errors && g.errors.length) { const ok = await App.modal('Problems found', '<p>The program has <b>' + g.errors.length + ' problem(s)</b>:</p><ul>' + g.errors.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul><p>Saving it can damage the job. Do you still want to save?</p>', [{ label: 'Go back and fix', value: false, cls: 'pri' }, { label: 'Save anyway', value: true }]); if (!ok) return; }
    const name = (S.prog.name || 'EMT0001').replace(/\.wc$/i, '') + '.WC';
    const p = await App.saveText(name, g.text, 'wc'); if (p) toast('Program saved: ' + String(p).split(/[\\/]/).pop(), 'o', 4000);
  }
}
App.renderProgramPanel = renderProgramPanel;
App.enterProgramMode = () => { if (!S.viewer) generate(); else resetSim(); renderProgramPanel(); App.redraw(); };
App.viewProgramFile = (name, text) => { const parsed = WC.parseWC(text); S.viewer = { name, text, parsed }; App.setMode('program'); resetSim(); renderProgramPanel(); const b = parsed.bbox; if (isFinite(b.x0)) App.fitBox(b); toast('Opened program ' + name + ' for viewing', 'o'); };
})();
