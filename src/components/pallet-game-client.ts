/**
 * PalletBallet — interactive conveyor game client.
 *
 * The game talks to the real inference API (no canned physics): scenarios come
 * from GET /scenarios, each dispatch is a live MuJoCo run via POST /solve with
 * include_replay, and the reveal comes from POST /safety/analyze. Three.js is
 * dynamically imported when the stage scrolls into view.
 *
 * Coordinate note: MuJoCo is Z-up with +X = belt travel. All bodies live in a
 * parent group rotated -90° about X, so MuJoCo positions and (w,x,y,z)
 * quaternions pass straight through (reordered to three's x,y,z,w).
 */

import type * as THREE_NS from "three";
import type { OrbitControls as OrbitControlsT } from "three/addons/controls/OrbitControls.js";

// ---------- API payload types (subset) ----------

type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // w, x, y, z (MuJoCo order)

interface ScenarioSummary {
	slug: string;
	name: string;
	tag: string;
	description: string;
	expected_failure: string;
	item_count: number;
	total_mass_kg: number;
	stack_height_m: number;
}

interface PalletItem {
	sku: string;
	weight_kg: number;
	dims_m: Vec3;
	fragility: string;
	position: Vec3;
	orientation_deg: number;
}

interface PalletConfig {
	pallet_id: string;
	base_dims_m: Vec3;
	items: PalletItem[];
	wrap: string;
	env: string;
	body_temp_c: number;
	total_mass_kg: number;
	composite_com_m: Vec3;
	stack_height_m: number;
	overhang_m: number;
	[k: string]: unknown;
}

interface Scenario {
	slug: string;
	name: string;
	tag: string;
	description: string;
	expected_failure: string;
	pallet: PalletConfig;
	suggested_profile: { target_speed_mps: number; accel_mps2: number; duration_s: number };
}

interface ReplayItem {
	sku: string;
	name: string;
	dims_m: Vec3;
	fragility: string;
	category: string;
}

interface ReplayData {
	times_s: number[];
	belt_disp_m: number[];
	base_dims_m: Vec3;
	pallet_pos_m: Vec3[];
	pallet_quat_wxyz: Quat[];
	items: ReplayItem[];
	item_pos_m: Vec3[][];
	item_quat_wxyz: Quat[][];
}

interface SolveResponse {
	pallet_id: string;
	failure: { mode: string; time_s: number | null; max_tip_angle_deg: number };
	trace: { times_s: number[]; conveyor_vel_mps: number[]; tip_angle_deg: number[] };
	runtime_ms: number;
	n_steps_simulated: number;
	replay: ReplayData | null;
}

interface SafetyResponse {
	result: {
		max_speed_mps: number;
		max_accel_mps2: number;
		max_decel_mps2: number;
		max_lateral_g: number;
		dominant_failure_mode: string;
		margin_pct: number;
		confidence: number;
		sim_runtime_ms: number;
		config_hash: string;
	};
	sims_run: number;
	cache_hits: number;
}

// ---------- constants ----------

const FAILURE_LABELS: Record<string, string> = {
	no_failure: "CLEAN DISPATCH",
	tip_over: "TIP-OVER",
	top_item_slide: "TOP-ITEM SLIDE",
	pallet_slip: "PALLET SLIP",
	load_shift: "LOAD SHIFT",
};

const CATEGORY_COLORS: Record<string, number> = {
	fresh_dairy: 0xe8e0cd,
	frozen_meat: 0xb07a5a,
	frozen_seafood: 0x7fb2c8,
	frozen_vegetables: 0x86a97e,
	ice_cream: 0xd9a7c7,
	fresh_produce: 0x9dbd72,
	dry_goods: 0xc9a86a,
	beverage: 0x7290c9,
	unknown: 0x9aa0a6,
};

// SKU category lookup is only present in replay payloads; for the pre-send
// preview we key off the SKU prefix instead.
const SKU_PREFIX_CATEGORY: Record<string, string> = {
	"SKU-FM": "frozen_meat",
	"SKU-FS": "frozen_seafood",
	"SKU-FV": "frozen_vegetables",
	"SKU-IC": "ice_cream",
	"SKU-FD": "fresh_dairy",
	"SKU-FP": "fresh_produce",
	"SKU-DG": "dry_goods",
	"SKU-BV": "beverage",
	"SKU-MS": "fresh_dairy",
};

const BELT_PERIOD_M = 0.6; // one chevron repeat, in metres of belt travel
const SHIFT_SEQUENCE = [
	"stable-dairy-slab",
	"frozen-meat-sprint",
	"top-heavy-surprise",
	"asymmetric-load",
	"tall-unwrapped-tower",
];
const MYSTERY_SLUG = "__mystery__";
const LS_BEST = "pb_best_shift_v1";

// ---------- three.js lazy core ----------

interface ThreeCore {
	THREE: typeof THREE_NS;
	OrbitControls: typeof OrbitControlsT;
}

let threePromise: Promise<ThreeCore> | null = null;
function loadThree(): Promise<ThreeCore> {
	if (!threePromise) {
		threePromise = Promise.all([
			import("three"),
			import("three/addons/controls/OrbitControls.js"),
		]).then(([three, controls]) => ({ THREE: three, OrbitControls: controls.OrbitControls }));
	}
	return threePromise;
}

// ---------- small helpers ----------

const $ = <T extends HTMLElement>(root: ParentNode, sel: string): T => {
	const el = root.querySelector<T>(sel);
	if (!el) throw new Error(`missing element: ${sel}`);
	return el;
};

