# i18n Parity Tracking

> Maintainer-facing policy for the bilingual documentation site. This file is
> not published by `scripts/sync-docs-site.mjs`.

## Current baseline

Updated 2026-09-02:

- Gateway health contract `5.6.0`;
- stable Gateway Client Protocol wire version `6.0.0`;
- GCP1–GCP5 complete;
- WebUI, Desktop, and TUI on the shared reference Client SDK;
- current BackendPort, knowledge, memory, personalization, and extension docs.

There are no known English/Chinese content gaps in the published manual.

## Build-time guard

Every published Markdown page must have a side-by-side language companion:

- `page.md` — English source;
- `page.zh.md` — Chinese source.

`npm run docs:build` fails when either side is missing. Maintainer-only files
and directories explicitly excluded by `scripts/sync-docs-site.mjs` do not
participate in this check.

## Policy

- Update both language files in the same change.
- Keep section structure and technical meaning aligned; sentence-by-sentence
  literal translation is not required.
- Product names, protocol identifiers, commands, environment variables, and
  capability names must remain identical across languages.
- A language-only document must be explicitly excluded from the published
  site rather than silently shipped without a companion.
