import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const TOTAL_LAPS = 3;

// Circuit défini par une centerline (Catmull-Rom fermée) avec chicanes/virages
const TRACK_HALF_WIDTH = 24;
const FENCE_OFFSET = TRACK_HALF_WIDTH - 0.6; // position visuelle des clôtures
const FENCE_R = TRACK_HALF_WIDTH - 1.6; // limite de rebond (intérieur de la clôture)
const FENCE_BOUNCE = 0.55; // coefficient de restitution du rebond
// Tracé sinueux (boucle "étoilée" sans auto-intersection) — 12 virages,
// base 4 lobes + harmonique 8 pour multiplier les petits virages
const TRACK_CONTROL: [number, number][] = [
  [-317.5, 0],
  [-315.6, -30.8],
  [-299.7, -60],
  [-279.5, -87.8],
  [-252, -112.9],
  [-211.3, -130.3],
  [-163.6, -138.9],
  [-121.3, -146.9],
  [-85.7, -162.7],
  [-47, -183.1],
  [0, -195.8],
  [50, -194.6],
  [97.4, -184.8],
  [142.4, -172.4],
  [183.1, -155.4],
  [211.3, -130.3],
  [225.2, -100.9],
  [238.1, -74.8],
  [263.9, -52.9],
  [297, -29],
  [317.5, 0],
  [315.6, 30.8],
  [299.7, 60],
  [279.5, 87.8],
  [252, 112.9],
  [211.3, 130.3],
  [163.6, 138.9],
  [121.3, 146.9],
  [85.7, 162.7],
  [47, 183.1],
  [0, 195.8],
  [-50, 194.6],
  [-97.4, 184.8],
  [-142.4, 172.4],
  [-183.1, 155.4],
  [-211.3, 130.3],
  [-225.2, 100.9],
  [-238.1, 74.8],
  [-263.9, 52.9],
  [-297, 29],
];