const fmt = (v: number, d = 2) => v.toFixed(d);
const reducedMotion = () =>
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function categoryFor(sku: string): string {
	return SKU_PREFIX_CATEGORY[sku.slice(0, 6)] ?? "unknown";
}

// ---------- the 3D stage ----------

class Stage {
	private readonly T: typeof THREE_NS;
	renderer: THREE_NS.WebGLRenderer;
	scene: THREE_NS.Scene;
	camera: THREE_NS.PerspectiveCamera;
	controls: OrbitControlsT;
	/** MuJoCo frame: children use raw MuJoCo coords. */
	mj: THREE_NS.Group;
	private beltTex: THREE_NS.CanvasTexture;
	private palletMesh: THREE_NS.Group | null = null;
	private itemMeshes: THREE_NS.Group[] = [];
	private comMarker: THREE_NS.Group | null = null;
	private followTarget = { x: 0, y: 0, z: 0.4 };
	private disposed = false;

	constructor(core: ThreeCore, host: HTMLElement) {
		const { THREE, OrbitControls } = core;
		this.T = THREE;

		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		host.appendChild(this.renderer.domElement);

		this.scene = new THREE.Scene();
		this.scene.fog = new THREE.Fog(0x06090b, 9, 22);

		this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 60);
		this.camera.position.set(2.6, 1.7, 2.9);

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.maxPolarAngle = Math.PI * 0.52;
		this.controls.minDistance = 1.2;
		this.controls.maxDistance = 12;
		this.controls.target.set(0, 0.4, 0);

		// Lights: cold-storage grade.
		this.scene.add(new THREE.HemisphereLight(0xbfd7e4, 0x0a0e12, 0.75));
		const key = new THREE.DirectionalLight(0xeaf6ff, 2.0);
		key.position.set(3, 6, 2.5);
		key.castShadow = true;
		key.shadow.mapSize.set(1024, 1024);
		key.shadow.camera.left = -4;
		key.shadow.camera.right = 8;
		key.shadow.camera.top = 4;
		key.shadow.camera.bottom = -4;
		this.scene.add(key);
		const rim = new THREE.DirectionalLight(0x66d9ef, 0.5);
		rim.position.set(-4, 2, -3);
		this.scene.add(rim);

		// MuJoCo frame (Z-up → three Y-up).
		this.mj = new THREE.Group();
		this.mj.rotation.x = -Math.PI / 2;
		this.scene.add(this.mj);

		this.beltTex = this.makeBeltTexture();
		this.buildConveyor();

		const grid = new THREE.GridHelper(40, 80, 0x14343c, 0x0c1a20);
		grid.position.y = -0.055;
		this.scene.add(grid);

