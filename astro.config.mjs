import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { stlViewerPlugin } from "emdash-plugin-stl-viewer";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
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
			sandboxed: [webhookNotifierPlugin()],
			sandboxRunner: sandbox(),
			marketplace: "https://marketplace.emdashcms.com",
		}),
	],
	devToolbar: { enabled: false },
});
