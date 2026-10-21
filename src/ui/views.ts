/**
 * MCP Apps views (extension io.modelcontextprotocol/ui, spec 2026-01-26).
 *
 * Each view is one self-contained HTML document: no external scripts, styles
 * or fonts, because a host's default CSP for a view allows none. A host loads
 * the document in a sandboxed iframe and talks to it over postMessage with
 * JSON-RPC: the view sends `ui/initialize`, the host answers with its context
 * (theme, style variables), then sends `ui/notifications/tool-input` and
 * `ui/notifications/tool-result` carrying the full CallToolResult. The view
 * renders `structuredContent` — the same data the tool's output schema
 * promises — and falls back to the text content for errors.
 *
 * The buttons (swap a conversion, check or remove a watch) call tools back
 * through the host with `tools/call`, which is how a view stays interactive
 * without holding any credential: the host proxies to this server.
 *
 * Kept as strings in TypeScript rather than .html files so `tsc` ships them in
 * dist/ with nothing else to copy at deploy time.
 */

export const UI_MIME_TYPE = 'text/html;profile=mcp-app';
const APP_PROTOCOL = '2026-01-26';

export type ViewName = 'rates' | 'corridor' | 'watchlist';

export const VIEW_URIS: Record<ViewName, string> = {
  rates: 'ui://afrirate/rates',
  corridor: 'ui://afrirate/corridor',
  watchlist: 'ui://afrirate/watchlist',
};

/**
 * Host style variables from the spec, each with our own fallback, so the view
 * looks right in a host that passes none of them and blends in with one that
 * passes all of them.
 */
const CSS = `
:root {
  color-scheme: light dark;
  --color-background-primary: light-dark(#ffffff, #10151d);
  --color-background-secondary: light-dark(#f4f6f9, #171e29);
  --color-text-primary: light-dark(#141a22, #f3f5f8);
  --color-text-secondary: light-dark(#5b6675, #8b95a5);
  --color-border-primary: light-dark(#dde2e9, #243042);
  --color-text-info: light-dark(#0b6fa4, #2ec5f0);
  --color-text-warning: light-dark(#9a5b00, #ffb347);
  --color-text-danger: light-dark(#b3261e, #ff6b6b);
  --color-text-success: light-dark(#1d7a46, #4fd18b);
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --border-radius-md: 12px;
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body { font: 15px/1.4 var(--font-sans); color: var(--color-text-primary); }
.card { background: var(--color-background-primary); border: 1px solid var(--color-border-primary);
  border-radius: var(--border-radius-md); padding: 14px 16px; display: grid; gap: 8px; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
  color: var(--color-text-secondary); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.head b { color: var(--color-text-info); font: 12px var(--font-mono); text-transform: none; letter-spacing: 0; }
.hero { font-size: 32px; font-weight: 650; line-height: 1.1; }
.sub { color: var(--color-text-secondary); font-size: 14px; }
.row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0;
  border-top: 1px solid var(--color-border-primary); font-size: 14px; }
.row:first-of-type { border-top: 0; }
.row span:last-child { color: var(--color-text-secondary); white-space: nowrap; }
.badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: 600;
  margin-left: 6px; background: var(--color-background-secondary); }
.age { color: var(--color-text-warning); }
.bad { color: var(--color-text-danger); }
.ok { color: var(--color-text-success); }
.note { font-size: 13px; color: var(--color-text-warning); }
.err { color: var(--color-text-danger); font-size: 14px; white-space: pre-wrap; }
.bar { display: grid; grid-template-columns: minmax(70px, auto) 1fr auto; align-items: center; gap: 10px; font-size: 14px; }
.bar i { display: block; height: 10px; border-radius: 6px; background: var(--color-text-info); opacity: .85; }
.bar.lo i { opacity: .55; }
button { font: inherit; font-size: 13px; color: var(--color-text-primary); background: var(--color-background-secondary);
  border: 1px solid var(--color-border-primary); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--color-text-info); }
button:disabled { opacity: .5; cursor: default; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
.watch { display: grid; gap: 2px; padding: 8px 0; border-top: 1px solid var(--color-border-primary); }
.watch:first-of-type { border-top: 0; }
.watch .line { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.watch b.fired { color: var(--color-text-info); }
.watch small { color: var(--color-text-secondary); font-size: 13px; }
code { font: 13px var(--font-mono); }
.head code.id { text-transform: none; letter-spacing: 0; font-size: 12px; }
.empty { color: var(--color-text-secondary); font-size: 14px; }
`;