		const ro = new ResizeObserver(() => this.resize(host));
		ro.observe(host);
		this.resize(host);
	}

	private makeBeltTexture(): THREE_NS.CanvasTexture {
		const { T } = this;
		const c = document.createElement("canvas");
		c.width = 128;
		c.height = 64;
		const g = c.getContext("2d")!;
		g.fillStyle = "#171c1f";
		g.fillRect(0, 0, 128, 64);
		g.strokeStyle = "#232b2f";
		g.lineWidth = 6;
		g.beginPath();
		g.moveTo(84, -8);
		g.lineTo(44, 72);
		g.stroke();
		g.strokeStyle = "#10557a";
		g.lineWidth = 2;
		g.beginPath();
		g.moveTo(92, -8);
		g.lineTo(52, 72);
		g.stroke();
		const tex = new T.CanvasTexture(c);
		tex.wrapS = T.RepeatWrapping;
		tex.wrapT = T.RepeatWrapping;
		tex.colorSpace = T.SRGBColorSpace;
		return tex;
	}

	private buildConveyor() {
		const { T } = this;
		const LEN = 26; // -6 .. +20 in belt-travel X
		const W = 1.35;
		const X0 = -6;

		const belt = new T.Mesh(
			new T.PlaneGeometry(LEN, W),
			new T.MeshStandardMaterial({ map: this.beltTex, roughness: 0.92, metalness: 0.05 }),
		);
		this.beltTex.repeat.set(LEN / BELT_PERIOD_M, 1);
		belt.position.set(X0 + LEN / 2, 0, -0.002);
		belt.receiveShadow = true;
		this.mj.add(belt);

		const railMat = new T.MeshStandardMaterial({ color: 0x2b3338, roughness: 0.5, metalness: 0.6 });
		for (const side of [-1, 1]) {
			const rail = new T.Mesh(new T.BoxGeometry(LEN, 0.06, 0.1), railMat);
			rail.position.set(X0 + LEN / 2, side * (W / 2 + 0.045), -0.03);
			this.mj.add(rail);
		}
		// Roller legs every metre — cheap instancing-free repetition, few meshes.
		const legMat = new T.MeshStandardMaterial({ color: 0x1c2226, roughness: 0.7 });
		for (let x = X0 + 1; x < X0 + LEN; x += 2) {
			const leg = new T.Mesh(new T.BoxGeometry(0.08, W + 0.15, 0.5), legMat);
			leg.position.set(x, 0, -0.3);
			this.mj.add(leg);
		}
	}

	resize(host: HTMLElement) {
		if (this.disposed) return;
		const w = host.clientWidth || 1;
		const h = host.clientHeight || 1;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	/** Box with soft edge lines, centred on its own origin. */
	private box(dims: Vec3, color: number): THREE_NS.Group {
		const { T } = this;
		const g = new T.Group();
		const geo = new T.BoxGeometry(dims[0], dims[1], dims[2]);
		const mesh = new T.Mesh(
			geo,
			new T.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.02 }),
		);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		g.add(mesh);
		const edges = new T.LineSegments(
			new T.EdgesGeometry(geo),
			new T.LineBasicMaterial({ color: 0x06090b, transparent: true, opacity: 0.35 }),
		);
		g.add(edges);
		return g;
	}

	clearPallet() {
		for (const m of [this.palletMesh, ...this.itemMeshes, this.comMarker]) {
			if (m) this.mj.remove(m);
		}
		this.palletMesh = null;
		this.itemMeshes = [];
		this.comMarker = null;
	}

	/** Static preview from a PalletConfig (bottom-face anchored positions). */
	buildPreview(cfg: PalletConfig) {
		this.clearPallet();
		const { T } = this;
		const [bl, bw, bh] = cfg.base_dims_m;
		this.palletMesh = this.box([bl, bw, bh], 0x8a6238);
		this.palletMesh.position.set(0, 0, bh / 2);
		this.mj.add(this.palletMesh);

		for (const item of cfg.items) {
			const g = this.box(item.dims_m, CATEGORY_COLORS[categoryFor(item.sku)] ?? CATEGORY_COLORS.unknown);
			g.position.set(item.position[0], item.position[1], item.position[2] + item.dims_m[2] / 2);
			g.rotation.z = (item.orientation_deg * Math.PI) / 180;
			this.mj.add(g);
			this.itemMeshes.push(g);
		}

		// Centre-of-mass plumb line.
		const com = cfg.composite_com_m;
		const marker = new T.Group();
		const dot = new T.Mesh(
			new T.SphereGeometry(0.028, 16, 12),
			new T.MeshBasicMaterial({ color: 0x22d3ee }),
		);
		dot.position.set(com[0], com[1], com[2]);
		marker.add(dot);
		const lineGeo = new T.BufferGeometry().setFromPoints([
			new T.Vector3(com[0], com[1], 0.005),
			new T.Vector3(com[0], com[1], com[2]),
		]);
		const line = new T.Line(
			lineGeo,
			new T.LineDashedMaterial({ color: 0x22d3ee, dashSize: 0.03, gapSize: 0.03, transparent: true, opacity: 0.8 }),
		);
		line.computeLineDistances();
		marker.add(line);
		this.comMarker = marker;
		this.mj.add(marker);

		this.followTarget = { x: 0, y: 0, z: Math.min(cfg.stack_height_m * 0.55, 1.1) };
		this.snapCameraToTarget();
	}

	/** Rebuild meshes for a replay (centre-anchored poses). */
	buildReplayBodies(replay: ReplayData) {
		this.clearPallet();
		this.palletMesh = this.box(replay.base_dims_m, 0x8a6238);
		this.mj.add(this.palletMesh);
		for (const item of replay.items) {
			const g = this.box(item.dims_m, CATEGORY_COLORS[item.category] ?? CATEGORY_COLORS.unknown);
			this.mj.add(g);
			this.itemMeshes.push(g);
		}
	}

	/** Apply interpolated world poses for frame f..f+1 at blend a. */
	applyFrame(replay: ReplayData, f: number, a: number) {
		const { T } = this;
		const f2 = Math.min(f + 1, replay.times_s.length - 1);
		const lerp3 = (p: Vec3, q: Vec3): Vec3 => [
			p[0] + (q[0] - p[0]) * a,
			p[1] + (q[1] - p[1]) * a,
			p[2] + (q[2] - p[2]) * a,
		];
		const qa = new T.Quaternion();
		const qb = new T.Quaternion();
		const setQ = (obj: THREE_NS.Object3D, w1: Quat, w2: Quat) => {
			qa.set(w1[1], w1[2], w1[3], w1[0]);
			qb.set(w2[1], w2[2], w2[3], w2[0]);
			obj.quaternion.slerpQuaternions(qa, qb, a);
		};

		if (this.palletMesh) {
			const p = lerp3(replay.pallet_pos_m[f], replay.pallet_pos_m[f2]);
			this.palletMesh.position.set(p[0], p[1], p[2]);
			setQ(this.palletMesh, replay.pallet_quat_wxyz[f], replay.pallet_quat_wxyz[f2]);
			this.followTarget = { x: p[0], y: p[1], z: p[2] + 0.35 };
		}
		for (let k = 0; k < this.itemMeshes.length; k++) {
			const p = lerp3(replay.item_pos_m[f][k], replay.item_pos_m[f2][k]);
			this.itemMeshes[k].position.set(p[0], p[1], p[2]);
			setQ(this.itemMeshes[k], replay.item_quat_wxyz[f][k], replay.item_quat_wxyz[f2][k]);
		}
		const disp = replay.belt_disp_m[f] + (replay.belt_disp_m[f2] - replay.belt_disp_m[f]) * a;
		this.beltTex.offset.x = disp / BELT_PERIOD_M;
	}

	snapCameraToTarget() {
		const t = this.followTarget;
		this.controls.target.set(t.x, t.z, -t.y); // mj → three
	}

	/** Chase: shift target+camera together toward the follow point. */
	updateCamera() {
		const t = this.followTarget;
		const want = { x: t.x, y: t.z, z: -t.y };
		const cur = this.controls.target;
		const dx = (want.x - cur.x) * 0.12;
		const dy = (want.y - cur.y) * 0.12;
		const dz = (want.z - cur.z) * 0.12;
		cur.x += dx;
		cur.y += dy;
		cur.z += dz;
		this.camera.position.x += dx;
		this.camera.position.y += dy;
		this.camera.position.z += dz;
	}

	render() {
		this.controls.update();
		this.renderer.render(this.scene, this.camera);
	}

	dispose() {
		this.disposed = true;
		this.renderer.dispose();
	}
}

