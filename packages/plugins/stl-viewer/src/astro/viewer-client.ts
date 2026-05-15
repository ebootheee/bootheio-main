/**
 * STL Viewer — client-side runtime.
 *
 * Finds every `[data-stl-viewer]` element on the page, lazy-loads three.js
 * the first time one enters the viewport, then renders an interactive scene.
 * Three.js is loaded once per page (the dynamic import is memoized), so
 * additional viewers cost only their own scene/canvas.
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

interface ViewerConfig {
	url: string;
	material: string;
	color: string;
	autoRotate: boolean;
	showGrid: boolean;
}

interface ThreeBundle {
	THREE: typeof THREE_NS;
	OrbitControls: typeof OrbitControlsT;
	STLLoader: typeof STLLoaderT;
}

let threePromise: Promise<ThreeBundle> | null = null;
function loadThree(): Promise<ThreeBundle> {
	if (!threePromise) {
		threePromise = Promise.all([
			import("three"),
			import("three/addons/controls/OrbitControls.js"),
			import("three/addons/loaders/STLLoader.js"),
		]).then(([THREE, controls, loader]) => ({
			THREE: THREE as unknown as typeof THREE_NS,
			OrbitControls: controls.OrbitControls,
			STLLoader: loader.STLLoader,
		}));
	}
	return threePromise;
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
		};
	} catch {
		return {
			url: "",
			material: "matte",
			color: "#cfd1d4",
			autoRotate: true,
			showGrid: true,
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

async function fetchStl(
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

async function startViewer(viewer: Viewer) {
	if (viewer.state !== "idle") return;
	viewer.state = "loading";

	const config = viewer.config;
	if (!config.url) {
		showError(viewer, "No STL URL configured");
		return;
	}

	const placeholder =
		viewer.stage.querySelector<HTMLElement>("[data-placeholder]");
	const errEl = viewer.stage.querySelector<HTMLElement>("[data-error]");
	if (errEl) errEl.hidden = true;
	setProgress(viewer, null, "Loading viewer…");

	let bundle: ThreeBundle;
	try {
		bundle = await loadThree();
	} catch {
		showError(viewer, "Failed to load 3D library");
		return;
	}
	const { THREE, OrbitControls, STLLoader } = bundle;

	setProgress(viewer, 0, "Downloading model…");
	let buffer: ArrayBuffer;
	try {
		buffer = await fetchStl(config.url, (ratio, label) => {
			setProgress(viewer, ratio, label);
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		showError(viewer, `Could not load STL: ${msg}`);
		return;
	}

	let geometry: THREE_NS.BufferGeometry;
	try {
		const loader = new STLLoader();
		geometry = loader.parse(buffer);
	} catch {
		showError(viewer, "Could not parse STL file");
		return;
	}

	// `center()` shifts the geometry so its bounding box is symmetric around
	// the origin. We compute normals after centering — STL is just triangle
	// soup, so we generate smooth-shaded normals here.
	geometry.computeBoundingBox();
	geometry.center();
	geometry.computeVertexNormals();
	geometry.computeBoundingSphere();

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

	const radius = geometry.boundingSphere?.radius || 50;

	const material = buildMaterial(THREE, config);
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

	// Re-center the mesh around the origin after rotation. We want the model's
	// visual centroid at (0, 0, 0) so the camera's target naturally sits in
	// the middle of the viewport rather than at the model's base.
	const postRotBox = new THREE.Box3().setFromObject(mesh);
	const postRotCenter = new THREE.Vector3();
	postRotBox.getCenter(postRotCenter);
	mesh.position.sub(postRotCenter);
	mesh.updateMatrixWorld(true);

	scene.add(mesh);

	const visualBox = new THREE.Box3().setFromObject(mesh);

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
		// Place the grid at the model's base — model is centered at origin,
		// so its lowest point is at -visualSize.y / 2.
		grid.position.y = visualBox.min.y - 0.05;
		scene.add(grid);
	}

	const camera = new THREE.PerspectiveCamera(
		38,
		Math.max(stage.clientWidth, 1) / Math.max(stage.clientHeight, 1),
		Math.max(radius / 1000, 0.01),
		radius * 100,
	);
	// camDist is chosen so the bounding sphere fits the vertical FOV with a
	// 25% margin around it. d = r / tan(fov/2) just barely fits; we use a
	// slightly larger factor for visual breathing room.
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
	controls.autoRotateSpeed = 1.5; // ~40s per orbit, gentle
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
		geometry.dispose();
		(material as unknown as { dispose: () => void }).dispose();
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
