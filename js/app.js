/* Visual Python — draws any Python program: memory, flowchart and graphics */
(function () {
  'use strict';

  const W = 400, H = 400;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  const isAr = (t) => /[؀-ۿ]/.test(t);
  // Text is right-to-left only if it starts with an Arabic letter
  // Isolate quoted strings and identifiers so mixed-direction text renders correctly
  const bidiFix = (t) => t.replace(/(["'])(?:(?!\1).)*\1|[A-Za-z_][\w.]*(?:\(\))?/g, (m) => '\u2068' + m + '\u2069');
  const startsAr = (t) => /^[^A-Za-z0-9_]*[؀-ۿ]/.test(t);

  const st = {
    py: null, ready: false, busy: false, pending: false,
    result: null, display: [],
    mode: 'idle', idx: 0, timer: null,
    auto: store.get('vp-auto') !== '0',
    tab: store.get('vp-tab') || 'mem',
    zoom: 1, flowSize: { w: 0, h: 0 },
    selLine: 0, loading: false,
    view: { n: 0, hi: null },
    hadGfx: false,
    memZoom: +(store.get('vp-memzoom') || 1),
    pos: {},       // memory box offsets after dragging
    flowPos: {},   // flowchart offsets after dragging
    drag: null, suppressClick: false,
    conceptOpen: store.get('vp-concept') !== '0',
  };

  const DEFAULT_CODE = window.EXAMPLES[0].code;

  /* ================= Editor ================= */
  const cm = CodeMirror(document.getElementById('editor'), {
    value: store.get('vp-code') ?? DEFAULT_CODE,
    mode: 'python', lineNumbers: true, indentUnit: 4, tabSize: 4,
    direction: 'ltr', gutters: ['step-gutter', 'CodeMirror-linenumbers'],
    extraKeys: {
      'Ctrl-Enter': () => run(), 'Cmd-Enter': () => run(),
      Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('    ', 'end')),
      'Shift-Tab': (c) => c.indentSelection('subtract'),
    },
  });

  let marks = [];
  function clearMarks() {
    marks.forEach(([h, c]) => cm.removeLineClass(h, 'background', c));
    marks = [];
    cm.clearGutter('step-gutter');
  }
  function mark(line, cls) {
    if (line < 1 || line > cm.lineCount()) return;
    marks.push([cm.addLineClass(line - 1, 'background', cls), cls]);
  }
  function gutter(line, cls, ch) {
    if (line < 1 || line > cm.lineCount()) return;
    const el = document.createElement('span');
    el.className = 'gut ' + cls;
    el.textContent = ch;
    cm.setGutterMarker(line - 1, 'step-gutter', el);
  }
  let hoverMark = null;
  function setHoverLine(line) {
    if (hoverMark) { cm.removeLineClass(hoverMark, 'background', 'cm-line-hover'); hoverMark = null; }
    if (line > 0 && line <= cm.lineCount()) hoverMark = cm.addLineClass(line - 1, 'background', 'cm-line-hover');
  }
  const lineText = (n) => (n >= 1 && n <= cm.lineCount() ? cm.getLine(n - 1) : '');
  const indentOf = (n) => lineText(n).match(/^\s*/)[0].replace(/\t/g, '    ').length;

  /* ================= Running Python ================= */
  // When Python is ready, the status is replaced by the dedication heart
  let statusT = null;
  function setStatus(cls, text) {
    clearTimeout(statusT);
    const idle = cls === 'ready' && text === 'Python ready';
    $('#status').className = 'status ' + cls;
    $('#statusText').textContent = text;
    $('#status').hidden = idle;
    $('#btnDedication').hidden = !idle;
    // short "ready" messages go back to the heart after a moment
    if (cls === 'ready' && !idle) statusT = setTimeout(() => setStatus('ready', 'Python ready'), 2500);
  }
  const dedication = $('#dedication');
  // A random picture under the sentence each time (never the same one twice in a row)
  const MEMES = [1, 2, 3, 4, 5].map((n) => `img/meme/meme${n}.jpg`);
  let lastMeme = -1;
  $('#btnDedication').addEventListener('click', () => {
    let k;
    do { k = Math.floor(Math.random() * MEMES.length); } while (MEMES.length > 1 && k === lastMeme);
    lastMeme = k;
    const img = $('#dedicationImg');
    img.src = MEMES[k];
    img.hidden = false;
    dedication.showModal();
  });
  // click outside the card closes it
  dedication.addEventListener('click', (e) => {
    const r = dedication.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dedication.close();
  });

  async function boot() {
    try {
      st.py = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
      st.py.runPython(window.PY_ENGINE);
      st.ready = true;
      setStatus('ready', 'Python ready');
      $('#btnRun').disabled = false;
      $('#btnStep').disabled = false;
      // Deep links such as #tab=flow&step=5&ex=2
      const h = new URLSearchParams(location.hash.slice(1));
      if (h.has('ex') && window.EXAMPLES[+h.get('ex')]) { st.loading = true; cm.setValue(window.EXAMPLES[+h.get('ex')].code); st.loading = false; }
      if (h.has('tab')) switchTab(h.get('tab'));
      if (h.has('step')) {
        startStep(+h.get('step') - 1);
      } else run();
    } catch (e) {
      console.error(e);
      setStatus('error', 'Could not load Python. Check your internet connection and reload.');
    }
  }

  // Load packages the code imports (numpy, matplotlib, ...) then run
  async function execute() {
    const src = cm.getValue();
    try {
      setStatus('loading', 'Loading packages…');
      await st.py.loadPackagesFromImports(src);
    } catch (e) { console.warn(e); }
    setStatus('loading', 'Running…');
    await new Promise((r) => setTimeout(r, 0));
    st.py.globals.set('__vp_src', src);
    st.py.globals.set('__vp_in', $('#stdin').value);
    st.py.runPython('_set_stdin(__vp_in)');
    const json = st.py.runPython('_run(__vp_src)');
    st.result = JSON.parse(json);
    setStatus('ready', 'Python ready');
    buildDisplay();
  }

  // Each display step = one executed line: state before (b) and after (a)
  function buildDisplay() {
    const S = st.result.steps;
    const idx = [];
    S.forEach((s, i) => { if (s.kind === 'line') idx.push(i); });
    st.display = idx.map((bi, k) => {
      const ai = k + 1 < idx.length ? idx[k + 1] : S.length - 1;
      return { b: S[bi], a: S[ai], rets: S.slice(bi + 1, ai).filter((s) => s.kind === 'return') };
    });
  }

  async function guarded(fn) {
    if (!st.ready) return;
    if (st.busy) { st.pending = fn; return; }
    st.busy = true;
    stopPlay();
    try { await execute(); fn(); } catch (e) { internalError(e); }
    st.busy = false;
    if (st.pending) { const p = st.pending; st.pending = false; guarded(p); }
  }
  const run = () => guarded(showFinal);
  const startStep = (at = 0) => guarded(() => {
    if (!st.display.length) { showFinal(); return; }
    st.mode = 'step';
    $('#stepper').hidden = false;
    $('#stepRange').max = st.display.length - 1;
    renderFlow(st.result.flow);
    showStep(typeof at === 'number' ? at : 0);
  });

  function internalError(e) {
    console.error(e);
    setStatus('ready', 'Python ready');
    $('#explain').innerHTML = `<div class="error-box"><b>Internal error</b><pre>${esc(e.message || e)}</pre></div>`;
  }

  /* ================= Snapshot helpers ================= */
  function heapOf(s) { if (!s._h) s._h = new Map(s.heap || []); return s._h; }
  const topFrame = (s) => s.stack[s.stack.length - 1];
  function findVar(s, name) {
    const top = topFrame(s);
    for (const f of [top, s.stack[0]]) {
      if (!f) continue;
      const e = f.vars.find((v) => v[0] === name);
      if (e) return e[1];
    }
    return null;
  }
  function valText(enc, s) {
    if (!enc) return '?';
    if (enc[0] === 'P') return enc[2];
    const o = heapOf(s).get(enc[1]);
    return o ? o.r : '…';
  }
  const isSimple = (enc) => enc && enc[0] === 'P' && ['int', 'float', 'str', 'bool', 'NoneType'].includes(enc[1]);
  const showV = (enc, s) => `<code>${esc(valText(enc, s))}</code>`;
  const lastStep = () => { const S = st.result && st.result.steps; return S && S.length ? S[S.length - 1] : null; };

  /* ================= Final result ================= */
  function showFinal() {
    st.mode = 'final';
    $('#stepper').hidden = true;
    clearMarks();
    const r = st.result;
    if (r.error) { mark(r.error.line, 'cm-line-error'); gutter(r.error.line, 'gut-err', '✕'); }
    renderMem(lastStep(), null);
    renderFlow(r.flow);
    updateFlow(0, countsUpTo(st.display.length - 1));
    renderOut(r.out.length, -1);
    st.view = { n: r.cmds.length, hi: null };
    renderGfx();
    explainFinal();
  }

  function explainFinal() {
    const r = st.result;
    const parts = [];
    if (r.error) parts.push(errorHtml(r.error));
    else parts.push(`<div class="ok-box"><b>Program finished</b> in <b>${st.display.length}</b> steps.</div>`);
    if (st.display.length) {
      const lines = new Set(st.display.map((d) => d.b.line));
      const calls = st.display.filter((d) => d.a.stack.length > d.b.stack.length).length;
      const depth = Math.max(...r.steps.map((s) => s.stack.length)) - 1;
      const objs = new Set();
      r.steps.forEach((s) => (s.heap || []).forEach(([id, o]) => { if (o.t !== 'function' && o.t !== 'class') objs.add(id); }));
      const printed = r.out.join('').split('\n').filter(Boolean).length;
      parts.push(`<h5>Summary</h5><ul>
        <li><b>${lines.size}</b> different lines ran, ${st.display.length} line executions in total.</li>
        ${calls ? `<li><b>${calls}</b> function call${calls > 1 ? 's' : ''}${depth > 1 ? `; the deepest point was <b>${depth}</b> calls inside each other` : ''}.</li>` : ''}
        ${objs.size ? `<li><b>${objs.size}</b> object${objs.size > 1 ? 's' : ''} (lists, dicts, instances…) were created.</li>` : ''}
        ${printed ? `<li><b>${printed}</b> line${printed > 1 ? 's' : ''} printed to the Output.</li>` : ''}
      </ul>`);
    }
    if (r.truncated) parts.push(`<p class="note">This program is long, so step-by-step mode shows only the first ${r.maxRec} steps.</p>`);
    parts.push(`<ul class="tips">
      <li class="tip">Press <b>Step by step</b> to watch memory and the flowchart change line by line.</li>
      <li class="tip">An arrow in <b>Memory</b> means the variable <i>refers to</i> that object.</li>
      <li class="tip">Drag any box to rearrange the diagram. Click a flowchart shape to jump to its line.</li>
    </ul>`);
    $('#explain').innerHTML = parts.join('');
  }

  /* ================= Step by step ================= */
  function countsUpTo(i) {
    const c = new Map();
    for (let k = 0; k <= i && k < st.display.length; k++) {
      const l = st.display[k].b.line;
      c.set(l, (c.get(l) || 0) + 1);
    }
    return c;
  }

  function showStep(i) {
    i = Math.max(0, Math.min(i, st.display.length - 1));
    st.idx = i;
    const d = st.display[i];
    const { b, a } = d;
    const isLast = i === st.display.length - 1;
    clearMarks();
    mark(b.line, 'cm-line-exec');
    gutter(b.line, 'gut-exec', '➜');
    if (a.kind === 'error') { mark(a.line, 'cm-line-error'); gutter(a.line, 'gut-err', '✕'); }
    else if (a.kind === 'line' && a.line !== b.line) mark(a.line, 'cm-line-next');
    cm.scrollIntoView({ line: b.line - 1, ch: 0 }, 80);

    renderMem(a, b);
    updateFlow(b.line, countsUpTo(i));
    renderOut(a.no, b.no);
    st.view = { n: a.nc, hi: [b.nc, a.nc] };
    renderGfx();
    explainStep(i, isLast);

    $('#stepRange').value = i;
    $('#stepCount').textContent = `Step ${i + 1} of ${st.display.length}`;
    $('#btnPrev').disabled = $('#btnFirst').disabled = i === 0;
    $('#btnNext').disabled = $('#btnLast').disabled = isLast;
  }

  const speedMs = () => Math.round(1600 - (+$('#speed').value) * 15);
  function play() {
    if (st.mode !== 'step') return;
    if (st.idx >= st.display.length - 1) showStep(0);
    $('#btnPlay').textContent = '❚❚ Pause';
    const tick = () => {
      if (st.idx >= st.display.length - 1) { stopPlay(); return; }
      showStep(st.idx + 1);
      st.timer = setTimeout(tick, speedMs());
    };
    st.timer = setTimeout(tick, speedMs());
  }
  function stopPlay() {
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    $('#btnPlay').textContent = '▶ Play';
  }

  /* ================= Memory diagram ================= */
  const TNAME = { generator: 'generator', list: 'list', tuple: 'tuple', set: 'set', dict: 'dict', function: 'function', class: 'class', instance: 'object', file: 'file', bytes: 'bytes', table: 'table' };
  // Legend: one entry per shape (icon + name + what it means)
  const KINDS = {
    class: ['Class', 'blueprint for objects'],
    instance: ['Object', 'made from a class'],
    function: ['Function', 'code you can call'],
    generator: ['Generator', 'paused function that yields values'],
    list: ['List', 'ordered, changeable'],
    tuple: ['Tuple', 'ordered, cannot change'],
    dict: ['Dict', 'key → value'],
    set: ['Set', 'no duplicates'],
    bytes: ['Bytes', 'raw numbers 0-255'],
    table: ['Table', 'pandas / numpy'],
    file: ['File object', 'open connection to a file'],
    disk: ['File on disk', 'saved data'],
  };

  function primClass(t) {
    if (t === 'str') return 'p-str';
    if (t === 'int' || t === 'float' || t === 'complex') return 'p-num';
    if (t === 'bool' || t === 'NoneType') return 'p-kw';
    return 'p-other';
  }
  function valHtml(v) {
    if (v[0] === 'R') return `<span class="ref" data-ref="${esc(v[1])}" title="Reference to an object"></span>`;
    return `<span class="p ${primClass(v[1])}" ${isAr(v[2]) ? 'dir="auto"' : ''}>${esc(v[2])}</span>`;
  }
  function childRefs(o) {
    const out = [];
    const add = (v) => { if (v && v[0] === 'R') out.push(v[1]); };
    if (o.t === 'bytes') return out;
    if (o.items) o.items.forEach((it) => (o.t === 'dict' ? (add(it[0]), add(it[1])) : add(it)));
    if (o.attrs) o.attrs.forEach((it) => add(it[1]));
    if (o.closure) o.closure.forEach((it) => add(it[1]));
    return out;
  }
  function kvTable(rows, kcls, head) {
    if (!rows.length) return '<div class="none">empty</div>';
    return `<table class="kv">${head ? `<tr class="kv-head"><th>${head[0]}</th><th>${head[1]}</th></tr>` : ''}${rows.map(([k, v]) => `<tr><td class="${kcls}">${typeof k === 'string' ? esc(k) : valHtml(k)}</td><td>${valHtml(v)}</td></tr>`).join('')}</table>`;
  }
  const fmtSize = (n) => (n == null ? '?' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  const MODES = { r: 'read', w: 'write (erase first)', a: 'append', x: 'create new', 'r+': 'read + write', 'w+': 'write + read', 'a+': 'append + read', memory: 'in memory' };
  const modeText = (m) => { const k = String(m || '').replace(/[bt]/g, ''); return (MODES[k] || m) + (/b/.test(m) ? ', binary' : ''); };

  // What Python uses each special method for
  const SPECIAL = {
    __init__: 'runs when an object is created', __str__: 'used by print() and str()', __repr__: 'how the object is shown',
    __len__: 'used by len()', __eq__: 'used by ==', __lt__: 'used by <', __gt__: 'used by >', __le__: 'used by <=', __ge__: 'used by >=',
    __add__: 'used by +', __sub__: 'used by -', __mul__: 'used by *', __getitem__: 'used by obj[key]', __setitem__: 'used by obj[key] = v',
    __iter__: 'used by for loops', __next__: 'next item in a loop', __contains__: 'used by in', __call__: 'obj() like a function',
    __enter__: 'start of with', __exit__: 'end of with', __hash__: 'used by sets and dict keys', __bool__: 'used by if obj',
    __del__: 'runs when the object is deleted',
  };
  function objHtml(id, o, changed) {
    let label = TNAME[o.t] || esc(o.type || o.t), body = '', icon = '', extra = '';
    const more = o.n > (o.items ? o.items.length : 0) ? `<div class="cell more">+${o.n - o.items.length}</div>` : '';
    switch (o.t) {
      case 'list': case 'tuple': case 'set':
        icon = o.t === 'list' ? '[ ]' : o.t === 'tuple' ? '( )' : '{ }';
        body = o.items.length
          ? `<div class="cells">${o.items.map((v, i) => `<div class="cell">${o.t !== 'set' ? `<span class="idx">${i}</span>` : ''}<span class="cv">${valHtml(v)}</span></div>`).join('')}${more}</div>`
          : '<div class="none">empty</div>';
        label += ` <small>${o.n} item${o.n === 1 ? '' : 's'}${o.t === 'tuple' ? ' · 🔒 cannot change' : ''}</small>`;
        break;
      case 'bytes':
        icon = '01';
        label = `${esc(o.type)} <small>${o.n} byte${o.n === 1 ? '' : 's'}</small>`;
        body = o.items.length
          ? `<div class="cells">${o.items.map((b, i) => `<div class="cell"><span class="idx">${i}</span><span class="cv"><span class="p p-num">${b}</span><span class="byte-ch">${b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : '·'}</span></span></div>`).join('')}${more}</div>`
          : '<div class="none">empty</div>';
        break;
      case 'dict':
        icon = '{:}';
        label += ` <small>${o.n} pair${o.n === 1 ? '' : 's'}</small>`;
        body = kvTable(o.items, 'dk', ['key', 'value']) + (o.n > o.items.length ? `<div class="none">… and ${o.n - o.items.length} more</div>` : '');
        break;
      case 'instance':
        icon = '●';
        label = `<b>${esc(o.cls)}</b> object`;
        extra = o.clsref && o.clsref[0] === 'R' ? `<div class="inst-of">instance of <b>${esc(o.cls)}</b><span class="ref cls-ref" data-ref="${esc(o.clsref[1])}" title="Its class"></span></div>` : '';
        body = extra + (o.attrs.length ? kvTable(o.attrs, 'ak') : '<div class="none">no attributes yet</div>');
        break;
      case 'class': {
        icon = '📐';
        label = `class <b>${esc(o.name)}</b>${o.bases.length ? ` <small>extends ${esc(o.bases.join(', '))}</small>` : ''}`;
        const meths = o.attrs.filter(([, v]) => v[0] === 'P' && v[1] === 'method');
        const fields = o.attrs.filter(([, v]) => !(v[0] === 'P' && v[1] === 'method'));
        const isSpecial = (k) => /^__\w+__$/.test(k);
        const pill = ([k, v]) => `<span class="meth${isSpecial(k) ? ' special' : ''}" title="${isSpecial(k) ? 'Special method: Python calls it for you' : 'Method'}">${esc(v[2])}${isSpecial(k) && SPECIAL[k] ? ` <small>${SPECIAL[k]}</small>` : ''}</span>`;
        body = (o.baserefs || []).map(([n, r]) => `<div class="inst-of">inherits from <b>${esc(n)}</b><span class="ref cls-ref" data-ref="${esc(r[1])}" title="Parent class"></span></div>`).join('')
          + (o.fields && o.fields.length ? `<div class="sec">Fields (dataclass)</div>${kvTable(o.fields.map(([k, t]) => [k, ['P', 'type', t]]), 'ak')}` : '')
          + (fields.length ? `<div class="sec">Class variables <small>(shared by all objects)</small></div>${kvTable(fields, 'ak')}` : '')
          + (meths.length ? `<div class="sec">Methods</div><div class="meths">${meths.map(pill).join('')}</div>` : '')
          + (!o.attrs.length && !(o.fields && o.fields.length) ? '<div class="none">empty class</div>' : '');
        break;
      }
      case 'function':
        icon = o.name === '<lambda>' ? 'λ' : 'ƒ';
        label = '';
        body = `<div class="fn">${o.name === '<lambda>' ? '<span class="sig">lambda</span>' : esc(o.name)}<span class="sig">${esc(o.sig)}</span>${o.gen ? ' <span class="tag-gen" title="Contains yield: calling it makes a generator">generator function</span>' : ''}</div>`;
        if (o.closure && o.closure.length) {
          // closure: values remembered from the outer function
          return `<div class="obj obj-function has-closure${changed ? ' changed' : ''}" id="obj-${esc(id)}" data-key="o:${esc(id)}"><div class="fn-row"><div class="obj-h"><span class="grip" aria-hidden="true">⠿</span><span class="ico">${icon}</span></div>${body}</div><div class="closure"><div class="sec">Remembers (closure)</div>${kvTable(o.closure, 'ak')}</div></div>`;
        }
        break;
      case 'generator': {
        const ic = { suspended: '⏸', running: '▶', created: '○', closed: '■' };
        icon = ic[o.state] || '⏸';
        label = `generator <b>${esc(o.name)}</b>`;
        const stTxt = { created: 'created, not started yet', suspended: `paused at line ${o.line}`, running: 'running now', closed: 'finished (no more values)' }[o.state] || o.state;
        body = `<div class="gen-state gs-${esc(o.state)}">${esc(stTxt)}</div>${o.attrs.length ? `<div class="sec">Saved local variables</div>${kvTable(o.attrs, 'ak')}` : ''}`;
        break;
      }
      case 'file': {
        icon = '📄';
        label = `file <b>${esc(o.name == null ? '(memory)' : o.name)}</b>`;
        const st_ = o.closed ? '<span class="badge-st closed">closed</span>' : '<span class="badge-st open">open</span>';
        const pct = o.pos != null && o.size ? Math.min(100, Math.round((o.pos / o.size) * 100)) : 0;
        body = `<table class="kv">
            <tr><td class="ak">mode</td><td><code>${esc(o.mode)}</code> <small>${esc(modeText(o.mode))}</small></td></tr>
            <tr><td class="ak">state</td><td>${st_}</td></tr>
            ${o.closed ? '' : `<tr><td class="ak">cursor</td><td>${o.pos == null ? '<small>moving (for loop)</small>' : `<div class="cursor-bar"><i style="width:${pct}%"></i></div><small>position ${o.pos}${o.size != null ? ` of ${o.size}` : ''}</small>`}</td></tr>`}
            ${o.enc ? `<tr><td class="ak">encoding</td><td><small>${esc(o.enc)}</small></td></tr>` : ''}
          </table>${o.path ? `<div class="to-disk">on disk<span class="ref disk-ref" data-ref="d:${esc(o.path)}" title="The file on disk"></span></div>` : (o.mode === 'memory' ? `<pre class="repr">${esc(o.r)}</pre>` : '')}`;
        break;
      }
      case 'table': {
        icon = '▦';
        label = `${esc(o.type)} <small>${esc((o.shape || []).join(' × '))}${o.dtype ? ` · ${esc(o.dtype)}` : ''}</small>`;
        const hasIdx = o.idx && o.idx.length;
        body = `<div class="grid-wrap"><table class="grid"><tr>${hasIdx ? '<th class="gi"></th>' : ''}${o.cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${o.rows.map((row, r) => `<tr>${hasIdx ? `<th class="gi">${esc(o.idx[r])}</th>` : ''}${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
        break;
      }
      default:
        body = `<pre class="repr">${esc(o.r)}</pre>`;
    }
    return `<div class="obj obj-${o.t}${changed ? ' changed' : ''}" id="obj-${esc(id)}" data-key="o:${esc(id)}"><div class="obj-h"><span class="grip" aria-hidden="true">⠿</span>${icon ? `<span class="ico">${icon}</span>` : ''}${label}</div>${body}</div>`;
  }

  // A file saved on the virtual disk (folder-tab shape, content with visible line endings)
  function diskHtml(e, prevMap, cursor) {
    const [path, size, kind, prev, cut] = e;
    const old = prevMap && prevMap.get(path);
    const isNew = prevMap && !old;
    const changed = prevMap && old && JSON.stringify(old) !== JSON.stringify(e);
    let content;
    if (kind === 'bin') {
      content = `<div class="bin">${prev.map((b) => `<span>${b.toString(16).padStart(2, '0')}</span>`).join('')}${cut || size > prev.length ? '<span class="more">…</span>' : ''}</div><div class="none">binary file: bytes shown in hex, not readable as text</div>`;
    } else if (!prev) {
      content = '<div class="none">empty file</div>';
    } else {
      const lines = prev.split('\n');
      const last = lines.pop();
      const rows = lines.map((l) => [l, true]);
      if (last !== '' || !rows.length) rows.push([last, false]);
      // cursor: position of an open file object reading this file (text before it is "already read")
      const enc = new TextEncoder();
      let off = 0;
      const lineHtml = (l, nl) => {
        const cr = /\r$/.test(l), body = cr ? l.slice(0, -1) : l;
        const start = off, len = enc.encode(l).length + (nl ? 1 : 0);
        off += len;
        const ends = (cr ? '<span class="eol">\\r</span>' : '') + (nl ? '<span class="eol" title="newline character">\\n</span>' : '');
        if (cursor == null || cursor >= start + len) return cursor != null ? `<span class="done">${esc(body)}${ends}</span>` : esc(body) + ends;
        if (cursor < start) return esc(body) + ends;
        // the cursor is inside this line: split at the matching character
        let b = 0, cut = 0;
        for (const ch of body) { if (start + b >= cursor) break; b += enc.encode(ch).length; cut += ch.length; }
        const caret = '<span class="caret" title="file cursor"></span>';
        if (start + b >= cursor && cut <= body.length) return `<span class="done">${esc(body.slice(0, cut))}</span>${caret}${esc(body.slice(cut))}${ends}`;
        return `<span class="done">${esc(body)}</span>${caret}${ends}`;
      };
      const parts = rows.map(([l, nl]) => lineHtml(l, nl));
      const atEnd = cursor != null && cursor >= off;
      content = `<div class="lines">${rows.slice(0, 40).map((r, k) => `<div class="ln-row"><span class="ln-no">${k + 1}</span><span class="ln-tx" dir="auto">${parts[k]}${atEnd && k === Math.min(rows.length, 40) - 1 ? '<span class="caret" title="file cursor: end of file"></span>' : ''}</span></div>`).join('')}${rows.length > 40 || cut ? '<div class="ln-row"><span class="ln-no"></span><span class="ln-tx none">…</span></div>' : ''}</div>`;
      if (cursor != null) content += `<div class="none">▍ cursor at position ${cursor}${atEnd ? ' (end of file)' : ''} · <span class="done">shaded</span> = already read</div>`;
    }
    return `<div class="obj obj-disk${isNew || changed ? ' changed' : ''}" id="obj-d:${esc(path)}" data-key="o:d:${esc(path)}"><div class="obj-h"><span class="grip" aria-hidden="true">⠿</span><span class="ico">🗎</span><b>${esc(path)}</b> <small>${fmtSize(size)}${isNew ? ' · new' : changed ? ' · changed' : ''}</small></div>${content}</div>`;
  }

  function renderMem(s, prev) {
    const box = $('#mem');
    if (!s) { box.innerHTML = '<p class="empty">Run the code to see memory.</p>'; return; }
    const heap = heapOf(s);
    const prevHeap = prev ? heapOf(prev) : null;
    const prevFrames = prev ? new Map(prev.stack.map((f) => [f.fid, f])) : null;

    let fh = '';
    s.stack.forEach((f, i) => {
      const active = i === s.stack.length - 1 && s.stack.length > 1;
      const pf = prevFrames && prevFrames.get(f.fid);
      const pv = pf ? new Map(pf.vars.map(([k, v]) => [k, JSON.stringify(v)])) : null;
      const title = f.name === '<module>' ? 'Global frame' : `${esc(f.name)}() <small>local frame</small>`;
      const rows = f.vars.map(([k, v]) => {
        const changed = prev && (!pv || pv.get(k) !== JSON.stringify(v));
        return `<tr class="${changed ? 'changed' : ''}"><td class="vn">${esc(k)}</td><td class="vv">${valHtml(v)}</td></tr>`;
      }).join('');
      fh += `<div class="frame${active ? ' active' : ''}${prev && !pf ? ' new' : ''}" data-key="f:${esc(f.fid)}"><div class="frame-h"><span class="grip" aria-hidden="true">⠿</span>${title}</div>${rows ? `<table>${rows}</table>` : '<div class="none">no variables</div>'}</div>`;
    });

    // Layout: each object referenced by a variable starts a row; its children follow it
    const placed = new Set(), rows = [];
    const place = (id, row) => {
      if (placed.has(id) || !heap.has(id)) return;
      placed.add(id); row.push(id);
      childRefs(heap.get(id)).forEach((c) => place(c, row));
    };
    s.stack.forEach((f) => f.vars.forEach(([, v]) => {
      if (v[0] === 'R' && !placed.has(v[1])) { const row = []; place(v[1], row); rows.push(row); }
    }));
    (s.heap || []).forEach(([id]) => { if (!placed.has(id)) { const row = []; place(id, row); rows.push(row); } });

    const hh = rows.map((row) => `<div class="heap-row">${row.map((id) => {
      const o = heap.get(id);
      const changed = prevHeap && (!prevHeap.has(id) || JSON.stringify(prevHeap.get(id)) !== JSON.stringify(o));
      return objHtml(id, o, changed);
    }).join('')}</div>`).join('');

    // Files on the virtual disk: shown when the program touches files
    const disks = st.result && st.result.disks;
    const dk = disks && s.dk != null ? disks[s.dk] : null;
    const pdk = disks && prev && prev.dk != null ? disks[prev.dk] : null;
    const usesFiles = [...heap.values()].some((o) => o.t === 'file') || /\b(open|pickle|shelve|csv|read_csv|to_csv)\b/.test(cm.getValue());
    let disk = '';
    if (dk && usesFiles) {
      const pm = pdk && prev ? new Map(pdk.map((e) => [e[0], e])) : null;
      // Open read-mode files show their cursor on the disk copy
      const cursors = new Map();
      heap.forEach((o) => { if (o.t === 'file' && !o.closed && o.path && o.pos != null && /r/.test(o.mode) && !/b/.test(o.mode)) cursors.set(o.path, o.pos); });
      const gone = pm ? [...pm.keys()].filter((k) => !dk.some((e) => e[0] === k)) : [];
      disk = `<div class="mem-disk"><h4>Disk <small>(files)</small></h4>${dk.map((e) => diskHtml(e, pm, cursors.get(e[0]))).join('') || '<div class="none">No files.</div>'}${gone.map((g) => `<div class="none">🗑 ${esc(g)} was deleted</div>`).join('')}</div>`;
    }
    const kinds = new Set([...heap.values()].map((o) => o.t));
    if (disk) kinds.add('disk');
    const legend = Object.keys(KINDS).filter((k) => kinds.has(k)).map((k) => `<span class="lg lg-${k}"><i></i>${KINDS[k][0]} <small>${KINDS[k][1]}</small></span>`).join('');

    box.innerHTML = `${legend ? `<div class="legend">${legend}</div>` : ''}<div class="mem-cols">
        <div class="mem-frames"><h4>Frames</h4>${fh}</div>
        <div class="mem-heap"><h4>Objects</h4>${hh || '<div class="none">No objects yet. Simple values (numbers, strings) are shown directly in the frame.</div>'}</div>
        ${disk}
      </div><svg class="mem-arrows" width="1" height="1" aria-hidden="true"></svg>`;
    // Restore positions the user dragged boxes to
    box.querySelectorAll('[data-key]').forEach((el) => {
      const p = st.pos[el.dataset.key];
      if (p) { el.style.translate = `${p[0]}px ${p[1]}px`; el.classList.add('moved'); }
    });
    applyMemZoom();
    requestAnimationFrame(drawArrows);
  }

  function applyMemZoom() {
    const box = $('#mem');
    box.style.transform = `scale(${st.memZoom})`;
    const z = st.memZoom;
    let w = box.offsetWidth, h = box.offsetHeight;
    const br = box.getBoundingClientRect();
    box.querySelectorAll('.moved').forEach((el) => {
      const r = el.getBoundingClientRect();
      w = Math.max(w, (r.right - br.left) / z + 30);
      h = Math.max(h, (r.bottom - br.top) / z + 30);
    });
    const sizer = $('#memSizer');
    sizer.style.width = w * z + 'px';
    sizer.style.height = h * z + 'px';
  }

  const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#be123c'];
  const arrowColors = new Map();
  function arrowColor(id) {
    if (!arrowColors.has(id)) arrowColors.set(id, arrowColors.size % PALETTE.length);
    return arrowColors.get(id);
  }
  const ARROW_COLORS = { list: '#3b82f6', tuple: '#0ea5e9', set: '#14b8a6', dict: '#8b5cf6', instance: '#10b981', class: '#f59e0b', function: '#64748b', other: '#94a3b8' };
  let arrowRaf = 0;
  const scheduleArrows = () => { if (!arrowRaf) arrowRaf = requestAnimationFrame(() => { arrowRaf = 0; drawArrows(); }); };

  function drawArrows() {
    const box = $('#mem');
    const svg = box.querySelector('svg.mem-arrows');
    if (!svg || box.offsetParent === null) return;
    // Screen coordinates are scaled by zoom, so divide by it
    const z = st.memZoom;
    const br = box.getBoundingClientRect();
    const X = (v) => (v - br.left) / z, Y = (v) => (v - br.top) / z;
    // Every box (frames and objects): arrows fade where they pass over one
    const boxes = [...box.querySelectorAll('[data-key]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { key: el.dataset.key, x: X(r.left), y: Y(r.top), w: r.width / z, h: r.height / z };
    });
    let paths = '', masks = '';
    box.querySelectorAll('.ref').forEach((el, i) => {
      el.dataset.i = i;
      const t = document.getElementById('obj-' + el.dataset.ref);
      if (!t) return;
      const owner = el.closest('[data-key]');
      const src = owner ? owner.dataset.key : '', dst = 'o:' + el.dataset.ref;
      const a = el.getBoundingClientRect(), b = t.getBoundingClientRect();
      const sx = X(a.left + a.width / 2), sy = Y(a.top + a.height / 2);
      const bl = X(b.left), brt = X(b.right), bt = Y(b.top), bb = Y(b.bottom);
      const ey = Math.min(bt + 18, (bt + bb) / 2);
      let d;
      if (bl > sx + 12) {
        const dx = Math.max(30, (bl - sx) / 2);
        d = `M${sx},${sy} C${sx + dx},${sy} ${bl - dx},${ey} ${bl},${ey}`;
      } else if (brt < sx - 12) {
        const dx = Math.max(30, (sx - brt) / 2);
        d = `M${sx},${sy} C${sx - dx},${sy} ${brt + dx},${ey} ${brt},${ey}`;
      } else {
        d = `M${sx},${sy} C${sx - 70},${sy} ${bl - 70},${ey} ${bl},${ey}`;
      }
      // Mask: the arrow is faint wherever it is over a box (including the one it starts in)
      const holes = boxes
        .map((q) => `<rect x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" fill="#444"/>`).join('');
      masks += `<mask id="am${i}" maskUnits="userSpaceOnUse" x="-10000" y="-10000" width="30000" height="30000"><rect x="-10000" y="-10000" width="30000" height="30000" fill="#fff"/>${holes}</mask>`;
      // Special links: object -> its class, file object -> file on disk (dashed)
      if (el.classList.contains('cls-ref') || el.classList.contains('disk-ref')) {
        const disk = el.classList.contains('disk-ref');
        const col = disk ? '#a16207' : '#6b7280';
        el.style.background = col;
        paths += `<path d="${d}" class="arrow link" style="stroke:${col}" stroke-dasharray="6 5" mask="url(#am${i})" data-i="${i}" data-src="${src}" data-to="${esc(dst)}" marker-end="url(#ah-${disk ? 'd' : 'g'})"/>`;
        return;
      }
      // Each variable keeps its own colour across steps; its dot takes the same colour
      const label = ((el.closest('tr, .cell') || el).querySelector('td, .idx') || {}).textContent || String(i);
      const ci = arrowColor(src + '|' + label);
      el.style.background = PALETTE[ci];
      paths += `<path d="${d}" class="arrow" style="stroke:${PALETTE[ci]}" mask="url(#am${i})" data-i="${i}" data-src="${src}" data-to="${esc(dst)}" marker-end="url(#ah-${ci})"/>`;
    });
    const markers = PALETTE.map((c, k) =>
      `<marker id="ah-${k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('');
    const extra = [['g', '#6b7280'], ['d', '#a16207']].map(([k, c]) =>
      `<marker id="ah-${k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('');
    svg.innerHTML = `<defs>${markers}${extra}${masks}</defs>${paths}`;
    if (st.focus) setMemFocus(st.focus);
  }

  // Hovering a variable or box highlights its arrows and linked boxes
  function setMemFocus(f) {
    st.focus = f;
    const box = $('#mem');
    box.classList.toggle('focusing', !!f);
    const linked = new Set();
    box.querySelectorAll('.arrow').forEach((p) => {
      const on = !!f && (f.i != null ? p.dataset.i === String(f.i) : (p.dataset.src === f.key || p.dataset.to === f.key));
      p.classList.toggle('on', on);
      if (on) { linked.add(p.dataset.src); linked.add(p.dataset.to); }
    });
    if (f && f.key) linked.add(f.key);
    box.querySelectorAll('[data-key]').forEach((n) => n.classList.toggle('linked', linked.has(n.dataset.key)));
    box.querySelectorAll('.ref').forEach((r) => r.classList.toggle('on', !!f && f.i != null && r.dataset.i === String(f.i)));
  }

  /* ================= Flowchart ================= */
  const measure = document.createElement('canvas').getContext('2d');
  function textW(t) {
    measure.font = startsAr(t) ? '13px "IBM Plex Sans Arabic", sans-serif' : '12.5px "JetBrains Mono", monospace';
    return measure.measureText(t).width;
  }
  const GAP = 26;
  const empty = () => ({ w: 0, h: 0, cx: 0, shapes: [], paths: [] });
  function merge(out, p, dx, dy) {
    p.shapes.forEach((s) => out.shapes.push({ ...s, x: s.x + dx, y: s.y + dy }));
    p.paths.forEach((q) => out.paths.push({ ...q, pts: q.pts.map(([x, y]) => [x + dx, y + dy]), label: q.label && { ...q.label, x: q.label.x + dx, y: q.label.y + dy } }));
  }
  function flatten(items) {
    const out = [];
    items.forEach((it) => (it.t === 'seq' ? out.push(...flatten(it.items)) : out.push(it)));
    return out;
  }
  function nodeShape(kind, text, line) {
    const tw = textW(text);
    if (kind === 'dia') return { kind, text, line, w: Math.max(120, tw + 70), h: 54 };
    if (kind === 'oval') return { kind, text, line, w: Math.max(90, tw + 40), h: 34 };
    return { kind, text, line, w: Math.max(76, tw + 30), h: 34 };
  }
  function layoutSimple(n) {
    const s = nodeShape(n.k, n.text, n.line);
    return { w: s.w, h: s.h, cx: s.w / 2, shapes: [{ ...s, x: 0, y: 0 }], paths: [] };
  }
  function layoutSeq(items) {
    const parts = flatten(items).map(layoutNode);
    if (!parts.length) return empty();
    const left = Math.max(...parts.map((p) => p.cx));
    const right = Math.max(...parts.map((p) => p.w - p.cx));
    const out = { w: left + right, cx: left, h: 0, shapes: [], paths: [] };
    let y = 0;
    parts.forEach((p, i) => {
      if (i) { out.paths.push({ pts: [[left, y], [left, y + GAP]], arrow: true }); y += GAP; }
      merge(out, p, left - p.cx, y);
      y += p.h;
    });
    out.h = y;
    return out;
  }
  function layoutIf(n) {
    const d = nodeShape('dia', n.text, n.line);
    const yes = layoutSeq(n.body), no = layoutSeq(n.orelse);
    // 'Yes' branch on the right, 'No' on the left
    const a = Math.max(no.w, 50), b = Math.max(yes.w, 50);
    const cNoL = no.w ? no.cx : a / 2, cYesL = yes.w ? yes.cx : b / 2;
    const gap = Math.max(36, d.w + 34 - (a - cNoL) - cYesL);
    const xYes = a + gap;
    const cNo = cNoL, cYes = xYes + cYesL;
    const cx = (cNo + cYes) / 2;
    const top = d.h + 24;
    const mergeY = top + Math.max(no.h, yes.h) + 22;
    const out = { w: xYes + b, h: mergeY, cx, shapes: [{ ...d, x: cx - d.w / 2, y: 0 }], paths: [] };
    merge(out, no, 0, top);
    merge(out, yes, xYes, top);
    const mid = d.h / 2;
    const branch = (c, L, label, side) => {
      const corner = cx + side * d.w / 2;
      const lab = { text: label, x: corner + side * 8, y: mid - 7, cls: side > 0 ? 'yes' : 'no' };
      if (L.h) {
        out.paths.push({ pts: [[corner, mid], [c, mid], [c, top]], arrow: true, label: lab });
        out.paths.push({ pts: [[c, top + L.h], [c, mergeY], [cx, mergeY]] });
      } else {
        out.paths.push({ pts: [[corner, mid], [c, mid], [c, mergeY], [cx, mergeY]], label: lab });
      }
    };
    branch(cYes, yes, 'Yes', 1);
    branch(cNo, no, 'No', -1);
    return out;
  }
  function layoutLoop(n) {
    const d = nodeShape('dia', n.text, n.line);
    const body = layoutSeq(n.body);
    const L = 30, R = 30;
    const inL = Math.max(body.cx, d.w / 2), inR = Math.max(body.w - body.cx, d.w / 2);
    const cx = L + inL, Wd = cx + inR + R;
    const top = d.h + 26, bb = top + body.h, Hh = bb + 40;
    const out = { w: Wd, h: Hh, cx, shapes: [{ ...d, x: cx - d.w / 2, y: 0, loop: true }], paths: [] };
    merge(out, body, cx - body.cx, top);
    const mid = d.h / 2;
    out.paths.push({ pts: [[cx, d.h], [cx, top]], arrow: true, label: { text: n.k === 'for' ? 'next' : 'Yes', x: cx + 7, y: d.h + 16, cls: 'yes', anchor: 'start' } });
    out.paths.push({ pts: [[cx, bb], [cx, bb + 16], [8, bb + 16], [8, mid], [cx - d.w / 2, mid]], arrow: true, cls: 'back' });
    out.paths.push({ pts: [[cx + d.w / 2, mid], [Wd - 8, mid], [Wd - 8, Hh - 8], [cx, Hh - 8], [cx, Hh]], cls: 'exit', label: { text: n.k === 'for' ? 'done' : 'No', x: cx + d.w / 2 + 8, y: mid + 15, cls: 'no', anchor: 'start' } });
    return out;
  }
  function layoutNode(n) {
    if (n.t === 'if') return layoutIf(n);
    if (n.t === 'loop') return layoutLoop(n);
    return layoutSimple(n);
  }

  function shapeSvg(s) {
    const { x, y, w, h } = s;
    const cx = x + w / 2, cy = y + h / 2;
    let body;
    switch (s.kind) {
      case 'dia': body = `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}"/>`; break;
      case 'io': body = `<polygon points="${x + 10},${y} ${x + w},${y} ${x + w - 10},${y + h} ${x},${y + h}"/>`; break;
      case 'oval': body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`; break;
      case 'return': body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>`; break;
      default: body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`;
    }
    const dir = startsAr(s.text) ? 'rtl' : 'ltr';
    const cls = `fc-node fc-${s.kind}${s.loop ? ' fc-loop' : ''}${s.line ? ' has-line' : ''}`;
    return `<g class="${cls}"${s.line ? ` data-line="${s.line}"` : ''}>${body}<text x="${cx}" y="${cy}" direction="${dir}" class="fc-t">${esc(bidiFix(s.text))}</text>` +
      (s.line ? `<text class="fc-count" x="${x + w * 0.72}" y="${y - 4}" direction="ltr"></text><title>Line ${s.line}</title>` : '') + '</g>';
  }

  function renderFlow(flow) {
    const host = $('#flow');
    if (!flow) { host.innerHTML = '<p class="empty">Fix the syntax error to see the flowchart.</p>'; st.flowSize = { w: 0, h: 0 }; return; }
    const charts = flow.map((ch) => ({
      ch,
      L: layoutSeq([{ t: 'simple', k: 'oval', text: ch.start, line: 0 }, ...ch.body, { t: 'simple', k: 'oval', text: ch.end, line: 0 }]),
    }));
    const GC = 80, TOP = 56, PAD = 30;
    const totalW = charts.reduce((s, c) => s + c.L.w, 0) + GC * (charts.length - 1) + PAD * 2;
    const totalH = Math.max(...charts.map((c) => c.L.h)) + TOP + PAD;
    let x = PAD;
    let out = '';
    charts.forEach(({ ch, L }, ci) => {
      const ox = x, oy = TOP;
      x += L.w + GC;
      const fp = st.flowPos[ch.title] || [0, 0];
      out += `<g class="fc-chart" data-ci="${esc(ch.title)}" transform="translate(${fp[0]} ${fp[1]})">`;
      out += `<rect class="fc-frame" x="${ox - 18}" y="${oy - 44}" width="${L.w + 36}" height="${L.h + 60}" rx="6"/>`;
      out += `<text class="fc-title" x="${ox + L.w / 2}" y="${oy - 22}">${esc(bidiFix(ch.title))}</text>`;
      L.paths.forEach((p) => {
        const pts = p.pts.map(([px, py]) => `${px + ox},${py + oy}`).join(' ');
        out += `<polyline points="${pts}" class="fc-edge${p.cls ? ' ' + p.cls : ''}"${p.arrow ? ' marker-end="url(#fa)"' : ''}/>`;
        if (p.label) {
          const anchor = p.label.anchor || (p.label.cls === 'yes' ? 'start' : 'end');
          out += `<text class="fc-label ${p.label.cls}" x="${p.label.x + ox}" y="${p.label.y + oy}" text-anchor="${anchor}" direction="ltr">${esc(p.label.text)}</text>`;
        }
      });
      L.shapes.forEach((s) => { out += shapeSvg({ ...s, x: s.x + ox, y: s.y + oy }); });
      out += '</g>';
    });
    host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}">
      <defs><marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="fa"/></marker></defs>${out}</svg>`;
    st.flowSize = { w: totalW, h: totalH };
    applyZoom();
    markFlowSel();
  }

  function updateFlow(line, counts) {
    const host = $('#flow');
    host.querySelectorAll('.fc-node.has-line').forEach((g) => {
      const l = +g.dataset.line;
      const n = counts.get(l) || 0;
      g.classList.toggle('active', l === line);
      g.classList.toggle('visited', n > 0);
      const c = g.querySelector('.fc-count');
      if (c) c.textContent = n > 1 ? `×${n}` : '';
    });
    if (line && st.tab === 'flow') scrollFlowTo(host.querySelector('.fc-node.active'));
  }
  function scrollFlowTo(el) {
    if (!el) return;
    const sc = $('#flowScroll');
    const r = el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    if (r.top < sr.top + 20 || r.bottom > sr.bottom - 20) sc.scrollTop += r.top - sr.top - sr.height / 2 + r.height / 2;
    if (r.left < sr.left + 20 || r.right > sr.right - 20) sc.scrollLeft += r.left - sr.left - sr.width / 2 + r.width / 2;
  }
  function markFlowSel() {
    $('#flow').querySelectorAll('.fc-node.has-line').forEach((g) => g.classList.toggle('sel', +g.dataset.line === st.selLine));
  }
  function applyZoom() {
    const svg = $('#flow svg');
    if (!svg) return;
    svg.style.width = st.flowSize.w * st.zoom + 'px';
    svg.style.height = st.flowSize.h * st.zoom + 'px';
  }
  function fitZoom() {
    if (st.tab === 'mem') {
      const sc = $('#memScroll'), box = $('#mem');
      st.memZoom = Math.max(0.4, Math.min(1.6, Math.min((sc.clientWidth - 10) / box.offsetWidth, (sc.clientHeight - 10) / box.offsetHeight)));
      zoomMem(0);
      return;
    }
    const sc = $('#flowScroll');
    if (!st.flowSize.w || !sc.clientWidth) return;
    st.zoom = Math.max(0.3, Math.min(1.4, (sc.clientWidth - 16) / st.flowSize.w));
    applyZoom();
  }
  function zoomMem(f) {
    if (f) st.memZoom = Math.max(0.4, Math.min(2, st.memZoom * f));
    store.set('vp-memzoom', String(st.memZoom));
    applyMemZoom();
    drawArrows();
  }
  function zoomBy(f) {
    if (st.tab === 'mem') zoomMem(f);
    else { st.zoom = Math.max(0.3, Math.min(2.5, st.zoom * f)); applyZoom(); }
  }
  function resetLayout() {
    if (st.tab === 'mem') {
      st.pos = {};
      $('#mem').querySelectorAll('[data-key]').forEach((el) => { el.style.translate = ''; el.classList.remove('moved'); });
      applyMemZoom();
      drawArrows();
    } else {
      st.flowPos = {};
      $('#flow').querySelectorAll('.fc-chart').forEach((g) => g.setAttribute('transform', 'translate(0 0)'));
    }
  }

  /* ================= Dragging ================= */
  // Drag a memory box, a flowchart, or the background to pan
  function onPointerDown(e) {
    if (e.button !== 0) return;
    const pane = e.currentTarget;
    const card = e.target.closest('#mem [data-key]');
    const chart = e.target.closest('#flow .fc-chart');
    const base = { sx: e.clientX, sy: e.clientY, moved: false, pid: e.pointerId };
    if (card) {
      const p = st.pos[card.dataset.key] || [0, 0];
      st.drag = { ...base, kind: 'card', el: card, key: card.dataset.key, ox: p[0], oy: p[1] };
    } else if (chart) {
      const p = st.flowPos[chart.dataset.ci] || [0, 0];
      st.drag = { ...base, kind: 'chart', el: chart, key: chart.dataset.ci, ox: p[0], oy: p[1] };
    } else {
      st.drag = { ...base, kind: 'pan', el: pane, ox: pane.scrollLeft, oy: pane.scrollTop };
    }
  }
  function onPointerMove(e) {
    const d = st.drag;
    if (!d || e.pointerId !== d.pid) return;
    const mx = e.clientX - d.sx, my = e.clientY - d.sy;
    if (!d.moved && Math.hypot(mx, my) < 4) return;
    if (!d.moved) {
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      d.el.classList.add('dragging');
      if (d.kind === 'card') setMemFocus({ key: d.key });
    }
    e.preventDefault();
    if (d.kind === 'card') {
      const p = [d.ox + mx / st.memZoom, d.oy + my / st.memZoom];
      st.pos[d.key] = p;
      d.el.style.translate = `${p[0]}px ${p[1]}px`;
      d.el.classList.add('moved');
      scheduleArrows();
    } else if (d.kind === 'chart') {
      const p = [d.ox + mx / st.zoom, d.oy + my / st.zoom];
      st.flowPos[d.key] = p;
      d.el.setAttribute('transform', `translate(${p[0]} ${p[1]})`);
    } else {
      d.el.scrollLeft = d.ox - mx;
      d.el.scrollTop = d.oy - my;
    }
  }
  function onPointerUp(e) {
    const d = st.drag;
    if (!d || e.pointerId !== d.pid) return;
    d.el.classList.remove('dragging');
    if (d.moved) {
      st.suppressClick = true;
      setTimeout(() => { st.suppressClick = false; }, 0);
      if (d.kind === 'card') { applyMemZoom(); setMemFocus(null); }
    }
    st.drag = null;
  }
  ['#memScroll', '#flowScroll'].forEach((sel) => {
    const pane = $(sel);
    pane.addEventListener('pointerdown', onPointerDown);
    pane.addEventListener('pointermove', onPointerMove);
    pane.addEventListener('pointerup', onPointerUp);
    pane.addEventListener('pointercancel', onPointerUp);
    // Ctrl + mouse wheel zooms
    pane.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
  });
  $('#mem').addEventListener('pointerover', (e) => {
    if (st.drag) return;
    const row = e.target.closest('tr, .cell');
    const ref = row && row.querySelector('.ref');
    if (ref && ref.dataset.i != null) { setMemFocus({ i: ref.dataset.i }); return; }
    const card = e.target.closest('[data-key]');
    setMemFocus(card ? { key: card.dataset.key } : null);
  });
  $('#mem').addEventListener('pointerleave', () => { if (!st.drag) setMemFocus(null); });

  /* ================= Graphics: turtle and matplotlib ================= */
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  (function setupCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  })();

  function pathFor(c) {
    ctx.beginPath();
    switch (c.type) {
      case 'circle': ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); return 'fill';
      case 'polygon': c.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); return 'fill';
      case 'line': ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); return 'stroke';
      case 'poly': c.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); return 'stroke';
      default: return null;
    }
  }
  function drawCmd(c) {
    ctx.save();
    switch (c.type) {
      case 'bg': ctx.fillStyle = c.color; ctx.fillRect(0, 0, W, H); break;
      case 'circle': pathFor(c); ctx.fillStyle = c.color; ctx.fill(); break;
      case 'polygon':
        pathFor(c); ctx.fillStyle = c.color; ctx.fill();
        if (c.stroke) { ctx.strokeStyle = c.stroke; ctx.lineWidth = c.width; ctx.lineJoin = 'round'; ctx.stroke(); }
        break;
      case 'line': case 'poly':
        pathFor(c); ctx.strokeStyle = c.color; ctx.lineWidth = c.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); break;
      case 'text':
        ctx.font = `${c.size}px "IBM Plex Sans Arabic", sans-serif`;
        ctx.fillStyle = c.color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(c.msg, c.x, c.y); break;
      default: break;
    }
    ctx.restore();
  }
  function glow(c) {
    ctx.save();
    const k = pathFor(c);
    if (k) {
      ctx.strokeStyle = '#f59e0b'; ctx.shadowColor = '#f59e0b'; ctx.shadowBlur = 12;
      ctx.lineWidth = k === 'stroke' ? (c.width || 2) + 6 : 3; ctx.globalAlpha = 0.6; ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawTurtle(t) {
    ctx.save();
    ctx.translate(t.tx, t.ty);
    ctx.rotate(-t.th * Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(13, 0); ctx.lineTo(-8, 8); ctx.lineTo(-4, 0); ctx.lineTo(-8, -8); ctx.closePath();
    ctx.fillStyle = t.tc || '#111'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 4;
    ctx.stroke(); ctx.fill();
    ctx.restore();
  }
  function drawCanvas() {
    const cmds = st.result.cmds;
    const { n, hi } = st.view;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const turtles = new Map();
    for (let i = 0; i < n; i++) { drawCmd(cmds[i]); if (cmds[i].tid) turtles.set(cmds[i].tid, cmds[i]); }
    if (hi) for (let i = hi[0]; i < hi[1]; i++) glow(cmds[i]);
    turtles.forEach((t) => { if (t.tv) drawTurtle(t); });
  }
  function renderGfx() {
    const r = st.result;
    const hasTurtle = r.cmds.length > 0;
    const figs = r.figs || [];
    $('#turtleWrap').hidden = !hasTurtle;
    if (hasTurtle) drawCanvas();
    const figsKey = figs.length + ':' + (figs[0] || '').slice(-40);
    if ($('#figs').dataset.key !== figsKey) {
      $('#figs').dataset.key = figsKey;
      $('#figs').innerHTML = figs.map((b, i) => `<img alt="Figure ${i + 1}" src="data:image/png;base64,${b}">`).join('');
    }
    const has = hasTurtle || figs.length > 0;
    $('#gfxEmpty').hidden = has;
    const badge = $('#gfxBadge');
    badge.hidden = !has;
    badge.textContent = figs.length + (hasTurtle ? 1 : 0);
    if (has && !st.hadGfx) switchTab('gfx');
    st.hadGfx = has;
  }

  // Find which line drew the turtle stroke under the mouse
  function distSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function hitTest(x, y) {
    if (!st.result) return -1;
    const cmds = st.result.cmds;
    for (let i = st.view.n - 1; i >= 0; i--) {
      const c = cmds[i];
      if (c.type === 'line' && distSeg(x, y, c.x1, c.y1, c.x2, c.y2) <= c.width / 2 + 4) return i;
      if (c.type === 'poly') for (let k = 1; k < c.pts.length; k++) if (distSeg(x, y, ...c.pts[k - 1], ...c.pts[k]) <= c.width / 2 + 4) return i;
      if (c.type === 'circle' && Math.hypot(x - c.x, y - c.y) <= c.r + 2) return i;
    }
    return -1;
  }
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    const h = hitTest(x, y);
    const tip = $('#tooltip');
    if (h >= 0) {
      const c = st.result.cmds[h];
      setHoverLine(c.line);
      tip.innerHTML = `${esc(c.desc)}<br><b>Line ${c.line}</b>`;
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth) + 'px';
      tip.style.top = Math.min(e.clientY - r.top + 14, r.height - tip.offsetHeight) + 'px';
    } else { tip.hidden = true; setHoverLine(0); }
  });
  canvas.addEventListener('mouseleave', () => { $('#tooltip').hidden = true; setHoverLine(0); });

  /* ================= Explanations ================= */
  const IDENT_RE = /(["'])(?:\\.|(?!\1).)*\1|[A-Za-z_ء-ي][A-Za-z0-9_ء-ي]*/g;
  function substitute(expr, s) {
    let changed = false;
    const out = expr.replace(IDENT_RE, (m, q, off) => {
      if (q || (off > 0 && expr[off - 1] === '.')) return m;
      const v = findVar(s, m);
      if (isSimple(v)) { changed = true; return v[2]; }
      return m;
    });
    return changed ? out : null;
  }
  const OP_TIPS = [
    [/%/, '<code>%</code> gives the <b>remainder</b> of a division.'],
    [/==/, '<code>==</code> asks "is equal?", while <code>=</code> stores a value.'],
    [/!=/, '<code>!=</code> means "not equal".'],
    [/\band\b/, '<code>and</code>: both conditions must be true.'],
    [/\bor\b/, '<code>or</code>: at least one condition must be true.'],
    [/\bnot\b/, '<code>not</code> flips the condition.'],
    [/\bis\b/, '<code>is</code> asks: are they the <b>same object</b> in memory?'],
    [/\bin\b/, '<code>in</code> asks: is the item inside the collection?'],
  ];

  // Short lessons shown under each step ("Concept")
  const CONCEPTS = {
    for: ['for loop', 'A <b>for loop</b> repeats its indented block once for every item in a sequence (a list, a string, a <code>range</code>…). Each round, the loop variable is set to the next item. When no items are left, Python continues with the first line after the loop.'],
    while: ['while loop', 'A <b>while loop</b> checks its condition before every round. As long as it is <b>True</b>, the indented block runs again. Something inside the loop must eventually make the condition <b>False</b>, otherwise the loop never ends.'],
    if: ['if statement', 'An <b>if statement</b> lets the program make a decision. Python evaluates the condition to <b>True</b> or <b>False</b> and runs the indented block only when it is True. <code>elif</code> adds another condition to try, and <code>else</code> runs when none of them were True.'],
    def: ['functions', 'A <b>function</b> is a named, reusable block of code. <code>def</code> only stores it in memory; the code inside runs each time the function is called, and every call gets its own fresh set of local variables (a new <b>frame</b>).'],
    try: ['try / except', 'Code inside <b>try</b> runs normally. If an error (exception) happens there, Python <b>stops that block immediately</b> and jumps to the first <code>except</code> whose type matches the error. If no error happens, all <code>except</code> blocks are skipped. <code>else</code> runs only when there was no error, and <code>finally</code> <b>always</b> runs, error or not.'],
    raise: ['raise', '<b>raise</b> creates an error on purpose, e.g. <code>raise ValueError("bad age")</code>. Normal execution stops; Python looks for a matching <code>except</code> in this function, then in the functions that called it. If none is found, the program stops with that error.'],
    generator: ['generators', 'A function that contains <b>yield</b> is a <b>generator function</b>. Calling it does not run it: you get a <b>generator object</b>. Each <code>next()</code> (or each round of a <code>for</code> loop) runs the body until the next <code>yield</code>, hands that value out, and <b>pauses</b> with all local variables saved. The next time it continues right after the <code>yield</code>.'],
    closure: ['closures', 'A function defined <b>inside</b> another function can use the outer function\'s variables. When the outer function returns, its frame is gone, but the inner function <b>remembers</b> those variables (they are stored with it). This is called a <b>closure</b>.'],
    lambda: ['lambda', '<code>lambda x: x * 2</code> is a short way to write a small function without a name. It can only contain one expression, whose value is returned automatically.'],
    comprehension: ['comprehensions', 'A <b>comprehension</b> builds a collection in one line: <code>[x * x for x in nums if x > 0]</code> means: for every <code>x</code> in <code>nums</code>, if the condition is true, add <code>x * x</code> to a new list. <code>{...}</code> builds a set or dict, and <code>( ... )</code> inside a call like <code>sum(...)</code> is a <b>generator expression</b> that produces values one at a time.'],
    global: ['global and nonlocal', '<code>global x</code> inside a function means: <code>x</code> is the variable of the <b>global frame</b>, so assigning to it changes the global one instead of creating a local. <code>nonlocal x</code> does the same for a variable of the <b>enclosing function</b>.'],
    match: ['match / case', '<b>match</b> compares one value against several <b>patterns</b>, from top to bottom. The first <code>case</code> that fits runs and the rest are skipped. <code>case _:</code> matches anything (like <code>else</code>), and <code>|</code> means "or".'],
    decorator: ['decorators', 'A <b>decorator</b> line <code>@name</code> above a <code>def</code> passes the new function to <code>name</code> and stores whatever it returns under the function\'s name. It is a way to add behaviour (logging, timing, checking…) around a function.'],
    input: ['input', '<b>input()</b> waits for the user to type a line and returns it as <b>text</b> (a str), even if it looks like a number. Use <code>int(...)</code> or <code>float(...)</code> to convert it. Here, the values come from the <b>Input</b> box under the code, one line per call.'],
    string: ['strings and indexes', 'A <b>string</b> is a sequence of characters. Each character has an <b>index</b> starting at 0; negative indexes count from the end (<code>-1</code> is the last). <code>s[a:b]</code> is a <b>slice</b>: from index <code>a</code> up to, but not including, <code>b</code>. Strings cannot be changed in place; methods like <code>upper()</code> return a new string.'],
    del: ['del', '<b>del</b> removes a name (the variable disappears) or an item from a list/dict. The object itself is deleted only when nothing points to it any more.'],
    assert: ['assert', '<b>assert condition</b> checks that something is true. If it is false, Python raises <code>AssertionError</code>. It is used to catch mistakes early.'],
    oop: ['object-oriented programming', '<b>OOP</b> groups data (attributes) and behaviour (methods) into objects. A <b>class</b> is the blueprint, an <b>object</b> is one thing built from it. A class can <b>inherit</b> from a parent class (<code>class Dog(Animal):</code>): it gets all the parent\'s methods and can <b>override</b> some of them. Python looks for a method first in the object\'s own class, then in its parents. <b>Special methods</b> like <code>__str__</code> or <code>__eq__</code> are called by Python itself (by <code>print</code>, <code>==</code>, …).'],
    class: ['classes', 'A <b>class</b> is a blueprint for objects. Calling it like a function, e.g. <code>Name(...)</code>, creates a new object and runs <code>__init__</code> to set up its attributes with <code>self.x = ...</code>. Methods are functions that belong to the class.'],
    import: ['import', '<b>import</b> loads a module (a file of ready-made code) so you can use its functions and values with <code>module.name</code>.'],
    assign: ['assignment', '<b>Assignment</b> (<code>name = value</code>) first evaluates everything on the right, then makes the name on the left refer to the result. Simple values (numbers, text, True/False) are shown inside the frame; bigger values (lists, dicts, objects) live in the Objects area and the variable points to them with an arrow.'],
    augassign: ['augmented assignment', '<code>x += 1</code> is a shortcut for <code>x = x + 1</code>. The same works for <code>-=</code>, <code>*=</code>, <code>/=</code>. On a list, <code>+=</code> extends the list in place.'],
    attr: ['attributes', '<b>Attribute assignment</b> (<code>obj.name = value</code>) stores a value inside an object. In a method, <code>self</code> is the object the method was called on, so <code>self.x = ...</code> saves data in that object.'],
    item: ['changing an item', '<b>Item assignment</b> (<code>seq[index] = value</code>) replaces one element inside a list or dictionary. The list is still the same object; only its contents change, so every variable pointing to it sees the change.'],
    swap: ['tuple unpacking', '<code>a, b = b, a</code> evaluates the whole right side first (building a tuple), then unpacks it into the names on the left. That is why two values can be swapped without a temporary variable.'],
    return: ['return', '<b>return</b> ends the function immediately and sends a value back to the line that called it. The function\'s frame and its local variables disappear. A function without <code>return</code> gives back <code>None</code>.'],
    call: ['calling a function', 'When a function is called, Python creates a <b>new frame</b>, puts each argument into the matching parameter, and runs the function body from the top. When it finishes, execution continues where the call was made.'],
    print: ['print', '<b>print()</b> turns its arguments into text and writes them to the Output panel, separated by spaces and followed by a new line.'],
    method: ['methods', 'A <b>method call</b> (<code>obj.method(...)</code>) runs a function that belongs to the object. Methods such as <code>list.append</code> change the object <i>in place</i>, so no new list is created.'],
    break: ['break', '<b>break</b> stops the nearest loop immediately; Python jumps to the first line after the loop.'],
    continue: ['continue', '<b>continue</b> skips the rest of the current round and goes straight to the next round of the loop.'],
    pass: ['pass', '<b>pass</b> does nothing. It is a placeholder where Python needs a statement but you have no code yet.'],
    with: ['the with statement', '<b>with</b> opens something (usually a file) and <b>guarantees it is closed</b> when the indented block ends, even if an error happens. <code>with open(path) as f:</code> is the Pythonic way to work with files, so you never forget <code>f.close()</code>.'],
    file: ['files', '<code>open(path, mode)</code> connects your program to a file on the <b>disk</b> and returns a <b>file object</b>. The file object has a <b>cursor</b>: every read or write moves it forward. <code>read()</code> reads everything, <code>readline()</code> one line, <code>readlines()</code> a list of lines. <code>write()</code> does <b>not</b> add <code>\\n</code> for you. Modes: <code>r</code> read, <code>w</code> write (erases), <code>a</code> append, <code>x</code> create only, add <code>b</code> for binary.'],
    pickle: ['pickle', '<b>pickle</b> turns any Python object into bytes (<i>serialization</i>) and back. <code>pickle.dump(obj, f)</code> writes to a file opened with <code>"wb"</code>; <code>pickle.load(f)</code> reads it back with <code>"rb"</code>. The file is binary, so it is not readable in an editor. Never load a pickle file you do not trust.'],
    csv: ['CSV files', '<b>CSV</b> (comma-separated values) is a plain-text table: every line is a <b>row</b> and commas separate the <b>columns</b>. <code>csv.writer(f).writerow([...])</code> writes one row; <code>csv.reader(f)</code> gives each row back as a list of strings.'],
    pandas: ['pandas', '<b>pandas</b> is a library for tables. A <b>Series</b> is one labelled column; a <b>DataFrame</b> is a table of rows and columns that share an <b>index</b>. Use <code>df.loc[label]</code> to select by label and <code>df.iloc[number]</code> by position; <code>pd.read_csv</code> loads a CSV file into a DataFrame.'],
    expr: ['expressions', 'Python evaluates the expression from the inside out: names are replaced by their values, then operators and function calls are worked out.'],
  };

  // Built-in functions and common methods explained when they appear in a line
  const BUILTINS = {
    print: '<code>print(...)</code> shows values in the Output panel.',
    len: '<code>len(x)</code> gives the number of items in <code>x</code> (characters in a string, elements in a list, keys in a dict).',
    range: '<code>range(n)</code> gives 0, 1, …, n-1. <code>range(a, b)</code> goes from a up to b-1; <code>range(a, b, step)</code> jumps by <i>step</i>.',
    input: '<code>input(prompt)</code> asks the user to type something and returns it as text.',
    int: '<code>int(x)</code> converts <code>x</code> to a whole number.',
    float: '<code>float(x)</code> converts <code>x</code> to a decimal number.',
    str: '<code>str(x)</code> converts <code>x</code> to text.',
    abs: '<code>abs(x)</code> gives the distance from zero (removes the minus sign).',
    round: '<code>round(x, n)</code> rounds <code>x</code> to <code>n</code> decimal places.',
    sum: '<code>sum(items)</code> adds up all the numbers.',
    min: '<code>min(...)</code> gives the smallest value.',
    max: '<code>max(...)</code> gives the largest value.',
    sorted: '<code>sorted(items)</code> returns a <b>new</b> sorted list; the original is not changed.',
    reversed: '<code>reversed(items)</code> goes through the items from last to first.',
    enumerate: '<code>enumerate(items)</code> gives pairs <code>(index, item)</code>, useful when you need the position too.',
    zip: '<code>zip(a, b)</code> walks through two sequences side by side, giving pairs.',
    list: '<code>list(x)</code> builds a new list from <code>x</code>.',
    dict: '<code>dict()</code> builds a new dictionary (key → value pairs).',
    set: '<code>set(x)</code> builds a set: unordered, with no duplicates.',
    tuple: '<code>tuple(x)</code> builds a tuple: like a list, but it cannot be changed.',
    type: '<code>type(x)</code> tells you what kind of value <code>x</code> is.',
    isinstance: '<code>isinstance(x, T)</code> checks whether <code>x</code> is of type <code>T</code>.',
    append: '<code>list.append(x)</code> adds <code>x</code> to the <b>end</b> of the list (in place).',
    extend: '<code>list.extend(items)</code> adds every item of another sequence to the end of the list.',
    insert: '<code>list.insert(i, x)</code> puts <code>x</code> at position <code>i</code>, shifting the rest right.',
    pop: '<code>pop()</code> removes and returns the last item (or the item at a given index / key).',
    remove: '<code>list.remove(x)</code> deletes the first item equal to <code>x</code>.',
    sort: '<code>list.sort()</code> sorts the list <b>in place</b> (the same list object is changed).',
    reverse: '<code>list.reverse()</code> reverses the list in place.',
    index: '<code>index(x)</code> gives the position of the first <code>x</code>.',
    count: '<code>count(x)</code> counts how many times <code>x</code> appears.',
    split: '<code>text.split()</code> cuts a string into a list of words (or at the separator you give).',
    join: '<code>sep.join(items)</code> glues a list of strings together with <code>sep</code> between them.',
    strip: '<code>text.strip()</code> removes spaces from both ends.',
    upper: '<code>text.upper()</code> returns the text in CAPITAL letters.',
    lower: '<code>text.lower()</code> returns the text in small letters.',
    replace: '<code>text.replace(a, b)</code> returns a copy with every <code>a</code> replaced by <code>b</code>.',
    format: '<code>format()</code> inserts values into a text template.',
    keys: '<code>dict.keys()</code> gives all the keys of a dictionary.',
    values: '<code>dict.values()</code> gives all the values of a dictionary.',
    items: '<code>dict.items()</code> gives <code>(key, value)</code> pairs.',
    get: '<code>dict.get(key, default)</code> reads a value, returning <code>default</code> instead of an error if the key is missing.',
    update: '<code>dict.update(other)</code> copies all pairs from <code>other</code> into the dictionary.',
    randint: '<code>random.randint(a, b)</code> gives a random whole number from a to b (both included).',
    choice: '<code>random.choice(items)</code> picks one item at random.',
    sqrt: '<code>math.sqrt(x)</code> gives the square root of <code>x</code>.',
    next: '<code>next(gen)</code> runs a generator (or iterator) until it produces its next value.',
    iter: '<code>iter(x)</code> makes an iterator that gives the items of <code>x</code> one at a time.',
    map: '<code>map(f, items)</code> applies the function <code>f</code> to every item (lazily, one at a time).',
    filter: '<code>filter(f, items)</code> keeps only the items for which <code>f(item)</code> is true.',
    any: '<code>any(items)</code> is True if at least one item is true.',
    all: '<code>all(items)</code> is True if every item is true.',
    ord: '<code>ord(ch)</code> gives the number (code point) of a character, e.g. <code>ord("a")</code> is 97.',
    chr: '<code>chr(n)</code> gives the character with number <code>n</code>, e.g. <code>chr(97)</code> is "a".',
    find: '<code>text.find(sub)</code> gives the index where <code>sub</code> starts, or -1 if it is not there.',
    startswith: '<code>text.startswith(p)</code> checks whether the text begins with <code>p</code>.',
    endswith: '<code>text.endswith(p)</code> checks whether the text ends with <code>p</code>.',
    isdigit: '<code>text.isdigit()</code> is True if every character is a digit.',
    isalpha: '<code>text.isalpha()</code> is True if every character is a letter.',
    title: '<code>text.title()</code> returns the text with Each Word Capitalised.',
    capitalize: '<code>text.capitalize()</code> makes only the first letter capital.',
    super: '<code>super()</code> gives access to the methods of the parent class.',
    open: '<code>open(path, mode)</code> opens a file and returns a file object. Mode <code>"r"</code> read (default), <code>"w"</code> write, <code>"a"</code> append, <code>"x"</code> create; add <code>"b"</code> for binary.',
    read: '<code>f.read()</code> reads the whole file (from the cursor to the end) as one string.',
    readline: '<code>f.readline()</code> reads <b>one</b> line, including its <code>\\n</code>, and moves the cursor to the next line.',
    readlines: '<code>f.readlines()</code> reads all remaining lines into a list; each line keeps its <code>\\n</code>.',
    write: '<code>f.write(text)</code> writes text at the cursor. It does <b>not</b> add a new line: add <code>"\\n"</code> yourself.',
    writelines: '<code>f.writelines(list)</code> writes every string in the list, without adding new lines.',
    close: '<code>f.close()</code> closes the file and saves anything still waiting in memory.',
    splitlines: '<code>text.splitlines()</code> splits text into a list of lines and removes the <code>\\n</code> characters.',
    seek: '<code>f.seek(n)</code> moves the cursor to position <code>n</code> (0 = start of the file).',
    tell: '<code>f.tell()</code> gives the current cursor position.',
    flush: '<code>f.flush()</code> pushes waiting data to the disk now.',
    dump: '<code>pickle.dump(obj, f)</code> converts <code>obj</code> to bytes and writes them to the binary file <code>f</code>.',
    load: '<code>pickle.load(f)</code> reads bytes from <code>f</code> and rebuilds the original object.',
    writer: '<code>csv.writer(f)</code> makes a helper that writes rows (lists) as comma-separated lines.',
    reader: '<code>csv.reader(f)</code> reads a CSV file row by row; each row is a list of strings.',
    writerow: '<code>writer.writerow(row)</code> writes one list as one CSV line.',
    writerows: '<code>writer.writerows(rows)</code> writes many rows at once.',
    DictReader: '<code>csv.DictReader(f)</code> reads each row as a dict, using the first line as column names.',
    DictWriter: '<code>csv.DictWriter(f, fieldnames)</code> writes dicts as CSV rows.',
    Series: '<code>pd.Series(data)</code> makes a one-dimensional labelled column.',
    DataFrame: '<code>pd.DataFrame(data)</code> makes a table with rows, columns and an index.',
    read_csv: '<code>pd.read_csv(path)</code> loads a CSV file into a DataFrame.',
    to_csv: '<code>df.to_csv(path)</code> saves a DataFrame as a CSV file.',
    head: '<code>df.head(n)</code> shows the first <code>n</code> rows (5 by default).',
    tail: '<code>df.tail(n)</code> shows the last <code>n</code> rows.',
    drop: '<code>df.drop(label, axis=1)</code> removes a column (<code>axis=0</code> removes a row). It returns a new table unless <code>inplace=True</code>.',
    rename: '<code>df.rename(columns={old: new})</code> renames columns.',
    fillna: '<code>fillna(value)</code> replaces missing values (NaN) with <code>value</code>.',
    dropna: '<code>dropna()</code> removes rows that contain missing values.',
    isnull: '<code>isnull()</code> gives True where a value is missing.',
    notnull: '<code>notnull()</code> gives True where a value is present.',
    set_index: '<code>set_index(col)</code> uses a column as the row labels.',
    reset_index: '<code>reset_index()</code> moves the index back into a normal column.',
    where: '<code>df.where(cond)</code> keeps values where the condition is True and puts NaN elsewhere.',
    bytearray: '<code>bytearray(list)</code> makes a changeable sequence of bytes (numbers 0-255).',
    bytes: '<code>bytes(...)</code> makes an unchangeable sequence of bytes.',
    encode: '<code>text.encode("utf-8")</code> turns text into bytes using an encoding.',
    decode: '<code>data.decode("utf-8")</code> turns bytes back into text.',
    exists: '<code>os.path.exists(path)</code> checks whether a file or folder exists.',
    listdir: '<code>os.listdir()</code> lists the files in a folder.',
  };

  function usedBuiltins(code) {
    const clean = code.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/, '');
    const found = [];
    clean.replace(/([A-Za-z_]\w*)\s*\(/g, (m, name) => { if (BUILTINS[name] && !found.includes(name)) found.push(name); return m; });
    return found.slice(0, 4);
  }

  // Which round of a loop is this? (counts hits of this line in the same frame since the loop was entered)
  function loopRound(i) {
    const line = st.display[i].b.line, fid = topFrame(st.display[i].b).fid;
    let n = 0;
    for (let j = i; j >= 0; j--) {
      const e = st.display[j].b;
      if (topFrame(e).fid !== fid) continue;
      if (e.line === line) n++;
      else if (e.line < line) break;
    }
    let total = n;
    for (let j = i + 1; j < st.display.length; j++) {
      const e = st.display[j].b;
      if (topFrame(e).fid !== fid) continue;
      if (e.line === line) total++;
      else if (e.line < line) break;
    }
    return { n, rounds: total - 1 }; // the last hit is the check that ends the loop
  }

  // Value of obj.attr in a snapshot (e.g. self.balance)
  function attrValue(s, objName, attr) {
    const v = findVar(s, objName);
    if (!v || v[0] !== 'R') return null;
    const o = heapOf(s).get(v[1]);
    if (!o || !o.attrs) return null;
    const e = o.attrs.find(([k]) => k === attr);
    return e ? { v: e[1], o } : null;
  }

  const typeName = (o) => (o ? (o.t === 'instance' ? `${o.cls} object` : (TNAME[o.t] || o.type || o.t)) : 'object');

  // ----- string helpers -----
  // Text of a Python str value from its repr (skips strings with escapes or cut off)
  function pyStr(enc) {
    if (!enc || enc[0] !== 'P' || enc[1] !== 'str') return null;
    const r = enc[2];
    if (r.length < 2 || r.endsWith('...') || r.includes('\\')) return null;
    return r.slice(1, -1);
  }
  // Evaluate a small integer expression after replacing variables by their values
  function evalInt(expr, s) {
    if (expr == null) return null;
    expr = expr.trim();
    if (expr === '') return undefined;
    const sub = (substitute(expr, s) || expr).replace(/\/\//g, '/');
    if (!/^[\d\s+\-*%()/]+$/.test(sub)) return null;
    try {
      const v = Function(`"use strict"; return (${sub});`)();
      return Number.isFinite(v) ? Math.floor(v) : null;
    } catch (e) { return null; }
  }
  // Indexes selected by a Python slice a:b:c on a sequence of length n
  function sliceIdx(n, a, b, c) {
    c = c === undefined ? 1 : c;
    if (!c) return [];
    const norm = (v, d, lo, hi) => { if (v === undefined) return d; if (v < 0) v += n; return Math.max(lo, Math.min(hi, v)); };
    const s0 = c > 0 ? norm(a, 0, 0, n) : norm(a, n - 1, -1, n - 1);
    const e0 = c > 0 ? norm(b, n, 0, n) : norm(b, -1, -1, n - 1);
    const out = [];
    for (let k = s0; c > 0 ? k < e0 : k > e0; k += c) { out.push(k); if (out.length > 200) break; }
    return out;
  }
  function strStrip(text, sel, title) {
    const chars = [...text];
    const cells = chars.slice(0, 40).map((ch, k) => `<span class="sc${sel.has(k) ? ' on' : ''}"><i>${k}</i><b>${ch === ' ' ? '␣' : esc(ch)}</b><i class="neg">${k - chars.length}</i></span>`).join('');
    return `<div class="str-viz">${title}<div class="str-cells" dir="ltr">${cells}${chars.length > 40 ? '<span class="sc"><b>…</b></span>' : ''}</div></div>`;
  }
  function strViz(code, s) {
    const out = [];
    const clean = code.replace(/#.*$/, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, (q) => ' '.repeat(q.length));
    const re = /([A-Za-z_]\w*)\[([^[\]]*)\]/g;
    let m;
    while ((m = re.exec(clean)) && out.length < 2) {
      const text = pyStr(findVar(s, m[1]));
      if (!text) continue;
      const inner = code.slice(m.index + m[1].length + 1, m.index + m[0].length - 1);
      const parts = inner.split(':');
      if (parts.length > 3) continue;
      const n = [...text].length, sel = new Set();
      let label;
      if (parts.length === 1) {
        let k = evalInt(parts[0], s);
        if (k == null) continue;
        if (k < 0) k += n;
        if (k >= 0 && k < n) sel.add(k);
        label = `<code>${esc(m[1])}[${esc(inner)}]</code> is the character at index <b>${k}</b>${sel.size ? '' : ' — <span class="no">out of range (IndexError)</span>'}`;
      } else {
        const v = parts.map((p) => evalInt(p, s));
        if (v.includes(null)) continue;
        sliceIdx(n, v[0], v[1], v[2]).forEach((k) => sel.add(k));
        label = `<code>${esc(m[1])}[${esc(inner)}]</code> is a <b>slice</b>: ${sel.size} character${sel.size === 1 ? '' : 's'} ${v[2] && v[2] < 0 ? `, read <b>backwards</b> (step ${v[2]})` : v[2] > 1 ? `, taking every ${v[2]}th one` : ' (the end index is <i>not</i> included)'}`;
      }
      out.push(strStrip(text, sel, `<div class="str-h">${label}. Top: index · bottom: negative index.</div>`));
    }
    return out;
  }
  // Source of the indented block under a def line (to look for yield)
  function funcBody(line) {
    const base = indentOf(line), out = [];
    for (let k = line + 1; k <= cm.lineCount(); k++) {
      const t = lineText(k);
      if (t.trim() && indentOf(k) <= base) break;
      out.push(t);
    }
    return out.join('\n');
  }

  function explainStep(i, isLast) {
    const d = st.display[i];
    const { b, a } = d;
    const code = lineText(b.line).trim();
    const did = [], mem = [];
    let concept = null;
    const tb = topFrame(b), ta = topFrame(a);
    const sameFrame = ta.fid === tb.fid;
    const deeper = a.stack.length > b.stack.length;
    const nextInside = sameFrame && a.kind === 'line' && a.line > b.line && indentOf(a.line) > indentOf(b.line);
    const explained = new Set();
    let m;

    const withValues = (expr, s = b) => {
      const sub = substitute(expr, s);
      return sub && sub !== expr ? ` <span class="sub">With values: <code>${esc(sub)}</code></span>` : '';
    };
    const condTips = (cond) => OP_TIPS.forEach(([re, tip]) => { if (re.test(cond)) did.push({ tip }); });
    const yesNo = (ok) => (ok ? '<b class="yes">True</b>' : '<b class="no">False</b>');

    if ((m = code.match(/^for\s+(.+?)\s+in\s+(.+):\s*(#.*)?$/))) {
      concept = 'for';
      const names = m[1].replace(/[()[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      names.forEach((n) => explained.add(n));
      const { n, rounds } = loopRound(i);
      if (nextInside) {
        did.push(`<b>Round ${n}${rounds > 0 ? ` of ${rounds}` : ''}</b> of the loop: ${names.map((x) => `<code>${esc(x)}</code> = ${showV(findVar(a, x), a)}`).join(', ')}.`);
        did.push(`Now the indented lines under <code>for</code> run with this value.`);
        const itName = m[2].trim();
        const itv = /^[A-Za-z_]\w*$/.test(itName) ? pyStr(findVar(b, itName)) : null;
        if (itv && n - 1 < [...itv].length) {
          did.push({ html: strStrip(itv, new Set([n - 1]), `<div class="str-h">A string is a sequence of characters: the loop is at index <b>${n - 1}</b> of <code>${esc(itName)}</code>.</div>`) });
        }
        if (n === 1) {
          const sub = substitute(m[2], b) || m[2];
          const r = sub.match(/^range\((\d+)\)$/);
          did.push({ tip: r ? `<code>${esc(m[2])}</code> is <code>range(${r[1]})</code>, which gives the numbers 0 to ${+r[1] - 1}.` : `The loop takes the items of <code>${esc(m[2])}</code> one by one.` });
        }
      } else {
        did.push(`<b>The loop is finished</b>: there are no more items in <code>${esc(m[2])}</code>${rounds > 0 ? ` (it ran ${rounds} time${rounds > 1 ? 's' : ''})` : ''}.`);
        did.push(`Python jumps to the first line after the loop.`);
      }
    } else if ((m = code.match(/^(if|elif)\s+(.+):\s*(#.*)?$/))) {
      concept = 'if';
      did.push(`<b>Check the condition</b> <code>${esc(m[2])}</code>.${withValues(m[2])}`);
      did.push(`The result is ${yesNo(nextInside)}, so the indented block ${nextInside ? '<b>runs</b>' : 'is <b>skipped</b>'}${!nextInside && m[1] === 'if' ? ' (Python moves on to <code>elif</code>/<code>else</code> if there is one)' : ''}.`);
      condTips(m[2]);
    } else if ((m = code.match(/^while\s+(.+):\s*(#.*)?$/))) {
      concept = 'while';
      const { n } = loopRound(i);
      did.push(`<b>Check #${n}</b> of the while condition <code>${esc(m[1])}</code>.${withValues(m[1])}`);
      did.push(`The result is ${yesNo(nextInside)}, so ${nextInside ? 'the loop body <b>runs again</b>' : 'the loop <b>stops</b> and Python continues after it'}.`);
      condTips(m[1]);
    } else if (/^try\s*:/.test(code)) {
      concept = 'try';
      did.push('<b>Start a try block.</b> Python runs the indented lines; if one of them causes an error, it jumps to a matching <code>except</code> instead of stopping the program.');
    } else if ((m = code.match(/^except\b\s*(.*?)\s*:\s*(#.*)?$/))) {
      concept = 'try';
      const prevExc = i > 0 ? st.display[i - 1].a.exc : null;
      const asName = (m[1].match(/\s+as\s+(\w+)$/) || [])[1];
      const typ = m[1].replace(/\s+as\s+\w+$/, '') || 'any error';
      if (prevExc) did.push(`An error <b>${esc(prevExc.type)}</b> happened on line ${prevExc.line}, so Python left the try block and came to this <code>except</code>.`);
      did.push(nextInside ? `<code>except ${esc(typ)}</code> <b>matches</b> the error, so this block runs and the program continues normally.` : `<code>except ${esc(typ)}</code> does <b>not</b> match the error; Python checks the next handler.`);
      if (asName && nextInside) { explained.add(asName); did.push({ tip: `<code>as ${esc(asName)}</code> stores the error object in <code>${esc(asName)}</code>; <code>str(${esc(asName)})</code> gives its message.` }); }
    } else if (/^finally\s*:/.test(code)) {
      concept = 'try';
      did.push('<b>finally</b>: this block <b>always</b> runs, whether an error happened or not. It is used to clean up.');
    } else if (/^else\s*:/.test(code)) {
      did.push('<b>else</b>: this block runs because the conditions above were not true (after <code>try</code>: because no error happened; after a loop: because it ended without <code>break</code>).');
    } else if ((m = code.match(/^raise\b\s*(.*)$/))) {
      concept = 'raise';
      did.push(`<b>Raise an error</b>${m[1] ? `: <code>${esc(m[1].replace(/\s+#.*$/, ''))}</code>` : ' (re-raise the current one)'}. Normal execution stops here.`);
    } else if ((m = code.match(/^(global|nonlocal)\s+(.+)$/))) {
      concept = 'global';
      did.push(m[1] === 'global'
        ? `<code>${esc(m[2])}</code> now means the variable of the <b>global frame</b>: assigning to it here changes the global one.`
        : `<code>${esc(m[2])}</code> now means the variable of the <b>enclosing function</b>, not a new local one.`);
    } else if ((m = code.match(/^del\s+(.+)$/))) {
      concept = 'del';
      did.push(`<b>Delete</b> <code>${esc(m[1])}</code>.`);
    } else if ((m = code.match(/^assert\s+(.+?)(?:,\s*(.+))?$/))) {
      concept = 'assert';
      did.push(`<b>Check</b> that <code>${esc(m[1])}</code> is true.${withValues(m[1])}`);
      did.push(a.kind === 'error' || a.exc ? 'It is <b class="no">False</b>, so <code>AssertionError</code> is raised.' : 'It is <b class="yes">True</b>, so nothing happens.');
    } else if ((m = code.match(/^match\s+(.+):\s*(#.*)?$/))) {
      concept = 'match';
      did.push(`<b>match</b>: take the value of <code>${esc(m[1])}</code>${withValues(m[1])} and compare it with each <code>case</code> below, from top to bottom.`);
    } else if ((m = code.match(/^case\s+(.+?):\s*(#.*)?$/))) {
      concept = 'match';
      did.push(nextInside ? `The value <b>matches</b> <code>case ${esc(m[1])}</code>, so this block runs and the other cases are skipped.` : `The value does <b>not</b> match <code>case ${esc(m[1])}</code>; Python tries the next case.`);
    } else if ((m = code.match(/^@([\w.]+)/))) {
      concept = 'decorator';
      did.push(`<b>Decorator</b> <code>@${esc(m[1])}</code>: the function defined below is passed to <code>${esc(m[1])}</code>, and the result is stored under the function's name.`);
    } else if (/^(\w+\s*=\s*)?yield\b/.test(code)) {
      concept = 'generator';
      did.push('<b>yield</b>: give a value to whoever asked for it (<code>next()</code> or a <code>for</code> loop) and <b>pause</b> here.');
    } else if ((m = code.match(/^def\s+(\w+)\s*\((.*)\)/))) {
      concept = 'def';
      explained.add(m[1]);
      const params = m[2].trim();
      did.push(`<b>Define the function</b> <code>${esc(m[1])}</code>${params ? ` with parameter${params.includes(',') ? 's' : ''} <code>${esc(params)}</code>` : ' with no parameters'}.`);
      did.push('A function object is created in memory, and the name points to it. The body does <b>not</b> run yet.');
      if (tb.name !== '<module>' && !/^class\s/.test(lineText(Math.max(1, b.line - 1)).trim())) {
        concept = 'closure';
        did.push({ tip: `<code>${esc(m[1])}</code> is defined <b>inside</b> <code>${esc(tb.name)}()</code>. If it uses variables of <code>${esc(tb.name)}</code>, it will <b>remember</b> them even after <code>${esc(tb.name)}</code> returns (a <b>closure</b>).` });
      }
      if (/\byield\b/.test(funcBody(b.line))) did.push({ tip: 'This function contains <code>yield</code>, so it is a <b>generator function</b>: calling it gives a generator object instead of running the body.' });
    } else if ((m = code.match(/^class\s+(\w+)/))) {
      concept = 'class';
      explained.add(m[1]);
      did.push(`<b>Define the class</b> <code>${esc(m[1])}</code>. Its methods are stored inside the class object.`);
      const par = code.match(/^class\s+\w+\s*\((.+)\)\s*:/);
      if (par && par[1].trim()) did.push({ tip: `<code>${esc(m[1])}</code> <b>inherits</b> from <code>${esc(par[1].trim())}</code>: it gets all its methods and attributes, and can replace (override) some of them.` });
    } else if ((m = code.match(/^with\s+(.+?):\s*(#.*)?$/)) && i > 0 && topFrame(st.display[i - 1].b).fid === tb.fid && st.display[i - 1].b.line > b.line) {
      // Python 3.12 revisits the with line when the block ends
      concept = 'with';
      did.push('<b>The <code>with</code> block is finished.</b> Python comes back to the <code>with</code> line to clean up: it calls the exit method of the file, which <b>closes the file</b>.');
    } else if ((m = code.match(/^with\s+(.+?):\s*(#.*)?$/))) {
      concept = 'with';
      const parts = m[1].split(/,\s*(?=[\w.]+\()/);
      parts.forEach((p) => {
        const w = p.match(/^(.*?)\s+as\s+(\w+)\s*$/);
        const expr = w ? w[1] : p, name = w ? w[2] : null;
        if (name) explained.add(name);
        const op = expr.match(/^open\((.*)\)$/);
        if (op) {
          const sub = substitute(op[1], b) || op[1];
          did.push(`<b>Open a file</b>: <code>open(${esc(sub)})</code>${name ? ` and give the file object the name <code>${esc(name)}</code>` : ''}.`);
        } else did.push(`<b>Enter</b> <code>${esc(expr)}</code>${name ? ` as <code>${esc(name)}</code>` : ''}.`);
      });
      did.push({ tip: 'When the indented block under <code>with</code> ends, Python <b>closes the file automatically</b>.' });
    } else if ((m = code.match(/^(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/))) {
      concept = 'import';
      explained.add(m[1] || m[2]);
      did.push(`<b>Import</b> the module <code>${esc(m[1] || m[2])}</code> so its functions can be used.`);
    } else if ((m = code.match(/^return\b\s*(.*)$/))) {
      concept = 'return';
      const expr = m[1].replace(/\s+#.*$/, '');
      if (expr) did.push(`<b>Evaluate</b> <code>${esc(expr)}</code> to get the value to send back.${withValues(expr)}`);
    } else if (/^break\b/.test(code)) { concept = 'break'; did.push('<b>break</b>: leave the loop now.'); }
    else if (/^continue\b/.test(code)) { concept = 'continue'; did.push('<b>continue</b>: skip to the next round of the loop.'); }
    else if (/^pass\b/.test(code)) { concept = 'pass'; did.push('<b>pass</b>: nothing happens.'); }
    else if ((m = code.match(/^(\w+)\s*,\s*(\w+)\s*=(?!=)\s*(\w+)\s*,\s*(\w+)\s*(#.*)?$/)) && m[1] === m[4] && m[2] === m[3]) {
      concept = 'swap';
      explained.add(m[1]); explained.add(m[2]);
      did.push(`<b>Swap</b> <code>${m[1]}</code> and <code>${m[2]}</code>: ${showV(findVar(b, m[1]), b)} and ${showV(findVar(b, m[2]), b)} → ${showV(findVar(a, m[1]), a)} and ${showV(findVar(a, m[2]), a)}.`);
    } else if (/^[^=]*\]\s*,.*=(?!=)/.test(code) || /^[\w.[\]\s+-]+,\s*[\w.[\]\s+-]+=(?!=)/.test(code)) {
      concept = 'swap';
      did.push('<b>Assign two targets at once</b>: the right side is computed first, then unpacked into the targets on the left.');
    } else if ((m = code.match(/^([A-Za-z_]\w*)\.(\w+)\s*(\+=|-=|\*=|\/=|=)(?!=)\s*(.+)$/))) {
      concept = m[3] === '=' ? 'attr' : 'augassign';
      const rhs = m[4].replace(/\s+#.*$/, '');
      const after = attrValue(a, m[1], m[2]), before = attrValue(b, m[1], m[2]);
      if (after) {
        did.push(`<b>Store</b> in the attribute <code>${esc(m[2])}</code> of the <b>${esc(typeName(after.o))}</b> that <code>${esc(m[1])}</code> points to.${withValues(rhs)}`);
        did.push(before ? `<code>${esc(m[1])}.${esc(m[2])}</code> changed from ${showV(before.v, b)} to ${showV(after.v, a)}.` : `<code>${esc(m[1])}.${esc(m[2])}</code> is now ${showV(after.v, a)}.`);
      } else did.push(`<b>Set</b> the attribute <code>${esc(m[1])}.${esc(m[2])}</code>.${withValues(rhs)}`);
    } else if ((m = code.match(/^([A-Za-z_]\w*)\[(.+?)\]\s*(\+=|-=|\*=|=)(?!=)\s*(.+)$/))) {
      concept = 'item';
      const idx = substitute(m[2], b) || m[2];
      did.push(`<b>Replace the item</b> at <code>${esc(m[1])}[${esc(m[2])}]</code>${idx !== m[2] ? ` (index <code>${esc(idx)}</code>)` : ''}.${withValues(m[4].replace(/\s+#.*$/, ''))}`);
    } else if ((m = code.match(/^([A-Za-z_ء-ي][\wء-ي]*)\s*(\+=|-=|\*=|\/=|\/\/=|%=|=)(?!=)\s*(.+)$/))) {
      const n = m[1], op = m[2], rhs = m[3].replace(/\s+#.*$/, '');
      concept = op === '=' ? 'assign' : 'augassign';
      explained.add(n);
      if (deeper) {
        did.push(`To get the value of <code>${esc(rhs)}</code>, a function must run first. When it returns, the result will be stored in <code>${esc(n)}</code>.`);
      } else if (sameFrame && a.kind === 'line' && a.line === b.line && (a.comp || a.exc == null) && JSON.stringify(findVar(a, n)) === JSON.stringify(findVar(b, n)) && a.comp) {
        // a comprehension needs several steps on the same line before the variable gets its value
        did.push(`Python is still building the value of <code>${esc(rhs)}</code>, one round at a time. <code>${esc(n)}</code> gets the result when all rounds are done.`);
      } else {
        const v = findVar(a, n), pv = findVar(b, n);
        const sub = substitute(rhs, b);
        if (op !== '=') did.push(`<code>${esc(n)} ${op} ${esc(rhs)}</code> means <code>${esc(n)} = ${esc(n)} ${op.slice(0, -1)} ${esc(rhs)}</code>.`);
        did.push(`<b>Evaluate</b> the right side <code>${esc(rhs)}</code>${sub ? ` → <code>${esc(sub)}</code>` : ''} = ${showV(v, a)}.`);
        if (v && v[0] === 'R') {
          const o = heapOf(a).get(v[1]);
          const same = pv && pv[0] === 'R' && pv[1] === v[1];
          did.push(same ? `<code>${esc(n)}</code> still points to the same ${esc(typeName(o))}.`
            : `<code>${esc(n)}</code> now <b>points</b> (arrow) to the ${esc(typeName(o))}.`);
          if (pv && pv[0] === 'R' && !same) did.push({ tip: 'Nothing was copied: only the arrow moved to a different object.' });
          if (!pv && /^[A-Za-z_]\w*$/.test(rhs)) did.push({ tip: `<code>${esc(n)}</code> and <code>${esc(rhs)}</code> now point to the <b>same</b> object. Changing it through one name is visible through the other.` });
        } else {
          did.push(pv ? `<code>${esc(n)}</code> changed from ${showV(pv, b)} to ${showV(v, a)}.` : `A new variable <code>${esc(n)}</code> is created with the value ${showV(v, a)}.`);
        }
      }
    } else {
      // expression statement: print(...), obj.method(...), function call ...
      concept = /^print\s*\(/.test(code) ? 'print' : /^[\w.]+\.\w+\s*\(/.test(code) ? 'method' : deeper ? 'call' : 'expr';
      const w = withValues(code.replace(/\s+#.*$/, ''));
      if (w) did.push(`<b>Evaluate</b> <code>${esc(code)}</code>.${w}`);
    }

    // Function call: a new frame
    if (deeper) {
      if (!concept || concept === 'expr' || concept === 'assign') concept = concept === 'assign' ? 'assign' : 'call';
      const params = ta.vars.map(([k, v]) => `<code>${esc(k)}</code> = ${showV(v, a)}`).join(', ');
      const classBody = /^class\s/.test(code);
      const genSeen = ta.gen && st.display.slice(0, i).some((x) => x.b.stack.some((f) => f.fid === ta.fid));
      if (classBody) {
        concept = 'class';
        did.push('Python now runs the <b>body of the class</b> once, in a temporary frame, to collect its methods and class variables. No object is created yet.');
      } else if (ta.gen) {
        concept = 'generator';
        did.push(genSeen
          ? `<b>Resume</b> the generator <code>${esc(ta.name)}()</code>: it continues right after the <code>yield</code> where it paused, with its saved variables.`
          : `<b>Start</b> the generator <code>${esc(ta.name)}()</code> for the first time: its body runs until the first <code>yield</code>.`);
      } else if (ta.name === '<lambda>') {
        concept = 'lambda';
        did.push(`<b>Call the lambda function</b> with ${params || 'no arguments'}. It returns the value of its one expression.`);
      } else if (ta.name === '__init__') {
        concept = 'class';
        const selfV = ta.vars.find(([k]) => k === 'self');
        const o = selfV && selfV[1][0] === 'R' ? heapOf(a).get(selfV[1][1]) : null;
        const owner = (ta.qn || '').includes('.') ? ta.qn.split('.').slice(-2, -1)[0] : null;
        if (/\bsuper\(\)/.test(code)) did.push(`<b>super().__init__</b>: run the <code>__init__</code> of the parent class <code>${esc(owner || '')}</code> for this same ${esc(o ? o.cls : '')} object.`);
        else did.push(`<b>Create a new ${esc(o ? o.cls : '')} object.</b> Python makes an empty object, then automatically calls <code>__init__</code> to set it up.`);
        if (owner && o && owner !== o.cls && !/\bsuper\(\)/.test(code)) did.push({ tip: `<code>${esc(o.cls)}</code> has no <code>__init__</code> of its own, so the one from the parent class <code>${esc(owner)}</code> is used.` });
        did.push({ tip: '<code>self</code> is the new object. Each <code>self.name = ...</code> line inside <code>__init__</code> adds an attribute to it.' });
      } else {
        const selfV = ta.vars.find(([k]) => k === 'self');
        const selfO = selfV && selfV[1][0] === 'R' ? heapOf(a).get(selfV[1][1]) : null;
        const owner = (ta.qn || '').includes('.') ? ta.qn.split('.').slice(-2, -1)[0] : null;
        if (selfO && selfO.t === 'instance') {
          did.push(`<b>Call the method</b> <code>${esc(ta.name)}()</code> on the <b>${esc(selfO.cls)}</b> object. Inside the method, <code>self</code> is that object.`);
          if (owner && owner !== selfO.cls) did.push({ tip: `<code>${esc(selfO.cls)}</code> has no own <code>${esc(ta.name)}</code>, so Python looked it up in the parent class <code>${esc(owner)}</code> and used <code>${esc(owner)}.${esc(ta.name)}</code> (<b>inheritance</b>).` });
          else if (owner && !/\bsuper\(\)/.test(code)) {
            // Does a parent class also define this method? Then this one overrides it.
            const h = heapOf(a), cls = selfO.clsref ? h.get(selfO.clsref[1]) : null;
            const parents = cls && cls.baserefs ? cls.baserefs.map(([n, r]) => [n, h.get(r[1])]) : [];
            const hit = parents.find(([, pc]) => pc && pc.attrs.some(([k]) => k === ta.name));
            if (hit) did.push({ tip: `<code>${esc(selfO.cls)}</code> has its <b>own</b> <code>${esc(ta.name)}</code>, so it is used instead of <code>${esc(hit[0])}.${esc(ta.name)}</code>. This is called <b>overriding</b>.` });
          } else if (owner && /\bsuper\(\)/.test(code)) did.push({ tip: `<code>super()</code> calls the method of the <b>parent class</b> <code>${esc(owner)}</code>, so the parent can set up its part of the object.` });
          if (SPECIAL[ta.name] && ta.name !== '__init__' && !new RegExp('\\.' + ta.name + '\\s*\\(').test(code)) did.push({ tip: `<code>${esc(ta.name)}</code> is a <b>special method</b>: the code did not call it by name, Python called it automatically (${SPECIAL[ta.name]}).` });
          concept = 'oop';
        } else {
          did.push(`<b>Call</b> <code>${esc(ta.name)}()</code>. Execution jumps into the function.`);
          // closure: the called function carries remembered values
          const fo = [...heapOf(a).values()].find((o) => o.t === 'function' && o.name === ta.name && o.closure && o.closure.length);
          if (fo) {
            concept = 'closure';
            did.push({ tip: `<code>${esc(ta.name)}</code> is a <b>closure</b>: it still remembers ${fo.closure.map(([k, v]) => `<code>${esc(k)}</code> = ${showV(v, a)}`).join(', ')} from the function that created it.` });
          }
        }
      }
      if (genSeen) mem.push(`The paused frame of <code>${esc(ta.name)}()</code> is active again, with the variables it had when it paused.`);
      else if (classBody) mem.push(`A temporary frame for the class body <code>${esc(ta.name)}</code> is created; when it ends, everything in it becomes part of the class object.`);
      else mem.push(`A new frame <code>${esc(ta.name)}()</code> is created${params ? ` with ${params}` : ''}.`);
      const same = a.stack.filter((f) => (f.qn || f.name) === (ta.qn || ta.name)).length;
      if (same > 1) {
        did.push({ tip: `<code>${esc(ta.name)}</code> is calling itself (<b>recursion</b>). There are now ${same} frames of it, each with its own variables. A base case must stop the calls.` });
      }
    }

    // Functions that returned during this step
    d.rets.forEach((r) => {
      if (r.yield) {
        concept = 'generator';
        did.push(`<code>${esc(r.func)}()</code> <b>yields</b> ${showV(r.ret, r)} and <b>pauses</b>.`);
        mem.push(`The frame of <code>${esc(r.func)}()</code> is <b>paused</b>, not removed: its variables are saved inside the generator object.`);
        return;
      }
      if (r.raised) {
        did.push(`<code>${esc(r.func)}()</code> <b>stops</b> because of the error, without returning a value. The error is passed up to the line that called it.`);
        mem.push(`The frame of <code>${esc(r.func)}()</code> is removed.`);
        return;
      }
      const has = r.ret && !(r.ret[0] === 'P' && r.ret[1] === 'NoneType');
      did.push(has
        ? `<code>${esc(r.func)}()</code> <b>returns</b> ${showV(r.ret, r)} to the line that called it.`
        : `<code>${esc(r.func)}()</code> reached its end and returns <code>None</code>.`);
      mem.push(`The frame of <code>${esc(r.func)}()</code> is removed; its local variables are gone.`);
    });

    // Variables that changed and were not explained above
    if (!deeper) {
      const fa = ta;
      const fb = b.stack.find((f) => f.fid === fa.fid);
      const pv = fb ? new Map(fb.vars.map(([k, v]) => [k, v])) : new Map();
      fa.vars.forEach(([k, v]) => {
        if (explained.has(k) || /^(def|class)\s/.test(code)) return;
        const old = pv.get(k);
        if (!old) mem.push(`New variable <code>${esc(k)}</code> = ${showV(v, a)}.`);
        else if (JSON.stringify(old) !== JSON.stringify(v)) mem.push(`<code>${esc(k)}</code> changed from ${showV(old, b)} to ${showV(v, a)}.`);
      });
    }

    // Objects created, changed or no longer used
    const ha = heapOf(a), hb = heapOf(b);
    let created = 0, changed = 0, freed = 0;
    ha.forEach((o, id) => {
      const old = hb.get(id);
      if (o.t === 'file') return;
      if (!old && o.t === 'generator') {
        concept = 'generator';
        mem.push(`A <b>generator object</b> was created. Calling a generator function does <b>not</b> run its body yet: it waits for <code>next()</code> or a <code>for</code> loop.`);
        return;
      }
      if (!old && o.t === 'function' && o.closure && o.closure.length) {
        mem.push(`A new function <code>${esc(o.name)}</code> was created that <b>remembers</b> ${o.closure.map(([k, v]) => `<code>${esc(k)}</code> = ${showV(v, a)}`).join(', ')} (a closure).`);
      }
      if (!old) {
        if (created++ < 3 && o.t !== 'function' && o.t !== 'class') mem.push(`A new <b>${esc(typeName(o))}</b> was created: <code>${esc(o.r)}</code>.`);
      } else if (o.t !== 'generator' && o.t !== 'class' && JSON.stringify(old) !== JSON.stringify(o) && changed++ < 3) {
        mem.push(`The ${esc(typeName(o))} changed <i>in place</i>: <code>${esc(old.r)}</code> → <code>${esc(o.r)}</code>.`);
      }
    });
    hb.forEach((o, id) => {
      if (!ha.has(id) && o.t !== 'file' && freed++ < 2 && o.t !== 'function' && o.t !== 'class') {
        mem.push(`No variable points to the ${esc(typeName(o))} <code>${esc(o.r)}</code> any more, so Python can delete it (garbage collection).`);
      }
    });

    const generic = () => !concept || ['assign', 'expr', 'call', 'method', 'augassign', 'print'].includes(concept);
    // input(): values taken from the Input box
    (a.inp || []).forEach(([prompt, val, n]) => {
      did.push(`<code>input(${prompt ? esc(JSON.stringify(prompt)) : ''})</code> read <code>${esc(JSON.stringify(val))}</code> from line ${n} of the <b>Input</b> box.`);
      did.push({ tip: /\b(int|float)\s*\(\s*input\b/.test(code)
        ? `<code>${/\bfloat\s*\(/.test(code) ? 'float' : 'int'}(...)</code> converts that text into a number.`
        : 'input() always gives <b>text</b> (str). To calculate with it, convert it: <code>int(input())</code>.' });
      concept = 'input';
    });
    // An error (exception) was raised during this step
    if (a.exc) {
      const ex = a.exc;
      did.push(`<b class="no">Error raised</b>: <code>${esc(ex.type)}: ${esc(ex.msg)}</code>${ex.func !== '<module>' && ex.func !== tb.name ? ` (inside <code>${esc(ex.func)}()</code>)` : ''}.`);
      if (a.kind === 'line') {
        const tgt = lineText(a.line).trim();
        did.push(/^except\b/.test(tgt)
          ? `The rest of the try block is skipped: Python <b>jumps</b> to <code>${esc(tgt)}</code> (line ${a.line}) to look for a matching handler.`
          : /^finally\b/.test(tgt) ? `Python jumps to <code>finally</code> (line ${a.line}) before passing the error on.`
            : `The error was handled; execution continues at line ${a.line}.`);
        if (generic()) concept = 'try';
      } else if (a.kind === 'error') concept = concept === 'raise' ? 'raise' : 'try';
    }
    // Comprehension rounds (counted across the steps of this line)
    (a.comp || []).forEach((c) => {
      let before = 0;
      for (let j = i - 1; j >= 0; j--) {
        const pc = (st.display[j].a.comp || []).find((x) => x.id === c.id);
        if (!pc || st.display[j].b.line !== b.line) break;
        before += pc.n;
      }
      const KIND = { list: 'List comprehension', set: 'Set comprehension', dict: 'Dict comprehension', generator: 'Generator expression' };
      const rows = c.rounds.map((r, k) => `<tr class="${r.k ? '' : 'skip'}"><td class="rn">${before + k + 1}</td><td>${c.names.map((nm, q) => `<code>${esc(nm)}</code> = <code>${esc(r.v[q])}</code>`).join(', ')}</td><td>${r.k ? (r.r != null ? `→ <code>${esc(r.r)}</code>` : 'kept') : '<span class="no">skipped (condition False)</span>'}</td></tr>`).join('');
      const more = c.n > c.rounds.length ? `<tr><td></td><td colspan="2" class="none">… ${c.n - c.rounds.length} more rounds</td></tr>` : '';
      const span = c.n > 1 ? `rounds ${before + 1}–${before + c.n}` : `round ${before + 1}`;
      did.push({ html: `<div class="comp-box"><div class="comp-h"><b>${KIND[c.kind] || 'Comprehension'}</b> · ${span}${c.kind === 'dict' ? ' <small>(value shown)</small>' : ''}</div><table class="comp-t"><tr><th>#</th><th>loop variable</th><th>${c.has_if ? 'condition → value' : 'value added'}</th></tr>${rows}${more}</table></div>` });
      if (generic()) concept = 'comprehension';
    });
    if (/\blambda\b/.test(code)) {
      did.push({ tip: '<code>lambda</code> creates a small function without a name; its single expression is its return value.' });
      if (generic()) concept = 'lambda';
    }
    // Strings: show characters with their indexes when a string is indexed or sliced
    const sv = strViz(code, b);
    sv.forEach((h) => did.push({ html: h }));
    if (sv.length && generic()) concept = 'string';

    // Files: opened / read / written / closed, and changes on the disk
    const files = [];
    const fname = (o) => `<code>${esc(o.name == null ? '(in memory)' : o.name)}</code>`;
    ha.forEach((o, id) => {
      if (o.t !== 'file') return;
      const old = hb.get(id);
      if (!old) {
        if (o.closed) return;
        files.push(`<b>Opened</b> ${fname(o)} in mode <code>${esc(o.mode)}</code> (${esc(modeText(o.mode))}). The cursor starts at position ${o.pos == null ? 0 : o.pos}${/a/.test(o.mode) && o.pos ? ' (the end, because of append mode)' : ''}.`);
        const k = String(o.mode).replace(/[bt]/g, '');
        if (k === 'w' || k === 'w+') files.push({ tip: 'Mode <code>w</code> <b>erases</b> the old content of the file (or creates it if it does not exist).' });
        else if (k === 'a' || k === 'a+') files.push({ tip: 'Mode <code>a</code> keeps the old content and adds new text at the <b>end</b>.' });
        else if (k === 'x') files.push({ tip: 'Mode <code>x</code> only creates a <b>new</b> file. If it already exists you get <b>FileExistsError</b>.' });
        else if (k === 'r') files.push({ tip: 'Mode <code>r</code> only reads. The file must already exist, otherwise you get <b>FileNotFoundError</b>.' });
        if (/b/.test(o.mode)) files.push({ tip: '<code>b</code> = binary: you read and write <b>bytes</b>, not text.' });
        return;
      }
      if (!old.closed && o.closed) {
        files.push(/\.close\s*\(/.test(code) ? `<b>Closed</b> ${fname(o)}.` : `${fname(o)} was <b>closed automatically</b> because the <code>with</code> block ended.`);
      } else if (!o.closed && old.pos != null && o.pos != null && o.pos !== old.pos) {
        const n = o.pos - old.pos;
        const w = !/^r[bt]?$/.test(o.mode) && !/\.(read|readline|readlines)\s*\(|\bload\s*\(|\breader\b|^for\s/.test(code);
        files.push(w ? `<b>Wrote</b> ${n} ${/b/.test(o.mode) ? 'byte' : 'character'}${n === 1 ? '' : 's'} to ${fname(o)}. The cursor moved from ${old.pos} to ${o.pos}.`
          : `<b>Read</b> ${n} ${/b/.test(o.mode) ? 'byte' : 'character'}${n === 1 ? '' : 's'} from ${fname(o)}. The cursor moved from ${old.pos} to ${o.pos}${o.size != null && o.pos >= o.size ? ' — the <b>end of the file</b>' : ''}.`);
      } else if (!o.closed && old.pos != null && o.pos == null) {
        files.push(`Reading ${fname(o)} line by line with a <code>for</code> loop.`);
      }
    });
    const disks = st.result.disks || [];
    if (b.dk != null && a.dk != null && b.dk !== a.dk) {
      const db = new Map((disks[b.dk] || []).map((e) => [e[0], e])), da = new Map((disks[a.dk] || []).map((e) => [e[0], e]));
      da.forEach((e, k) => {
        const o = db.get(k);
        if (!o) files.push(`<b>New file on disk</b>: <code>${esc(k)}</code> (${fmtSize(e[1])}).`);
        else if (e[1] === 0 && o[1] > 0) files.push(`<code>${esc(k)}</code> was <b>emptied</b> (mode <code>w</code> erases the old content).`);
        else if (e[1] > o[1]) files.push(`<code>${esc(k)}</code> on disk grew from ${fmtSize(o[1])} to ${fmtSize(e[1])}.`);
        else if (JSON.stringify(e) !== JSON.stringify(o)) files.push(`<code>${esc(k)}</code> on disk changed (${fmtSize(e[1])}).`);
      });
      db.forEach((e, k) => { if (!da.has(k)) files.push(`<code>${esc(k)}</code> was <b>deleted</b> from the disk.`); });
    }
    if (files.length && (!concept || ['assign', 'expr', 'method', 'call', 'augassign'].includes(concept))) concept = 'file';
    if (/\bpickle\./.test(code)) concept = 'pickle';
    else if (/\bcsv\./.test(code)) concept = 'csv';
    else if (/\bpd\.|\bpandas\b|DataFrame|\.loc\[|\.iloc\[/.test(code)) concept = 'pandas';

    // Turtle drawing and printed text
    const cmds = st.result.cmds.slice(b.nc, a.nc);
    cmds.slice(0, 4).forEach((c) => did.push({ draw: esc(c.desc) }));
    if (cmds.length > 4) did.push({ draw: `… and ${cmds.length - 4} more drawing commands` });
    const printed = st.result.out.slice(b.no, a.no).join('').replace(/\n$/, '');
    if (printed) did.push(`<b>Output</b>: <code>${esc(printed)}</code>`);

    if (!did.length) did.push('Python ran this line.');

    const list = (arr) => '<ul>' + arr.map((it) => {
      if (typeof it === 'string') return `<li>${it}</li>`;
      if (it.html) return `<li class="viz">${it.html}</li>`;
      if (it.draw) return `<li class="draw">${it.draw}</li>`;
      return `<li class="tip">${it.tip}</li>`;
    }).join('') + '</ul>';

    let html = `<div class="ex-head"><span class="ln">Line ${b.line}</span><code>${esc(code)}</code></div>`;
    if (tb.name !== '<module>') {
      const depth = b.stack.length - 1;
      html += `<div class="ex-ctx">Inside <code>${esc(tb.name)}()</code>${depth > 1 ? `, ${depth} calls deep` : ''}</div>`;
    }
    html += `<h5>What Python did</h5>${list(did)}`;
    if (mem.length) html += `<h5>In memory</h5>${list(mem)}`;
    if (files.length) html += `<h5>Files</h5>${list(files)}`;
    const fns = usedBuiltins(code);
    if (fns.length) html += `<h5>Functions used</h5>${list(fns.map((f) => ({ tip: BUILTINS[f] })))}`;
    if (a.kind === 'error') html += errorHtml(st.result.error);
    if (concept && CONCEPTS[concept]) {
      const [title, text] = CONCEPTS[concept];
      html += `<details class="concept"${st.conceptOpen ? ' open' : ''}><summary>Concept: ${title}</summary><p>${text}</p></details>`;
    }
    if (a.kind !== 'error') {
      if (isLast) html += '<p class="ex-next">Last step: the program has finished.</p>';
      else if (a.kind === 'line') html += `<p class="ex-next">Next: line <b>${a.line}</b> <code>${esc(lineText(a.line).trim())}</code></p>`;
    }
    $('#explain').innerHTML = html;
    const det = $('#explain details.concept');
    if (det) det.addEventListener('toggle', () => { st.conceptOpen = det.open; store.set('vp-concept', det.open ? '1' : '0'); });
  }

  /* ================= Friendly errors ================= */
  function levenshtein(s, t) {
    const d = Array.from({ length: s.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= t.length; j++) d[0][j] = j;
    for (let i = 1; i <= s.length; i++) for (let j = 1; j <= t.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    return d[s.length][t.length];
  }
  function suggestName(name) {
    const pool = new Set(['print', 'range', 'len', 'str', 'int', 'float', 'input', 'list', 'dict', 'set', 'tuple', 'sum', 'min', 'max', 'sorted', 'True', 'False', 'None', 'append']);
    st.result.steps.forEach((s) => s.stack.forEach((f) => f.vars.forEach(([k]) => pool.add(k))));
    let best = null, bd = 3;
    pool.forEach((p) => { const x = levenshtein(name.toLowerCase(), p.toLowerCase()); if (x < bd && p !== name) { bd = x; best = p; } });
    return best;
  }
  function errorHtml(err) {
    const t = err.type, msg = err.msg || '';
    let ex = 'An error occurred while running.', mm;
    if (t === 'NameError') {
      const name = err.name || (msg.match(/'(.+?)'/) || [])[1] || '';
      const sug = name && suggestName(name);
      ex = `The name <code>${esc(name)}</code> is not defined. Is it spelled correctly? Was it created before this line?` + (sug ? `<br>Did you mean <code>${esc(sug)}</code>?` : '');
    } else if (t === 'IndentationError' || t === 'TabError') {
      ex = '<b>Indentation</b> problem: lines inside <code>for</code>/<code>if</code>/<code>def</code> must be indented by the same amount (usually 4 spaces).';
    } else if (t === 'SyntaxError') {
      ex = '<b>Syntax</b> error: check colons <code>:</code>, brackets and quotes.';
      if (/expected ':'/.test(msg)) ex = 'Missing a <b>colon</b> <code>:</code> at the end of the line.';
      else if (/was never closed|unexpected EOF/.test(msg)) ex = 'A <b>bracket was never closed</b>.';
      else if (/unterminated string/.test(msg)) ex = 'A string is missing its closing quote.';
      else if (/Maybe you meant '=='/.test(msg)) ex = 'Use <code>==</code> to compare, not <code>=</code>.';
      else if (/invalid character/.test(msg)) ex = 'There is an <b>invalid character</b> in the code (for example a non-English comma or quote).';
    } else if (t === 'TypeError') {
      if ((mm = msg.match(/^(\S+)\(\) missing \d+ required positional arguments?: (.+)$/))) ex = `<code>${esc(mm[1])}()</code> needs more arguments: <code>${esc(mm[2])}</code>`;
      else if ((mm = msg.match(/^(\S+)\(\) takes (\d+) positional arguments? but (\d+) (?:was|were) given$/))) ex = `<code>${esc(mm[1])}()</code> received ${mm[3]} arguments but accepts only ${mm[2]}.`;
      else if (/can only concatenate str|for \+: 'int' and 'str'/.test(msg)) ex = 'You cannot add a <b>string</b> and a <b>number</b>. Use <code>str(number)</code>.';
      else if (/not callable/.test(msg)) ex = 'You tried to call something that is not a function.';
      else if (/not subscriptable/.test(msg)) ex = 'You used <code>[ ]</code> on a value that is not a list or dictionary.';
      else ex = 'The value has the wrong type for this operation.';
    } else if (t === 'ZeroDivisionError') ex = 'You cannot <b>divide by zero</b>.';
    else if (t === 'IndexError') ex = 'That index is <b>out of range</b>. Indexes start at <code>0</code>; the last one is <code>len - 1</code>.';
    else if (t === 'KeyError') ex = 'That key is not in the dictionary.';
    else if (t === 'AttributeError') ex = `This object has no attribute <code>${esc(err.name || '')}</code>.`;
    else if (t === 'ValueError' && !/closed file/.test(msg)) ex = 'Invalid value (for example <code>int("abc")</code>).';
    else if (t === 'ModuleNotFoundError' || t === 'ImportError') ex = 'This module is not available in the browser.';
    else if (t === 'EOFError') ex = '<code>input()</code> asked for a value, but the <b>Input</b> box (under the code) has no more lines. Type one value per line there.';
    else if (t === 'StopIteration') ex = 'The generator (or iterator) has <b>no more values</b>: <code>next()</code> was called after it finished.';
    else if (t === 'AssertionError') ex = 'An <code>assert</code> condition was <b>False</b>.';
    else if (t === 'UnboundLocalError') ex = 'This function assigns to the variable, so Python treats it as <b>local</b>, but it is used before it gets a value. If you meant the global variable, add <code>global name</code> at the top of the function.';
    else if (t === 'FileNotFoundError') ex = 'The file <b>does not exist</b> (check the name and the folder). Mode <code>"r"</code> can only open files that already exist; <code>"w"</code> or <code>"a"</code> would create it. Look at the <b>Disk</b> column in Memory to see which files exist.';
    else if (t === 'FileExistsError') ex = 'Mode <code>"x"</code> only creates a <b>new</b> file, and this file already exists. Use <code>"w"</code> to overwrite it or <code>"a"</code> to add to it.';
    else if (t === 'IsADirectoryError') ex = 'That path is a <b>folder</b>, not a file.';
    else if (t === 'PermissionError') ex = 'You are not allowed to open this file.';
    else if (t === 'UnicodeDecodeError') ex = 'The bytes in the file are not valid in this <b>encoding</b>. Try <code>encoding="utf-8"</code>, or open it in binary mode <code>"rb"</code>.';
    else if (t === 'UnsupportedOperation') ex = /not readable/.test(msg) ? 'This file was opened for <b>writing</b>, so it cannot be read. Open it with <code>"r"</code> (or <code>"r+"</code>).' : /not writable/.test(msg) ? 'This file was opened for <b>reading</b>, so it cannot be written. Open it with <code>"w"</code> or <code>"a"</code>.' : 'This operation is not supported on this file.';
    else if (t === 'ValueError' && /closed file/.test(msg)) ex = 'The file is already <b>closed</b>. After a <code>with</code> block ends (or after <code>close()</code>) you cannot read or write it.';
    else if (t === 'UnpicklingError' || t === 'EOFError') ex = 'Could not read the pickle data: the file is empty, damaged, or not a pickle file.';
    else if (t === 'TooLong') ex = '<b>Too many steps</b>. This is probably an <b>infinite loop</b>: a <code>while</code> condition that never becomes false.';
    else if (t === 'TooMany') ex = 'Too many drawing commands, so the program was stopped.';
    else if (t === 'RecursionError') ex = 'The function calls itself <b>without stopping</b>. It needs a base case.';
    else if (t === 'OSError' && /stdin|I\/O/.test(msg)) ex = 'Could not read input.';
    return `<div class="error-box"><b>Error on line ${err.line}</b> <span class="etype">${esc(t)}</span><p>${ex}</p><pre>${esc(msg)}</pre></div>`;
  }

  /* ================= Output ================= */
  function renderOut(n, from) {
    const out = st.result ? st.result.out : [];
    const box = $('#output');
    if (!n) { box.innerHTML = '<span class="empty">No output. Anything you <code>print()</code> appears here.</span>'; return; }
    let html = '';
    for (let i = 0; i < n; i++) html += from >= 0 && i >= from ? `<mark>${esc(out[i])}</mark>` : esc(out[i]);
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  /* ================= Tabs ================= */
  function switchTab(name) {
    st.tab = name;
    store.set('vp-tab', name);
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    $('#flowTools').hidden = name === 'gfx';
    $('#diskReset').hidden = name !== 'mem';
    if (name === 'mem') requestAnimationFrame(() => { applyMemZoom(); drawArrows(); });
    if (name === 'flow') scrollFlowTo($('#flow .fc-node.active'));
  }

  /* ================= Events ================= */
  let autoTimer = null;
  // Input box for input(): opens by itself when the code uses input()
  const stdinBox = $('#stdinBox'), stdinEl = $('#stdin');
  stdinEl.value = store.get('vp-stdin') ?? 'Sara\n20';
  const syncStdinBox = () => { if (/\binput\s*\(/.test(cm.getValue())) stdinBox.open = true; };
  syncStdinBox();
  stdinEl.addEventListener('input', () => {
    store.set('vp-stdin', stdinEl.value);
    if (st.mode === 'step') { stopPlay(); st.mode = 'final'; $('#stepper').hidden = true; clearMarks(); }
    clearTimeout(autoTimer);
    if (st.auto && st.ready) autoTimer = setTimeout(run, 700);
  });
  cm.on('change', () => {
    if (st.loading) { syncStdinBox(); return; }
    syncStdinBox();
    store.set('vp-code', cm.getValue());
    if (st.mode === 'step') { stopPlay(); st.mode = 'final'; $('#stepper').hidden = true; clearMarks(); }
    clearTimeout(autoTimer);
    if (st.auto && st.ready) autoTimer = setTimeout(run, 700);
  });
  cm.on('cursorActivity', () => {
    const line = cm.getCursor().line + 1;
    if (line === st.selLine) return;
    st.selLine = line;
    markFlowSel();
  });

  $('#flow').addEventListener('click', (e) => {
    const g = e.target.closest('.fc-node.has-line');
    if (!g || st.suppressClick) return;
    const line = +g.dataset.line;
    cm.setCursor({ line: line - 1, ch: lineText(line).length });
    cm.scrollIntoView({ line: line - 1, ch: 0 }, 80);
    cm.focus();
  });
  $('#flow').addEventListener('mouseover', (e) => {
    const g = e.target.closest('.fc-node.has-line');
    setHoverLine(g ? +g.dataset.line : 0);
  });
  $('#flow').addEventListener('mouseleave', () => setHoverLine(0));

  $('#btnRun').onclick = run;
  $('#btnStep').onclick = () => startStep(0);
  $('#btnFirst').onclick = () => { stopPlay(); showStep(0); };
  $('#btnPrev').onclick = () => { stopPlay(); showStep(st.idx - 1); };
  $('#btnNext').onclick = () => { stopPlay(); showStep(st.idx + 1); };
  $('#btnLast').onclick = () => { stopPlay(); showStep(st.display.length - 1); };
  $('#btnPlay').onclick = () => (st.timer ? stopPlay() : play());
  $('#btnExitStep').onclick = () => { stopPlay(); if (st.result) showFinal(); };
  $('#stepRange').oninput = (e) => { stopPlay(); showStep(+e.target.value); };
  $('#btnClear').onclick = () => { cm.setValue(''); cm.focus(); };
  $('#chkAuto').checked = st.auto;
  $('#chkAuto').onchange = (e) => { st.auto = e.target.checked; store.set('vp-auto', st.auto ? '1' : '0'); };
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
  $('#zoomIn').onclick = () => zoomBy(1.2);
  $('#zoomOut').onclick = () => zoomBy(1 / 1.2);
  $('#zoomFit').onclick = fitZoom;
  $('#layoutReset').onclick = resetLayout;
  $('#diskReset').onclick = () => {
    if (!st.ready) return;
    st.py.runPython('_clear_disk()');
    setStatus('ready', 'Disk reset: only data.txt is left');
    if (st.mode === 'step') startStep(0); else run();
  };

  const sel = $('#examples');
  window.EXAMPLES.forEach((ex, i) => { const o = document.createElement('option'); o.value = i; o.textContent = ex.name; sel.appendChild(o); });
  sel.onchange = () => {
    if (sel.value === '') return;
    cm.setValue(window.EXAMPLES[+sel.value].code);
    sel.value = '';
    run();
  };

  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { applyCodeWidth(); drawArrows(); }, 120); });

  /* ================= Resizable layout ================= */
  // Generic pointer drag (mouse, pen and touch)
  function dragHandle(el, onStart, onMove, onEnd) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      document.body.classList.add('resizing');
      const start = onStart(e);
      const move = (ev) => onMove(ev, start);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.classList.remove('active');
        document.body.classList.remove('resizing');
        onEnd();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
      el.addEventListener('pointercancel', up, { once: true });
    });
  }
  const relayout = () => { cm.refresh(); scheduleArrows(); };

  // 1) Height of the code editor
  const edH = { min: 120, max: () => Math.max(300, window.innerHeight * 1.5) };
  function setEditorHeight(h, save) {
    if (h == null) { cm.getWrapperElement().style.height = ''; cm.refresh(); if (save) store.set('vp-edh', ''); return; }
    h = Math.round(Math.max(edH.min, Math.min(edH.max(), h)));
    cm.setSize(null, h);
    if (save) store.set('vp-edh', String(h));
  }
  const savedH = +(store.get('vp-edh') || 0);
  if (savedH) setEditorHeight(Math.min(savedH, window.innerHeight * 0.9));
  const edRes = $('#edResize');
  dragHandle(edRes, (e) => ({ y: e.clientY, h: cm.getWrapperElement().offsetHeight }),
    (e, s) => setEditorHeight(s.h + e.clientY - s.y), () => { setEditorHeight(cm.getWrapperElement().offsetHeight, true); relayout(); });
  edRes.addEventListener('dblclick', () => { setEditorHeight(null, true); relayout(); });
  edRes.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setEditorHeight(cm.getWrapperElement().offsetHeight + (e.key === 'ArrowDown' ? 30 : -30), true);
  });

  // 2) Width of the code column (wide screens only)
  const layoutEl = $('.layout'), splitter = $('#splitter');
  let codeW = +(store.get('vp-codew') || 0);
  function applyCodeWidth() {
    if (!codeW) { layoutEl.style.removeProperty('--code-w'); return; }
    const maxW = Math.max(300, window.innerWidth - 380);
    layoutEl.style.setProperty('--code-w', Math.round(Math.max(280, Math.min(maxW, codeW))) + 'px');
  }
  applyCodeWidth();
  dragHandle(splitter, (e) => ({ x: e.clientX, w: $('.col-code').offsetWidth }),
    (e, s) => { codeW = s.w + e.clientX - s.x; applyCodeWidth(); scheduleArrows(); },
    () => { store.set('vp-codew', String(Math.round(codeW))); relayout(); });
  splitter.addEventListener('dblclick', () => { codeW = 0; store.set('vp-codew', ''); applyCodeWidth(); relayout(); });
  splitter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    codeW = $('.col-code').offsetWidth + (e.key === 'ArrowRight' ? 30 : -30);
    applyCodeWidth(); store.set('vp-codew', String(Math.round(codeW))); relayout();
  });
  document.addEventListener('keydown', (e) => {
    if (st.mode !== 'step' || cm.hasFocus() || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stopPlay(); showStep(st.idx + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlay(); showStep(st.idx - 1); }
  });

  /* ================= Start ================= */
  switchTab(st.tab === 'gfx' ? 'mem' : st.tab);
  renderMem(null);
  $('#flow').innerHTML = '<p class="empty">Run the code to see the flowchart.</p>';
  $('#output').innerHTML = '<span class="empty">No output yet.</span>';
  $('#explain').innerHTML = '<p class="empty">Please wait while Python loads…</p>';
  boot();
})();