// ---------- API console ----------

interface ApiCall {
	method: string;
	path: string;
	status: number;
	ms: number;
	bytes: number;
	note: string;
	curl: string;
}

class ApiConsole {
	private list: HTMLElement;
	constructor(root: HTMLElement) {
		this.list = $(root, "[data-pbg-console]");
	}
	log(call: ApiCall) {
		const row = document.createElement("div");
		row.className = "pbg-call";
		const ok = call.status >= 200 && call.status < 300;
		row.innerHTML = `
			<span class="pbg-call-method">${call.method}</span>
			<span class="pbg-call-path">${call.path}</span>
			<span class="pbg-call-status ${ok ? "ok" : "err"}">${call.status || "ERR"}</span>
			<span class="pbg-call-meta">${call.ms} ms · ${(call.bytes / 1024).toFixed(1)} KB</span>
			<span class="pbg-call-note">${call.note}</span>
			<button class="pbg-call-curl" type="button" title="Copy as curl">curl ⧉</button>`;
		const btn = row.querySelector<HTMLButtonElement>(".pbg-call-curl")!;
		btn.addEventListener("click", async () => {
			await navigator.clipboard.writeText(call.curl);
			btn.textContent = "copied ✓";
			setTimeout(() => (btn.textContent = "curl ⧉"), 1400);
		});
		this.list.prepend(row);
		while (this.list.children.length > 24) this.list.lastChild?.remove();
	}
}

// ---------- API client (logs every call) ----------

class Api {
	constructor(
		private base: string,
		private con: ApiConsole,
	) {}

	async call<T>(method: string, path: string, body: unknown, note: string, curl: string): Promise<T> {
		const t0 = performance.now();
		let status = 0;
		try {
			const res = await fetch(this.base + path, {
				method,
				headers: body !== undefined ? { "content-type": "application/json" } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(20000),
			});
			status = res.status;
			const buf = await res.arrayBuffer();
			this.con.log({
				method, path, status, note, curl,
				ms: Math.round(performance.now() - t0),
				bytes: buf.byteLength,
			});
			if (!res.ok) throw new Error(`${method} ${path} → ${status}`);
			return JSON.parse(new TextDecoder().decode(buf)) as T;
		} catch (e) {
			if (status === 0) {
				this.con.log({ method, path, status: 0, note: "network error", curl, ms: Math.round(performance.now() - t0), bytes: 0 });
			}
			throw e;
		}
	}

	health() {
		return this.call<{ status: string; version: string }>(
			"GET", "/healthz", undefined, "liveness probe",
			`curl -s ${this.base}/healthz`,
		);
	}

	scenarios() {
		return this.call<ScenarioSummary[]>(
			"GET", "/scenarios", undefined, "curated demo pallets",
			`curl -s ${this.base}/scenarios | jq '.[].slug'`,
		);
	}

	scenario(slug: string) {
		return this.call<Scenario>(
			"GET", `/scenarios/${slug}`, undefined, "full pallet config",
			`curl -s ${this.base}/scenarios/${slug} | jq .pallet`,
		);
	}

	randomPallet(seed: number) {
		return this.call<PalletConfig>(
			"POST", "/pallet/random", { seed, anomaly_rate: 0.25, min_layers: 2, max_layers: 5 },
			`mystery pallet, seed ${seed}`,
			`curl -s -X POST ${this.base}/pallet/random -H 'content-type: application/json' -d '{"seed": ${seed}, "anomaly_rate": 0.25, "min_layers": 2, "max_layers": 5}'`,
		);
	}

	solve(pallet: PalletConfig, speed: number, accel: number, duration: number, slugHint: string) {
		const profile = { target_speed_mps: speed, accel_mps2: accel, duration_s: duration };
		const curl = [
			`PALLET=$(curl -s ${this.base}/scenarios/${slugHint} | jq .pallet)`,
			`curl -s -X POST ${this.base}/solve -H 'content-type: application/json' \\`,
			`  -d "{\\"pallet\\": $PALLET, \\"profile\\": {\\"target_speed_mps\\": ${speed}, \\"accel_mps2\\": ${accel}, \\"duration_s\\": ${duration}}, \\"include_replay\\": true}" | jq .failure`,
		].join("\n");
		return this.call<SolveResponse>(
			"POST", "/solve",
			{ pallet, profile, include_replay: true, output_hz: 30 },
			`live MuJoCo run @ ${fmt(speed)} m/s`,
			curl,
		);
	}

	analyze(pallet: PalletConfig, slugHint: string) {
		return this.call<SafetyResponse>(
			"POST", "/safety/analyze", pallet, "envelope search (brentq)",
			`curl -s ${this.base}/scenarios/${slugHint} | jq .pallet | curl -s -X POST ${this.base}/safety/analyze -H 'content-type: application/json' -d @- | jq .result`,
		);
	}
}

// ---------- game ----------

type Phase = "boot" | "ready" | "simulating" | "replaying" | "revealed" | "offline";

interface DispatchResult {
	slug: string;
	name: string;
	speed: number;
	survived: boolean;
	failureMode: string;
	points: number;
	badge: string;
	solverMax: number;
}

class Game {
	private root: HTMLElement;
	private apiBase: string;
	private api: Api;
	private stage: Stage | null = null;
	private phase: Phase = "boot";

