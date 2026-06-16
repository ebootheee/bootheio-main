const WORDS_PER_MINUTE = 200;

/**
 * Strip Markdown/MDX syntax down to readable words. Drops fenced code blocks,
 * inline code, image/link syntax, JSX tags, and Markdown punctuation so the
 * word count reflects prose, not markup.
 */
export function extractText(markdown: string | undefined): string {
	if (!markdown || typeof markdown !== "string") return "";
	return markdown
		.replace(/```[\s\S]*?```/g, " ") // fenced code
		.replace(/`[^`]*`/g, " ") // inline code
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> link text
		.replace(/<[^>]+>/g, " ") // html/jsx tags
		.replace(/[#>*_~`-]/g, " ") // md punctuation
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Calculate reading time in minutes from a Markdown/MDX body string.
 */
export function getReadingTime(markdown: string | undefined): number {
	const text = extractText(markdown);
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	return Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
}

export function formatReadingTime(minutes: number): string {
	return `${minutes} min read`;
}
