import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { stlViewerPlugin } from "emdash-plugin-stl-viewer";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { cloudflareEmailPlugin } from "./src/plugins/email-cloudflare/index.ts";

// Leave siteUrl undefined in dev so the WebAuthn RP ID matches the request
// origin (localhost). When set, EmDash uses it as both the rpId and canonical
// origin, which breaks passkey registration on localhost.
const isProd = process.env.NODE_ENV === "production";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	vite: {
		ssr: {
			optimizeDeps: {
				// emdash's integration pre-bundles its runtime deps for workerd, but
				// these entries get discovered one-by-one on first request instead.
				// Each discovery triggers a re-optimize + reload that invalidates
				// chunk hashes mid-flight and wedges workerd (requests hang, emdash
				// "Failed to hydrate bylines/terms" warnings). Declaring them up
				// front means one optimize pass at startup and stable chunks.
				include: [
					"emdash/middleware",
					"emdash/middleware/redirect",
					"emdash/middleware/setup",
					"emdash/middleware/auth",
					"emdash/middleware/request-context",
					"emdash/media/local-runtime",
					"emdash/page",
					"emdash/runtime",
					"emdash/ui",
					"@emdash-cms/cloudflare/db/d1",
					"@emdash-cms/cloudflare/storage/r2",
					"@emdash-cms/plugin-forms",
					"@emdash-cms/plugin-forms/astro",
					"emdash-plugin-stl-viewer",
					"emdash-plugin-stl-viewer/astro",
					"mimetext",
					"astro/zod",
				],
			},
		},
	},
	integrations: [
		react(),
		emdash({
			siteUrl: isProd ? "https://boothe.io" : undefined,
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [
				formsPlugin(),
				stlViewerPlugin(),
				cloudflareEmailPlugin({ from: "noreply@boothe.io" }),
			],
			sandboxed: [webhookNotifier],
			sandboxRunner: sandbox(),
			marketplace: "https://marketplace.emdashcms.com",
		}),
	],
	devToolbar: { enabled: false },
});
