import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Posts are now git-based Markdown/MDX (migrated off EmDash). The glob loader
// reads every .md/.mdx file in src/content/posts; the file name is the slug.
const posts = defineCollection({
	loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: "./src/content/posts" }),
	schema: z.object({
		title: z.string(),
		excerpt: z.string().optional(),
		publishedAt: z.coerce.date().optional(),
		updatedAt: z.coerce.date().optional(),
		draft: z.boolean().default(false),
		tags: z.array(z.string()).default([]),
		categories: z.array(z.string()).default([]),
	}),
});

// Models collection — one .md per 3D print in src/content/models, shown at
// /models and /models/[slug]. Model files live under public/stls.
const models = defineCollection({
	loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: "./src/content/models" }),
	schema: z.object({
		title: z.string(),
		model_url: z.string().optional(),
		material: z.string().optional(),
		color: z.string().optional(),
		height: z.string().optional(),
		auto_rotate: z.boolean().default(true),
		show_grid: z.boolean().default(true),
		related_posts: z.array(z.string()).default([]),
		publishedAt: z.coerce.date().optional(),
	}),
});

export const collections = { posts, models };