// Facteur d'agrandissement global du circuit principal
const TRACK_SCALE = 2.0;
// Croissance du reste du monde (2e circuit, montagnes, herbe, brouillard,
// portée caméra) relativement au layout de référence calé à TRACK_SCALE = 1.3
const WORLD_GROW = TRACK_SCALE / 1.3;
const _trackCurve = new THREE.CatmullRomCurve3(
  TRACK_CONTROL.map(
    ([x, z]) => new THREE.Vector3(x * TRACK_SCALE, 0, z * TRACK_SCALE),
  ),
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
const RAMP_POSITIONS: number[] = [];
const RAMP_HEIGHT = 8;
const RAMP_WIDTH = 0.025;
const GRAVITY = 65;
// Trou dans la route juste après chaque tremplin
const GAP_RANGES_T: [number, number][] = RAMP_POSITIONS.map((r) => [
  r + 0.024,
  r + 0.034,
]);
// Grande montagne : une portion du circuit grimpe haut
const MOUNTAIN_CENTER_T = 0.65;
const MOUNTAIN_WIDTH = 0.27;
const MOUNTAIN_AMP = 60;
function mountainHumpAt(t: number): number {
  let d = t - MOUNTAIN_CENTER_T;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  if (Math.abs(d) < MOUNTAIN_WIDTH) {
    return MOUNTAIN_AMP * 0.5 * (1 + Math.cos((d * Math.PI) / MOUNTAIN_WIDTH));
  }
  return 0;
}
// Profil d'élévation : bosses, creux et tremplins
function heightAtT(t: number): number {
  const u = t * Math.PI * 2;
  let h =
    TRACK_RAISE +
    mountainHumpAt(t) +
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
// Position et taille suivent l'agrandissement du monde ; largeur de route fixe
const TRACK2_CX = -720 * WORLD_GROW;
const TRACK2_CZ = 0;
const TRACK2_RX = 220 * WORLD_GROW;
const TRACK2_RZ = 150 * WORLD_GROW;
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

// Liaison : du point de la piste principale le plus proche du vertex est du 2e circuit
let _connMainIdx = 0;
let _connMainD2 = Infinity;
for (let i = 0; i < trackPoints.length; i++) {
  const dx = trackPoints[i].x - (TRACK2_CX + TRACK2_RX);
  const dz = trackPoints[i].z - TRACK2_CZ;
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
// Côté de la piste principale où débouche la liaison (clôture ouverte ici)
const LINK_SIDE: 1 | -1 =
  LINK_DIR_X * -trackTangents[_connMainIdx].z +
    LINK_DIR_Z * trackTangents[_connMainIdx].x >
  0
    ? 1
    : -1;
function linkJunctionNear(i: number, span: number): boolean {
  const d = Math.min(
    (i - _connMainIdx + TRACK_SAMPLES) % TRACK_SAMPLES,
    (_connMainIdx - i + TRACK_SAMPLES) % TRACK_SAMPLES,
  );
  return d <= span;
}

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
  isBot: boolean; // piloté par l'IA
  speedFactor: number; // multiplicateur de vitesse max (variété/difficulté)
};

// Voitures : 2 joueurs humains (P1/P2) + bots pilotés par l'IA
const CAR_DEFS: {
  name: string;
  color: number;
  bot: boolean;
  speedFactor: number;
}[] = [
  { name: "P1", color: 0xe04030, bot: false, speedFactor: 1.0 },
  { name: "P2", color: 0x3a8bff, bot: false, speedFactor: 1.0 },
  { name: "Bot 1", color: 0xffc400, bot: true, speedFactor: 0.93 },
  { name: "Bot 2", color: 0x35d07f, bot: true, speedFactor: 0.88 },
  { name: "Bot 3", color: 0xb56bff, bot: true, speedFactor: 0.97 },
];

// Grille de départ : 2 par rangée, rangées successives en retrait derrière la ligne
function makeInitialCars(): CarState[] {
  return CAR_DEFS.map((def, k) => {
    const row = Math.floor(k / 2);
    const col = k % 2;
    const idx = (TRACK_SAMPLES - row * 3) % TRACK_SAMPLES;
    const p = trackPoints[idx];
    const tg = trackTangents[idx];
    const lane = (col === 0 ? 1 : -1) * 7;
    return {
      pos: new THREE.Vector3(
        p.x + -tg.z * lane,
        trackHeights[idx],
        p.z + tg.x * lane,
      ),
      vy: 0,
      prevTargetY: trackHeights[idx],
      lastSafeIdx: idx,
      angle: Math.atan2(tg.z, tg.x),
      speed: 0,
      lap: 0,
      checkpoint: 0,
      name: def.name,
      isBot: def.bot,
      speedFactor: def.speedFactor,
    };
  });
}

// Roue détaillée : pneu + disque de frein + jante chromée multi-branches
function makeWheel(): THREE.Group {
  const g = new THREE.Group();
  const R = 0.56;
  const width = 0.44;
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x121316,
    roughness: 0.85,
    metalness: 0.1,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xd9dee6,
    metalness: 1,
    roughness: 0.2,
  });
  const discMat = new THREE.MeshStandardMaterial({
    color: 0x2a2d33,
    metalness: 0.7,
    roughness: 0.4,
  });

  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, width, 28),
    tireMat,
  );
  tire.rotation.x = Math.PI / 2;
  tire.castShadow = true;
  g.add(tire);

  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.66, R * 0.66, width * 0.6, 24),
    discMat,
  );
  disc.rotation.x = Math.PI / 2;
  g.add(disc);

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.3, R * 0.3, width * 0.95, 20),
    rimMat,
  );
  hub.rotation.x = Math.PI / 2;
  g.add(hub);

  const spokeGeo = new THREE.BoxGeometry(R * 1.0, 0.08, width * 0.45);
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(spokeGeo, rimMat);
    s.rotation.z = (i / 5) * Math.PI * 2;
    g.add(s);
  }
  return g;
}

