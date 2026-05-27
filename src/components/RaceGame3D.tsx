import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

const TOTAL_LAPS = 3;

// Circuit défini par une centerline (Catmull-Rom fermée) avec chicanes/virages
const TRACK_HALF_WIDTH = 34;
const TRACK_CONTROL: [number, number][] = [
  [-300, 0],
  [-260, -90],
  [-160, -160],
  [-30, -180],
  [90, -150],
  [140, -80], // chicane montée
  [200, -50], // chicane redescente
  [280, -80],
  [330, 0],
  [310, 80],
  [220, 140],
  [90, 110], // chicane haute (resserre)
  [-30, 160],
  [-160, 200],
  [-260, 170],
  [-320, 90],
];

const _trackCurve = new THREE.CatmullRomCurve3(
  TRACK_CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z)),
  true,
  "centripetal",
);
const TRACK_SAMPLES = 360;
const trackPoints: THREE.Vector3[] = [];
const trackTangents: THREE.Vector3[] = [];
for (let i = 0; i < TRACK_SAMPLES; i++) {
  const t = i / TRACK_SAMPLES;
  trackPoints.push(_trackCurve.getPoint(t));
  trackTangents.push(_trackCurve.getTangent(t).normalize());
}

// Hauteur de base de la route (surélevée par rapport à l'herbe)
const TRACK_RAISE = 8;
// Tremplins répartis le long du circuit
const RAMP_POSITIONS = [0.16, 0.48, 0.79];
const RAMP_HEIGHT = 8;
const RAMP_WIDTH = 0.025;
const GRAVITY = 65;
// Trou dans la route juste après chaque tremplin
const GAP_RANGES_T: [number, number][] = RAMP_POSITIONS.map((r) => [
  r + 0.024,
  r + 0.034,
]);
// Profil d'élévation : bosses, creux et tremplins
function heightAtT(t: number): number {
  const u = t * Math.PI * 2;
  let h =
    TRACK_RAISE +
    Math.sin(u * 3) * 4 +
    Math.sin(u * 7 + 1.3) * 1.6 +
    Math.sin(u * 11 + 2.7) * 0.7;
  for (const r of RAMP_POSITIONS) {
    let d = t - r;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    if (Math.abs(d) < RAMP_WIDTH) {
      h += RAMP_HEIGHT * 0.5 * (1 + Math.cos((d * Math.PI) / RAMP_WIDTH));
    }
  }
  return h;
}
const trackHeights: number[] = [];
const trackIsGap: boolean[] = [];
for (let i = 0; i < TRACK_SAMPLES; i++) {
  const t = i / TRACK_SAMPLES;
  trackHeights.push(heightAtT(t));
  let gap = false;
  for (const [a, b] of GAP_RANGES_T) {
    if (t >= a && t < b) {
      gap = true;
      break;
    }
  }
  trackIsGap.push(gap);
}

const VOID_Y = -200;

const TRACK_BOUND_X = Math.max(...trackPoints.map((p) => Math.abs(p.x))) + TRACK_HALF_WIDTH;
const TRACK_BOUND_Z = Math.max(...trackPoints.map((p) => Math.abs(p.z))) + TRACK_HALF_WIDTH;

// Second circuit (anneau ovale) + route de liaison — surélevés à TRACK_RAISE
const TRACK2_CX = -720;
const TRACK2_CZ = 0;
const TRACK2_RX = 220;
const TRACK2_RZ = 150;
const TRACK2_HW = 28;
const SECONDARY_SAMPLES = 240;
const secondaryTrackPoints: THREE.Vector3[] = [];
const secondaryTrackTangents: THREE.Vector3[] = [];
for (let i = 0; i < SECONDARY_SAMPLES; i++) {
  const t = (i / SECONDARY_SAMPLES) * Math.PI * 2;
  secondaryTrackPoints.push(
    new THREE.Vector3(
      TRACK2_CX + Math.cos(t) * TRACK2_RX,
      0,
      TRACK2_CZ + Math.sin(t) * TRACK2_RZ,
    ),
  );
  const tx = -Math.sin(t) * TRACK2_RX;
  const tz = Math.cos(t) * TRACK2_RZ;
  const len = Math.sqrt(tx * tx + tz * tz);
  secondaryTrackTangents.push(new THREE.Vector3(tx / len, 0, tz / len));
}

// Liaison : du point de la piste principale le plus proche de (-500, 0) jusqu'à l'est du second circuit
let _connMainIdx = 0;
let _connMainD2 = Infinity;
for (let i = 0; i < trackPoints.length; i++) {
  const dx = trackPoints[i].x + 500;
  const dz = trackPoints[i].z;
  const d2 = dx * dx + dz * dz;
  if (d2 < _connMainD2) {
    _connMainD2 = d2;
    _connMainIdx = i;
  }
}
const connMainP = trackPoints[_connMainIdx];
const connSecondP = new THREE.Vector3(TRACK2_CX + TRACK2_RX, 0, 0);
const LINK_HALF_WIDTH = 12;
const _linkDX = connSecondP.x - connMainP.x;
const _linkDZ = connSecondP.z - connMainP.z;
const LINK_LEN = Math.sqrt(_linkDX * _linkDX + _linkDZ * _linkDZ);
const LINK_DIR_X = _linkDX / LINK_LEN;
const LINK_DIR_Z = _linkDZ / LINK_LEN;
const LINK_ANGLE = Math.atan2(_linkDZ, _linkDX);

function onLink(x: number, z: number): boolean {
  const rx = x - connMainP.x;
  const rz = z - connMainP.z;
  const along = rx * LINK_DIR_X + rz * LINK_DIR_Z;
  if (along < 0 || along > LINK_LEN) return false;
  const perp = rx * -LINK_DIR_Z + rz * LINK_DIR_X;
  return Math.abs(perp) < LINK_HALF_WIDTH;
}

function nearestSampleIndex(x: number, z: number): number {
  let bestI = 0;
  let minD2 = Infinity;
  for (let i = 0; i < trackPoints.length; i++) {
    const p = trackPoints[i];
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < minD2) {
      minD2 = d2;
      bestI = i;
    }
  }
  return bestI;
}

