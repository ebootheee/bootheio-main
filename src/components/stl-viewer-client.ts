/**
 * STL / 3MF Viewer — client-side runtime.
 *
 * Finds every `[data-stl-viewer]` element on the page, lazy-loads three.js
 * the first time one enters the viewport, then renders an interactive scene.
 * Three.js is loaded once per page (the dynamic import is memoized), so
 * additional viewers cost only their own scene/canvas. The 3MF loader is
 * loaded separately and only when a 3MF file is encountered, so pages with
 * STL-only content don't pay the cost of fflate (the 3MF zip decoder).
 *
 * Supported formats:
 *   - .stl  (binary or ASCII; via STLLoader)
 *   - .3mf  (zipped XML mesh; via 3MFLoader; returns a Group)
 *
 * Format is auto-detected from the URL's pathname extension; pass `format`
 * in the config to override (e.g. for opaque URLs without an extension).
 *
 * Lifecycle:
 *   - IntersectionObserver triggers init when scrolled near.
 *   - Manual "Load" button bypasses the observer.
 *   - Render loop pauses when offscreen or when the tab is hidden.
 *   - ResizeObserver keeps the canvas in sync with the stage element.
 *   - Auto-rotate pauses on user interaction, resumes after idle.
 *   - On removal from DOM, geometry/material/renderer are disposed.
 */

import type * as THREE_NS from "three";
import type { OrbitControls as OrbitControlsT } from "three/addons/controls/OrbitControls.js";
import type { STLLoader as STLLoaderT } from "three/addons/loaders/STLLoader.js";
import type { ThreeMFLoader as ThreeMFLoaderT } from "three/addons/loaders/3MFLoader.js";

type ModelFormat = "stl" | "3mf";

interface ViewerConfig {
	url: string;
	material: string;
	color: string;
	autoRotate: boolean;
	showGrid: boolean;
	format: ModelFormat | "auto";
}

interface ThreeCore {
	THREE: typeof THREE_NS;
	OrbitControls: typeof OrbitControlsT;
	STLLoader: typeof STLLoaderT;
}

let threeCorePromise: Promise<ThreeCore> | null = null;
function loadThreeCore(): Promise<ThreeCore> {
	if (!threeCorePromise) {
		threeCorePromise = Promise.all([
			import("three"),
			import("three/addons/controls/OrbitControls.js"),
			import("three/addons/loaders/STLLoader.js"),
		]).then(([THREE, controls, loader]) => ({
			THREE: THREE as unknown as typeof THREE_NS,
			OrbitControls: controls.OrbitControls,
			STLLoader: loader.STLLoader,
		}));
	}
	return threeCorePromise;
}

let threeMFPromise: Promise<typeof ThreeMFLoaderT> | null = null;
function loadThreeMFLoader(): Promise<typeof ThreeMFLoaderT> {
	if (!threeMFPromise) {
		threeMFPromise = import("three/addons/loaders/3MFLoader.js").then(
			(m) => m.ThreeMFLoader,
		);
	}
	return threeMFPromise;
}

