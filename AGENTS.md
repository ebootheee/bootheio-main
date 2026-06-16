boothe.io is a plain **Astro** site (git-based Markdown/MDX content) deployed to Cloudflare Workers. It was migrated off the EmDash CMS in June 2026 — there is no longer a database, admin UI, or CMS runtime.

## Commands

```bash
npm run dev      # astro dev (local at http://localhost:4321)
npm run build    # astro build -> dist/ (static client + tiny SSR worker)
npm run deploy   # wrangler deploy -c dist/server/wrangler.json. git push does NOT redeploy.
npm run typecheck # astro check
```

Deploy targets the `bootheio-main` Worker, which serves **boothe.io** (and `bootheio-main.ericboothe.workers.dev`). Always `npm run build` before `npm run deploy`. Verify the live site after deploying.

## Content

- Posts live in `src/content/posts/*.{md,mdx}` — the filename is the slug. Frontmatter: `title`, `excerpt?`, `publishedAt?`, `updatedAt?`, `draft`, `tags[]`, `categories[]` (schema in `src/content.config.ts`). Drafts are excluded from listings/RSS and are not built (404 on direct hit).
- To embed a 3D model or app demo in a post, use `.mdx` and import a component (e.g. `import StlViewer from "../../components/StlViewer.astro"`). This is the whole point of the migration — any post can embed arbitrary components.
- Investments (the `/about` portfolio grid) are in `src/data/investments.ts`.
- Media: commit files to `public/` (e.g. `public/media/`, `public/stls/`) and reference by path. No upload pipeline.

## Key Files

| File | Purpose |
| --- | --- |
| `astro.config.mjs` | Astro config: cloudflare adapter, `output: "static"`, `trailingSlash: "never"`, `build.format: "file"`, mdx, `syntaxHighlight: false` |
| `src/content.config.ts` | Content collections (`posts`, `models`) via the glob loader |
| `src/layouts/Base.astro` | Layout: static nav, SEO/OG meta, theme switcher, footer |
| `src/components/StlViewer.astro` + `stl-viewer-client.ts` | Vendored three.js STL/3MF viewer (no CMS dependency) |
| `src/pages/` | Routes. All prerendered except `src/pages/search.astro` (SSR, `prerender = false`) |
| `wrangler.jsonc` | Worker name + `nodejs_compat` + SESSION KV (Astro sessions). The adapter writes the real deploy config to `dist/server/wrangler.json` |
| `tmp/*` | Gitignored. Migration scripts + verification probes kept as reference |

## Rules

- Content pages are static: use `getCollection`/`getEntry` + `render()` and `<Content />`, with `getStaticPaths` for dynamic routes. Filter `(p) => !p.data.draft`.
- `entry.id` is the slug. Use it for URLs (`/posts/${entry.id}`).
- Code blocks are intentionally **not** syntax-highlighted and render on a dark terminal background (`#1e1e1e` / `#e0e0e0`) — see `.article-content pre` in `src/pages/posts/[slug].astro`.
- The Powell demo iframe is a hardcoded slug special-case in `posts/[slug].astro`; the palletballet sim is a standalone page. Custom apps belong in plain `.astro`/`.mdx`, not a CMS.
- Bambu/Orca/Prusa-exported 3MFs use the production extension and **fail** in three.js's 3MFLoader (viewer shows the parse error inline). Use STL for slicer exports.
- Rollback a bad deploy with `wrangler rollback`. The old EmDash D1/R2/KV resources still exist in the account but are unused.
