import cloudflare from "@astrojs/cloudflare";
import mdx from "@astrojs/mdx";
import { defineConfig } from "astro/config";

// boothe.io — git-based Astro content site (migrated off EmDash).
// Content lives in src/content/posts as Markdown/MDX; pages are server-rendered
// only where they need to be (/search), everything else is prerendered static.
export default defineConfig({
	site: "https://boothe.io",
	output: "static",
	// Serve /posts/slug directly (no trailing-slash redirect), matching the
	// pre-migration SSR URLs that all internal links + canonicals use.
	trailingSlash: "never",
	build: { format: "file" },
	// No Astro <Image> usage on the site, so skip Cloudflare Images (avoids the
	// IMAGES binding); markdown images are served as plain files from /public.
	adapter: cloudflare({ imageService: "passthrough" }),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	markdown: {
		// Match the pre-migration look: code blocks were plain <pre><code>, not
		// syntax-highlighted. Disabling Shiki keeps the existing theme CSS in charge.
		syntaxHighlight: false,
	},
	integrations: [mdx()],
	devToolbar: { enabled: false },
});