	private scenarios: ScenarioSummary[] = [];
	private currentPallet: PalletConfig | null = null;
	private replay: ReplayData | null = null;
	private solveRes: SolveResponse | null = null;
	private analyzePromise: Promise<SafetyResponse> | null = null;

	// replay clock
	private playT = 0;
	private playing = false;
	private rate = 1;
	private lastTick = 0;

	// shift mode
	private shiftActive = false;
	private shiftIndex = 0;
	private shiftResults: DispatchResult[] = [];

	constructor(root: HTMLElement) {
		this.root = root;
		this.apiBase = root.dataset.apiBase || "";
		this.api = new Api(this.apiBase, new ApiConsole(root));
		this.bindControls();
	}

	// ---- elements ----
	private el<T extends HTMLElement = HTMLElement>(sel: string) {
		return $<T>(this.root, sel);
	}

	private bindControls() {
		const speed = this.el<HTMLInputElement>("[data-pbg-speed]");
		const accel = this.el<HTMLInputElement>("[data-pbg-accel]");
		const sync = () => {
			this.el("[data-pbg-speed-val]").textContent = `${fmt(parseFloat(speed.value))} m/s`;
			this.el("[data-pbg-accel-val]").textContent = `${fmt(parseFloat(accel.value), 1)} m/s²`;
		};
		speed.addEventListener("input", sync);
		accel.addEventListener("input", sync);
		sync();

		this.el("[data-pbg-send]").addEventListener("click", () => void this.send());
		this.el("[data-pbg-shift]").addEventListener("click", () => void this.startShift());
		this.el("[data-pbg-next]").addEventListener("click", () => void this.nextInShift());
		this.el("[data-pbg-replay-again]").addEventListener("click", () => this.restartReplay());
		this.el("[data-pbg-share]").addEventListener("click", () => void this.share());

		const scrub = this.el<HTMLInputElement>("[data-pbg-scrub]");
		scrub.addEventListener("input", () => {
			if (!this.replay) return;
			this.playing = false;
			this.playT = (parseFloat(scrub.value) / 1000) * this.replayDuration();
			this.el("[data-pbg-play]").textContent = "▶";
		});
		this.el("[data-pbg-play]").addEventListener("click", () => {
			if (!this.replay) return;
			if (this.playT >= this.replayDuration() - 0.01) this.playT = 0;
			this.playing = !this.playing;
			this.el("[data-pbg-play]").textContent = this.playing ? "❚❚" : "▶";
		});
		this.el("[data-pbg-slomo]").addEventListener("click", () => {
			this.rate = this.rate === 1 ? 0.25 : 1;
			this.el("[data-pbg-slomo]").classList.toggle("active", this.rate !== 1);
		});
	}

	async boot() {
		try {
			const t0 = performance.now();
			const h = await this.api.health();
			this.setStatus(`solver online · v${h.version} · ${Math.round(performance.now() - t0)} ms`, "ok");
		} catch {
			this.setStatus("solver offline — the home server appears to be down", "off");
			this.setPhase("offline");
			return;
		}

		try {
			this.scenarios = await this.api.scenarios();
			this.renderChips();
			await this.select(SHIFT_SEQUENCE[0]);
		} catch {
			this.setStatus("failed to load scenarios", "off");
			this.setPhase("offline");
		}
	}

	private setStatus(text: string, cls: "ok" | "warn" | "off") {
		const el = this.el("[data-pbg-status]");
		el.textContent = text;
		el.className = `pbg-status-text pbg-status-${cls}`;
	}

	private setPhase(p: Phase) {
		this.phase = p;
		this.root.dataset.phase = p;
	}

	private renderChips() {
		const wrap = this.el("[data-pbg-chips]");
		wrap.innerHTML = "";
		const mk = (slug: string, label: string, sub: string) => {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "pbg-chip";
			b.dataset.slug = slug;
			b.innerHTML = `<span class="pbg-chip-name">${label}</span><span class="pbg-chip-sub">${sub}</span>`;
			b.addEventListener("click", () => void this.select(slug));
			wrap.appendChild(b);
		};
		for (const s of this.scenarios) {
			mk(s.slug, s.name, `${s.item_count} items · ${Math.round(s.total_mass_kg)} kg`);
		}
		mk(MYSTERY_SLUG, "Mystery pallet", "random scanner payload");
	}

	private markChip(slug: string) {
		this.root.querySelectorAll<HTMLElement>(".pbg-chip").forEach((c) => {
			c.classList.toggle("active", c.dataset.slug === slug);
		});
	}

