/**
 * Cloudflare Email Sending provider for EmDash CMS.
 *
 * Native trusted plugin that implements the email:deliver exclusive hook by
 * dispatching to a Cloudflare Workers `send_email` binding. The binding is
 * declared in wrangler.jsonc.
 *
 * Constraints (per Cloudflare docs):
 *   - The `from` address must belong to a domain you have Email Routing
 *     active on (boothe.io here).
 *   - The recipient (`to`) address must be a pre-verified destination address
 *     in your Email Routing configuration. This is NOT a transactional email
 *     service — it's "email to verified inboxes only," which is fine for
 *     single-admin magic-link auth.
 *
 * Dev fallback: when `cloudflare:workers` / `cloudflare:email` aren't loadable
 * (any non-Workers context, e.g. `npx emdash dev`), the handler logs the
 * message to stdout and resolves successfully — the email pipeline doesn't
 * fail just because we're not running on Cloudflare.
 */
import { definePlugin } from "emdash";
import type { PluginDescriptor, ResolvedPlugin } from "emdash";

export interface CloudflareEmailOptions {
	/** From address. Must be on a domain with Email Routing active. */
	from: string;
	/** Optional friendly display name shown alongside the from address. */
	fromName?: string;
}

const PLUGIN_ID = "email-cloudflare";
const PLUGIN_VERSION = "0.1.0";

export function cloudflareEmailPlugin(
	options: CloudflareEmailOptions,
): PluginDescriptor<CloudflareEmailOptions> {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: "/src/plugins/email-cloudflare/index.ts",
		options,
	};
}

export function createPlugin(options: CloudflareEmailOptions): ResolvedPlugin {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: ["email:provide"],
		hooks: {
			"email:deliver": {
				exclusive: true,
				handler: async ({ message, source }, ctx) => {
					let cfWorkers: { env: Record<string, unknown> } | null = null;
					let cfEmail: { EmailMessage: new (from: string, to: string, raw: string) => unknown } | null = null;
					try {
						cfWorkers = (await import(/* @vite-ignore */ "cloudflare:workers")) as typeof cfWorkers;
						cfEmail = (await import(/* @vite-ignore */ "cloudflare:email")) as typeof cfEmail;
					} catch {
						// Non-Workers context — log and exit so dev flows don't break.
						ctx.log.info(
							`[email-cloudflare:dev] To: ${message.to} | Subject: ${message.subject} | Source: ${source}\n${message.text}`,
						);
						return;
					}

					const binding = cfWorkers?.env.SEND_EMAIL as
						| { send: (msg: unknown) => Promise<unknown> }
						| undefined;
					if (!binding) {
						throw new Error(
							"SEND_EMAIL binding missing. Add `send_email` to wrangler.jsonc and redeploy.",
						);
					}

					const { createMimeMessage } = await import("mimetext");
					const msg = createMimeMessage();
					msg.setSender(
						options.fromName
							? { name: options.fromName, addr: options.from }
							: options.from,
					);
					msg.setRecipient(message.to);
					msg.setSubject(message.subject);
					msg.addMessage({ contentType: "text/plain", data: message.text });
					if (message.html) {
						msg.addMessage({ contentType: "text/html", data: message.html });
					}

					const emailMessage = new cfEmail!.EmailMessage(
						options.from,
						message.to,
						msg.asRaw(),
					);
					await binding.send(emailMessage);
					ctx.log.info(`[email-cloudflare] sent to ${message.to} (source=${source})`);
				},
			},
		},
	});
}

export default createPlugin;