function nearestSecondaryIndex(x: number, z: number): number {
  let bestI = 0;
  let minD2 = Infinity;
  for (let i = 0; i < secondaryTrackPoints.length; i++) {
    const p = secondaryTrackPoints[i];
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < minD2) {
      minD2 = d2;
      bestI = i;
    }
  }
  return bestI;
}

function onTrack(x: number, z: number) {
  const r2 = TRACK_HALF_WIDTH * TRACK_HALF_WIDTH;
  for (let i = 0; i < trackPoints.length; i++) {
    const p = trackPoints[i];
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < r2) return true;
  }
  if (onLink(x, z)) return true;
  const r2b = TRACK2_HW * TRACK2_HW;
  for (let i = 0; i < secondaryTrackPoints.length; i++) {
    const p = secondaryTrackPoints[i];
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < r2b) return true;
  }
  return false;
}

// Hauteur de la piste à une position : prend le bon référentiel (principale, liaison ou seconde)
function surfaceHeight(x: number, z: number): number {
  // Priorité piste principale
  const mainI = nearestSampleIndex(x, z);
  const p = trackPoints[mainI];
  const dxM = p.x - x;
  const dzM = p.z - z;
  if (dxM * dxM + dzM * dzM < TRACK_HALF_WIDTH * TRACK_HALF_WIDTH) {
    return trackIsGap[mainI] ? VOID_Y : trackHeights[mainI];
  }
  if (onLink(x, z)) return TRACK_RAISE;
  const secI = nearestSecondaryIndex(x, z);
  const ps = secondaryTrackPoints[secI];
  const dxS = ps.x - x;
  const dzS = ps.z - z;
  if (dxS * dxS + dzS * dzS < TRACK2_HW * TRACK2_HW) return TRACK_RAISE;
  return VOID_Y;
}

// Position de départ : sur la centerline au point 0, voitures décalées perpendiculairement
const _startP = trackPoints[0];
const _startT = trackTangents[0];
const START_ANGLE = Math.atan2(_startT.z, _startT.x);
const _perpX = -_startT.z;
const _perpZ = _startT.x;
const _startY = trackHeights[0];
const CAR1_START = new THREE.Vector3(_startP.x + _perpX * 6, _startY, _startP.z + _perpZ * 6);
const CAR2_START = new THREE.Vector3(_startP.x - _perpX * 6, _startY, _startP.z - _perpZ * 6);

type CarState = {
  pos: THREE.Vector3;
  vy: number; // vitesse verticale (sauts)
  prevTargetY: number; // hauteur piste à la frame précédente
  lastSafeIdx: number; // dernier index de piste avec sol valide
  angle: number; // yaw, radians
  speed: number;
  lap: number;
  checkpoint: number;
  name: string;
};

function makeCarMesh(color: number) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.7, roughness: 0.25 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, metalness: 0.4, roughness: 0.6 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x223344,
    metalness: 0.2,
    roughness: 0.05,
    transparent: true,
    opacity: 0.55,
  });
  const headlightMat = new THREE.MeshStandardMaterial({
    color: 0xfff6c0,
    emissive: 0xfff2a0,
    emissiveIntensity: 0.8,
  });
  const taillightMat = new THREE.MeshStandardMaterial({
    color: 0xff3020,
    emissive: 0xff1010,
    emissiveIntensity: 0.7,
  });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xbfc4cc, metalness: 1, roughness: 0.25 });

  // Châssis bas (plateforme)
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.35, 1.85), bodyMat);
  chassis.position.y = 0.5;
  chassis.castShadow = true;
  group.add(chassis);

  // Capot avant (un peu plus bas)
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 1.75), bodyMat);
  hood.position.set(1.0, 0.95, 0);
  hood.castShadow = true;
  group.add(hood);

  // Coffre arrière
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 1.75), bodyMat);
  trunk.position.set(-1.25, 0.97, 0);
  trunk.castShadow = true;
  group.add(trunk);

  // Habitacle (toit)
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.5), bodyMat);
  roof.position.set(-0.15, 1.55, 0);
  roof.castShadow = true;
  group.add(roof);

  // Pare-brise incliné (avant)
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 1.45), glassMat);
  windshield.position.set(0.55, 1.4, 0);
  windshield.rotation.z = Math.PI / 5;
  group.add(windshield);

  // Lunette arrière inclinée
  const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.65, 1.45), glassMat);
  rearGlass.position.set(-0.85, 1.4, 0);
  rearGlass.rotation.z = -Math.PI / 5;
  group.add(rearGlass);

  // Vitres latérales
  const sideGlassGeo = new THREE.BoxGeometry(1.3, 0.4, 0.05);
  const sideL = new THREE.Mesh(sideGlassGeo, glassMat);
  sideL.position.set(-0.15, 1.55, 0.78);
  group.add(sideL);
  const sideR = new THREE.Mesh(sideGlassGeo, glassMat);
  sideR.position.set(-0.15, 1.55, -0.78);
  group.add(sideR);

  // Phares avant
  const headlightGeo = new THREE.BoxGeometry(0.08, 0.22, 0.35);
  [0.55, -0.55].forEach((z) => {
    const h = new THREE.Mesh(headlightGeo, headlightMat);
    h.position.set(1.66, 0.85, z);
    group.add(h);
  });

  // Feux arrière
  const taillightGeo = new THREE.BoxGeometry(0.08, 0.2, 0.45);
  [0.55, -0.55].forEach((z) => {
    const t = new THREE.Mesh(taillightGeo, taillightMat);
    t.position.set(-1.71, 0.95, z);
    group.add(t);
  });

  // Calandre / pare-chocs avant
  const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.25, 1.6), darkMat);
  frontBumper.position.set(1.7, 0.55, 0);
  group.add(frontBumper);

  // Pare-chocs arrière
  const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.25, 1.6), darkMat);
  rearBumper.position.set(-1.7, 0.55, 0);
  group.add(rearBumper);

  // Becquet arrière
  const spoilerLeg = new THREE.BoxGeometry(0.08, 0.3, 0.08);
  const spoilerL = new THREE.Mesh(spoilerLeg, darkMat);
  spoilerL.position.set(-1.55, 1.3, 0.55);
  group.add(spoilerL);
  const spoilerR = new THREE.Mesh(spoilerLeg, darkMat);
  spoilerR.position.set(-1.55, 1.3, -0.55);
  group.add(spoilerR);
  const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 1.4), bodyMat);
  spoilerWing.position.set(-1.55, 1.5, 0);
  group.add(spoilerWing);

  // Rétroviseurs
  const mirrorGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
  [0.85, -0.85].forEach((z) => {
    const m = new THREE.Mesh(mirrorGeo, bodyMat);
    m.position.set(0.4, 1.35, z);
    group.add(m);
  });

  // Roues avec jantes
  const tireGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 20);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95 });
  const rimGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.42, 16);
  const wheelPositions: [number, number, number][] = [
    [1.15, 0.5, 0.95],
    [1.15, 0.5, -0.95],
    [-1.15, 0.5, 0.95],
    [-1.15, 0.5, -0.95],
  ];
  wheelPositions.forEach(([x, y, z]) => {
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.rotation.x = Math.PI / 2;
    tire.position.set(x, y, z);
    tire.castShadow = true;
    group.add(tire);

    const rim = new THREE.Mesh(rimGeo, chromeMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(x, y, z);
    group.add(rim);
  });

  return group;
}

