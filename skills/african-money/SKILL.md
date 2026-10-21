---
name: african-money
description: Answer money questions about African countries with the AfriRate MCP server - what a transfer home is worth today, which central bank quotes a pair best, whether a price has kept up with inflation, and a morning brief of the user's watched rates. Use when the user asks about exchange rates, sending money, prices or inflation in an African country, or says "tell me when" about a currency.
license: MIT
compatibility: Needs the AfriRate MCP server (https://mcp.afrirate.statotec.com/mcp, Streamable HTTP, no key) connected as a tool source.
---

# African money questions, with AfriRate

AfriRate publishes official exchange rates, inflation and central-bank gold prices for 28 African countries,
taken from each central bank. The MCP server gives you 10 tools. This skill covers four questions people ask
out loud, and the order to call the tools in so the answer is right and honest.

## Rules that apply to every answer

- **Never quote a rate from memory.** Every figure comes from a tool call made in this conversation.
- **Codes first.** Map country names with `list_countries` (Zimbabwe is `ZW`) and currency names with
  `list_currencies` (Zimbabwe Gold is `ZWG`, not ZWL, which is retired). If a tool says a code is unknown, use
  one of the codes it lists. Don't guess again.
- **Say the date.** Every rate carries the date it was published. Give it as a date ("20 October"). Never say
  "today" unless the date is today.
- **Say when it's old or failing.** When a result says a rate is N days old, or that a source is failing, include
  that in your answer. It is part of the answer, not a footnote.
- **One quote is not a spread.** If `compare_corridor` returns `single_source: true`, say only one bank publishes
  the pair. Don't report a 0% spread.
- If a tool reports it was rate-limited, say you couldn't check yet and offer to retry in a minute. Never present
  a throttle as "no data".

## 1. "How much is my transfer worth?" (sending money home)

Example: *"I'm sending 500 rand to my mother in Harare. What will she get in ZiG?"*

1. `convert` with `amount`, `from` and `to`. Pass `country` (the receiving country) when the user cares about the
   official rate there. It also costs the server one upstream request instead of up to six.
2. If the result's `path` is `cross-usd`, say the figure goes through the US dollar. The two legs can come from
   different dates, and the result gives the oldest.
3. Give the amount in the receiving currency, the rate, its source and its date.

What you give is the **official** rate. Money transfer services add fees and their own margin, so say what's
received may be lower. Don't estimate those fees.

## 2. "Where is the rate better?" (one pair, several central banks)

Example: *"Is the pula worth more against the rand in Botswana or in South Africa?"*

1. `compare_corridor` with `base` and `quote`. Add `countries` only if the user named specific countries.
2. Report each bank's quote with its date, and the spread between them. The cheapest and dearest are in the
   result.
3. If a quote is marked `inverted`, that bank publishes the pair the other way round. That's normal; say so only
   if asked.

## 3. "Has this price kept up?" (inflation)

Example: *"My rent in Nairobi went from 20,000 to 22,000 shillings over a year. Is that more than inflation?"*

1. `get_inflation` for the country. Use the year-on-year figure, and the food or non-food split when the question
   is about one of them.
2. Compare the user's change (here +10%) with the year-on-year rate, and give the month the inflation figure is
   for.

## 4. "Tell me when…" and the morning brief (watchlists)

Example: *"Tell me if the dollar goes above 27 Zimbabwe Gold."*

1. `watch_rate` with `from`, `to`, `condition` (`above`, `below` or `moves_pct`) and `value`. To set several
   watches, set the first one, then pass the `watchlist` id it returns to each of the rest. Calls made in
   parallel without an id each start their own list.
2. Tell the user the watch is saved, and give them the watchlist id **once** so they can keep it. Nothing else
   can find the list.
3. **At the start of a later conversation**, if the user has given you a watchlist id, call `check_watches` before
   anything else. Lead with what holds. For each watch, say where the rate is now against the threshold. Say it
   "moved" only when `new_publication` is true. If `held_when_set` is true, it already held when the watch was
   set, so don't describe it as news.

A watch does not push notifications. It fires when it is checked, so make the check part of the user's routine.

## On a screen

`convert`, `get_rate`, `compare_corridor` and the watch tools also declare MCP Apps views
(`_meta.ui.resourceUri`, `ui://afrirate/…`). In a host that renders MCP Apps, the result appears as a card.
There the user can swap a conversion's direction, check a watchlist or remove a watch without asking you. Keep
your spoken answer short: the card shows the detail.
