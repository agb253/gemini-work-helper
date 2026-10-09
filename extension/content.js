// Gemini Work Helper — you press the buttons; nothing is sent without your click.
(() => {
  const $ = (s) => document.querySelector(s);
  const ask = (m) => new Promise(res => chrome.runtime.sendMessage(m, res));
  const editor = () => $('rich-textarea div[contenteditable="true"]') || $('div[contenteditable="true"][role="textbox"]') || $('div.ql-editor');
  const sendBtn = () => $('button[aria-label*="Send" i]') || $('button.send-button');
  const generating = () => !!$('button[aria-label*="Stop" i]');
  const responses = () => document.querySelectorAll('model-response, .model-response-text, message-content');
  let pending = null, watching = false;

  // Panel: drag by its title bar, "–" minimizes it to a small tab (click the tab to reopen).
  // Position and minimized state are remembered. It starts minimized when nothing is waiting.
  const mem = { get(k, d) { try { const v = localStorage.getItem('wh-' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
                set(k, v) { try { localStorage.setItem('wh-' + k, JSON.stringify(v)); } catch (e) {} } };
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:99999;background:#1f2937;color:#f9fafb;font:13px system-ui;padding:10px 12px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35);width:260px';
  box.innerHTML = `<div id="wh-bar" style="display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:6px;cursor:move;user-select:none">
      <span>Work helper</span><button id="wh-min" title="Minimize" style="all:unset;cursor:pointer;padding:0 6px;font-size:16px;line-height:1">–</button></div>
    <div id="wh-s" style="margin-bottom:8px;color:#d1d5db">checking queue…</div>
    <button id="wh-load">Load next batch</button> <button id="wh-run">Paste &amp; Run</button>
    <div style="margin-top:6px"><button id="wh-save">Save reply now</button> <label><input type="checkbox" id="wh-auto" checked> auto-save</label></div>
    <div style="margin-top:6px"><label>Tasks per batch <select id="wh-n"><option>1</option><option>2</option><option>3</option></select></label></div>
    <pre id="wh-log" style="white-space:pre-wrap;max-height:160px;overflow:auto;margin:8px 0 0;color:#a7f3d0;font-size:11px"></pre>`;
  const tab = document.createElement('button');
  tab.title = 'Open the work helper';
  tab.style.cssText = 'position:fixed;z-index:99999;background:#1f2937;color:#f9fafb;font:600 12px system-ui;padding:6px 10px;border-radius:999px;border:1px solid #6b7280;box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer';
  document.body.appendChild(box); document.body.appendChild(tab);
  box.querySelectorAll('button:not(#wh-min)').forEach(b => b.style.cssText = 'background:#374151;color:#fff;border:1px solid #6b7280;border-radius:6px;padding:4px 8px;cursor:pointer;margin:2px 0');
  const S = (t) => box.querySelector('#wh-s').textContent = t;
  const L = (t) => box.querySelector('#wh-log').textContent = t;
  const nSel = box.querySelector('#wh-n'); nSel.value = String(mem.get('n', 1)); nSel.onchange = () => mem.set('n', +nSel.value);

  // position: stored as distance from the right/bottom edges so it stays put when the window resizes
  let pos = mem.get('pos', { r: 16, b: 96 });
  const place = () => {
    pos.r = Math.min(Math.max(0, pos.r), window.innerWidth - 60); pos.b = Math.min(Math.max(0, pos.b), window.innerHeight - 40);
    for (const el of [box, tab]) { el.style.right = pos.r + 'px'; el.style.bottom = pos.b + 'px'; }
  };
  const setMin = (m) => { box.style.display = m ? 'none' : 'block'; tab.style.display = m ? 'block' : 'none'; mem.set('min', m); };
  let waiting = 0;
  const tabText = () => tab.textContent = waiting ? `Work helper · ${waiting}` : 'Work helper';
  box.querySelector('#wh-min').onclick = () => setMin(true);
  function drag(handle, onClick) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.id === 'wh-min')) return;
      const sx = e.clientX, sy = e.clientY, r0 = pos.r, b0 = pos.b; let moved = false;
      const mv = (ev) => { const dx = ev.clientX - sx, dy = ev.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
                           pos = { r: r0 - dx, b: b0 - dy }; place(); };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
                         mem.set('pos', pos); if (!moved && onClick) onClick(); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); e.preventDefault();
    });
  }
  drag(box.querySelector('#wh-bar')); drag(tab, () => setMin(false));
  window.addEventListener('resize', place);
  place(); setMin(mem.get('min', false));

  async function status() {
    const r = await ask({ type: 'status' });
    waiting = r.error ? 0 : (r.todo || 0); tabText();
    if (!r.error && !waiting && !pending && !watching) setMin(true);   // nothing to do: get out of the way
    S(r.error ? r.error : `${r.todo} task(s) waiting · ${r.inflight || 0} in progress` + (pending ? ` · loaded ${pending.pack}` : ''));
  }
  async function load() {
    if (pending && !confirm(`Batch ${pending.pack} is loaded and not saved yet. Load a DIFFERENT batch anyway? (Its tasks come back after 24 h if never saved.)`)) return;
    const r = await ask({ type: 'next', n: +nSel.value || 1 });
    if (r.error) return S(r.error);
    pending = r; const ed = editor(); if (!ed) return S('Could not find the Gemini prompt box.');
    ed.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, r.text);
    S(`Loaded ${r.pack} (${r.ids.length} tasks). Scroll the prompt box to review, then Paste & Run.`);
  }
  async function run() {
    if (watching) return S('Already running — wait for it to finish.');
    const ed = editor();
    if (!pending || !ed || !ed.innerText.trim()) await load();
    if (!pending) return;
    const before = responses().length;
    setTimeout(() => { const b = sendBtn(); if (!b) return S('Could not find the Send button — press Enter yourself.'); b.click(); watch(before); }, 400);
  }
  function watch(before) {
    if (watching) return; watching = true; S('Running… will save when Gemini finishes.');
    let last = '', stable = 0;
    const t = setInterval(async () => {
      const rs = responses(); if (rs.length <= before) return;
      const txt = rs[rs.length - 1].innerText;
      if (!generating() && txt && txt === last) stable++; else stable = 0; last = txt;
      if (stable >= 3) { clearInterval(t); watching = false; if (box.querySelector('#wh-auto').checked) save(txt); else S('Finished. Click "Save reply now".'); }
    }, 2000);
  }
  let saving = false;
  async function save(txt) {
    if (saving) return; saving = true; try {
    const rs = responses(); txt = txt || (rs.length ? rs[rs.length - 1].innerText : '');
    if (!txt) return S('No reply found on the page.');
    S('Saving…'); const r = await ask({ type: 'reply', text: txt });
    L((r.report || [r.error]).join('\n')); if (!r.error) pending = null; S(r.error ? 'Save failed: ' + r.error : `Saved. ${r.todo ?? '?'} task(s) still waiting.`);
    } finally { saving = false; }
  }
  box.querySelector('#wh-load').onclick = load;
  box.querySelector('#wh-run').onclick = run;
  box.querySelector('#wh-save').onclick = () => save();
  status();
})();
