#!/usr/bin/env node
/**
 * Generate test STL fixtures for local development.
 *
 * Writes a few simple solids as binary STL files to public/stls/. Run with:
 *   node packages/plugins/stl-viewer/scripts/generate-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");
const OUT_DIR = join(PROJECT_ROOT, "public", "stls");

mkdirSync(OUT_DIR, { recursive: true });

// ─── Binary STL writer ───────────────────────────────────────────

function writeBinarySTL(triangles, outPath) {
	// 80-byte header + 4-byte triangle count + 50 bytes per triangle
	const size = 80 + 4 + triangles.length * 50;
	const buf = new ArrayBuffer(size);
	const view = new DataView(buf);
	view.setUint32(80, triangles.length, true);
	let offset = 84;
	for (const tri of triangles) {
		const [a, b, c] = tri;
		const n = computeNormal(a, b, c);
		view.setFloat32(offset, n[0], true);
		view.setFloat32(offset + 4, n[1], true);
		view.setFloat32(offset + 8, n[2], true);
		offset += 12;
		for (const v of [a, b, c]) {
			view.setFloat32(offset, v[0], true);
			view.setFloat32(offset + 4, v[1], true);
			view.setFloat32(offset + 8, v[2], true);
			offset += 12;
		}
		view.setUint16(offset, 0, true);
		offset += 2;
	}
	writeFileSync(outPath, Buffer.from(buf));
	console.log(`wrote ${outPath} (${size} bytes, ${triangles.length} triangles)`);
}

function computeNormal(a, b, c) {
	const ux = b[0] - a[0],
		uy = b[1] - a[1],
		uz = b[2] - a[2];
	const vx = c[0] - a[0],
		vy = c[1] - a[1],
		vz = c[2] - a[2];
	const nx = uy * vz - uz * vy;
	const ny = uz * vx - ux * vz;
	const nz = ux * vy - uy * vx;
	const len = Math.hypot(nx, ny, nz) || 1;
	return [nx / len, ny / len, nz / len];
}

// ─── Solids ──────────────────────────────────────────────────────

function cube(size = 20) {
	const h = size / 2;
	const v = [
		[-h, -h, -h],
		[h, -h, -h],
		[h, h, -h],
		[-h, h, -h],
		[-h, -h, h],
		[h, -h, h],
		[h, h, h],
		[-h, h, h],
	];
	const faces = [
		// bottom
		[0, 1, 2],
		[0, 2, 3],
		// top
		[4, 6, 5],
		[4, 7, 6],
		// front
		[0, 5, 1],
		[0, 4, 5],
		// back
		[3, 2, 6],
		[3, 6, 7],
		// left
		[0, 3, 7],
		[0, 7, 4],
		// right
		[1, 5, 6],
		[1, 6, 2],
	];
	return faces.map(([a, b, c]) => [v[a], v[b], v[c]]);
}

function icosahedron(radius = 15) {
	const t = (1 + Math.sqrt(5)) / 2;
	const verts = [
		[-1, t, 0],
		[1, t, 0],
		[-1, -t, 0],
		[1, -t, 0],
		[0, -1, t],
		[0, 1, t],
		[0, -1, -t],
		[0, 1, -t],
		[t, 0, -1],
		[t, 0, 1],
		[-t, 0, -1],
		[-t, 0, 1],
	].map((p) => {
		const l = Math.hypot(p[0], p[1], p[2]);
		return [(p[0] / l) * radius, (p[1] / l) * radius, (p[2] / l) * radius];
	});
	const faces = [
		[0, 11, 5],
		[0, 5, 1],
		[0, 1, 7],
		[0, 7, 10],
		[0, 10, 11],
		[1, 5, 9],
		[5, 11, 4],
		[11, 10, 2],
		[10, 7, 6],
		[7, 1, 8],
		[3, 9, 4],
		[3, 4, 2],
		[3, 2, 6],
		[3, 6, 8],
		[3, 8, 9],
		[4, 9, 5],
		[2, 4, 11],
		[6, 2, 10],
		[8, 6, 7],
		[9, 8, 1],
	];
	return faces.map(([a, b, c]) => [verts[a], verts[b], verts[c]]);
}

function torus(R = 18, r = 6, segMajor = 48, segMinor = 16) {
	const tris = [];
	for (let i = 0; i < segMajor; i++) {
		for (let j = 0; j < segMinor; j++) {
			const a0 = (i / segMajor) * Math.PI * 2;
			const a1 = ((i + 1) / segMajor) * Math.PI * 2;
			const b0 = (j / segMinor) * Math.PI * 2;
			const b1 = ((j + 1) / segMinor) * Math.PI * 2;
			const v = (a, b) => [
				(R + r * Math.cos(b)) * Math.cos(a),
				(R + r * Math.cos(b)) * Math.sin(a),
				r * Math.sin(b),
			];
			const p00 = v(a0, b0);
			const p10 = v(a1, b0);
			const p11 = v(a1, b1);
			const p01 = v(a0, b1);
			tris.push([p00, p10, p11]);
			tris.push([p00, p11, p01]);
		}
	}
	return tris;
}

// Knurled cylinder — looks like a printed knob/handle
function knurledCylinder(radius = 12, height = 24, segments = 64) {
	const tris = [];
	const halfH = height / 2;
	for (let i = 0; i < segments; i++) {
		const a0 = (i / segments) * Math.PI * 2;
		const a1 = ((i + 1) / segments) * Math.PI * 2;
		// alternate ribs (knurl) — modulate radius slightly
		const r0 = i % 2 === 0 ? radius : radius * 0.94;
		const r1 = (i + 1) % 2 === 0 ? radius : radius * 0.94;
		const p0b = [Math.cos(a0) * r0, -halfH, Math.sin(a0) * r0];
		const p1b = [Math.cos(a1) * r1, -halfH, Math.sin(a1) * r1];
		const p0t = [Math.cos(a0) * r0, halfH, Math.sin(a0) * r0];
		const p1t = [Math.cos(a1) * r1, halfH, Math.sin(a1) * r1];
		tris.push([p0b, p1b, p1t]);
		tris.push([p0b, p1t, p0t]);
		// caps
		tris.push([[0, -halfH, 0], p1b, p0b]);
		tris.push([[0, halfH, 0], p0t, p1t]);
	}
	return tris;
}

// ─── Generate ────────────────────────────────────────────────────

writeBinarySTL(cube(20), join(OUT_DIR, "cube.stl"));
writeBinarySTL(icosahedron(15), join(OUT_DIR, "icosahedron.stl"));
writeBinarySTL(torus(18, 6, 64, 24), join(OUT_DIR, "torus.stl"));
writeBinarySTL(knurledCylinder(12, 24, 96), join(OUT_DIR, "knurled.stl"));
