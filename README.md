# AfriRate MCP

An [MCP](https://modelcontextprotocol.io) server that gives AI agents live exchange rates,
inflation figures and central-bank gold prices for **28 African countries**, sourced from
[AfriRate](https://afrirate.statotec.com).

Rates across most of Africa are scattered, inconsistent and often quietly out of date. AfriRate
scrapes central banks and market sources directly; this server puts that in front of an agent —
and, unlike most rate tools, it tells you when a number is stale instead of pretending otherwise.

Built by [StatoTech Systems](https://statotec.com).

## Try it — no key needed

A hosted instance is running at:

```
https://mcp.afrirate.statotec.com/mcp
```

Point any MCP client that speaks Streamable HTTP at it. There is nothing to sign up for:
without a key, each IP address gets the AfriRate Free plan's volume, **10 tool calls a minute and
300 a day**. Setup messages such as `initialize` and `tools/list` are not counted.

**For more, use your own AfriRate key.** Send it as `Authorization: Bearer ar_…`, or, for clients
that cannot set headers (claude.ai and ChatGPT connectors), put it on the URL:
`https://mcp.afrirate.statotec.com/mcp?api_key=ar_…`. The server answers on that key, so your plan's
limits apply and the usage shows on your AfriRate account. A key on a URL ends up in logs, so use one
you can revoke. Keys,
including a free one, are at [afrirate.statotec.com/pricing](https://afrirate.statotec.com/pricing).

`GET https://mcp.afrirate.statotec.com/healthz` shows whether it is up and the server's own upstream
quota.

From the command line — the server is stateless, so a single request needs no session:

```sh
curl -s https://mcp.afrirate.statotec.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"convert","arguments":{"amount":100,"from":"USD","to":"KES"}}}'
```

Running your own copy (below) needs an AfriRate API key.

### On a simulated Alexa+ device

`demo/` is a smart-display simulator: a microphone, a speaker and a screen, and it is an **MCP
Apps host**. It connects to this server with the official MCP client, offers the server's tools to
a model as functions, and runs whatever the model calls. Each result is drawn by the view the tool
names in `_meta.ui.resourceUri`: HTML served by this MCP server, loaded in a sandbox on a second
origin, as the MCP Apps spec requires of a web host. The device keeps a watchlist id the way a
device remembers its owner, so **☀ New day** starts a fresh conversation that opens with
`check_watches`.

```sh
OPENAI_API_KEY=sk-... npm run demo      # then open http://127.0.0.1:4173
```

Without a key the device is a keyless caller like any other: 10 tool calls a minute and 300 a day
from your IP. Set `AFRIRATE_KEY=ar_…` to send your own AfriRate key and be served on your plan.

The model is OpenAI's `gpt-4.1-mini` through the Responses API. Speech in and out uses OpenAI's
transcription and text-to-speech models. Set `MCP_URL` to point it at a local server instead of the
hosted one. It binds to localhost because it holds your key.

### MCP Apps: the server ships its own cards

`convert`, `get_rate`, `compare_corridor` and the three watch tools declare MCP Apps views
(extension `io.modelcontextprotocol/ui`, spec `2026-01-26`). In any host that renders MCP Apps,
their results appear as interactive cards instead of text:

| View | For | Interactive |
| --- | --- | --- |
| `ui://afrirate/rates` | `convert`, `get_rate` | **Swap** reverses a conversion by calling `convert` through the host |
| `ui://afrirate/corridor` | `compare_corridor` | One bar per central bank, with the spread |
| `ui://afrirate/watchlist` | `watch_rate`, `check_watches`, `remove_watch` | **Check watchlist** and **Remove** call the tools through the host |

Each view is one self-contained HTML document with no external requests, so it runs under a host's
strictest default CSP. It follows the host's theme through the spec's standard style variables and
falls back to its own light and dark palettes. Hosts without MCP Apps still get the full text
answer. We checked the views against the official host-side `AppBridge` from
`@modelcontextprotocol/ext-apps`, which validates every message: handshake, size reports and tool
calls from the buttons.

### Agent Skill

[`skills/african-money/SKILL.md`](skills/african-money/SKILL.md) is an
[Agent Skill](https://agentskills.io) that teaches an agent the order to call these tools for four
everyday questions: what a transfer home is worth, which central bank quotes a pair best, whether
a price has kept up with inflation, and a morning brief from a watchlist. It also covers the
honesty rules: dates, data age, single-source pairs and rate limits.

## Tools

| Tool | What it does |
| --- | --- |
| `list_countries` | The 28 covered countries, with ISO codes and source counts |
| `list_currencies` | Every currency quoted, with symbol and precision |
| `get_rate` | Latest rates for one country, or one pair across every source |
| `get_inflation` | MoM / YoY / CPI, split food vs non-food where published |
| `get_gold` | Central-bank gold-coin prices |
| `convert` | Convert an amount, falling back through inverse and a USD cross |
| `compare_corridor` | One pair across sources and countries, with the spread between them |
| `watch_rate` | Remember a rate and a condition — above, below, or a % move — across conversations |
| `check_watches` | What changed on a watchlist since it was set, and since the last check |
| `remove_watch` | Drop one watch, or all of them |

Six of these tools also render as interactive cards in hosts that support MCP Apps (see "MCP Apps" above).

`convert`, `compare_corridor` and the watch tools are computed here — no AfriRate endpoint returns
them.

### Watchlists: state across conversations

Ask *"tell me if the US dollar goes above 27 Zimbabwe gold"* and the agent calls `watch_rate`, which
reads today's rate, stores the condition and returns a watchlist id such as `wl_k3x9p2m7qa`. In a
later conversation — a day later, after a restart — `check_watches` with that id reports, for
each watch, whether it fired, how far the rate has moved since it was set, and how far since the
previous check.

- **No accounts.** The id is the key, like an unlisted link. A list holds currency pairs and
  thresholds and nothing about who asked.
- **No push.** A watch fires when it is checked. The server instructions tell the agent to check
  a user's watchlist at the start of a conversation and lead with anything that fired.
- **A quiet source is not a steady rate.** When a source has published nothing since the last
  check, `check_watches` says so instead of reporting a 0% move.
- **Bounded.** Ten watches per list; lists unused for 90 days expire. One JSON file, written
  atomically, under `AFRIRATE_STATE_DIR` (or systemd's `STATE_DIRECTORY`).

### Saying what we do not know

Three things a rate tool can do worse than failing: hide a dead source, present last month's
number as this morning's, and report being throttled as there being no such rate. Each has its
own signal here.

**`stale`** — `true` when the source feeding a rate has been failing, so the value is the last one
published rather than a fresh scrape. Carried in both the text and the structured output, and the
server instructions tell the model to say so when quoting.

**Data age** — not the same thing. A source can scrape cleanly and still not have moved its figure
in weeks, which comes back `stale: false` with an old `rate_date`. Any observation more than seven
days old is labelled with its age, and `convert` returns `age_days` for the oldest leg of the route
it used.

**Absence vs. not knowing** — `compare_corridor` separates countries that answered and publish
nothing for a pair (`unavailable`) from countries it could not reach or was rate-limited out of
(`errors`). A throttle is never reported as a missing rate.

Most pairs are published by exactly one central bank. Asked for one of those, `compare_corridor`
returns `single_source: true` and `spread_pct: null` and says there is nothing to compare against
— rather than reporting a spread of zero, which reads as a broken tool.

## Running it

```sh
npm install
cp .env.example .env     # add AFRIRATE_MCP_API_KEY
npm run build
npm start
```

The server listens on `POST /mcp` (Streamable HTTP, protocol revision `2025-11-25`) and exposes
`GET /healthz`, which probes the upstream API and reports the remaining request quota and cache
counters. It runs **stateless** — a fresh MCP server per request — so concurrent clients never
share state.

For local development against a desktop MCP client, `npm run stdio` serves the same tools over
stdio.

```sh
npm test         # unit and tool-level tests against a stub API — no key, no quota spent
npm run typecheck
```

### Upstream request budget

The API key this server holds is metered, and the tools are written to spend it carefully:

- **Responses are cached by URL** for the lifetime of the process — 60s for rates, which is the
  `s-maxage` the API itself advertises, 10 minutes for inflation and gold, 6 hours for the country
  and currency lists. `AFRIRATE_CACHE_TTL_MS=0` disables rate caching.
- **Identical concurrent requests are coalesced** into one. `convert` probes the same country
  payload up to five times while walking direct → inverse → cross-USD; that is one upstream
  request, not five.
- **Passing `country` to `convert`** costs one request rather than up to six, because the country
  form of the API returns every pair at once.
- **`compare_corridor` stops** once it is rate-limited instead of spending the rest of a
  known-closed window on certain failures, and names the countries it therefore did not check.

`GET /healthz` reports what is left:

```json
{ "quota": { "limit": 1000, "remaining": 996, "resetAt": "..." },
  "cache": { "hits": 1, "misses": 1, "coalesced": 0, "entries": 1 } }
```

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `AFRIRATE_MCP_API_KEY` | — | Required for rates, inflation and gold. Without it those return a clear error; countries, currencies and health still work. |
| `AFRIRATE_API_BASE` | `https://afrirate.statotec.com/api/v1` | Override to point at a staging AfriRate |
| `PORT` | `3025` | |
| `HOST` | `127.0.0.1` | Bind behind a reverse proxy, not directly |
| `AFRIRATE_TIMEOUT_MS` | `10000` | Upstream request timeout |
| `AFRIRATE_CACHE_TTL_MS` | `60000` | How long a rate response may be reused. `0` disables it. |
| `AFRIRATE_STATE_DIR` | `./data` | Where watchlists are kept. `STATE_DIRECTORY` (set by systemd) also works |

The API key is held server-side and never appears in a response, a log line or this repo.

## Scope

This repository is the MCP server. It talks to the public AfriRate REST API over HTTPS and nothing
else — it holds no database credentials and contains none of the scraping, parsing or source
configuration that produces the data.

## Licence

MIT — see [LICENSE](LICENSE).
