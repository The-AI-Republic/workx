# App Store Catalog Growth: Live Ecosystem Survey

Date: 2026-05-19
Status: Advisory companion to `technical_design.md` (do not duplicate; this doc is the supply-side / catalog-growth analysis only).

## TL;DR

1. Catalog supply is **not** the bottleneck. There are tens of thousands of MCP servers in directories, ~250–400 vendor-verified remote servers, and a canonical machine-readable feed (the official MCP Registry) explicitly designed for marketplaces like ours to ingest.
2. The bottleneck is **runtime fit**. The modern first-party ecosystem is converging on **Streamable HTTP + OAuth 2.1**. Some providers support Dynamic Client Registration (DCR); others require a pre-registered platform OAuth client. Our MVP runtime supports only `sse` + `stdio` and has no standard MCP OAuth path. Catalog growth velocity is gated by closing that gap, not by finding apps.
3. There is a **usable launch window on SSE today**: roughly half of the marquee first-party servers still expose an SSE endpoint as of this survey. But that window is closing on a known schedule (Atlassian deprecates SSE 2026-06-30; the spec and most new servers are Streamable-HTTP-first).
4. Recommended model: ingest the official MCP Registry as the spine, layer a curated first-party tier on top, auto-generate manifest + discovery markdown by introspection, and gate trust by namespace verification + tier. This turns "build each app" into "sync a feed".

## 1. Methodology & freshness

Live web survey performed 2026-05-19. Sources: the official MCP Registry API and docs, the `awesome-remote-mcp-servers` curated list, the Anthropic Connectors Directory mirror, the Apigene remote-MCP directory, and PulseMCP/Glama/mcp.so/Smithery directory totals. Full source links at the end.

Caveats:
- The official MCP Registry is explicitly in **preview** ("breaking changes or data resets may occur"). Treat its schema as stabilizing, not stable.
- Endpoint URLs in §4 are point-in-time. They move. The registry — not a hand-maintained list — must be the source of truth at ingestion.
- A hard live count of total registry entries was not surfaced from the sampled endpoint (the API returns page-level `count` + a `nextCursor`, not a global total). Get the live number by paginating `/v0/servers` at implementation time.

## 2. The supply landscape (the numbers)

| Source | Reported size | Nature | Use for us |
|---|---|---|---|
| Official MCP Registry (`registry.modelcontextprotocol.io`) | Canonical feed; preview; backed by Anthropic, GitHub, PulseMCP, Microsoft | Low-noise, namespace-verified metadata, REST API | **Primary ingestion spine** |
| Anthropic Connectors Directory | 398 verified integrations (as of 2026-05-15), 30 categories, Anthropic-vetted | Curated, first-party-heavy | Tier-0 curation reference |
| Apigene vendor-verified directory | 251+ vendor-verified remote servers | Curated remote-only | Tier-0 cross-check |
| `awesome-remote-mcp-servers` | 100+ remote, ~85 official/vendor, ~70 OAuth 2.1 | Curated, high inclusion bar | Tier-0 seed list (§4) |
| PulseMCP | ~12,000–15,000+ | Broad directory, daily-updated | Tier-1 breadth |
| Glama | ~21,000+ | Broad directory | Tier-1 breadth |
| mcp.so | ~19,700+ | Community-submitted | Tier-1 breadth (noisy) |
| Smithery | ~7,000+ | Broad directory | Tier-1 breadth |

The broad directories overlap heavily and vary wildly in quality (community-submitted, often local stdio, often abandoned). They are a breadth reservoir, not a launch catalog. The **registry + curated lists** are where launch-quality apps come from.

## 3. The official MCP Registry is purpose-built for us

This is the single most important finding for catalog growth. The registry's stated design intent is *"intended to be consumed primarily by downstream aggregators, such as MCP server marketplaces"* — i.e. exactly this feature.

What it gives us:

```text
- REST API: GET /v0/servers?limit=&cursor=  (paginate via metadata.nextCursor)
- Standardized server.json per server
- Reverse-DNS namespace (io.github.user/server, com.vendor/server)
- Namespace authenticity via GitHub/DNS/HTTP challenge verification
- remotes[] array: { type: "streamable-http" | "sse", url }
- package pointers (npm/PyPI/Docker) for local/stdio servers
- _meta.io.modelcontextprotocol.registry/official: status, publishedAt,
  updatedAt, isLatest  (built-in versioning + lifecycle)
- An OpenAPI spec other registries also implement
```

