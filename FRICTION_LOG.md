# Friction log

What got in the way while building AfriRate MCP for the Alexa+ track of Build, Ship, Shape: Amazon Developer
Hackathon 2026, recorded as we hit it. Each entry gives the task, the steps, what we expected and what happened,
the severity, our workaround and a suggestion.

Severity: High = blocked the intended path; Medium = cost real time or forced a design guess; Low = annoyance.

### F1. Testing the MCP server on a real Alexa+ device — High

- **Task:** run our deployed MCP server inside Alexa+ to check it works end to end with voice.
- **Steps:** read the Alexa+ section of the Resources page and the Official Rules, looking for an Alexa+ developer
  console, device setting or simulator that accepts an MCP server URL.
- **Expected:** a way to register `https://mcp.afrirate.statotec.com/mcp` with a test device or console.
- **Actual:** none found. The guidance is to simulate Alexa+ in our own web app.
- **Workaround:** built `demo/`, a simulated smart display driven by a third-party model with our MCP server attached.
- **Suggestion:** an Alexa+ MCP test console, even text-only, that accepts a Streamable HTTP URL and shows which tools
  Alexa+ called and what it said. That one tool would let entrants test against the real assistant, not a stand-in.

### F2. No per-user identity for stateful tools — Medium

- **Task:** let a user say "tell me if the dollar goes above 27" today, and hear about it in a later conversation.
- **Steps:** looked for how Alexa+ identifies a user to an MCP server, through a header, a token or an argument.
- **Expected:** a stable per-user identifier, so the server can store watches against it.
- **Actual:** none documented. A stateless MCP server sees no user.
- **Workaround:** `watch_rate` returns an unguessable watchlist id (`wl_` plus 10 random characters). The client keeps
  it and passes it back, so knowing the id is what grants access. Our simulated device keeps it the way a device
  remembers its owner.
- **Suggestion:** document what Alexa+ passes to an MCP server about the user. For example, a per-skill, per-user
  opaque id in a request header, and whether it is stable across conversations.

### F3. Parallel tool calls split a stateful operation — Medium

- **Task:** "Tell me if the dollar falls below 130 shillings, or goes above 27 Zimbabwe Gold": two watches, one list.
- **Steps:** recorded the demo with the assistant model's default settings.
- **Expected:** both watches saved to one watchlist.
- **Actual:** the model issued both `watch_rate` calls in parallel. Neither had a watchlist id yet, so each created
  its own list, and the device kept only one id. The next morning's check reported one watch, not two.
- **Workaround:** turned off parallel tool calls in the simulator, and added to the tool description: "set one
  first and pass its watchlist id to the rest".
- **Suggestion:** say in the Alexa+ MCP guidance whether Alexa+ calls tools in parallel. If it does, either offer a
  per-user identity (F2) or recommend that stateful tools take batches, so servers can be designed for it.

### F4. Models fill optional numeric parameters with 0 — Low

- **Task:** set a watch with one of three optional thresholds (`above`, `below`, `moves_pct`).
- **Expected:** the model sends the one threshold the user asked for.
- **Actual:** it sent all three, with zeros in the unused ones (`above: 0, moves_pct: 0`). Schema validation rejected
  the call, and the model asked the user a confused question.
- **Workaround:** replaced the three optional numbers with one required `condition` enum and one required `value`
  (commit `bf9f320`).
- **Suggestion:** a short "designing tools for Alexa+" note covering this and F5. Several of our bugs came from how
  a model fills a schema, not from the protocol.

### F5. Models guess currency codes — Low

- **Task:** "the official exchange rate in Zimbabwe", and "Zimbabwe Gold".
- **Actual:** across demo takes the model sent `ZAG`, `ZGD` and `ZWL` (Zimbabwe's retired dollar) instead of `ZWG`.
  Our server answered "no published route", which gave the model nothing to recover with.
- **Workaround:** an unknown code now gets an error that names it and lists all 24 codes the API knows, and
  `get_rate` answers a missed pair with what the country does publish (commits `9368904`, `296dfa9`). The model
  then corrects itself in one step.
- **Suggestion:** as F4. Error text written for a model to act on is part of the interface.

---

### F6. MCP Apps server helpers require MCP SDK version 2 — Low

- **Task:** add MCP Apps views to an existing server built on `@modelcontextprotocol/sdk` 1.30.
- **Steps:** installed `@modelcontextprotocol/ext-apps` 2.0.3 for its server helpers.
- **Expected:** helpers usable from the SDK we had.
- **Actual:** its peer dependencies are `@modelcontextprotocol/server`, `client` and `core` at `^2.0.0`.
- **Workaround:** registered the `ui://` resources and `_meta.ui` links by hand on SDK 1.x, following the spec.
  It worked, and the official `AppBridge` validates the result.
- **Suggestion:** a 1.x-compatible server helper, or a short "by hand" section in the docs.

### F7. A view that announces itself early is never connected — Medium

- **Task:** check our views against the official `AppBridge`.
- **Steps:** loaded a view in an iframe, waited for it to load, then connected the bridge.
- **Expected:** the handshake completes.
- **Actual:** the view's one `ui/initialize` had already been sent and was lost, so the view stayed blank. The
  official view SDK also sends it only once, so hosts must start listening before the view loads. Nothing in the
  view-author docs says so.
- **Workaround:** our views resend `ui/initialize` once a second until a host answers, and use the first answer.
  We tested this against a host that attaches late.
- **Suggestion:** state the ordering in the spec's lifecycle section, and consider a resend in the official view
  SDK.

## Feature requests

| Request | Why it matters to this project | Priority |
| --- | --- | --- |
| Alexa+ MCP test console that accepts a Streamable HTTP URL | It is the only way to test against real Alexa+ rather than a simulation (F1) | Critical |
| A documented per-user identifier passed to MCP servers | Lets watchlists belong to a user, not to whoever holds an id (F2) | Important |
| Published rules for whether and how Alexa+ renders MCP Apps on Echo Show | Our tools already return structured data. We would design cards for the real screen | Important |
| A conformance check for MCP spec 2025-11-25 | Lets entrants show the version requirement is met, not just claim it | Nice-to-have |
