# AfriRate MCP

An [MCP](https://modelcontextprotocol.io) server that gives AI agents live exchange rates,
inflation figures and central-bank gold prices for **28 African countries**, sourced from
[AfriRate](https://afrirate.statotec.com).

Rates across most of Africa are scattered, inconsistent and often quietly out of date. AfriRate
scrapes central banks and market sources directly; this server puts that in front of an agent —
and, unlike most rate tools, it tells you when a number is stale instead of pretending otherwise.

Built by [StatoTech Systems](https://statotec.com).

## Tools

| Tool | What it does |
| --- | --- |
| `list_countries` | The 28 covered countries, with ISO codes and source counts |
| `list_currencies` | Every currency quoted, with symbol and precision |
| `get_rate` | Latest rates for one country, or one pair across every source |
| `get_inflation` | MoM / YoY / CPI, split food vs non-food where published |
| `get_gold` | Central-bank gold-coin prices |
| `convert` | Convert an amount, falling back through inverse and a USD cross |
| `compare_corridor` | One pair across sources and countries, with the spread |

`convert` and `compare_corridor` are computed here — no AfriRate endpoint returns them.

### The `stale` flag

Every rate carries `stale`. It is `true` when the source feeding it has been failing, meaning the
value is the last one published rather than a fresh scrape. Tools surface it in both the text and
the structured output, and the server instructions tell the model to say so when quoting. A rate
tool that hides a dead source is worse than one that admits it.

## Running it

```sh
npm install
cp .env.example .env     # add AFRIRATE_MCP_API_KEY
npm run build
npm start
```

The server listens on `POST /mcp` (Streamable HTTP, protocol revision `2025-11-25`) and exposes
`GET /healthz`, which also probes the upstream API. It runs **stateless** — a fresh MCP server per
request — so concurrent clients never share state.

For local development against a desktop MCP client, `npm run stdio` serves the same tools over
stdio.

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `AFRIRATE_MCP_API_KEY` | — | Required for rates, inflation and gold. Without it those return a clear error; countries, currencies and health still work. |
| `AFRIRATE_API_BASE` | `https://afrirate.statotec.com/api/v1` | Override to point at a staging AfriRate |
| `PORT` | `3025` | |
| `HOST` | `127.0.0.1` | Bind behind a reverse proxy, not directly |
| `AFRIRATE_TIMEOUT_MS` | `10000` | Upstream request timeout |

The API key is held server-side and never appears in a response, a log line or this repo.

## Scope

This repository is the MCP server. It talks to the public AfriRate REST API over HTTPS and nothing
else — it holds no database credentials and contains none of the scraping, parsing or source
configuration that produces the data.

## Licence

MIT — see [LICENSE](LICENSE).
