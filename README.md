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

Point any MCP client that speaks Streamable HTTP at it. The API key it needs is held on the
server, so there is nothing to sign up for. `GET https://mcp.afrirate.statotec.com/healthz` shows
whether it is up and how much of the upstream request quota is left.

From the command line — the server is stateless, so a single request needs no session:

```sh
curl -s https://mcp.afrirate.statotec.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"convert","arguments":{"amount":100,"from":"USD","to":"KES"}}}'
```

Running your own copy (below) needs an AfriRate API key.

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

`convert` and `compare_corridor` are computed here — no AfriRate endpoint returns them.

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
{ "quota": { "limit": 10, "remaining": 6, "resetAt": "..." },
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

The API key is held server-side and never appears in a response, a log line or this repo.

## Scope

This repository is the MCP server. It talks to the public AfriRate REST API over HTTPS and nothing
else — it holds no database credentials and contains none of the scraping, parsing or source
configuration that produces the data.

## Licence

MIT — see [LICENSE](LICENSE).