type Pebble = {
  x: number;
  y: number;
  z: number;
  size: number;
  index: number;
  cooldown: number; // secondes restantes avant de pouvoir être heurté à nouveau
};

function buildTrackMeshes(scene: THREE.Scene): {
  pebbles: THREE.InstancedMesh;
  pebbleData: Pebble[];
} {
  const pebbleData: Pebble[] = [];
  // Grass
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 1600),
    new THREE.MeshStandardMaterial({ color: 0x4a7c3a, roughness: 1 }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  scene.add(grass);

  // Ruban de piste construit à partir de la centerline
  const N = trackPoints.length;
  const trackPositions: number[] = [];
  const trackIndices: number[] = [];
  for (let i = 0; i < N; i++) {
    const p = trackPoints[i];
    const t = trackTangents[i];
    const nx = -t.z;
    const nz = t.x;
    const y = trackHeights[i] + 0.01;
    trackPositions.push(
      p.x + nx * TRACK_HALF_WIDTH,
      y,
      p.z + nz * TRACK_HALF_WIDTH,
    );
    trackPositions.push(
      p.x - nx * TRACK_HALF_WIDTH,
      y,
      p.z - nz * TRACK_HALF_WIDTH,
    );
  }
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    if (trackIsGap[i] || trackIsGap[next]) continue;
    const a = i * 2;
    const b = i * 2 + 1;
    const c = next * 2;
    const d = next * 2 + 1;
    trackIndices.push(a, c, b, b, c, d);
  }
  const trackGeo = new THREE.BufferGeometry();
  trackGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(trackPositions, 3),
  );
  trackGeo.setIndex(trackIndices);
  trackGeo.computeVertexNormals();
  const track = new THREE.Mesh(
    trackGeo,
    new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.85, side: THREE.DoubleSide }),
  );
  track.receiveShadow = true;
  scene.add(track);

  // Talus latéraux : descendent du bord de la route au sol
  const GROUND_Y = -0.3;
  const sideMat = new THREE.MeshStandardMaterial({
    color: 0x4a3a2a,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  for (const side of [+1, -1] as const) {
    const sidePositions: number[] = [];
    const sideIndices: number[] = [];
    for (let i = 0; i < N; i++) {
      const p = trackPoints[i];
      const tg = trackTangents[i];
      const nx = -tg.z;
      const nz = tg.x;
      const ex = p.x + nx * TRACK_HALF_WIDTH * side;
      const ez = p.z + nz * TRACK_HALF_WIDTH * side;
      sidePositions.push(ex, trackHeights[i], ez); // bord haut
      sidePositions.push(ex, GROUND_Y, ez); // bord bas
    }
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      if (trackIsGap[i] || trackIsGap[next]) continue;
      const a = i * 2;
      const b = i * 2 + 1;
      const c = next * 2;
      const d = next * 2 + 1;
      sideIndices.push(a, c, b, b, c, d);
    }
    const sideGeo = new THREE.BufferGeometry();
    sideGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(sidePositions, 3),
    );
    sideGeo.setIndex(sideIndices);
    sideGeo.computeVertexNormals();
    const wall = new THREE.Mesh(sideGeo, sideMat);
    wall.receiveShadow = true;
    wall.castShadow = true;
    scene.add(wall);
  }

  // Cailloux dispersés sur la chaussée (interactifs)
  const pebbleGeo = new THREE.DodecahedronGeometry(1, 0);
  const pebbleMat = new THREE.MeshStandardMaterial({
    color: 0x9a948a,
    roughness: 0.95,
    flatShading: true,
  });
  const PEBBLE_COUNT = 20;
  const pebbles = new THREE.InstancedMesh(pebbleGeo, pebbleMat, PEBBLE_COUNT);
  pebbles.receiveShadow = true;
  pebbles.castShadow = true;
  const _dummy = new THREE.Object3D();
  let placed = 0;
  for (let attempt = 0; attempt < PEBBLE_COUNT * 8 && placed < PEBBLE_COUNT; attempt++) {
    const i = Math.floor(Math.random() * TRACK_SAMPLES);
    if (trackIsGap[i]) continue;
    const p = trackPoints[i];
    const tg = trackTangents[i];
    const nx = -tg.z;
    const nz = tg.x;
    const offset = (Math.random() - 0.5) * 2 * (TRACK_HALF_WIDTH - 3);
    const size = 2.0 + Math.random() * 1.6;
    const px = p.x + nx * offset;
    const pz = p.z + nz * offset;
    const py = trackHeights[i] + size * 0.3;
    _dummy.position.set(px, py, pz);
    _dummy.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI,
    );
    _dummy.scale.setScalar(size);
    _dummy.updateMatrix();
    pebbles.setMatrixAt(placed, _dummy.matrix);
    pebbleData.push({
      x: px,
      y: py,
      z: pz,
      size,
      index: placed,
      cooldown: 0,
    });
    placed++;
  }
  pebbles.count = placed;
  scene.add(pebbles);

  // Bordures (rouge/blanc alternées en virages serrés)
  const kerbMat1 = new THREE.MeshStandardMaterial({ color: 0xdd2233, roughness: 0.7 });
  const kerbMat2 = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
  const kerbGeo = new THREE.BoxGeometry(2.2, 0.08, 1.4);
  for (let i = 0; i < N; i += 3) {
    if (trackIsGap[i]) continue;
    const p = trackPoints[i];
    const tg = trackTangents[i];
    const nx = -tg.z;
    const nz = tg.x;
    const mat = (i / 3) % 2 === 0 ? kerbMat1 : kerbMat2;
    const ky = trackHeights[i] + 0.05;
    const left = new THREE.Mesh(kerbGeo, mat);
    left.position.set(p.x + nx * (TRACK_HALF_WIDTH + 1), ky, p.z + nz * (TRACK_HALF_WIDTH + 1));
    left.rotation.y = -Math.atan2(tg.z, tg.x);
    scene.add(left);
    const right = new THREE.Mesh(kerbGeo, mat);
    right.position.set(p.x - nx * (TRACK_HALF_WIDTH + 1), ky, p.z - nz * (TRACK_HALF_WIDTH + 1));
    right.rotation.y = -Math.atan2(tg.z, tg.x);
    scene.add(right);
  }

  // Lignes centrales pointillées
  const dashGeo = new THREE.BoxGeometry(3, 0.05, 0.6);
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = 0; i < N; i += 6) {
    if (Math.floor(i / 6) % 2 !== 0) continue;
    if (trackIsGap[i]) continue;
    const p = trackPoints[i];
    const tg = trackTangents[i];
    const m = new THREE.Mesh(dashGeo, dashMat);
    m.position.set(p.x, trackHeights[i] + 0.03, p.z);
    m.rotation.y = -Math.atan2(tg.z, tg.x);
    scene.add(m);
  }

  // Ligne de départ/arrivée (damier) au point 0 de la piste
  const startGroup = new THREE.Group();
  startGroup.position.set(_startP.x, trackHeights[0] + 0.02, _startP.z);
  startGroup.rotation.y = -START_ANGLE;
  const rows = 2;
  const cols = 12;
  const tileZ = (TRACK_HALF_WIDTH * 2) / cols;
  const tileX = 1.2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(tileX, 0.05, tileZ),
        new THREE.MeshBasicMaterial({ color: (r + c) % 2 === 0 ? 0xffffff : 0x111111 }),
      );
      tile.position.set(-tileX / 2 + r * tileX, 0, -TRACK_HALF_WIDTH + (c + 0.5) * tileZ);
      startGroup.add(tile);
    }
  }
  scene.add(startGroup);

  // Second circuit surélevé, à l'ouest du circuit principal
  const track2Mat = new THREE.MeshStandardMaterial({
    color: 0x363640,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  const track2Positions: number[] = [];
  const track2Indices: number[] = [];
  const N2 = secondaryTrackPoints.length;
  for (let i = 0; i < N2; i++) {
    const p = secondaryTrackPoints[i];
    const tg = secondaryTrackTangents[i];
    const nx = -tg.z;
    const nz = tg.x;
    track2Positions.push(
      p.x + nx * TRACK2_HW,
      TRACK_RAISE + 0.01,
      p.z + nz * TRACK2_HW,
    );
    track2Positions.push(
      p.x - nx * TRACK2_HW,
      TRACK_RAISE + 0.01,
      p.z - nz * TRACK2_HW,
    );
  }
  for (let i = 0; i < N2; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = ((i + 1) % N2) * 2;
    const d = ((i + 1) % N2) * 2 + 1;
    track2Indices.push(a, c, b, b, c, d);
  }
  const track2Geo = new THREE.BufferGeometry();
  track2Geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(track2Positions, 3),
  );
  track2Geo.setIndex(track2Indices);
  track2Geo.computeVertexNormals();
  const track2 = new THREE.Mesh(track2Geo, track2Mat);
  track2.receiveShadow = true;
  scene.add(track2);

  // Talus du second circuit
  for (const side of [+1, -1] as const) {
    const s2Pos: number[] = [];
    const s2Idx: number[] = [];
    for (let i = 0; i < N2; i++) {
      const p = secondaryTrackPoints[i];
      const tg = secondaryTrackTangents[i];
      const nx = -tg.z;
      const nz = tg.x;
      const ex = p.x + nx * TRACK2_HW * side;
      const ez = p.z + nz * TRACK2_HW * side;
      s2Pos.push(ex, TRACK_RAISE, ez);
      s2Pos.push(ex, GROUND_Y, ez);
    }
    for (let i = 0; i < N2; i++) {
      const next = (i + 1) % N2;
      const a = i * 2;
      const b = i * 2 + 1;
      const c = next * 2;
      const d = next * 2 + 1;
      s2Idx.push(a, c, b, b, c, d);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(s2Pos, 3));
    sg.setIndex(s2Idx);
    sg.computeVertexNormals();
    const wall = new THREE.Mesh(sg, sideMat);
    wall.receiveShadow = true;
    wall.castShadow = true;
    scene.add(wall);
  }

  // Pointillés centraux sur le second circuit
  const track2DashGeo = new THREE.BoxGeometry(3, 0.05, 0.6);
  const track2DashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = 0; i < N2; i += 8) {
    if (Math.floor(i / 8) % 2 !== 0) continue;
    const p = secondaryTrackPoints[i];
    const tg = secondaryTrackTangents[i];
    const dash = new THREE.Mesh(track2DashGeo, track2DashMat);
    dash.position.set(p.x, TRACK_RAISE + 0.03, p.z);
    dash.rotation.y = -Math.atan2(tg.z, tg.x);
    scene.add(dash);
  }

  // Route de liaison surélevée
  const link = new THREE.Mesh(
    new THREE.PlaneGeometry(LINK_LEN, LINK_HALF_WIDTH * 2),
    track2Mat,
  );
  link.rotation.x = -Math.PI / 2;
  link.rotation.z = -LINK_ANGLE;
  link.position.set(
    connMainP.x + (connSecondP.x - connMainP.x) / 2,
    TRACK_RAISE + 0.02,
    connMainP.z + (connSecondP.z - connMainP.z) / 2,
  );
  link.receiveShadow = true;
  scene.add(link);

  // Talus de la liaison (côtés et bouts)
  const linkPerpX = -LINK_DIR_Z;
  const linkPerpZ = LINK_DIR_X;
  for (const side of [+1, -1] as const) {
    const lPos: number[] = [];
    const lIdx: number[] = [];
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = connMainP.x + (connSecondP.x - connMainP.x) * t;
      const cz = connMainP.z + (connSecondP.z - connMainP.z) * t;
      const ex = cx + linkPerpX * LINK_HALF_WIDTH * side;
      const ez = cz + linkPerpZ * LINK_HALF_WIDTH * side;
      const topY = TRACK_RAISE;
      lPos.push(ex, topY, ez);
      lPos.push(ex, GROUND_Y, ez);
    }
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      lIdx.push(a, c, b, b, c, d);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lPos, 3));
    lg.setIndex(lIdx);
    lg.computeVertexNormals();
    const lwall = new THREE.Mesh(lg, sideMat);
    lwall.receiveShadow = true;
    lwall.castShadow = true;
    scene.add(lwall);
  }

  // Bassins d'eau et cailloux sous chaque trou
  const gapWaterMat = new THREE.MeshStandardMaterial({
    color: 0x2a6fc8,
    roughness: 0.15,
    metalness: 0.45,
  });
  const gapSandMat = new THREE.MeshStandardMaterial({ color: 0x8a7050, roughness: 1 });
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x6d6d72,
    roughness: 0.9,
    flatShading: true,
  });
  for (const [ga, gb] of GAP_RANGES_T) {
    const tMid = (ga + gb) / 2;
    const idx = Math.floor(tMid * TRACK_SAMPLES) % TRACK_SAMPLES;
    const center = trackPoints[idx];

    const water = new THREE.Mesh(new THREE.CircleGeometry(14, 40), gapWaterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(center.x, 0.12, center.z);
    water.receiveShadow = true;
    scene.add(water);

    const bank = new THREE.Mesh(
      new THREE.RingGeometry(14, 16.5, 40),
      gapSandMat,
    );
    bank.rotation.x = -Math.PI / 2;
    bank.position.set(center.x, 0.1, center.z);
    scene.add(bank);

    // Cailloux : quelques-uns émergeant de l'eau, d'autres sur la berge
    for (let r = 0; r < 8; r++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * 15.5;
      const size = 0.7 + Math.random() * 1.7;
      const inWater = dist < 13;
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(size, 0),
        rockMat,
      );
      rock.position.set(
        center.x + Math.cos(ang) * dist,
        inWater ? size * 0.25 : size * 0.5,
        center.z + Math.sin(ang) * dist,
      );
      rock.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI,
      );
      rock.castShadow = true;
      rock.receiveShadow = true;
      scene.add(rock);
    }
  }

  // Montagnes lointaines (anneau autour de la scène)
  const mountainMat = new THREE.MeshStandardMaterial({
    color: 0x6a7a8a,
    roughness: 1,
    flatShading: true,
  });
  const snowMat = new THREE.MeshStandardMaterial({
    color: 0xf2f4f8,
    roughness: 1,
    flatShading: true,
  });
  const ringRadius = 1100;
  const mountainCount = 64;
  for (let i = 0; i < mountainCount; i++) {
    const angle = (i / mountainCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
    const r = ringRadius + (Math.random() - 0.5) * 80;
    const mx = Math.cos(angle) * r;
    const mz = Math.sin(angle) * r;
    const height = 60 + Math.random() * 70;
    const radius = 35 + Math.random() * 25;
    const segs = 6 + Math.floor(Math.random() * 3);

    const mountain = new THREE.Mesh(new THREE.ConeGeometry(radius, height, segs), mountainMat);
    mountain.position.set(mx, height / 2 - 2, mz);
    mountain.rotation.y = Math.random() * Math.PI;
    mountain.receiveShadow = true;
    scene.add(mountain);

    // Sommet enneigé
    const snowH = height * 0.28;
    const snowR = radius * 0.32;
    const snow = new THREE.Mesh(new THREE.ConeGeometry(snowR, snowH, segs), snowMat);
    snow.position.set(mx, height - snowH / 2 - 2, mz);
    snow.rotation.y = mountain.rotation.y;
    scene.add(snow);
  }

  // Some decorative trees
  const trunkGeo = new THREE.CylinderGeometry(0.6, 0.8, 3, 8);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a20 });
  const leafGeo = new THREE.ConeGeometry(3, 6, 10);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e6b2a });
  for (let i = 0; i < 200; i++) {
    const tx = (Math.random() - 0.5) * 2000;
    const tz = (Math.random() - 0.5) * 1400;
    // keep trees off the main track
    if (Math.abs(tx) < TRACK_BOUND_X + 15 && Math.abs(tz) < TRACK_BOUND_Z + 15) continue;
    // keep trees off the secondary track
    if (
      tx > TRACK2_CX - TRACK2_RX - 20 &&
      tx < TRACK2_CX + TRACK2_RX + 20 &&
      tz > TRACK2_CZ - TRACK2_RZ - 20 &&
      tz < TRACK2_CZ + TRACK2_RZ + 20
    )
      continue;
    // keep trees off the connector
    if (
      tx > connMainP.x &&
      tx < connSecondP.x &&
      Math.abs(tz - connMainP.z) < 18
    )
      continue;
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    const leaves = new THREE.Mesh(leafGeo, leafMat);
    trunk.position.set(tx, 1.5, tz);
    leaves.position.set(tx, 6, tz);
    trunk.castShadow = true;
    leaves.castShadow = true;
    scene.add(trunk);
    scene.add(leaves);
  }

  // Lac au centre du circuit
  const LAKE_X = 0;
  const LAKE_Z = 20;
  let nearestTrackDist = Infinity;
  for (const p of trackPoints) {
    const dx = p.x - LAKE_X;
    const dz = p.z - LAKE_Z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < nearestTrackDist) nearestTrackDist = d;
  }
  const LAKE_R = Math.max(15, nearestTrackDist - TRACK_HALF_WIDTH - 10);

  const lake = new THREE.Mesh(
    new THREE.CircleGeometry(LAKE_R, 64),
    new THREE.MeshStandardMaterial({
      color: 0x2a6fc8,
      roughness: 0.15,
      metalness: 0.4,
    }),
  );
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(LAKE_X, 0.06, LAKE_Z);
  lake.receiveShadow = true;
  scene.add(lake);

  // Berge sablonneuse autour du lac
  const lakeBorder = new THREE.Mesh(
    new THREE.RingGeometry(LAKE_R, LAKE_R + 2.5, 64),
    new THREE.MeshStandardMaterial({ color: 0xc9b078, roughness: 1 }),
  );
  lakeBorder.rotation.x = -Math.PI / 2;
  lakeBorder.position.set(LAKE_X, 0.05, LAKE_Z);
  scene.add(lakeBorder);

  // Arbres à l'intérieur du circuit (autour du lac)
  function pointInTrackLoop(x: number, z: number): boolean {
    let inside = false;
    for (let i = 0, j = trackPoints.length - 1; i < trackPoints.length; j = i++) {
      const pi = trackPoints[i];
      const pj = trackPoints[j];
      if ((pi.z > z) !== (pj.z > z)) {
        const xIntersect = ((pj.x - pi.x) * (z - pi.z)) / (pj.z - pi.z) + pi.x;
        if (x < xIntersect) inside = !inside;
      }
    }
    return inside;
  }
  function tooCloseToTrack(x: number, z: number, extra: number): boolean {
    const r2 = (TRACK_HALF_WIDTH + extra) ** 2;
    for (const p of trackPoints) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }
  for (let i = 0; i < 350; i++) {
    const tx = (Math.random() - 0.5) * TRACK_BOUND_X * 2;
    const tz = (Math.random() - 0.5) * TRACK_BOUND_Z * 2;
    if (!pointInTrackLoop(tx, tz)) continue;
    if (tooCloseToTrack(tx, tz, 4)) continue;
    const dxL = tx - LAKE_X;
    const dzL = tz - LAKE_Z;
    if (dxL * dxL + dzL * dzL < (LAKE_R + 4) ** 2) continue;
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    const leaves = new THREE.Mesh(leafGeo, leafMat);
    trunk.position.set(tx, 1.5, tz);
    leaves.position.set(tx, 6, tz);
    trunk.castShadow = true;
    leaves.castShadow = true;
    scene.add(trunk);
    scene.add(leaves);
  }

  return { pebbles, pebbleData };
}