Mapping `server.json` → our data model is close to mechanical:

```text
server.json.name (reverse-DNS)        -> apps.app_id
server.json.version + _meta.isLatest  -> app_versions (versioning is free)
server.json.remotes[].type/url        -> manifest.runtime.transport/url
server.json.description/title          -> catalog card + metadata seed
namespace DNS verification            -> our trust tier (verified vs community)
_meta.status / updatedAt              -> sync/dedup/freshness
```

Practical consequences:
- **Versioning is solved upstream.** `app_versions` (immutable releases) maps directly to registry version history + `isLatest`. We do not invent a version feed.
- **Trust has a free first signal.** Reverse-DNS namespace verification (`com.stripe/...` provably owned by stripe.com) is a ready-made input to our `trustedFirstPartyOnly` policy. It is necessary, not sufficient — it proves provenance, not safety.
- **The registry does not do security scanning.** It explicitly delegates that to package registries and downstream aggregators (us). Curation/scanning is our responsibility, not the feed's.
- **Aggregators are expected to poll ~hourly.** That sets the cadence for our sync job.

## 4. Tier-0 curated first-party seed (concrete, ingest-ready)

Marquee vendor-operated remote servers, with transport + auth as observed 2026-05-19. **Endpoints are point-in-time — resolve via registry at ingestion.**

| Provider | Endpoint (point-in-time) | Transport | Auth |
|---|---|---|---|
| GitHub | `https://api.githubcopilot.com/mcp` | Streamable HTTP | OAuth2.1 (no DCR) |
| Atlassian (Jira/Confluence) | `https://mcp.atlassian.com/v1/sse` | SSE → HTTP by 2026-06-30 | OAuth2.1 (no DCR) |
| Linear | `https://mcp.linear.app/sse` | SSE | OAuth2.1 |
| Notion | `https://mcp.notion.com/sse` | SSE | OAuth2.1 |
| Asana | `https://mcp.asana.com/sse` | SSE | OAuth2.1 |
| Sentry | `https://mcp.sentry.dev/sse` | SSE | OAuth2.1 |
| Intercom | `https://mcp.intercom.com/sse` | SSE | OAuth2.1 |
| PayPal | `https://mcp.paypal.com/sse` | SSE | OAuth2.1 |
| Square | `https://mcp.squareup.com/sse` | SSE | OAuth2.1 |
| Webflow | `https://mcp.webflow.com/sse` | SSE | OAuth2.1 |
| Plaid | `https://api.dashboard.plaid.com/mcp/sse` | SSE | OAuth2.1 (no DCR) |
| Cloudflare (Workers/Obs.) | `https://*.mcp.cloudflare.com/sse` | SSE | OAuth2.1 |
| Stripe | `https://mcp.stripe.com/` | Streamable HTTP | OAuth2.1 & API key |
| Vercel | `https://mcp.vercel.com/` | Streamable HTTP | OAuth2.1 |
| Supabase | `https://mcp.supabase.com/mcp` | Streamable HTTP | OAuth2.1 |
| Neon | `https://mcp.neon.tech/mcp` | Streamable HTTP | OAuth2.1 |
| Canva | `https://mcp.canva.com/mcp` | Streamable HTTP | OAuth2.1 |
| Airtable | `https://mcp.airtable.com/mcp` | Streamable HTTP | OAuth2.1 |
| HubSpot | `https://app.hubspot.com/mcp/v1/http` | Streamable HTTP | API key |
| Zapier (meta-app) | `https://mcp.zapier.com/api/mcp/mcp` | Streamable HTTP | API key |
| Google BigQuery / Maps | `https://*.googleapis.com/mcp` | Streamable HTTP | API key |
| AWS Knowledge | `https://knowledge-mcp.global.api.aws` | Streamable HTTP | Open |