function detectFormat(url: string, override: ViewerConfig["format"]): ModelFormat {
	if (override === "stl" || override === "3mf") return override;
	// Strip query/hash, then look at the trailing extension.
	const path = url.split(/[?#]/)[0] ?? "";
	const lower = path.toLowerCase();
	if (lower.endsWith(".3mf")) return "3mf";
	return "stl";
}

interface Viewer {
	root: HTMLElement;
	stage: HTMLElement;
	config: ViewerConfig;
	state: "idle" | "loading" | "ready" | "error";
	dispose: () => void;
}

const viewers = new WeakMap<HTMLElement, Viewer>();
const initialized = new WeakSet<HTMLElement>();

function parseConfig(el: HTMLElement): ViewerConfig {
	try {
		const raw = el.getAttribute("data-config") || "{}";
		const parsed = JSON.parse(raw) as Partial<ViewerConfig>;
		return {
			url: parsed.url || "",
			material: parsed.material || "matte",
			color: parsed.color || "#cfd1d4",
			autoRotate: parsed.autoRotate !== false,
			showGrid: parsed.showGrid !== false,
			format: parsed.format === "stl" || parsed.format === "3mf" ? parsed.format : "auto",
		};
	} catch {
		return {
			url: "",
			material: "matte",
			color: "#cfd1d4",
			autoRotate: true,
			showGrid: true,
			format: "auto",
		};
	}
}

function showError(viewer: Viewer, message: string) {
	const errEl = viewer.stage.querySelector<HTMLElement>("[data-error]");
	const placeholder =
		viewer.stage.querySelector<HTMLElement>("[data-placeholder]");
	const progress = viewer.stage.querySelector<HTMLElement>("[data-progress]");
	if (placeholder) placeholder.style.display = "none";
	if (progress) progress.hidden = true;
	if (errEl) {
		errEl.hidden = false;
		errEl.textContent = message;
	}
	viewer.state = "error";
}

function setProgress(viewer: Viewer, ratio: number | null, label?: string) {
	const wrap = viewer.stage.querySelector<HTMLElement>("[data-progress]");
	const bar = viewer.stage.querySelector<HTMLElement>("[data-progress-bar]");
	const lbl = viewer.stage.querySelector<HTMLElement>("[data-progress-label]");
	if (!wrap || !bar || !lbl) return;
	wrap.hidden = false;
	if (ratio === null) {
		wrap.classList.add("is-indeterminate");
		bar.style.width = "";
	} else {
		wrap.classList.remove("is-indeterminate");
		bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
	}
	if (label) lbl.textContent = label;
}

function hideProgress(viewer: Viewer) {
	const wrap = viewer.stage.querySelector<HTMLElement>("[data-progress]");
	if (wrap) wrap.hidden = true;
}

async function fetchModel(
	url: string,
	onProgress: (ratio: number | null, label: string) => void,
): Promise<ArrayBuffer> {
	const response = await fetch(url, { credentials: "same-origin" });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	const total = Number(response.headers.get("Content-Length")) || 0;
	const reader = response.body?.getReader();
	if (!reader) {
		return response.arrayBuffer();
	}
	const chunks: Uint8Array[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		chunks.push(value);
		received += value.byteLength;
		if (total > 0) {
			onProgress(
				received / total,
				`${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`,
			);
		} else {
			onProgress(null, `${(received / 1024 / 1024).toFixed(1)} MB`);
		}
	}
	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out.buffer;
}

function buildMaterial(THREE: typeof THREE_NS, config: ViewerConfig) {
	const color = new THREE.Color(config.color || "#cfd1d4");
	switch (config.material) {
		case "normal":
			return new THREE.MeshNormalMaterial({ flatShading: false });
		case "clay":
			return new THREE.MeshLambertMaterial({ color, flatShading: false });
		case "glossy":
			return new THREE.MeshStandardMaterial({
				color,
				roughness: 0.3,
				metalness: 0,
				flatShading: false,
			});
		case "metal":
			return new THREE.MeshStandardMaterial({
				color,
				roughness: 0.35,
				metalness: 0.9,
				flatShading: false,
			});
		case "matte":
		default:
			return new THREE.MeshStandardMaterial({
				color,
				roughness: 0.85,
				metalness: 0,
				flatShading: false,
			});
	}
}

/**
 * Override the material on every mesh inside a parsed scene root (used for
 * 3MF: the file's embedded materials are intentionally swapped for our
 * configured material so 3MF blocks render consistently with STL blocks).
 * Disposes the replaced materials to free GPU memory.
 */
function applyMaterialToTree(
	THREE: typeof THREE_NS,
	root: THREE_NS.Object3D,
	material: THREE_NS.Material,
): THREE_NS.Material[] {
	const disposed: THREE_NS.Material[] = [];
	root.traverse((obj) => {
		const mesh = obj as THREE_NS.Mesh;
		if (!mesh.isMesh) return;
		const current = mesh.material;
		if (Array.isArray(current)) {
			disposed.push(...current);
		} else if (current) {
			disposed.push(current);
		}
		mesh.material = material;
	});
	return disposed;
}

async function startViewer(viewer: Viewer) {
	if (viewer.state !== "idle") return;
	viewer.state = "loading";

	const config = viewer.config;
	if (!config.url) {
		showError(viewer, "No model URL configured");
		return;
	}

	const format = detectFormat(config.url, config.format);

	const placeholder =
		viewer.stage.querySelector<HTMLElement>("[data-placeholder]");
	const errEl = viewer.stage.querySelector<HTMLElement>("[data-error]");
	if (errEl) errEl.hidden = true;
	setProgress(viewer, null, "Loading viewer…");

	let core: ThreeCore;
	let ThreeMFLoader: typeof ThreeMFLoaderT | null = null;
	try {
		core = await loadThreeCore();
		if (format === "3mf") {
			ThreeMFLoader = await loadThreeMFLoader();
		}
	} catch {
		showError(viewer, "Failed to load 3D library");
		return;
	}
	const { THREE, OrbitControls, STLLoader } = core;

	setProgress(viewer, 0, "Downloading model…");
	let buffer: ArrayBuffer;
	try {
		buffer = await fetchModel(config.url, (ratio, label) => {
			setProgress(viewer, ratio, label);
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		showError(viewer, `Could not load ${format.toUpperCase()}: ${msg}`);
		return;
	}

	// `modelRoot` is the THREE object we add to the scene. For STL it's a
	// single Mesh built around a centered BufferGeometry. For 3MF it's a
	// Group returned by the loader (possibly multiple meshes), repositioned
	// so its visual centroid sits at the origin.
	let modelRoot: THREE_NS.Object3D;
	let primaryGeometry: THREE_NS.BufferGeometry | null = null;
	const ownedMaterials: THREE_NS.Material[] = [];
	const ownedGeometries: THREE_NS.BufferGeometry[] = [];
	const material = buildMaterial(THREE, config);
	ownedMaterials.push(material);

	try {
		if (format === "stl") {
			const loader = new STLLoader();
			const geometry = loader.parse(buffer);
			geometry.computeBoundingBox();
			geometry.center();
			geometry.computeVertexNormals();
			geometry.computeBoundingSphere();
			primaryGeometry = geometry;
			ownedGeometries.push(geometry);

			const mesh = new THREE.Mesh(geometry, material);

			// Most printable STLs are exported Z-up. If the longest extent is along
			// Z, rotate to make Y up so OrbitControls' default frame feels natural.
			const preBox = new THREE.Box3().setFromObject(mesh);
			const preSize = new THREE.Vector3();
			preBox.getSize(preSize);
			if (preSize.z > preSize.x && preSize.z > preSize.y) {
				mesh.rotation.x = -Math.PI / 2;
			}
			mesh.updateMatrixWorld(true);

			// Re-center after rotation so the visual centroid sits at (0,0,0).
			const postRotBox = new THREE.Box3().setFromObject(mesh);
			const postRotCenter = new THREE.Vector3();
			postRotBox.getCenter(postRotCenter);
			mesh.position.sub(postRotCenter);
			mesh.updateMatrixWorld(true);
			modelRoot = mesh;
		} else {
			if (!ThreeMFLoader) {
				showError(viewer, "3MF loader unavailable");
				return;
			}
			const loader = new ThreeMFLoader();
			const group = loader.parse(buffer);
			// Replace embedded materials for consistency with STL rendering. We
			// keep the originals around to dispose at teardown.
			const replaced = applyMaterialToTree(THREE, group, material);
			ownedMaterials.push(...replaced);
			// 3MF triangles don't carry per-face normals (unlike binary STL),
			// and 3MFLoader doesn't generate them. Without normals, a lit
			// MeshStandardMaterial renders solid black. Compute smooth-shaded
			// normals on every mesh, then collect the geometries for disposal.
			group.traverse((obj) => {
				const mesh = obj as THREE_NS.Mesh;
				if (!mesh.isMesh || !mesh.geometry) return;
				if (!mesh.geometry.getAttribute("normal")) {
					mesh.geometry.computeVertexNormals();
				}
				ownedGeometries.push(mesh.geometry);
			});

			// 3MF coordinate convention: same Z-up as STL. Apply the same heuristic.
			const preBox = new THREE.Box3().setFromObject(group);
			const preSize = new THREE.Vector3();
			preBox.getSize(preSize);
			if (preSize.z > preSize.x && preSize.z > preSize.y) {
				group.rotation.x = -Math.PI / 2;
			}
			group.updateMatrixWorld(true);

			const postBox = new THREE.Box3().setFromObject(group);
			const postCenter = new THREE.Vector3();
			postBox.getCenter(postCenter);
			group.position.sub(postCenter);
			group.updateMatrixWorld(true);
			modelRoot = group;
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		showError(viewer, `Could not parse ${format.toUpperCase()}: ${msg}`);
		return;
	}

	const stage = viewer.stage;
	const renderer = new THREE.WebGLRenderer({
		antialias: true,
		alpha: true,
		powerPreference: "high-performance",
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(stage.clientWidth || 320, stage.clientHeight || 240, false);
	renderer.setClearColor(0x000000, 0);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;
	stage.appendChild(renderer.domElement);

	const scene = new THREE.Scene();
	scene.add(modelRoot);

	const visualBox = new THREE.Box3().setFromObject(modelRoot);
	const visualSize = new THREE.Vector3();
	visualBox.getSize(visualSize);
	const radius =
		primaryGeometry?.boundingSphere?.radius ??
		(Math.max(visualSize.x, visualSize.y, visualSize.z) / 2 || 50);

	// Lights — skipped for the unlit normal-map material.
	if (config.material !== "normal") {
		const hemi = new THREE.HemisphereLight(0xb1e3ff, 0x1a1a22, 0.55);
		scene.add(hemi);
		const key = new THREE.DirectionalLight(0xffffff, 1.4);
		key.position.set(radius * 1.5, radius * 2.2, radius * 1.8);
		scene.add(key);
		const fill = new THREE.DirectionalLight(0x9fb6ff, 0.4);
		fill.position.set(-radius * 1.8, radius * 0.4, -radius * 1.2);
		scene.add(fill);
	}

	let grid: THREE_NS.GridHelper | null = null;
	if (config.showGrid) {
		const gridSize = radius * 4;
		const gridDivisions = 20;
		grid = new THREE.GridHelper(gridSize, gridDivisions, 0x22d3ee, 0x2a2a32);
		const gm = grid.material as THREE_NS.LineBasicMaterial;
		gm.opacity = 0.18;
		gm.transparent = true;
		grid.position.y = visualBox.min.y - 0.05;
		scene.add(grid);
	}

	const camera = new THREE.PerspectiveCamera(
		38,
		Math.max(stage.clientWidth, 1) / Math.max(stage.clientHeight, 1),
		Math.max(radius / 1000, 0.01),
		radius * 100,
	);
	const camDist = radius / Math.tan((38 * Math.PI) / 180 / 2) * 1.25;
	const initialCamPos = new THREE.Vector3(
		camDist * 0.78,
		camDist * 0.45,
		camDist * 0.78,
	);
	camera.position.copy(initialCamPos);
	const initialTarget = new THREE.Vector3(0, 0, 0);
	camera.lookAt(initialTarget);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.rotateSpeed = 0.9;
	controls.zoomSpeed = 0.8;
	controls.panSpeed = 0.7;
	controls.minDistance = radius * 0.6;
	controls.maxDistance = radius * 12;
	controls.target.copy(initialTarget);
	controls.autoRotate = config.autoRotate;
	controls.autoRotateSpeed = 1.5;
	controls.update();

	let autoRotatePaused = false;
	let idleResumeTimer: number | undefined;
	const userWantsAutoRotate = { value: config.autoRotate };
	controls.addEventListener("start", () => {
		if (controls.autoRotate) {
			controls.autoRotate = false;
			autoRotatePaused = true;
		}
		if (idleResumeTimer) window.clearTimeout(idleResumeTimer);
	});
	controls.addEventListener("end", () => {
		if (autoRotatePaused && userWantsAutoRotate.value) {
			idleResumeTimer = window.setTimeout(() => {
				controls.autoRotate = true;
				autoRotatePaused = false;
			}, 3000);
		}
	});

	const resetBtn = viewer.root.querySelector<HTMLButtonElement>(
		'[data-action="reset"]',
	);
	const rotateBtn = viewer.root.querySelector<HTMLButtonElement>(
		'[data-action="rotate"]',
	);
	if (resetBtn) {
		resetBtn.hidden = false;
		resetBtn.addEventListener("click", () => {
			camera.position.copy(initialCamPos);
			controls.target.copy(initialTarget);
			controls.update();
		});
	}
	if (rotateBtn) {
		rotateBtn.hidden = false;
		rotateBtn.setAttribute(
			"aria-pressed",
			userWantsAutoRotate.value ? "true" : "false",
		);
		rotateBtn.addEventListener("click", () => {
			userWantsAutoRotate.value = !userWantsAutoRotate.value;
			controls.autoRotate = userWantsAutoRotate.value;
			autoRotatePaused = false;
			rotateBtn.setAttribute(
				"aria-pressed",
				userWantsAutoRotate.value ? "true" : "false",
			);
		});
	}

	const resize = () => {
		const w = stage.clientWidth;
		const h = stage.clientHeight;
		if (w === 0 || h === 0) return;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h, false);
	};
	const ro = new ResizeObserver(resize);
	ro.observe(stage);

	let visible = true;
	const visibilityObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) visible = entry.isIntersecting;
		},
		{ rootMargin: "200px" },
	);
	visibilityObserver.observe(viewer.root);

	let rafId: number | undefined;
	const renderLoop = () => {
		rafId = requestAnimationFrame(renderLoop);
		if (document.hidden || !visible) return;
		controls.update();
		renderer.render(scene, camera);
	};
	rafId = requestAnimationFrame(renderLoop);

	viewer.root.classList.add("is-ready");
	if (placeholder) placeholder.style.display = "none";
	hideProgress(viewer);
	viewer.state = "ready";


	viewer.dispose = () => {
		if (rafId !== undefined) cancelAnimationFrame(rafId);
		ro.disconnect();
		visibilityObserver.disconnect();
		if (idleResumeTimer) window.clearTimeout(idleResumeTimer);
		controls.dispose();
		for (const geom of ownedGeometries) geom.dispose();
		for (const mat of ownedMaterials) {
			(mat as unknown as { dispose?: () => void }).dispose?.();
		}
		if (grid) {
			grid.geometry.dispose();
			(grid.material as unknown as { dispose?: () => void }).dispose?.();
		}
		renderer.dispose();
		try {
			renderer.forceContextLoss();
		} catch {}
		const canvas = renderer.domElement;
		if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
	};
}

function attach(root: HTMLElement) {
	if (initialized.has(root)) return;
	initialized.add(root);

	const stage = root.querySelector<HTMLElement>("[data-stage]");
	if (!stage) return;

	const config = parseConfig(root);
	const viewer: Viewer = {
		root,
		stage,
		config,
		state: "idle",
		dispose: () => {},
	};
	viewers.set(root, viewer);

	const loadBtn = root.querySelector<HTMLButtonElement>("[data-load]");
	loadBtn?.addEventListener("click", () => {
		void startViewer(viewer);
	});

	const io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					io.disconnect();
					void startViewer(viewer);
					return;
				}
			}
		},
		{ rootMargin: "400px" },
	);
	io.observe(root);
}

export function initStlViewers() {
	const run = () => {
		const elements = document.querySelectorAll<HTMLElement>("[data-stl-viewer]");
		elements.forEach(attach);
	};
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", run, { once: true });
	} else {
		run();
	}
}