const MINIMAP_PATH =
  trackPoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.z.toFixed(1)}`)
    .join(" ") + " Z";

const _startNX = -_startT.z;
const _startNZ = _startT.x;

function MiniMap({ cars, highlight }: { cars: CarState[]; highlight: 0 | 1 }) {
  const pad = TRACK_HALF_WIDTH + 10;
  const vbX = -TRACK_BOUND_X - pad;
  const vbY = -TRACK_BOUND_Z - pad;
  const vbW = (TRACK_BOUND_X + pad) * 2;
  const vbH = (TRACK_BOUND_Z + pad) * 2;
  const colors = ["#e04030", "#3a8bff"];
  return (
    <svg
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      className="w-32 h-20 md:w-40 md:h-24 block"
      aria-hidden
    >
      <path
        d={MINIMAP_PATH}
        stroke="#2a2a30"
        strokeWidth={TRACK_HALF_WIDTH * 2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d={MINIMAP_PATH}
        stroke="#ffffff90"
        strokeWidth={2}
        strokeDasharray="6 6"
        fill="none"
      />
      {/* ligne de départ */}
      <line
        x1={_startP.x + _startNX * TRACK_HALF_WIDTH}
        y1={_startP.z + _startNZ * TRACK_HALF_WIDTH}
        x2={_startP.x - _startNX * TRACK_HALF_WIDTH}
        y2={_startP.z - _startNZ * TRACK_HALF_WIDTH}
        stroke="#ffffff"
        strokeWidth={5}
      />
      {cars.map((car, i) => {
        const isMe = i === highlight;
        return (
          <circle
            key={i}
            cx={car.pos.x}
            cy={car.pos.z}
            r={isMe ? 14 : 10}
            fill={colors[i]}
            stroke="#ffffff"
            strokeWidth={isMe ? 3 : 2}
          />
        );
      })}
    </svg>
  );
}

export default function RaceGame3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const carsRef = useRef<CarState[]>([
    {
      pos: CAR1_START.clone(),
      vy: 0,
      prevTargetY: _startY,
      lastSafeIdx: 0,
      angle: START_ANGLE,
      speed: 0,
      lap: 0,
      checkpoint: 0,
      name: "P1",
    },
    {
      pos: CAR2_START.clone(),
      vy: 0,
      prevTargetY: _startY,
      lastSafeIdx: 0,
      angle: START_ANGLE,
      speed: 0,
      lap: 0,
      checkpoint: 0,
      name: "P2",
    },
  ]);
  const [tick, setTick] = useState(0);
  const [winner, setWinner] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);

  const reset = useCallback(() => {
    carsRef.current = [
      {
        pos: CAR1_START.clone(),
        vy: 0,
        prevTargetY: _startY,
        lastSafeIdx: 0,
        angle: START_ANGLE,
        speed: 0,
        lap: 0,
        checkpoint: 0,
        name: "P1",
      },
      {
        pos: CAR2_START.clone(),
        vy: 0,
        prevTargetY: _startY,
        lastSafeIdx: 0,
        angle: START_ANGLE,
        speed: 0,
        lap: 0,
        checkpoint: 0,
        name: "P2",
      },
    ];
    setWinner(null);
    setRunning(false);
    setCountdown(3);
  }, []);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setRunning(true);
      setCountdown(null);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c ?? 1) - 1), 800);
    return () => clearTimeout(t);
  }, [countdown]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keysRef.current[e.key.toLowerCase()] = true;
      if (
        ["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(
          e.key.toLowerCase(),
        )
      ) {
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      keysRef.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      setGpuError("WebGL n'est pas disponible dans ce navigateur.");
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x87ceeb);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x87ceeb, 400, 1500);

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x556633, 0.7);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(120, 180, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -450;
    sun.shadow.camera.right = 450;
    sun.shadow.camera.top = 450;
    sun.shadow.camera.bottom = -450;
    scene.add(sun);

    const { pebbleData } = buildTrackMeshes(scene);

    // Particules d'explosion
    type Particle = {
      mesh: THREE.Mesh;
      mat: THREE.MeshStandardMaterial;
      vx: number;
      vy: number;
      vz: number;
      life: number;
      maxLife: number;
    };
    const particles: Particle[] = [];
    const particleGeo = new THREE.IcosahedronGeometry(0.35, 0);
    const spawnExplosion = (x: number, y: number, z: number) => {
      const count = 16;
      for (let i = 0; i < count; i++) {
        const r = Math.random();
        const color = r < 0.45 ? 0xff7a20 : r < 0.8 ? 0xffd040 : 0x504030;
        const mat = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.9,
          transparent: true,
          opacity: 1,
        });
        const mesh = new THREE.Mesh(particleGeo, mat);
        mesh.position.set(x, y, z);
        mesh.scale.setScalar(0.6 + Math.random() * 0.9);
        const phi = Math.random() * Math.PI * 2;
        const theta = Math.random() * Math.PI * 0.45;
        const speed = 8 + Math.random() * 14;
        const vx = Math.cos(phi) * Math.cos(theta) * speed;
        const vz = Math.sin(phi) * Math.cos(theta) * speed;
        const vy = Math.sin(theta) * speed + 4;
        scene.add(mesh);
        const life = 0.7 + Math.random() * 0.5;
        particles.push({ mesh, mat, vx, vy, vz, life, maxLife: life });
      }
    };

    const car1Mesh = makeCarMesh(0xe04030);
    const car2Mesh = makeCarMesh(0x3a8bff);
    scene.add(car1Mesh);
    scene.add(car2Mesh);
    const carMeshes = [car1Mesh, car2Mesh];

    const cam1 = new THREE.PerspectiveCamera(65, 1, 0.1, 1900);
    const cam2 = new THREE.PerspectiveCamera(65, 1, 0.1, 1900);
    const cams = [cam1, cam2];

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      // split horizontally if wide, vertically if tall
      const split = w >= h ? "h" : "v";
      cams.forEach((c) => {
        c.aspect = split === "h" ? w / 2 / h : w / (h / 2);
        c.updateProjectionMatrix();
      });
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    let last = performance.now();
    const clock = new THREE.Clock();

    const update = (dt: number) => {
      const cars = carsRef.current;
      if (!running || winner) return;

      const controls = [
        { up: ["z", "w"], down: ["s"], left: ["q", "a"], right: ["d"] },
        { up: ["arrowup"], down: ["arrowdown"], left: ["arrowleft"], right: ["arrowright"] },
      ];

      cars.forEach((car, i) => {
        const k = keysRef.current;
        const c = controls[i];
        const any = (arr: string[]) => arr.some((x) => k[x]);
        let accel = 0;
        let turn = 0;
        if (any(c.up)) accel = 1;
        if (any(c.down)) accel = -1;
        if (any(c.left)) turn = -1;
        if (any(c.right)) turn = 1;

        const maxSpeed = 90;
        const accelRate = 55;
        const brakeRate = 75;
        const friction = 18;

        if (accel > 0) car.speed = Math.min(maxSpeed, car.speed + accelRate * dt);
        else if (accel < 0) car.speed = Math.max(-maxSpeed * 0.4, car.speed - brakeRate * dt);
        else {
          if (car.speed > 0) car.speed = Math.max(0, car.speed - friction * dt);
          else car.speed = Math.min(0, car.speed + friction * dt);
        }

        const turnRate = 1.8 * (car.speed / maxSpeed);
        car.angle += turn * turnRate * dt;

        // In 3D: forward is +x in car local; rotate around Y
        const fx = Math.cos(car.angle);
        const fz = Math.sin(car.angle);
        const nx = car.pos.x + fx * car.speed * dt;
        const nz = car.pos.z + fz * car.speed * dt;

        if (onTrack(nx, nz)) {
          car.pos.x = nx;
          car.pos.z = nz;
        } else {
          const sx = car.pos.x + fx * car.speed * dt * 0.25;
          const sz = car.pos.z + fz * car.speed * dt * 0.25;
          if (onTrack(sx, sz)) {
            car.pos.x = sx;
            car.pos.z = sz;
          }
          car.speed *= 0.82;
        }
        // Physique verticale : gravité + tremplins + trous + surfaces multiples
        const nearI = nearestSampleIndex(car.pos.x, car.pos.z);
        const targetY = surfaceHeight(car.pos.x, car.pos.z);
        const overGap = targetY === VOID_Y;
        const safeRoadRate = overGap
          ? 0
          : (targetY - car.prevTargetY) / Math.max(dt, 1e-4);
        car.prevTargetY = overGap ? car.prevTargetY : targetY;

        car.vy -= GRAVITY * dt;
        car.pos.y += car.vy * dt;

        if (car.pos.y <= targetY) {
          car.pos.y = targetY;
          // Seules les pentes raides (rampes) chargent vy ; les bosses sont absorbées
          const LAUNCH_THRESHOLD = 14;
          const launchVy = Math.max(0, safeRoadRate - LAUNCH_THRESHOLD);
          if (car.vy < launchVy) car.vy = launchVy;
          if (!overGap) car.lastSafeIdx = nearI;
        }

        // Collisions avec les cailloux (uniquement si la voiture est près du sol)
        if (car.pos.y - targetY < 1.2) {
          for (let pi = 0; pi < pebbleData.length; pi++) {
            const pb = pebbleData[pi];
            if (pb.cooldown > 0) {
              pb.cooldown -= dt;
              continue;
            }
            const dx = pb.x - car.pos.x;
            const dz = pb.z - car.pos.z;
            const r = 1.7 + pb.size;
            if (dx * dx + dz * dz < r * r) {
              pb.cooldown = 0.6;
              car.speed *= 0.55;
              car.angle += (Math.random() - 0.5) * 0.18;
              car.vy = Math.max(car.vy, 3);
              spawnExplosion(pb.x, pb.y + pb.size * 0.6, pb.z);
            }
          }
        }

        // Respawn si on est tombé dans le vide
        if (car.pos.y < -40) {
          const safeP = trackPoints[car.lastSafeIdx];
          const safeT = trackTangents[car.lastSafeIdx];
          car.pos.set(safeP.x, trackHeights[car.lastSafeIdx], safeP.z);
          car.vy = 0;
          car.speed = 0;
          car.angle = Math.atan2(safeT.z, safeT.x);
          car.prevTargetY = trackHeights[car.lastSafeIdx];
        }

        // Checkpoints (4 quadrants, traverse counter-clockwise starting from -x side / top)
        let quad = 0;
        if (car.pos.x >= 0 && car.pos.z < 0) quad = 1;
        else if (car.pos.x >= 0 && car.pos.z >= 0) quad = 2;
        else if (car.pos.x < 0 && car.pos.z >= 0) quad = 3;
        else quad = 0; // x<0, z<0

        const expected = (car.checkpoint + 1) % 4;
        if (quad === expected) {
          car.checkpoint = expected;
          if (expected === 0) {
            car.lap += 1;
            if (car.lap >= TOTAL_LAPS) {
              setWinner(car.name);
            }
          }
        }
      });
    };

    let hudTick = 0;
    const animate = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      update(dt);

      // Sync meshes
      carsRef.current.forEach((car, i) => {
        carMeshes[i].position.set(car.pos.x, car.pos.y, car.pos.z);
        carMeshes[i].rotation.y = -car.angle;
      });

      // Mise à jour des particules d'explosion
      for (let pi = particles.length - 1; pi >= 0; pi--) {
        const p = particles[pi];
        p.life -= dt;
        if (p.life <= 0) {
          scene.remove(p.mesh);
          p.mat.dispose();
          particles.splice(pi, 1);
          continue;
        }
        p.vy -= 30 * dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        if (p.mesh.position.y < 0.1) {
          p.mesh.position.y = 0.1;
          p.vy *= -0.3;
          p.vx *= 0.6;
          p.vz *= 0.6;
        }
        p.mat.opacity = Math.max(0, p.life / p.maxLife);
      }

      // Update chase cameras
      carsRef.current.forEach((car, i) => {
        const fx = Math.cos(car.angle);
        const fz = Math.sin(car.angle);
        const camDist = 18;
        const camHeight = 8;
        const cx = car.pos.x - fx * camDist;
        const cz = car.pos.z - fz * camDist;
        cams[i].position.set(cx, car.pos.y + camHeight, cz);
        cams[i].lookAt(car.pos.x + fx * 8, car.pos.y + 2, car.pos.z + fz * 8);
      });

      // Split-screen rendering
      const w = renderer.domElement.width / renderer.getPixelRatio();
      const h = renderer.domElement.height / renderer.getPixelRatio();
      const horizontal = w >= h;

      renderer.setScissorTest(true);
      if (horizontal) {
        renderer.setViewport(0, 0, w / 2, h);
        renderer.setScissor(0, 0, w / 2, h);
        renderer.render(scene, cams[0]);
        renderer.setViewport(w / 2, 0, w / 2, h);
        renderer.setScissor(w / 2, 0, w / 2, h);
        renderer.render(scene, cams[1]);
      } else {
        renderer.setViewport(0, h / 2, w, h / 2);
        renderer.setScissor(0, h / 2, w, h / 2);
        renderer.render(scene, cams[0]);
        renderer.setViewport(0, 0, w, h / 2);
        renderer.setScissor(0, 0, w, h / 2);
        renderer.render(scene, cams[1]);
      }
      renderer.setScissorTest(false);

      hudTick++;
      if (hudTick % 6 === 0) setTick((t) => (t + 1) % 1_000_000);

      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [running, winner]);

  const cars = carsRef.current;
  void tick;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="flex flex-col items-center py-3 gap-1">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Course 3D — 2 joueurs</h1>
        <p className="text-xs text-muted-foreground">
          Premier à {TOTAL_LAPS} tours gagne · P1 : Z Q S D · P2 : Flèches
        </p>
      </header>

      <div className="relative flex-1 min-h-[60vh]">
        <div ref={mountRef} className="absolute inset-0 [&>canvas]:block [&>canvas]:w-full [&>canvas]:h-full" />

        {/* HUD P1 */}
        <div className="pointer-events-none absolute top-2 left-2 md:left-2 md:top-2 px-3 py-1.5 rounded-md bg-black/55 backdrop-blur text-white text-sm font-semibold">
          <span className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle" style={{ background: "#e04030" }} />
          P1 · Tour {Math.min(cars[0].lap + 1, TOTAL_LAPS)}/{TOTAL_LAPS}
        </div>
        {/* HUD P2 — top-right on horizontal split, bottom-left on vertical */}
        <div className="pointer-events-none absolute top-2 right-2 px-3 py-1.5 rounded-md bg-black/55 backdrop-blur text-white text-sm font-semibold">
          <span className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle" style={{ background: "#3a8bff" }} />
          P2 · Tour {Math.min(cars[1].lap + 1, TOTAL_LAPS)}/{TOTAL_LAPS}
        </div>

        {/* Mini-map P1 (bas gauche) */}
        <div className="pointer-events-none absolute bottom-2 left-2 p-1.5 rounded-md bg-black/55 backdrop-blur">
          <MiniMap cars={cars} highlight={0} />
        </div>
        {/* Mini-map P2 (bas droite) */}
        <div className="pointer-events-none absolute bottom-2 right-2 p-1.5 rounded-md bg-black/55 backdrop-blur">
          <MiniMap cars={cars} highlight={1} />
        </div>

        {(countdown !== null || winner || !running || gpuError) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-sm">
            {gpuError ? (
              <div className="text-center max-w-md">
                <p className="text-xl font-bold mb-2">Impossible de démarrer la 3D</p>
                <p className="text-sm text-muted-foreground">{gpuError}</p>
              </div>
            ) : winner ? (
              <div className="text-center">
                <div className="text-4xl md:text-5xl font-bold mb-4 text-white">🏁 {winner} gagne !</div>
                <button
                  onClick={reset}
                  className="px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90"
                >
                  Rejouer
                </button>
              </div>
            ) : countdown !== null ? (
              <div className="text-7xl md:text-8xl font-bold text-white drop-shadow-lg">
                {countdown === 0 ? "GO!" : countdown}
              </div>
            ) : (
              <button
                onClick={reset}
                className="px-8 py-4 rounded-md bg-primary text-primary-foreground text-xl font-medium hover:opacity-90"
              >
                Démarrer la course
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}