	async select(slug: string) {
		if (this.phase === "simulating" || this.phase === "replaying") return;
		this.markChip(slug);
		this.el("[data-pbg-reveal]").hidden = true;
		this.el("[data-pbg-stamp]").hidden = true;

		let pallet: PalletConfig;
		let name: string;
		let tag: string;
		let description: string;
		if (slug === MYSTERY_SLUG) {
			const seed = Math.floor(Math.random() * 100000);
			pallet = await this.api.randomPallet(seed);
			name = `Mystery pallet #${seed}`;
			tag = "Scanner feed";
			description = "A randomized pallet straight from the mock scanner adapter. Nobody has analyzed this one before — not even the solver.";
			this.currentSlugHint = "random-scanner-feed";
		} else {
			const s = await this.api.scenario(slug);
			pallet = s.pallet;
			name = s.name;
			tag = s.tag;
			description = s.description;
			this.currentSlugHint = slug;
			// Start conservative: near the scenario's story speed but with a
			// gentle ramp. Surviving is easy at defaults — points come from
			// daring to push toward the edge.
			this.el<HTMLInputElement>("[data-pbg-speed]").value = String(
				Math.max(0.4, s.suggested_profile.target_speed_mps - 0.3),
			);
			this.el<HTMLInputElement>("[data-pbg-accel]").value = String(
				Math.min(s.suggested_profile.accel_mps2, 1.2),
			);
			this.el<HTMLInputElement>("[data-pbg-speed]").dispatchEvent(new Event("input"));
		}
		this.currentPallet = pallet;

		// Load card
		this.el("[data-pbg-load-name]").textContent = name;
		this.el("[data-pbg-load-tag]").textContent = tag;
		this.el("[data-pbg-load-desc]").textContent = description;
		const com = pallet.composite_com_m;
		const comOff = Math.hypot(com[0], com[1]);
		this.el("[data-pbg-load-stats]").innerHTML = [
			`<span><b>${pallet.items.length}</b> items</span>`,
			`<span><b>${Math.round(pallet.total_mass_kg)}</b> kg</span>`,
			`<span><b>${fmt(pallet.stack_height_m)}</b> m tall</span>`,
			`<span>CoM <b>${fmt(com[2])}</b> m up${comOff > 0.02 ? `, <b>${Math.round(comOff * 100)}</b> cm off-centre` : ""}</span>`,
			`<span>wrap <b>${pallet.wrap}</b></span>`,
			`<span><b>${fmt(pallet.body_temp_c, 1)} °C</b> ${pallet.env}</span>`,
		].join("");

		if (this.stage) {
			this.stage.buildPreview(pallet);
		}
		this.setPhase("ready");
	}

	private currentSlugHint = "stable-dairy-slab";

	private dialValues() {
		const speed = parseFloat(this.el<HTMLInputElement>("[data-pbg-speed]").value);
		const accel = parseFloat(this.el<HTMLInputElement>("[data-pbg-accel]").value);
		const duration = Math.min(6, Math.max(2, speed / accel + 2.0));
		return { speed, accel, duration };
	}

	async send() {
		if (this.phase !== "ready" && this.phase !== "revealed") return;
		if (!this.currentPallet) return;
		const { speed, accel, duration } = this.dialValues();
		this.setPhase("simulating");
		this.el("[data-pbg-reveal]").hidden = true;
		this.el("[data-pbg-stamp]").hidden = true;

		try {
			// Fire the envelope search concurrently; reveal it only after the replay.
			this.analyzePromise = this.api.analyze(this.currentPallet, this.currentSlugHint);
			this.analyzePromise.catch(() => {});
			this.solveRes = await this.api.solve(this.currentPallet, speed, accel, duration, this.currentSlugHint);
			this.replay = this.solveRes.replay;
			if (!this.replay) throw new Error("no replay in response");
		} catch {
			this.setStatus("simulation failed — is the solver reachable?", "warn");
			this.setPhase("ready");
			return;
		}

		this.stage?.buildReplayBodies(this.replay);
		this.playT = 0;
		this.rate = 1;
		this.el("[data-pbg-slomo]").classList.remove("active");
		this.playing = true;
		this.el("[data-pbg-play]").textContent = "❚❚";
		this.setPhase("replaying");
	}

	private replayDuration() {
		const t = this.replay?.times_s;
		return t && t.length ? t[t.length - 1] : 0;
	}

	private restartReplay() {
		if (!this.replay) return;
		this.playT = 0;
		this.playing = true;
		this.el("[data-pbg-play]").textContent = "❚❚";
		this.setPhase("replaying");
		this.el("[data-pbg-stamp]").hidden = true;
	}

	/** Called every animation frame by the render loop. */
	tick(now: number) {
		const dt = Math.min((now - this.lastTick) / 1000, 0.1);
		this.lastTick = now;
		if (!this.stage) return;

		if (this.replay && (this.phase === "replaying" || this.phase === "revealed")) {
			const dur = this.replayDuration();
			const failT = this.solveRes?.failure.time_s;

			if (this.playing) {
				// Auto slow-mo around the failure moment.
				let rate = this.rate;
				if (
					failT != null && !reducedMotion() &&
					this.playT > failT - 0.12 && this.playT < failT + 0.45
				) {
					rate = Math.min(rate, 0.3);
				}
				this.playT += dt * rate;
				if (this.playT >= dur) {
					this.playT = dur;
					this.playing = false;
					this.el("[data-pbg-play]").textContent = "▶";
					if (this.phase === "replaying") void this.reveal();
				}
			}

			// Failure stamp the instant we cross the event.
			const stamp = this.el("[data-pbg-stamp]");
			if (failT != null && this.playT >= failT && stamp.hidden && this.phase === "replaying") {
				stamp.textContent = FAILURE_LABELS[this.solveRes!.failure.mode] ?? this.solveRes!.failure.mode;
				stamp.hidden = false;
				this.root.classList.add("pbg-crashing");
				setTimeout(() => this.root.classList.remove("pbg-crashing"), 700);
			}
			if (failT != null && this.playT < failT && !stamp.hidden) stamp.hidden = true;

			// Frame interpolation
			const times = this.replay.times_s;
			let f = 0;
			// times are ~uniform; direct index guess then clamp-correct
			const guess = Math.floor((this.playT / dur) * (times.length - 1));
			f = Math.max(0, Math.min(guess, times.length - 2));
			while (f > 0 && times[f] > this.playT) f--;
			while (f < times.length - 2 && times[f + 1] < this.playT) f++;
			const span = times[f + 1] - times[f] || 1;
			const a = Math.max(0, Math.min(1, (this.playT - times[f]) / span));
			this.stage.applyFrame(this.replay, f, a);

			// HUD
			const scrub = this.el<HTMLInputElement>("[data-pbg-scrub]");
			scrub.value = String(Math.round((this.playT / dur) * 1000));
			this.el("[data-pbg-clock]").textContent = `t = ${fmt(this.playT)} s`;
			const vIdx = Math.min(f, this.solveRes!.trace.conveyor_vel_mps.length - 1);
			this.el("[data-pbg-belt-vel]").textContent =
				`belt ${fmt(this.solveRes!.trace.conveyor_vel_mps[vIdx])} m/s`;
		}

		this.stage.updateCamera();
		this.stage.render();
	}

