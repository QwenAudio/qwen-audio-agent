# i18n Parity Tracking

> Maintainer-facing policy for the bilingual documentation site. This file is
> not published by `scripts/sync-docs-site.mjs`.

## Current baseline

Reviewed against GitHub main `7aba34d3` on 2026-09-20:

- Gateway health contract `5.9.0`;
- stable Gateway Client Protocol wire version `7.0.0`;
- GCP1–GCP5 complete;
- Gateway remote access and Mobile Client roadmap tracked by issue #320;
- WebUI, Desktop, TUI, and Mobile on the shared reference Client SDK;
- current BackendPort, knowledge, memory, personalization, and extension docs.

The refresh covers navigation, setup, clients, features, configuration, operations,
and developer references. New concept, vision, lists/reminders, CLI, and example-index
pages have language companions. This is a documentation/source review, not a claim that
every external service or operating system was live-tested.

## Build-time guard

Every published Markdown page must have a side-by-side language companion:

- `page.md` — English source;
- `page.zh.md` — Chinese source.

`npm run docs:build` fails when either side is missing. Maintainer-only files
and directories explicitly excluded by `scripts/sync-docs-site.mjs` do not
participate in this check.

Command examples and configuration identifiers are also checked by
`test/docs-manual.test.mjs`. The site build checks generated links and anchors in both
languages. These checks complement, but do not replace, editorial review.

## Policy

- Update both language files in the same change.
- Keep section structure and technical meaning aligned; sentence-by-sentence
  literal translation is not required.
- Product names, protocol identifiers, commands, environment variables, and
  capability names must remain identical across languages.
- A language-only document must be explicitly excluded from the published
  site rather than silently shipped without a companion.