Marquee gaps in this particular list: **Slack** and **Figma** (Figma's MCP is a local dev-mode server, not a hosted remote; Slack reached via other connector paths). Note them as known-missing for launch.

## 5. Transport reality vs our MVP — the critical finding

Our runtime supports `sse` + `stdio` only (`src/core/mcp/types.ts:19`). The ecosystem trend is unambiguous:

```text
Spec direction:      standalone HTTP+SSE deprecated; Streamable HTTP is the
                     recommended remote transport.
New first-party:     Streamable-HTTP-first (Stripe, Vercel, Supabase, Neon,
                     Canva, Airtable, GitHub, HubSpot...).
Legacy still on SSE:  Linear, Notion, Asana, Sentry, Intercom, PayPal,
                     Square, Webflow, Plaid, Cloudflare.
Hard deadline signal: Atlassian removes SSE 2026-06-30.
```

Two consequences:

1. **There is a real SSE launch window.** ~10 marquee first-party servers are SSE-reachable *today* with zero transport work. We could ship a credible Tier-0 catalog on the existing runtime. This de-risks the schedule.
2. **The window is the trap, not the plan.** It is shrinking on a known clock, and all *new* high-value servers are HTTP-only — meaning a SSE-only catalog stops growing roughly the moment it launches. **Streamable HTTP support is the catalog-growth lever, full stop.** It should be MVP-blocking, not Phase-7 hardening (cross-ref: this is the same P0 raised in the design review).

## 6. Auth reality — DCR helps, but provider registration is the real axis

Observed auth distribution on the curated remote list: ~70 OAuth 2.1, ~8 OAuth 2.1 *without* DCR (the 🔐 subset), ~20 API key, ~15 open.

The decisive distinction for catalog velocity:

```text
OAuth 2.1 + Dynamic Client Registration (DCR) + AS-metadata discovery:
  Client discovers the server's authorization server via
  .well-known metadata, registers itself dynamically, runs PKCE.
  -> ZERO per-app auth config. Add an app = add a row.

OAuth 2.1 WITHOUT DCR (GitHub, Atlassian, Plaid 🔐):
  Requires a pre-registered OAuth client per provider.
  -> Per-app manual step. Acceptable for a curated Tier-0 handful.

Platform static client / provider verification (Google Workspace-style):
  BrowserX must register Apple Pi as an OAuth app/client with the provider,
  configure consent screen/scopes, and possibly complete provider verification.
  -> App can exist in the catalog, but user connect is blocked until company-side registration is ready.

API key (HubSpot, Zapier, Google, ...):
  User pastes a key; store in keychain like any secret.
  -> Trivial, no OAuth flow.

Open (AWS Knowledge):
  No auth. Trivial.
```

Implication for the manifest design: the current `auth` block hand-codes `authorizationUrl` / `tokenUrl` / scopes per app. That is fine for curated apps, but not enough for feed-scale ingestion. **The scalable path is: default to MCP-standard OAuth discovery + PKCE, use DCR when available, use platform static clients when BrowserX must register with the provider, and treat hand-authored provider URLs as the exception.** This is the auth analogue of the transport finding — both convert "author per app" into "discover/configure per server".

Identity model:

```text
Apple Pi account:
  Owns marketplace install state and sync state.

Provider account:
  Owns SaaS data permissions, workspace membership, scopes, and provider-side signup/login.

Email match:
  Display hint only. Never a shortcut for auth or account linking.
```

Linear-style app:

```text
Install Linear in Apple Pi.
User connects any Linear account through Linear OAuth: same email, different email, SSO, or signup.
Apple Pi stores only local token + non-secret providerAccountHint.
```

Google Workspace-style app:

```text
BrowserX first registers/verifies Apple Pi with Google for requested scopes.
Users then connect their Google accounts through Google OAuth.
Until provider registration is ready, catalog install can exist but connect should be blocked.
```

## 7. Recommended ingestion architecture

```text
Tier 0  Curated first-party (≈20–50)
  source: §4 seed, cross-checked vs Anthropic/Apigene directories
  trust:  first_party / verified
  effort: ~1 row each; the few no-DCR vendors get a manual OAuth client
  rights: eligible for auto-activate hints + (only here) any token forwarding

Tier 1  Registry ingestion (hundreds → thousands)
  source: official MCP Registry /v0/servers, polled ~hourly
  trust:  namespace-verified -> "verified"; else "community"
  effort: ZERO per app (sync job + auto-manifest pipeline)
  rights: discoverable in app_search; activation requires explicit user
          approval; never silent token forwarding

Tier 2  Auto-generated artifacts (pipeline, applies to T0+T1)
  connect once in sandbox -> initialize + tools/list + read server
  instructions/metadata -> synthesize manifest (runtime, toolPolicy,
  capabilities) + one small LLM pass over tool descriptions to emit the
  app_search discovery markdown (Used For / Best When / Tool Groups)
  -> the expensive hand-authored artifacts become a cron job

Tier 3  Self-serve publisher (post-MVP)
  publisher submits MCP URL -> backend runs Tier-2 pipeline -> review queue
  -> matches existing non-goal ("no third-party unreviewed install" in MVP)
```

The trust tier is the safety mechanism that makes Tier-1's volume acceptable: registry namespace verification proves *provenance*; our tier + curation + the existing `trustedFirstPartyOnly` policy govern *privilege*. Volume without the tier gate would be unsafe; the gate is already in the design — this just feeds it.

## 8. Realistic catalog sizing

```text
Launch (SSE window, no new transport work):  ~10 first-party apps
Launch + Streamable HTTP:                    ~25–50 curated first-party (Tier 0)
+ Registry ingestion (Tier 1):               hundreds of namespace-verified,
                                             thousands including community
+ Zapier/Composio as meta-apps:              one row each ≈ thousands of
                                             downstream actions (distinct UX;
                                             decide in/out of scope explicitly)
```

The jump from ~10 to "hundreds+" is gated by **(a) Streamable HTTP, (b) MCP-standard OAuth with DCR/static-client/provider-registration modes, (c) the auto-manifest pipeline.** None of the three is catalog content work — all three are runtime/pipeline work. That is the core strategic message: *we already have the apps; we need the consumer.*

## 9. Implications for `technical_design.md`

Design deltas this survey argues for, now reflected in `technical_design.md`:

1. Promote **Streamable HTTP transport** and **MCP-standard OAuth (AS-metadata discovery + PKCE + optional DCR)** from Phase-7 hardening to **MVP-blocking** — they are the catalog-growth levers, not polish.
2. Reframe the manifest `auth` block around client modes: dynamic client registration, platform static client, manual provider config, API key, none.
3. Add provider registration state (`ready`, `needs_company_registration`, `verification_pending`, `restricted`, `unsupported`) separately from per-user device connection state.
4. Add a **"Catalog Ingestion"** section: official MCP Registry as the spine, `server.json → apps/app_versions/manifest` mapping (§3), ~hourly poll, namespace-verification → trust tier.
5. Add the **Tier-2 auto-manifest/auto-metadata pipeline** — it removes the only per-app manual artifact in the current design.
6. Record the **SSE launch window** as a deliberate, time-boxed schedule option (ships value pre-Streamable-HTTP) with the 2026-06-30 Atlassian deadline as the canary.
7. Make the **Zapier/Composio meta-app** an explicit in/out-of-scope decision (high leverage, but bypasses per-app permission UX).

## 10. Open questions / decisions

1. Ship the SSE launch window first (value now, ~10 apps) or hold for Streamable HTTP (slower, but the catalog actually scales)?
2. Do we adopt MCP-standard auth discovery as the default and support DCR/static-client/manual modes, or stay with hand-authored manifest auth for an explicitly capped curated set?
3. Tier-1 ingestion at MVP, or Tier-0-only at MVP with the registry sync as fast-follow?
4. Are meta-apps (Zapier/Composio/Pipedream) in scope? They are the single highest-leverage catalog move but the worst fit for the per-app trust/permission model.
5. Registry preview risk: pin to a `server.json` schema snapshot and tolerate resets, or defer ingestion until GA?

## Sources

- [Official MCP Registry](https://registry.modelcontextprotocol.io/) · [Registry API sample](https://registry.modelcontextprotocol.io/v0/servers?limit=5) · [The MCP Registry — about](https://modelcontextprotocol.io/registry/about) · [Registry repo](https://github.com/modelcontextprotocol/registry) · [server.json schema](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/draft/server.schema.json)
- [Introducing the MCP Registry (blog)](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/)
- [awesome-remote-mcp-servers (jaw9c)](https://github.com/jaw9c/awesome-remote-mcp-servers) · [raw README](https://raw.githubusercontent.com/jaw9c/awesome-remote-mcp-servers/main/README.md)
- [awesome-claude-connectors (398 verified, 2026-05-15)](https://github.com/rdmgator12/awesome-claude-connectors) · [Anthropic Connectors Directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq)
- [Apigene: Remote MCP Servers 2026](https://apigene.ai/blog/remote-mcp-servers)
- [PulseMCP server directory](https://www.pulsemcp.com/servers) · [Where to Find MCP Servers in 2026](https://automationswitch.com/ai-workflows/where-to-find-mcp-servers-2026)
- [Awesome MCP Servers — 70+ in 2026](https://mcpplaygroundonline.com/blog/awesome-mcp-servers) · [Notion MCP server](https://github.com/makenotion/notion-mcp-server) · [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)
