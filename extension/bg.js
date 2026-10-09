importScripts('config.js');  // defines BRIDGE_TOKEN (written by: python3 bridge/bridge.py --write-config)
const BASE = 'http://127.0.0.1:8765';
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  const h = { 'X-Bridge-Token': BRIDGE_TOKEN };
  let p;
  if (msg.type === 'status') p = fetch(`${BASE}/status`, { headers: h });
  else if (msg.type === 'next') p = fetch(`${BASE}/next?n=${msg.n || 3}`, { headers: h });
  else if (msg.type === 'reply') p = fetch(`${BASE}/reply`, { method: 'POST', headers: h, body: msg.text });
  else return;
  p.then(r => r.json()).then(reply).catch(e => reply({ error: 'bridge not running? start it with: gemini-bridge  (' + e + ')' }));
  return true;
});