function makeCarMesh(color: number) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.5,
    roughness: 0.32,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x0c0c0e,
    metalness: 0.5,
    roughness: 0.55,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x10141c,
    metalness: 0.3,
    roughness: 0.08,
    transparent: true,
    opacity: 0.6,
  });
  const headlightMat = new THREE.MeshStandardMaterial({
    color: 0xfff6c0,
    emissive: 0xfff0a0,
    emissiveIntensity: 1.1,
    roughness: 0.3,
  });
  const taillightMat = new THREE.MeshStandardMaterial({
    color: 0xff2a18,
    emissive: 0xff1408,
    emissiveIntensity: 1.0,
    roughness: 0.3,
  });

  const rb = (w: number, h: number, d: number, r: number) =>
    new RoundedBoxGeometry(w, h, d, 3, r);

  // Coque principale basse et large
  const body = new THREE.Mesh(rb(3.5, 0.55, 1.9, 0.2), bodyMat);
  body.position.set(0, 0.7, 0);
  body.castShadow = true;
  group.add(body);

  // Nez plongeant
  const nose = new THREE.Mesh(rb(1.4, 0.4, 1.78, 0.18), bodyMat);
  nose.position.set(1.55, 0.6, 0);
  nose.castShadow = true;
  group.add(nose);

  // Arrière
  const tail = new THREE.Mesh(rb(0.9, 0.5, 1.85, 0.18), bodyMat);
  tail.position.set(-1.5, 0.7, 0);
  tail.castShadow = true;
  group.add(tail);

  // Cockpit / bulle vitrée arrondie, reculée
  const canopy = new THREE.Mesh(rb(2.0, 0.6, 1.5, 0.28), glassMat);
  canopy.position.set(-0.25, 1.2, 0);
  group.add(canopy);

  // Arceau de toit teinté carrosserie
  const roof = new THREE.Mesh(rb(0.8, 0.18, 1.35, 0.08), bodyMat);
  roof.position.set(-0.55, 1.5, 0);
  group.add(roof);

  // Splitter avant + diffuseur arrière
  const splitter = new THREE.Mesh(rb(0.5, 0.1, 1.9, 0.04), darkMat);
  splitter.position.set(2.05, 0.4, 0);
  group.add(splitter);
  const diffuser = new THREE.Mesh(rb(0.5, 0.18, 1.8, 0.05), darkMat);
  diffuser.position.set(-1.95, 0.42, 0);
  group.add(diffuser);

  // Bas de caisse
  [0.92, -0.92].forEach((z) => {
    const sk = new THREE.Mesh(rb(2.8, 0.12, 0.12, 0.05), darkMat);
    sk.position.set(0, 0.42, z);
    group.add(sk);
  });

  // Phares avant
  const hlGeo = rb(0.12, 0.16, 0.5, 0.05);
  [0.62, -0.62].forEach((z) => {
    const h = new THREE.Mesh(hlGeo, headlightMat);
    h.position.set(2.18, 0.72, z);
    group.add(h);
  });

  // Bande de feux arrière
  const tl = new THREE.Mesh(rb(0.1, 0.16, 1.5, 0.04), taillightMat);
  tl.position.set(-1.97, 0.85, 0);
  group.add(tl);

  // Aileron arrière
  [0.6, -0.6].forEach((z) => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 0.08), darkMat);
    leg.position.set(-1.7, 1.15, z);
    group.add(leg);
  });
  const wing = new THREE.Mesh(rb(0.5, 0.07, 1.5, 0.03), darkMat);
  wing.position.set(-1.75, 1.34, 0);
  group.add(wing);

  // Rétroviseurs
  [0.85, -0.85].forEach((z) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.18), darkMat);
    arm.position.set(0.5, 1.12, z);
    group.add(arm);
    const cap = new THREE.Mesh(rb(0.16, 0.12, 0.1, 0.04), bodyMat);
    cap.position.set(0.5, 1.16, z * 1.12);
    group.add(cap);
  });

  // Roues aux quatre coins (légèrement débordantes, style sport)
  const wheelPositions: [number, number, number][] = [
    [1.32, 0.56, 0.96],
    [1.32, 0.56, -0.96],
    [-1.32, 0.56, 0.96],
    [-1.32, 0.56, -0.96],
  ];
  wheelPositions.forEach(([x, y, z]) => {
    const w = makeWheel();
    w.position.set(x, y, z);
    group.add(w);
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
    new THREE.PlaneGeometry(2400 * WORLD_GROW, 1600 * WORLD_GROW),
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
      // bord haut au niveau de la route
      const topX = p.x + nx * TRACK_HALF_WIDTH * side;
      const topZ = p.z + nz * TRACK_HALF_WIDTH * side;
      // bord bas évasé vers l'extérieur selon la hauteur → flanc de montagne
      const spread = (trackHeights[i] - GROUND_Y) * 1.4;
      const botX = p.x + nx * (TRACK_HALF_WIDTH + spread) * side;
      const botZ = p.z + nz * (TRACK_HALF_WIDTH + spread) * side;
      sidePositions.push(topX, trackHeights[i], topZ); // bord haut
      sidePositions.push(botX, GROUND_Y, botZ); // bord bas évasé
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

  // Cascade descendant le flanc extérieur de la montagne
  {
    // Point le plus haut de la montagne
    let peakI = 0;
    let peakH = -Infinity;
    for (let i = 0; i < N; i++) {
      if (mountainHumpAt(i / TRACK_SAMPLES) > 5 && trackHeights[i] > peakH) {
        peakH = trackHeights[i];
        peakI = i;
      }
    }
    const p = trackPoints[peakI];
    const tg = trackTangents[peakI];
    const nx = -tg.z;
    const nz = tg.x;
    // côté extérieur du circuit (flanc le plus visible)
    const side = p.x * nx + p.z * nz > 0 ? 1 : -1;
    const onx = nx * side;
    const onz = nz * side;
    const spread = (peakH - GROUND_Y) * 1.4;
    const topX = p.x + onx * TRACK_HALF_WIDTH;
    const topZ = p.z + onz * TRACK_HALF_WIDTH;
    const botX = p.x + onx * (TRACK_HALF_WIDTH + spread);
    const botZ = p.z + onz * (TRACK_HALF_WIDTH + spread);
    const W = 14;
    const hw = W / 2;
    const off = 0.5; // léger décollement du flanc pour éviter le z-fighting

    // Texture d'eau procédurale (stries verticales) qui défilera
    const cnv = document.createElement("canvas");
    cnv.width = 64;
    cnv.height = 256;
    const ctx = cnv.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 64, 256);
      for (let s = 0; s < 70; s++) {
        const x = Math.random() * 64;
        const w = 1 + Math.random() * 3;
        const a = 0.25 + Math.random() * 0.6;
        const g = 215 + ((Math.random() * 40) | 0);
        ctx.fillStyle = `rgba(${g},${Math.min(255, g + 15)},255,${a})`;
        ctx.fillRect(x, 0, w, 256);
      }
    }
    const waterTex = new THREE.CanvasTexture(cnv);
    waterTex.wrapS = THREE.RepeatWrapping;
    waterTex.wrapT = THREE.RepeatWrapping;
    waterTex.repeat.set(2, 4);
    waterTex.colorSpace = THREE.SRGBColorSpace;

    const fallMat = new THREE.MeshStandardMaterial({
      map: waterTex,
      transparent: true,
      opacity: 0.9,
      color: 0xffffff,
      emissive: 0x9ec8ff,
      emissiveIntensity: 0.3,
      roughness: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Nappe le long de la pente (haut → bas), largeur W le long de la tangente
    const tL = [topX + tg.x * hw + onx * off, peakH + off, topZ + tg.z * hw + onz * off];
    const tR = [topX - tg.x * hw + onx * off, peakH + off, topZ - tg.z * hw + onz * off];
    const bL = [botX + tg.x * hw + onx * off, GROUND_Y + off, botZ + tg.z * hw + onz * off];
    const bR = [botX - tg.x * hw + onx * off, GROUND_Y + off, botZ - tg.z * hw + onz * off];
    const fallGeo = new THREE.BufferGeometry();
    fallGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [...tL, ...tR, ...bL, ...bR],
        3,
      ),
    );
    fallGeo.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2),
    );
    fallGeo.setIndex([0, 2, 1, 1, 2, 3]);
    fallGeo.computeVertexNormals();
    const fall = new THREE.Mesh(fallGeo, fallMat);
    fall.renderOrder = 2;
    fall.onBeforeRender = () => {
      waterTex.offset.y = -(performance.now() * 0.0005) % 1;
    };
    scene.add(fall);

    // Bassin à la base de la cascade
    const poolMat = new THREE.MeshStandardMaterial({
      color: 0x2f6ea0,
      transparent: true,
      opacity: 0.85,
      roughness: 0.12,
      metalness: 0.1,
    });
    const pool = new THREE.Mesh(new THREE.CircleGeometry(W * 0.85, 40), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(botX, 0.08, botZ);
    pool.receiveShadow = true;
    scene.add(pool);

    // Écume au point d'impact
    const foamMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xbfe0ff,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.7,
      roughness: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const foam = new THREE.Mesh(
      new THREE.RingGeometry(W * 0.28, W * 0.55, 28),
      foamMat,
    );
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(botX, 0.12, botZ);
    scene.add(foam);
  }

  // Tunnel voûté au sommet de la montagne
  const TUNNEL_START_T = 0.61;
  const TUNNEL_END_T = 0.69;
  const tunnelR = TRACK_HALF_WIDTH + 5;
  const ARCH_SEGS = 14;
  const tunnelMat = new THREE.MeshStandardMaterial({
    color: 0x33333a,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
  const portalMat = new THREE.MeshStandardMaterial({
    color: 0x55555f,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const tunnelStartI = Math.floor(TUNNEL_START_T * TRACK_SAMPLES);
  const tunnelEndI = Math.ceil(TUNNEL_END_T * TRACK_SAMPLES);
  const archPoint = (idx: number, theta: number, radius: number) => {
    const p = trackPoints[idx];
    const tg = trackTangents[idx];
    const nx = -tg.z;
    const nz = tg.x;
    const lateral = radius * Math.cos(theta);
    const vertical = radius * Math.sin(theta);
    return [
      p.x + nx * lateral,
      trackHeights[idx] + vertical,
      p.z + nz * lateral,
    ] as const;
  };

  // Voûte intérieure
  const tunnelPos: number[] = [];
  const tunnelIdx: number[] = [];
  const tunnelCols = ARCH_SEGS + 1;
  let rowCount = 0;
  for (let i = tunnelStartI; i <= tunnelEndI; i++) {
    const idx = ((i % TRACK_SAMPLES) + TRACK_SAMPLES) % TRACK_SAMPLES;
    for (let j = 0; j <= ARCH_SEGS; j++) {
      const [x, y, z] = archPoint(idx, (j / ARCH_SEGS) * Math.PI, tunnelR);
      tunnelPos.push(x, y, z);
    }
    rowCount++;
  }
  for (let r = 0; r < rowCount - 1; r++) {
    for (let j = 0; j < ARCH_SEGS; j++) {
      const a = r * tunnelCols + j;
      const b = r * tunnelCols + j + 1;
      const c = (r + 1) * tunnelCols + j;
      const d = (r + 1) * tunnelCols + j + 1;
      tunnelIdx.push(a, c, b, b, c, d);
    }
  }
  const tunnelGeo = new THREE.BufferGeometry();
  tunnelGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(tunnelPos, 3),
  );
  tunnelGeo.setIndex(tunnelIdx);
  tunnelGeo.computeVertexNormals();
  const tunnel = new THREE.Mesh(tunnelGeo, tunnelMat);
  tunnel.castShadow = true;
  tunnel.receiveShadow = true;
  scene.add(tunnel);

  // Portails (façades en arche) aux deux extrémités
  for (const endIdxRaw of [tunnelStartI, tunnelEndI]) {
    const idx = ((endIdxRaw % TRACK_SAMPLES) + TRACK_SAMPLES) % TRACK_SAMPLES;
    const outerR = tunnelR + 9;
    const pos: number[] = [];
    const ind: number[] = [];
    for (let j = 0; j <= ARCH_SEGS; j++) {
      const theta = (j / ARCH_SEGS) * Math.PI;
      const [ix, iy, iz] = archPoint(idx, theta, tunnelR);
      const [ox, oy, oz] = archPoint(idx, theta, outerR);
      pos.push(ix, iy, iz);
      pos.push(ox, oy, oz);
    }
    for (let j = 0; j < ARCH_SEGS; j++) {
      const a = j * 2;
      const b = j * 2 + 1;
      const c = (j + 1) * 2;
      const d = (j + 1) * 2 + 1;
      ind.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(ind);
    g.computeVertexNormals();
    const portal = new THREE.Mesh(g, portalMat);
    portal.castShadow = true;
    scene.add(portal);
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

  // Clôtures (guardrails) le long des deux bords de la piste principale
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xd7dbe2,
    metalness: 0.6,
    roughness: 0.4,
  });
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x8b9099,
    metalness: 0.5,
    roughness: 0.65,
  });
  const RAIL_Y = 1.7;
  const POST_H = 2.2;

  const railMatrices: THREE.Matrix4[] = [];
  const postMatrices: THREE.Matrix4[] = [];
  for (const side of [1, -1] as const) {
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      if (trackIsGap[i] || trackIsGap[next]) continue;
      if (side === LINK_SIDE && linkJunctionNear(i, 5)) continue;
      const p = trackPoints[i];
      const pn = trackPoints[next];
      const tg = trackTangents[i];
      const tgn = trackTangents[next];
      const ax = p.x + -tg.z * FENCE_OFFSET * side;
      const az = p.z + tg.x * FENCE_OFFSET * side;
      const bx = pn.x + -tgn.z * FENCE_OFFSET * side;
      const bz = pn.z + tgn.x * FENCE_OFFSET * side;
      const segLen = Math.hypot(bx - ax, bz - az) + 0.2;
      const yaw = -Math.atan2(bz - az, bx - ax);
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, yaw, 0),
      );
      const railY = (trackHeights[i] + trackHeights[next]) / 2 + RAIL_Y;
      railMatrices.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3((ax + bx) / 2, railY, (az + bz) / 2),
          q,
          new THREE.Vector3(segLen, 0.28, 0.14),
        ),
      );
      if (i % 3 === 0) {
        postMatrices.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(ax, trackHeights[i] + POST_H / 2, az),
            q,
            new THREE.Vector3(0.24, POST_H, 0.24),
          ),
        );
      }
    }
  }
  const fenceBox = new THREE.BoxGeometry(1, 1, 1);
  const railMesh = new THREE.InstancedMesh(
    fenceBox,
    railMat,
    railMatrices.length,
  );
  railMatrices.forEach((m, k) => railMesh.setMatrixAt(k, m));
  railMesh.instanceMatrix.needsUpdate = true;
  railMesh.castShadow = true;
  railMesh.frustumCulled = false;
  scene.add(railMesh);
  const postMesh = new THREE.InstancedMesh(
    fenceBox,
    postMat,
    postMatrices.length,
  );
  postMatrices.forEach((m, k) => postMesh.setMatrixAt(k, m));
  postMesh.instanceMatrix.needsUpdate = true;
  postMesh.castShadow = true;
  postMesh.frustumCulled = false;
  scene.add(postMesh);

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
  const ringRadius = 1100 * WORLD_GROW;
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
  const colors = CAR_DEFS.map(
    (d) => "#" + d.color.toString(16).padStart(6, "0"),
  );
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
  const carsRef = useRef<CarState[]>(makeInitialCars());
  const [tick, setTick] = useState(0);
  const [winner, setWinner] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);

  const reset = useCallback(() => {
    carsRef.current = makeInitialCars();
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x87ceeb);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x87ceeb, 400 * WORLD_GROW, 1500 * WORLD_GROW);

    // Lights
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a33, 0.5);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e6, 2.0);
    sun.position.set(120 * WORLD_GROW, 180 * WORLD_GROW, 80 * WORLD_GROW);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 900 * WORLD_GROW;
    sun.shadow.camera.left = -500 * WORLD_GROW;
    sun.shadow.camera.right = 500 * WORLD_GROW;
    sun.shadow.camera.top = 500 * WORLD_GROW;
    sun.shadow.camera.bottom = -500 * WORLD_GROW;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.6;
    scene.add(sun);

    // Ciel réaliste (Sky dome) + éclairage d'environnement IBL cohérent
    const sunDir = sun.position.clone().normalize();
    const makeSky = () => {
      const s = new Sky();
      s.scale.setScalar(10000);
      const u = s.material.uniforms;
      u.turbidity.value = 6;
      u.rayleigh.value = 1.6;
      u.mieCoefficient.value = 0.005;
      u.mieDirectionalG.value = 0.8;
      u.sunPosition.value.copy(sunDir);
      return s;
    };
    scene.add(makeSky());
    // IBL généré à partir du ciel (reflets PBR cohérents sur les voitures, etc.)
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(makeSky());
    const envTex = pmrem.fromScene(envScene).texture;
    scene.environment = envTex;
    pmrem.dispose();

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

    const carMeshes = CAR_DEFS.map((def) => {
      const m = makeCarMesh(def.color);
      scene.add(m);
      return m;
    });

    const cam1 = new THREE.PerspectiveCamera(65, 1, 0.1, 1900 * WORLD_GROW);
    const cam2 = new THREE.PerspectiveCamera(65, 1, 0.1, 1900 * WORLD_GROW);
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
        let accel = 0;
        let turn = 0;
        if (car.isBot) {
          // IA : vise un point de la centerline en avant et s'oriente vers lui
          const ni = nearestSampleIndex(car.pos.x, car.pos.z);
          const t = trackPoints[(ni + 7) % TRACK_SAMPLES];
          let err = Math.atan2(t.z - car.pos.z, t.x - car.pos.x) - car.angle;
          while (err > Math.PI) err -= 2 * Math.PI;
          while (err < -Math.PI) err += 2 * Math.PI;
          turn = Math.max(-1, Math.min(1, err * 2.2));
          const ae = Math.abs(err);
          // freine dans les virages serrés, lève le pied en courbe, plein gaz en ligne droite
          accel = ae > 0.8 ? -1 : ae > 0.45 ? 0 : 1;
        } else {
          const c = controls[i];
          const any = (arr: string[]) => arr.some((x) => k[x]);
          if (any(c.up)) accel = 1;
          if (any(c.down)) accel = -1;
          if (any(c.left)) turn = -1;
          if (any(c.right)) turn = 1;
        }

        const maxSpeed = 90 * car.speedFactor;
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
        let nx = car.pos.x + fx * car.speed * dt;
        let nz = car.pos.z + fz * car.speed * dt;

        // Rebond sur les clôtures qui bordent la piste principale
        const curP = trackPoints[nearestSampleIndex(car.pos.x, car.pos.z)];
        const onMain =
          (curP.x - car.pos.x) ** 2 + (curP.z - car.pos.z) ** 2 <
          TRACK_HALF_WIDTH * TRACK_HALF_WIDTH;
        if (onMain && !onLink(nx, nz)) {
          const fi = nearestSampleIndex(nx, nz);
          const fp = trackPoints[fi];
          const ftg = trackTangents[fi];
          const nrmX = -ftg.z;
          const nrmZ = ftg.x;
          const lat = (nx - fp.x) * nrmX + (nz - fp.z) * nrmZ;
          const side = lat > 0 ? 1 : -1;
          // près de la jonction, on laisse l'ouverture vers la liaison
          const openForLink = side === LINK_SIDE && linkJunctionNear(fi, 6);
          if (Math.abs(lat) > FENCE_R && !openForLink) {
            const onx = nrmX * side;
            const onz = nrmZ * side;
            // repousse la voiture juste à l'intérieur de la clôture
            const overshoot = Math.abs(lat) - FENCE_R;
            nx -= onx * overshoot;
            nz -= onz * overshoot;
            // réflexion de la vitesse sur la normale de la clôture
            const vx = fx * car.speed;
            const vz = fz * car.speed;
            const vn = vx * onx + vz * onz; // composante dirigée vers l'extérieur
            if (vn > 0) {
              const rvx = vx - (1 + FENCE_BOUNCE) * vn * onx;
              const rvz = vz - (1 + FENCE_BOUNCE) * vn * onz;
              car.speed = Math.hypot(rvx, rvz);
              car.angle = Math.atan2(rvz, rvx);
            }
          }
        }

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

      // Update chase cameras (uniquement les 2 joueurs humains)
      cams.forEach((cam, i) => {
        const car = carsRef.current[i];
        const fx = Math.cos(car.angle);
        const fz = Math.sin(car.angle);
        const camDist = 18;
        const camHeight = 8;
        const cx = car.pos.x - fx * camDist;
        const cz = car.pos.z - fz * camDist;
        cam.position.set(cx, car.pos.y + camHeight, cz);
        cam.lookAt(car.pos.x + fx * 8, car.pos.y + 2, car.pos.z + fz * 8);
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
      envTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [running, winner]);

  const cars = carsRef.current;
  void tick;
  // Classement : progression = tours + position le long de la centerline
  const _ranking = cars
    .map((c, i) => ({
      i,
      p: c.lap * TRACK_SAMPLES + nearestSampleIndex(c.pos.x, c.pos.z),
    }))
    .sort((a, b) => b.p - a.p);
  const posOf = (i: number) => _ranking.findIndex((r) => r.i === i) + 1;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="flex flex-col items-center py-3 gap-1">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Course 3D — 2 joueurs</h1>
        <p className="text-xs text-muted-foreground">
          Premier à {TOTAL_LAPS} tours gagne · P1 : Z Q S D · P2 : Flèches · vs 3 bots
        </p>
      </header>

      <div className="relative flex-1 min-h-[60vh]">
        <div ref={mountRef} className="absolute inset-0 [&>canvas]:block [&>canvas]:w-full [&>canvas]:h-full" />

        {/* HUD P1 */}
        <div className="pointer-events-none absolute top-2 left-2 md:left-2 md:top-2 px-3 py-1.5 rounded-md bg-black/55 backdrop-blur text-white text-sm font-semibold">
          <span className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle" style={{ background: "#e04030" }} />
          P1 · Tour {Math.min(cars[0].lap + 1, TOTAL_LAPS)}/{TOTAL_LAPS} · {posOf(0)}
          <sup>e</sup>/{cars.length}
        </div>
        {/* HUD P2 — top-right on horizontal split, bottom-left on vertical */}
        <div className="pointer-events-none absolute top-2 right-2 px-3 py-1.5 rounded-md bg-black/55 backdrop-blur text-white text-sm font-semibold">
          <span className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle" style={{ background: "#3a8bff" }} />
          P2 · Tour {Math.min(cars[1].lap + 1, TOTAL_LAPS)}/{TOTAL_LAPS} · {posOf(1)}
          <sup>e</sup>/{cars.length}
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