/**
 * The host bridge: JSON-RPC over postMessage, the `ui/initialize` handshake,
 * tool-input / tool-result notifications, theme and size reporting. `render`
 * and anything view-specific come after it in the same script.
 */
const BRIDGE = `
const APP = { name: 'afrirate-__VIEW__', version: '0.2.0' };
const state = { args: {}, result: null, ready: false };
let nextId = 1;
const pending = new Map();

function send(msg) { window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, msg), '*'); }
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) { send({ method, params: params || {} }); }

/** Ask the host to run one of this server's tools and return its CallToolResult. */
function callTool(name, args) { return request('tools/call', { name, arguments: args }); }

function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  const vars = ctx.styles && ctx.styles.variables;
  if (vars) for (const k of Object.keys(vars)) if (vars[k]) document.documentElement.style.setProperty(k, vars[k]);
}

window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.id != null && !m.method && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || 'request failed')); else p.resolve(m.result);
    return;
  }
  switch (m.method) {
    case 'ui/notifications/tool-input': state.args = (m.params && m.params.arguments) || {}; break;
    case 'ui/notifications/tool-result': state.result = m.params; show(); break;
    case 'ui/notifications/host-context-changed': applyContext(m.params); break;
    case 'ui/notifications/tool-cancelled': showError('The tool call was cancelled.'); break;
    case 'ui/resource-teardown': case 'ping': if (m.id != null) send({ id: m.id, result: {} }); break;
  }
});

new ResizeObserver(() => {
  const r = document.body.getBoundingClientRect();
  notify('ui/notifications/size-changed', { width: Math.ceil(r.width), height: Math.ceil(r.height) });
}).observe(document.body);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const root = () => document.getElementById('root');
function textOf(result) { return ((result && result.content) || []).map((c) => c.text || '').join('\\n'); }
function showError(text) { root().innerHTML = '<div class="card"><div class="err">' + esc(text) + '</div></div>'; }
function show() {
  const r = state.result;
  if (!r) return;
  if (r.isError || !r.structuredContent) return showError(textOf(r) || 'No result.');
  try { render(r.structuredContent, state.args); } catch (e) { showError(textOf(r)); }
}
function num(n, digits) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits == null ? 4 : digits });
}
function daysOld(date) {
  const t = Date.parse(date + 'T00:00:00Z');
  return isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
}
function ageBadge(date) {
  const d = daysOld(date);
  return d != null && d >= 7 ? '<span class="badge age">' + d + ' days old</span>' : '';
}
function staleBadge(stale) { return stale ? '<span class="badge bad">source failing</span>' : ''; }

// Hosts are meant to listen before the view loads, but one that attaches a
// moment late would lose a single initialize. Re-send until one is answered;
// the first answer wins and the rest are ignored.
let initTries = 0;
function initialize() {
  if (state.ready) return;
  request('ui/initialize', {
    protocolVersion: '${APP_PROTOCOL}',
    appInfo: APP,
    appCapabilities: { availableDisplayModes: ['inline'] },
  }).then((res) => {
    if (state.ready) return;
    state.ready = true;
    applyContext(res && res.hostContext);
    notify('ui/notifications/initialized');
  }).catch(() => {});
  if (++initTries < 5) setTimeout(initialize, 1000);
}
initialize();
`;

