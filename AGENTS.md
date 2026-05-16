This is an EmDash site -- a CMS built on Astro with a full admin UI.

## Commands

```bash
npx emdash dev        # Start dev server (runs migrations, seeds, generates types)
npx emdash types      # Regenerate TypeScript types from schema
npx emdash seed seed/seed.json --validate  # Validate seed file
npm run build && npm run deploy            # Build and ship to Cloudflare (wrangler). git push does NOT redeploy.
```

Local admin UI: `http://localhost:4321/_emdash/admin`. **Prod admin: `https://boothe.io/_emdash/admin`** — the workers.dev URL now 302s here.

## Key Files

| File                     | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `astro.config.mjs`       | Astro config with `emdash()` integration, database, and storage                  |
| `src/live.config.ts`     | EmDash loader registration (boilerplate -- don't modify)                         |
| `seed/seed.json`         | Schema definition + demo content (collections, fields, taxonomies, menus, widgets) |
| `seed/seed.prod.json`    | Prod-safe subset (menus/widgets/terms/bylines only — no content, no settings)    |
| `emdash-env.d.ts`      | Generated types for collections (auto-regenerated on dev server start)             |
| `src/layouts/Base.astro` | Base layout with EmDash wiring (menus, search, page contributions)               |
| `src/plugins/email-cloudflare/` | Inline native plugin: routes magic-link emails through CF `SEND_EMAIL`     |
| `src/pages/`             | Astro pages -- all server-rendered                                                 |
| `wrangler.jsonc`         | Cloudflare bindings: D1, R2, KV, IMAGES, SEND_EMAIL                              |
| `tmp/*.mjs`, `tmp/*.sql` | Gitignored. Remote appliers and SQL templates kept as reference patterns         |

## Skills

Agent skills are in `.agents/skills/`. Load them when working on specific tasks:

- **building-emdash-site** -- Querying content, rendering Portable Text, schema design, seed files, site features (menus, widgets, search, SEO, comments, bylines). Start here.
- **creating-plugins** -- Building EmDash plugins with hooks, storage, admin UI, API routes, and Portable Text block types.
- **emdash-cli** -- CLI commands for content management, seeding, type generation, and visual editing flow.

## Rules

- All content pages must be server-rendered (`output: "server"`). No `getStaticPaths()` for CMS content.
- Image fields are objects (`{ src, alt }`), not strings. Use `<Image image={...} />` from `"emdash/ui"`.
- `entry.id` is the slug (for URLs). `entry.data.id` is the database ULID (for API calls like `getEntryTerms`).
- Always call `Astro.cache.set(cacheHint)` on pages that query content.
- Taxonomy names in queries must match the seed's `"name"` field exactly (e.g., `"category"` not `"categories"`).
- **Magic-link URLs use `options.emdash:site_url` from the DB**, not `astro.config.mjs siteUrl` or `EMDASH_SITE_URL` env var. To change: `UPDATE options SET value='"https://newurl"' WHERE name='emdash:site_url';` via `wrangler d1 execute --remote`.
- `npx emdash seed` works on a **local SQLite file only**. To populate prod, POST to the REST API (`/_emdash/api/menus`, `/widget-areas`, `/taxonomies/<name>/terms`, `/admin/bylines`, `/sections`). See `tmp/apply-prod-seed.mjs` for the pattern.
- `POST /_emdash/api/content/<collection>` creates entries as **drafts** by default. To publish: `POST /_emdash/api/content/<collection>/<id>/publish`. The create body's schema only accepts `status: "draft"` (passing `"published"` returns VALIDATION_ERROR).
