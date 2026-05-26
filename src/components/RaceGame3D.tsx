import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

const TOTAL_LAPS = 3;

// Oval track (XZ plane)
const OUTER_RX = 200;
const OUTER_RZ = 130;
const INNER_RX = 130;
const INNER_RZ = 60;

function onTrack(x: number, z: number) {
  const a = (x / OUTER_RX) ** 2 + (z / OUTER_RZ) ** 2;
  const b = (x / INNER_RX) ** 2 + (z / INNER_RZ) ** 2;
  return a <= 1 && b >= 1;
}

type CarState = {
  pos: THREE.Vector3;
  angle: number; // yaw, radians
  speed: number;
  lap: number;
  checkpoint: number;
  name: string;
};

function makeCarMesh(color: number) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 1.1, 1.8),
    new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.35 }),
  );
  body.position.y = 0.8;
  body.castShadow = true;
  group.add(body);

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.8, 1.5),
    new THREE.MeshStandardMaterial({ color: 0x111114, metalness: 0.3, roughness: 0.2 }),
  );
  cabin.position.set(-0.1, 1.65, 0);
  cabin.castShadow = true;
  group.add(cabin);

  const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.35, 16);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
  const wheelPositions: [number, number, number][] = [
    [1.1, 0.45, 0.95],
    [1.1, 0.45, -0.95],
    [-1.1, 0.45, 0.95],
    [-1.1, 0.45, -0.95],
  ];
  wheelPositions.forEach(([x, y, z]) => {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.x = Math.PI / 2;
    w.position.set(x, y, z);
    group.add(w);
  });

  return group;
}

function buildTrackMeshes(scene: THREE.Scene) {
  // Grass
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: 0x4a7c3a, roughness: 1 }),
  );
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  scene.add(grass);

  // Track ring built from a shape with a hole
  const outer = new THREE.Shape();
  const seg = 96;
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const x = Math.cos(t) * OUTER_RX;
    const z = Math.sin(t) * OUTER_RZ;
    if (i === 0) outer.moveTo(x, z);
    else outer.lineTo(x, z);
  }
  const hole = new THREE.Path();
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const x = Math.cos(t) * INNER_RX;
    const z = Math.sin(t) * INNER_RZ;
    if (i === 0) hole.moveTo(x, z);
    else hole.lineTo(x, z);
  }
  outer.holes.push(hole);

  const trackGeo = new THREE.ShapeGeometry(outer, 64);
  trackGeo.rotateX(-Math.PI / 2);
  const track = new THREE.Mesh(
    trackGeo,
    new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.85 }),
  );
  track.position.y = 0.01;
  track.receiveShadow = true;
  scene.add(track);

  // Center line (dashed) using small boxes
  const midRX = (OUTER_RX + INNER_RX) / 2;
  const midRZ = (OUTER_RZ + INNER_RZ) / 2;
  const dashGeo = new THREE.BoxGeometry(2, 0.05, 0.5);
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = 0; i < 60; i++) {
    if (i % 2 === 0) continue;
    const t = (i / 60) * Math.PI * 2;
    const m = new THREE.Mesh(dashGeo, dashMat);
    m.position.set(Math.cos(t) * midRX, 0.03, Math.sin(t) * midRZ);
    m.rotation.y = -t + Math.PI / 2;
    scene.add(m);
  }

  // Start/finish line at x≈0, z between INNER_RZ and OUTER_RZ
  const startGroup = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.05, 5),
      new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0xffffff : 0x111111 }),
    );
    tile.position.set(-INNER_RX - 6 + i * 1.2, 0.02, 0);
    startGroup.add(tile);
  }
  scene.add(startGroup);

  // Some decorative trees
  const trunkGeo = new THREE.CylinderGeometry(0.6, 0.8, 3, 8);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a20 });
  const leafGeo = new THREE.ConeGeometry(3, 6, 10);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e6b2a });
  for (let i = 0; i < 90; i++) {
    const tx = (Math.random() - 0.5) * 820;
    const tz = (Math.random() - 0.5) * 820;
    // keep trees off the track
    if (Math.abs(tx) < OUTER_RX + 15 && Math.abs(tz) < OUTER_RZ + 15) continue;
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    const leaves = new THREE.Mesh(leafGeo, leafMat);
    trunk.position.set(tx, 1.5, tz);
    leaves.position.set(tx, 6, tz);
    trunk.castShadow = true;
    leaves.castShadow = true;
    scene.add(trunk);
    scene.add(leaves);
  }
}

export default function RaceGame3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const carsRef = useRef<CarState[]>([
    {
      pos: new THREE.Vector3(-INNER_RX - 12, 0, 6),
      angle: 0,
      speed: 0,
      lap: 0,
      checkpoint: 0,
      name: "P1",
    },
    {
      pos: new THREE.Vector3(-INNER_RX - 12, 0, -6),
      angle: 0,
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
        pos: new THREE.Vector3(-INNER_RX - 12, 0, 6),
        angle: 0,
        speed: 0,
        lap: 0,
        checkpoint: 0,
        name: "P1",
      },
      {
        pos: new THREE.Vector3(-INNER_RX - 12, 0, -6),
        angle: 0,
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
    scene.fog = new THREE.Fog(0x87ceeb, 200, 700);

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x556633, 0.7);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(120, 180, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -300;
    sun.shadow.camera.right = 300;
    sun.shadow.camera.top = 300;
    sun.shadow.camera.bottom = -300;
    scene.add(sun);

    buildTrackMeshes(scene);

    const car1Mesh = makeCarMesh(0xe04030);
    const car2Mesh = makeCarMesh(0x3a8bff);
    scene.add(car1Mesh);
    scene.add(car2Mesh);
    const carMeshes = [car1Mesh, car2Mesh];

    const cam1 = new THREE.PerspectiveCamera(65, 1, 0.1, 900);
    const cam2 = new THREE.PerspectiveCamera(65, 1, 0.1, 900);
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
        carMeshes[i].position.set(car.pos.x, 0, car.pos.z);
        carMeshes[i].rotation.y = -car.angle;
      });

      // Update chase cameras
      carsRef.current.forEach((car, i) => {
        const fx = Math.cos(car.angle);
        const fz = Math.sin(car.angle);
        const camDist = 18;
        const camHeight = 8;
        const cx = car.pos.x - fx * camDist;
        const cz = car.pos.z - fz * camDist;
        cams[i].position.set(cx, camHeight, cz);
        cams[i].lookAt(car.pos.x + fx * 8, 2, car.pos.z + fz * 8);
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