const RENDER: Record<ViewName, string> = {
  rates: `
function render(d, args) {
  if ('result' in d) return renderConversion(d);
  const rows = (d.rates || []).map((r) =>
    '<div class="row"><span>' + esc(r.source) + ' · 1 ' + esc(r.base) + ' = <b>' + esc(num(r.rate)) + '</b> ' + esc(r.quote) +
    ageBadge(r.rate_date) + staleBadge(r.stale) + '</span><span>' + esc(r.rate_date) + '</span></div>').join('');
  root().innerHTML = '<div class="card"><div class="head"><span>Latest rates' + (d.country ? ' · ' + esc(d.country) : '') +
    '</span><b>get_rate</b></div>' + (rows || '<div class="empty">No rates.</div>') + '</div>';
}
function renderConversion(d) {
  const route = { direct: 'direct', inverse: 'read inverted', 'cross-usd': 'cross through USD' }[d.path] || d.path;
  root().innerHTML = '<div class="card"><div class="head"><span>Conversion</span><b>convert</b></div>' +
    '<div class="sub">' + esc(num(d.amount, 2)) + ' ' + esc(d.from) + ' =</div>' +
    '<div class="hero">' + esc(num(d.result, 2)) + ' ' + esc(d.to) + '</div>' +
    '<div class="sub">1 ' + esc(d.from) + ' = ' + esc(num(d.rate, 6)) + ' ' + esc(d.to) + ' · ' + esc(route) +
    ' · ' + esc((d.sources || []).join(' → ')) + ' · as of ' + esc(d.as_of) + ageBadge(d.as_of) + staleBadge(d.stale) + '</div>' +
    '<div class="actions"><button id="swap">Swap to ' + esc(d.to) + ' → ' + esc(d.from) + '</button></div></div>';
  document.getElementById('swap').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const swapped = Object.assign({}, state.args, { amount: Math.round(d.result * 100) / 100, from: d.to, to: d.from });
      state.result = await callTool('convert', swapped);
      state.args = swapped;
      show();
    } catch (err) { showError(String(err.message || err)); }
  };
}
`,
  corridor: `
function render(d) {
  const quotes = d.quotes || [];
  const rates = quotes.map((q) => q.rate);
  const lo = Math.min.apply(null, rates), hi = Math.max.apply(null, rates);
  const bars = quotes.map((q) => {
    const w = hi === lo ? 100 : 30 + 70 * (q.rate - lo) / (hi - lo);
    return '<div class="bar' + (q.rate === lo && hi !== lo ? ' lo' : '') + '"><span>' + esc((q.country ? q.country + ' ' : '') + q.source) +
      '</span><i style="width:' + w.toFixed(1) + '%"></i><span>' + esc(num(q.rate, 6)) + (q.inverted ? ' <small class="sub">inv.</small>' : '') +
      ageBadge(q.rate_date) + staleBadge(q.stale) + '</span></div>';
  }).join('');
  const summary = d.single_source
    ? '<div class="sub">Only ' + esc(quotes[0] && quotes[0].source) + ' publishes this pair: one quote, not a spread of zero.</div>'
    : d.spread_pct != null ? '<div class="sub">Spread between sources: <b>' + esc(d.spread_pct.toFixed(2)) + '%</b> · cheapest ' +
      esc(d.best && d.best.source) + ', dearest ' + esc(d.worst && d.worst.source) + '</div>' : '';
  const unread = (d.errors || []).length
    ? '<div class="note">Not checked: ' + esc(d.errors.map((e) => e.target).join(', ')) + ' (nothing implied about them)</div>' : '';
  root().innerHTML = '<div class="card"><div class="head"><span>Across sources</span><b>compare_corridor</b></div>' +
    '<div class="hero">' + esc(d.base) + '/' + esc(d.quote) + '</div>' + bars + summary + unread + '</div>';
}
`,
  watchlist: `
const say = (c, from, to) => c.kind === 'moves' ? from + '/' + to + ' moves ' + c.value + '% either way'
  : from + '/' + to + ' goes ' + c.kind + ' ' + c.value;
const pct = (n) => (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
function render(d) {
  if (d.results) return renderCheck(d);
  if (d.removed) {
    root().innerHTML = '<div class="card"><div class="head"><span>Watchlist</span><b>remove_watch</b></div>' +
      '<div class="sub">Removed ' + esc(d.removed.join(', ')) + ' · ' + esc(d.remaining) + ' left</div></div>';
    return;
  }
  const w = d.watch;
  root().innerHTML = '<div class="card"><div class="head"><span>Watch saved</span><b>watch_rate</b></div>' +
    '<div class="hero" style="font-size:24px">🔔 ' + esc(say(w.condition, w.from, w.to)) + '</div>' +
    '<div class="sub">Now 1 ' + esc(w.from) + ' = ' + esc(num(d.rate, 6)) + ' ' + esc(w.to) + ' · as of ' + esc(d.as_of) + ageBadge(d.as_of) + '</div>' +
    (d.already_holds ? '<div class="note">That already holds today, so the next check reports it.</div>' : '') +
    '<div class="sub">Watchlist <code>' + esc(d.watchlist) + '</code> · ' + esc(d.watch_count) + ' watch' + (d.watch_count === 1 ? '' : 'es') + '</div>' +
    '<div class="actions"><button id="check">Check watchlist</button></div></div>';
  document.getElementById('check').onclick = () => run('check_watches', { watchlist: d.watchlist });
}
function renderCheck(d) {
  const items = d.results.map((r) => {
    const w = r.watch;
    const status = r.holds
      ? '<b class="fired">🔔 ' + esc(say(w.condition, w.from, w.to)) + '</b>'
      : '<b>' + esc(say(w.condition, w.from, w.to)) + '</b>';
    const how = r.holds ? (r.held_when_set ? 'holds, as it did when set' : r.newly_fired ? 'crossed since set' : 'still holds') : 'waiting';
    const moved = r.new_publication ? pct(r.change_since_last_check_pct) + ' since last check, ' + pct(r.change_since_set_pct) + ' since set'
      : 'no new publication since last check';
    return '<div class="watch"><div class="line">' + status + '<button data-id="' + esc(w.id) + '">Remove</button></div>' +
      '<small>' + esc(how) + ' · now ' + esc(num(r.rate, 6)) + ' as of ' + esc(r.as_of) + ' · ' + esc(moved) + '</small>' +
      ageBadge(r.as_of) + staleBadge(r.stale) + '</div>';
  }).join('');
  const unchecked = (d.unchecked || []).length
    ? '<div class="note">Not checked: ' + esc(d.unchecked.map((u) => u.id).join(', ')) + '; retry shortly</div>' : '';
  root().innerHTML = '<div class="card"><div class="head"><span>Watchlist · <code class="id">' + esc(d.watchlist) + '</code></span><b>check_watches</b></div>' +
    (items || '<div class="empty">No watches.</div>') + unchecked + '</div>';
  for (const b of document.querySelectorAll('button[data-id]')) {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const res = await callTool('remove_watch', { watchlist: d.watchlist, watch_id: b.dataset.id });
        if (res && !res.isError) b.closest('.watch').remove(); else b.disabled = false;
      } catch (e) { b.disabled = false; }
    };
  }
}
async function run(name, args) {
  try { state.result = await callTool(name, args); show(); } catch (e) { showError(String(e.message || e)); }
}
`,
};

export function viewHtml(view: ViewName): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AfriRate · ${view}</title>
<style>${CSS}</style>
</head>
<body>
<div id="root"><div class="card"><div class="empty">Loading…</div></div></div>
<script>
${BRIDGE.replace('__VIEW__', view)}
${RENDER[view]}
</script>
</body>
</html>`;
}
