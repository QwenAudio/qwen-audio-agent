# i18n Parity Tracking

> Documentation debt tracker for the bilingual (en/zh) docs site.
> Updated 2026-08-28 after migrating the docs site onto the 1.11.0 baseline
> (github/main @ 70dd204, includes the GCP1–GCP3 rollout): Gateway contract
> 5.2.0, `reference/` set, `gateway-protocol` Draft 0.6, Knowledge Provider,
> and the BackendPort extension paths.
> Line counts are a rough proxy only — CJK text wraps denser than English, so
> fully translated zh pages commonly sit at 75–90% of the en line count.
> This file is a working artifact — it is not published to the docs site.

## Genuine content gaps

| File | Note |
|---|---|
| `backends/overview.md` | zh has *more* lines (121 vs 113) but its capability table lacks the en Skills column and the skill-management link. Translate the column when the table next changes. |

## Content-complete pairs below 90% (wrap density)

Header structure verified 1:1; the ratio reflects CJK wrapping, not missing
sections:

`architecture/overview` (77%), `architecture/deep-dive` (78%),
`reference/frontend-evaluations` (79%), `scenarios/customer-service` (83%),
`reference/memory` (83%), `reference/personalization` (87%),
`reference/a2a-backend-adapter` (87%),
`reference/frontend-profile` (87%), `configuration` (88%),
`getting-started/webui` (88%),
`configuration/advanced` (88%), `configuration/backend` (88%),
`reference/backend-adapter-sdk` (89%).

## Pairs at parity (≥ 90%)

`backends/extend` (90%), `reference/frontend-mcp` (90%), `contract` (90%),
`voice-frontends/qwen-audio-realtime` (91%), `voice-frontends/qwen-omni-realtime` (91%),
`reference/knowledge` (91%), `desktop/pet-skin-spec` (92%),
`reference/frontend-openapi` (93%), `getting-started/tui` (93%),
`scenarios/smart-cockpit` (94%), `voice-frontends/speech-to-speech` (94%),
`configuration/frontend` (95%), `extensions` (95%),
`getting-started/install` (97%), `gateway-protocol` (98%),
`getting-started/quickstart` (100%), `voice-frontends/custom-provider` (100%),
`index` (100%), `desktop/overview` (104%), `backends/overview` (107%, see gap above).

## Unpaired files

| File | Missing side | Status |
|---|---|---|
| `frontend-agent-roadmap.md` | no zh | Maintainer-facing; excluded from the docs site (see `scripts/sync-docs-site.mjs` EXCLUDED_FILES) |
| `voice-agent-architecture-presentation.zh.md` | no en | Maintainer-facing; excluded from the docs site |
| `roadmap/` | n/a | Maintainer-facing directory; excluded from the docs site (EXCLUDED_DIRS) |

## Policy

- New docs land bilingual in the same PR, or are explicitly marked language-only.
- The docs build does **not** gate on parity; this file is the tracking surface.
