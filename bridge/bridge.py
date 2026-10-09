#!/usr/bin/env python3
"""Local bridge between a task queue on disk and the Gemini Work Helper extension.

Listens on 127.0.0.1:8765 only. Every request must carry the X-Bridge-Token header, which
blocks other web pages from talking to it.

  GET  /status        -> {"todo": N, "inflight": N}
  GET  /next?n=3      -> bundles the next N cards from workqueue/todo/ into one prompt
  POST /reply         -> body = Gemini's reply text; splits it per task, runs each card's check

Usage:
  python3 bridge.py --write-config   # create the token and write extension/config.js
  python3 bridge.py                  # run the bridge

Queue lives in $GEMINI_HELPER_QUEUE (default: ./workqueue). See README for the card format.
"""
import os, re, sys, json, glob, shutil, secrets, datetime, threading, traceback, subprocess, urllib.parse
import http.server

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get('GEMINI_HELPER_ROOT', os.getcwd())      # card `output:` paths and `check:` run from here
Q = os.environ.get('GEMINI_HELPER_QUEUE', os.path.join(ROOT, 'workqueue'))
P = os.path.join(Q, 'packs')
TOK_F = os.environ.get('GEMINI_HELPER_TOKEN_FILE', os.path.expanduser('~/.config/gemini-bridge.token'))
PORT = int(os.environ.get('GEMINI_HELPER_PORT', 8765))   # if changed, also edit BASE in extension/bg.js and host_permissions
LOCK = threading.Lock()
for d in ('todo', 'inflight', 'done', 'failed', 'packs'):
    os.makedirs(os.path.join(Q, d), exist_ok=True)


def token():
    if not os.path.exists(TOK_F):
        os.makedirs(os.path.dirname(TOK_F), exist_ok=True)
        fd = os.open(TOK_F, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_hex(16))
    return open(TOK_F).read().strip()


def parse(path):
    """Card = '---' front matter (key: value lines) '---' then the prompt."""
    m = re.match(r'---\n(.*?)\n---\n(.*)', open(path).read(), re.S)
    return dict(re.findall(r'^(\w+):\s*(.*?)\s*(?:#.*)?$', m.group(1), re.M)), m.group(2).strip()


def cards():
    return [c for c in sorted(glob.glob(f'{Q}/todo/*.md')) if parse(c)[0].get('worker', 'gemini-web') == 'gemini-web']


def release_stale(hours=24):
    """Cards loaded into Gemini but never saved come back to todo/ after a day."""
    import time
    for c in glob.glob(f'{Q}/inflight/*.md'):
        if time.time() - os.path.getmtime(c) > hours * 3600:
            shutil.move(c, f'{Q}/todo/')


def pack(n):
    release_stale()
    chosen = cards()[:n]
    if not chosen:
        return None
    ids = [os.path.basename(c)[:-3] for c in chosen]
    body = ["Complete each task below accurately. Never invent a URL or a quote.",
            f"There are {len(chosen)} TASKS below. For EACH task, write a line `RESULT <TASK ID>` (plain text, exactly that),",
            "then immediately one ```json code block containing only the JSON the task asks for. "
            "Nothing else except a one-line note if a task failed.", ""]
    for i, (c, cid) in enumerate(zip(chosen, ids), 1):
        body.append(f"=== TASK {i} — ID: {cid} ===\n{parse(c)[1]}\n")
    txt = '\n'.join(body)
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    open(f'{P}/PACK-{ts}.md', 'w').write(txt)
    for c in chosen:
        shutil.move(c, f'{Q}/inflight/')
        os.utime(f'{Q}/inflight/' + os.path.basename(c))
    return {'pack': f'PACK-{ts}', 'ids': ids, 'text': txt}


def extract_blocks(reply):
    """`RESULT <id>` followed by the first JSON value; works on markdown or rendered page text."""
    out, dec = {}, json.JSONDecoder()
    for m in re.finditer(r'RESULT\s+`?([A-Za-z0-9._-]+)', reply):
        pos = m.end()
        k = min([i for i in (reply.find('[', pos), reply.find('{', pos)) if i >= 0] or [-1])
        if k < 0:
            continue
        try:
            val, _ = dec.raw_decode(reply[k:])
            out[m.group(1).strip('`*: ')] = json.dumps(val)
        except Exception:
            pass
    return out


def unpack(reply):
    ts = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    open(f'{P}/REPLY-{ts}.md', 'w').write(reply)
    blocks = extract_blocks(reply)
    if not blocks:
        return [f'Reply saved as REPLY-{ts}.md but no RESULT blocks were found ({len(reply)} chars). '
                'Gemini may still have been writing, or used a different format.']
    report = []
    for cid, js in blocks.items():
        card = next((f'{Q}/{d}/{cid}.md' for d in ('inflight', 'todo') if os.path.exists(f'{Q}/{d}/{cid}.md')), None)
        if not card:
            report.append(f'{cid}: already filed or unknown, ignored')
            continue
        meta, _ = parse(card)
        out = os.path.join(ROOT, meta['output'])
        os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
        open(out, 'w').write(js)
        check = meta.get('check')
        if check:   # deterministic pass/fail; trusted because cards are files you wrote
            c = subprocess.run(check.format(output=out), shell=True, capture_output=True, text=True, cwd=ROOT, timeout=1800)
            ok, res = c.returncode == 0, f'check rc={c.returncode}: {c.stdout.strip()[-400:]}'
        else:
            ok, res = True, 'no check defined; JSON parsed and saved'
        dest = 'done' if ok else 'failed'
        shutil.move(card, f'{Q}/{dest}/')
        open(f'{Q}/{dest}/{cid}.result', 'w').write(f'# {cid} via gemini {ts}\n{res}\n')
        report.append(f'{cid}: {dest} — {res}')
    report.append(f'{len(blocks)} task block(s) found; reply saved as {P}/REPLY-{ts}.md')
    return report


class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _auth(self):
        if not secrets.compare_digest(self.headers.get('X-Bridge-Token', ''), TOKEN):
            self._send(403, {'error': 'bad token'})
            return False
        return True

    def do_GET(self):
        if not self._auth():
            return
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path == '/status':
            return self._send(200, {'todo': len(cards()), 'inflight': len(glob.glob(f'{Q}/inflight/*.md'))})
        if u.path == '/next':
            with LOCK:
                r = pack(max(1, min(int(q.get('n', ['3'])[0]), 10)))
            return self._send(200, r or {'error': 'no cards left in workqueue/todo/'})
        self._send(404, {'error': 'not found'})

    def do_POST(self):
        if not self._auth():
            return
        if self.path != '/reply':
            return self._send(404, {'error': 'not found'})
        txt = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode('utf8', 'ignore')
        try:
            with LOCK:
                report = unpack(txt)
        except Exception as e:
            traceback.print_exc()
            return self._send(200, {'error': f'save error: {e}', 'todo': len(cards())})
        self._send(200, {'report': report, 'todo': len(cards())})

    def log_message(self, *a):
        pass


TOKEN = token()
if __name__ == '__main__':
    if '--write-config' in sys.argv:
        dest = os.path.join(HERE, '..', 'extension', 'config.js')
        open(dest, 'w').write(f"const BRIDGE_TOKEN = '{TOKEN}';\n")
        os.chmod(dest, 0o600)
        sys.exit(print(f'Wrote {os.path.normpath(dest)}. Now load the extension/ folder in chrome://extensions.') or 0)
    print(f'bridge on http://127.0.0.1:{PORT}  (queue: {Q}, token: {TOK_F})', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
