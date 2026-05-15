/**
 * STL Viewer plugin for EmDash CMS.
 *
 * Native-format trusted plugin. Registers a `stl-viewer` Portable Text block
 * type backed by an Astro component that lazy-loads three.js on viewport entry.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import { stlViewerPlugin } from "@bootheio/plugin-stl-viewer";
 * plugins: [stlViewerPlugin()]
 * ```
 */
import { definePlugin } from "emdash";
import type { PluginDescriptor, ResolvedPlugin } from "emdash";

export interface StlViewerOptions {}

const PLUGIN_ID = "stl-viewer";
const PLUGIN_VERSION = "0.1.0";

export function stlViewerPlugin(
	options: StlViewerOptions = {},
): PluginDescriptor<StlViewerOptions> {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: "@bootheio/plugin-stl-viewer",
		componentsEntry: "@bootheio/plugin-stl-viewer/astro",
		options,
	};
}

export function createPlugin(_options: StlViewerOptions = {}): ResolvedPlugin {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		admin: {
			portableTextBlocks: [
				{
					type: "stl-viewer",
					label: "3D Model (STL)",
					icon: "code",
					description: "Embed an interactive 3D preview of an STL file",
					placeholder: "Paste STL file URL...",
					fields: [
						{
							type: "text_input",
							action_id: "id",
							label: "STL URL",
							placeholder: "https://… or /_emdash/api/media/file/…",
						},
						{
							type: "text_input",
							action_id: "title",
							label: "Title (optional)",
							placeholder: "e.g. Bracket v3",
						},
						{
							type: "text_input",
							action_id: "caption",
							label: "Caption (optional)",
						},
						{
							type: "select",
							action_id: "material",
							label: "Material",
							options: [
								{ label: "Matte plastic (default)", value: "matte" },
								{ label: "Glossy plastic", value: "glossy" },
								{ label: "Brushed metal", value: "metal" },
								{ label: "Normal map (rainbow)", value: "normal" },
								{ label: "Clay (unlit)", value: "clay" },
							],
						},
						{
							type: "text_input",
							action_id: "color",
							label: "Color (hex, e.g. #22d3ee)",
							placeholder: "#cfd1d4",
						},
						{
							type: "select",
							action_id: "height",
							label: "Viewer height",
							options: [
								{ label: "Compact (320px)", value: "compact" },
								{ label: "Standard (440px)", value: "standard" },
								{ label: "Tall (560px)", value: "tall" },
							],
						},
						{
							type: "toggle",
							action_id: "autoRotate",
							label: "Auto-rotate when idle",
							initial_value: true,
						},
						{
							type: "toggle",
							action_id: "showGrid",
							label: "Show ground plane",
							initial_value: true,
						},
					],
				},
			],
		},
	});
}

export default createPlugin;