	private async reveal() {
		this.setPhase("revealed");
		const solve = this.solveRes!;
		const { speed } = this.dialValues();
		const survived = solve.failure.mode === "no_failure";

		let env: SafetyResponse | null = null;
		try {
			env = await (this.analyzePromise ?? Promise.reject());
		} catch {
			/* envelope unavailable; still show sim outcome */
		}

		const r = env?.result;
		const solverMax = r?.max_speed_mps ?? NaN;
		let points = 0;
		let badge = "";
		if (survived) {
			const ratio = Number.isFinite(solverMax) && solverMax > 0 ? speed / solverMax : 0.5;
			points = Math.round(100 * Math.min(ratio, 1.25));
			if (ratio > 1.001) badge = "OVERCLOCKED";
			else if (ratio >= 0.85) badge = "DIALED IN";
			else if (ratio < 0.5) badge = "SANDBAGGED";
		} else {
			badge = "WRECKED";
		}

		const revealEl = this.el("[data-pbg-reveal]");
		revealEl.hidden = false;
		this.el("[data-pbg-outcome]").innerHTML = survived
			? `<span class="pbg-ok">✓ CLEAN DISPATCH</span> at ${fmt(speed)} m/s`
			: `<span class="pbg-bad">✗ ${FAILURE_LABELS[solve.failure.mode]}</span> at t = ${fmt(solve.failure.time_s ?? 0)} s`;
		this.el("[data-pbg-points]").textContent = `${points} pts`;
		const badgeEl = this.el("[data-pbg-badge]");
		badgeEl.textContent = badge;
		badgeEl.hidden = !badge;
		badgeEl.className = `pbg-badge pbg-badge-${badge === "WRECKED" ? "bad" : badge === "OVERCLOCKED" ? "hot" : "ok"}`;

		if (r && env) {
			const overSpeed = speed - r.max_speed_mps;
			const { accel } = this.dialValues();
			const overAccel = accel - r.max_accel_mps2;
			let verdict: string;
			if (!survived && overAccel > 0.05 && overAccel >= overSpeed) {
				verdict = `Your acceleration exceeded the envelope by ${fmt(overAccel, 1)} m/s² — that's what broke it.`;
			} else if (!survived && overSpeed > 0.02) {
				verdict = `You ran ${fmt(overSpeed)} m/s past the solver's ceiling.`;
			} else if (survived && Number.isFinite(solverMax) && solverMax - speed > 0.05) {
				verdict = `You left ${fmt(solverMax - speed)} m/s of throughput on the table.`;
			} else if (survived) {
				verdict = "You found the edge and lived there. That's the whole game.";
			} else {
				verdict = "Inside the envelope but still failed — margins exist for a reason.";
			}
			this.el("[data-pbg-envelope]").innerHTML = `
				<div class="pbg-env-row"><span>solver max speed</span><b>${fmt(r.max_speed_mps)} m/s</b><i>you: ${fmt(speed)}</i></div>
				<div class="pbg-env-row"><span>solver max accel</span><b>${fmt(r.max_accel_mps2, 1)} m/s²</b><i>you: ${fmt(this.dialValues().accel, 1)}</i></div>
				<div class="pbg-env-row"><span>governing mode</span><b>${FAILURE_LABELS[r.dominant_failure_mode] ?? r.dominant_failure_mode}</b><i>conf ${(r.confidence * 100).toFixed(0)}%</i></div>
				<div class="pbg-env-row"><span>search cost</span><b>${env.sims_run} sims</b><i>${r.sim_runtime_ms.toFixed(0)} ms${env.cache_hits ? " · cached" : ""}</i></div>
				<p class="pbg-verdict">${verdict}</p>`;
		} else {
			this.el("[data-pbg-envelope]").innerHTML =
				`<p class="pbg-verdict">Envelope search unavailable — sim outcome only.</p>`;
		}

		// Shift bookkeeping
		if (this.shiftActive) {
			this.shiftResults.push({
				slug: this.currentSlugHint,
				name: this.el("[data-pbg-load-name]").textContent ?? "",
				speed,
				survived,
				failureMode: solve.failure.mode,
				points,
				badge,
				solverMax,
			});
			this.renderShiftTracker();
			const done = this.shiftIndex >= SHIFT_SEQUENCE.length - 1;
			this.el("[data-pbg-next]").hidden = done;
			if (done) this.finishShift();
			else this.el("[data-pbg-next]").textContent =
				`NEXT PALLET (${this.shiftIndex + 2}/${SHIFT_SEQUENCE.length}) →`;
		} else {
			this.el("[data-pbg-next]").hidden = true;
		}
	}

	// ---- shift mode ----

	private async startShift() {
		this.shiftActive = true;
		this.shiftIndex = 0;
		this.shiftResults = [];
		this.el("[data-pbg-shift-report]").hidden = true;
		this.el("[data-pbg-shift]").textContent = "SHIFT IN PROGRESS…";
		(this.el("[data-pbg-shift]") as HTMLButtonElement).disabled = true;
		this.renderShiftTracker();
		await this.select(SHIFT_SEQUENCE[0]);
	}

	private async nextInShift() {
		this.shiftIndex++;
		await this.select(SHIFT_SEQUENCE[this.shiftIndex]);
	}

	private renderShiftTracker() {
		const el = this.el("[data-pbg-shift-tracker]");
		if (!this.shiftActive) {
			el.hidden = true;
			return;
		}
		el.hidden = false;
		el.innerHTML = SHIFT_SEQUENCE.map((_slug, i) => {
			const res = this.shiftResults[i];
			const cls = res ? (res.survived ? "done-ok" : "done-bad") : i === this.shiftIndex ? "now" : "";
			return `<span class="pbg-track ${cls}">${i + 1}</span>`;
		}).join("");
		const total = this.shiftResults.reduce((s, r) => s + r.points, 0);
		el.innerHTML += `<span class="pbg-track-score">${total} pts</span>`;
	}

	private finishShift() {
		this.shiftActive = false;
		const btn = this.el<HTMLButtonElement>("[data-pbg-shift]");
		btn.disabled = false;
		btn.textContent = "RUN IT BACK";

		const total = this.shiftResults.reduce((s, r) => s + r.points, 0);
		const grade =
			total >= 460 ? "S" : total >= 420 ? "A" : total >= 360 ? "B" :
			total >= 280 ? "C" : total >= 180 ? "D" : "F";

		let best: { score: number; grade: string } | null = null;
		try {
			best = JSON.parse(localStorage.getItem(LS_BEST) ?? "null");
		} catch { /* ignore */ }
		const isBest = !best || total > best.score;
		if (isBest) {
			try {
				localStorage.setItem(LS_BEST, JSON.stringify({ score: total, grade, date: new Date().toISOString() }));
			} catch { /* ignore */ }
		}

		const report = this.el("[data-pbg-shift-report]");
		report.hidden = false;
		report.innerHTML = `
			<div class="pbg-report-head">
				<span class="pbg-report-grade">${grade}</span>
				<div>
					<div class="pbg-report-total">${total} pts${isBest ? " · new personal best" : best ? ` · best ${best.score}` : ""}</div>
					<div class="pbg-report-sub">shift report — ${this.shiftResults.filter((r) => r.survived).length}/${SHIFT_SEQUENCE.length} pallets dispatched clean</div>
				</div>
			</div>
			${this.shiftResults.map((r) => `
				<div class="pbg-report-row">
					<span class="${r.survived ? "pbg-ok" : "pbg-bad"}">${r.survived ? "✓" : "✗"}</span>
					<span class="pbg-report-name">${r.name}</span>
					<span class="pbg-report-detail">${fmt(r.speed)} m/s${Number.isFinite(r.solverMax) ? ` / max ${fmt(r.solverMax)}` : ""}${r.survived ? "" : ` — ${FAILURE_LABELS[r.failureMode]}`}</span>
					<b>${r.points}</b>
				</div>`).join("")}
		`;
		this.lastShare = [
			`PalletBallet shift report: ${total} pts (${grade})`,
			this.shiftResults.map((r) => (r.survived ? "🟩" : "🟥")).join("") +
				` — ${this.shiftResults.filter((r) => r.survived).length}/${SHIFT_SEQUENCE.length} clean`,
			...this.shiftResults.filter((r) => !r.survived).slice(0, 1)
				.map((r) => `${r.name} got me at ${fmt(r.speed)} m/s (${FAILURE_LABELS[r.failureMode]})`),
			"can you beat the solver? https://boothe.io/palletballet",
		].join("\n");
		this.el("[data-pbg-share]").hidden = false;
	}

	private lastShare = "";
	private async share() {
		if (!this.lastShare) return;
		await navigator.clipboard.writeText(this.lastShare);
		const b = this.el("[data-pbg-share]");
		b.textContent = "copied to clipboard ✓";
		setTimeout(() => (b.textContent = "share shift report ⧉"), 1600);
	}

	// ---- stage bootstrapping ----

	async initStage() {
		if (this.stage) return;
		const core = await loadThree();
		const host = this.el("[data-pbg-canvas]");
		this.stage = new Stage(core, host);
		if (this.currentPallet) this.stage.buildPreview(this.currentPallet);
		this.root.classList.add("pbg-stage-ready");
		const loop = (now: number) => {
			this.tick(now);
			requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
	}
}

// ---------- entry ----------

export function initPalletGame(): void {
	const root = document.querySelector<HTMLElement>("[data-pallet-game]");
	if (!root) return;

	// ?api=http://localhost:8000 → play against your own clone. The API's
	// default ALLOWED_ORIGINS includes boothe.io, so a stock `docker compose
	// up` instance accepts these requests as-is.
	const override = new URLSearchParams(location.search).get("api");
	if (override && /^https?:\/\//.test(override)) {
		root.dataset.apiBase = override.replace(/\/+$/, "");
	}

	const game = new Game(root);
	void game.boot();

	// Load three.js when the stage approaches the viewport.
	const io = new IntersectionObserver(
		(entries) => {
			if (entries.some((e) => e.isIntersecting)) {
				io.disconnect();
				void game.initStage();
			}
		},
		{ rootMargin: "400px" },
	);
	io.observe(root);
}
