import { useEffect, useRef, useState, useCallback } from "react";

type Car = {
  x: number;
  y: number;
  angle: number;
  speed: number;
  lap: number;
  checkpoint: number;
  color: string;
  name: string;
};

const WIDTH = 900;
const HEIGHT = 560;
const TOTAL_LAPS = 3;

// Oval track geometry
const CX = WIDTH / 2;
const CY = HEIGHT / 2;
const OUTER_RX = 400;
const OUTER_RY = 240;
const INNER_RX = 220;
const INNER_RY = 100;

function onTrack(x: number, y: number) {
  const dx = (x - CX) / OUTER_RX;
  const dy = (y - CY) / OUTER_RY;
  const outer = dx * dx + dy * dy <= 1;
  const idx = (x - CX) / INNER_RX;
  const idy = (y - CY) / INNER_RY;
  const inner = idx * idx + idy * idy >= 1;
  return outer && inner;
}

function makeCar(y: number, color: string, name: string): Car {
  return {
    x: CX,
    y,
    angle: 0,
    speed: 0,
    lap: 0,
    checkpoint: 0,
    color,
    name,
  };
}

export default function RaceGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<Record<string, boolean>>({});
  const carsRef = useRef<Car[]>([
    makeCar(CY - (OUTER_RY + INNER_RY) / 2 + 20, "var(--p1)", "P1"),
    makeCar(CY - (OUTER_RY + INNER_RY) / 2 - 20, "var(--p2)", "P2"),
  ]);
  const [, force] = useState(0);
  const [winner, setWinner] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  const reset = useCallback(() => {
    carsRef.current = [
      makeCar(CY - (OUTER_RY + INNER_RY) / 2 + 20, "var(--p1)", "P1"),
      makeCar(CY - (OUTER_RY + INNER_RY) / 2 - 20, "var(--p2)", "P2"),
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
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(e.key.toLowerCase())) {
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
    let raf = 0;
    let last = performance.now();

    // Resolve CSS vars to actual colors for canvas
    const styles = getComputedStyle(document.documentElement);
    const resolve = (v: string) => {
      const m = v.match(/var\((--[^)]+)\)/);
      return m ? styles.getPropertyValue(m[1]).trim() || "#fff" : v;
    };

    const step = (now: number) => {
      const dt = Math.min(50, now - last) / 1000;
      last = now;
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) {
        raf = requestAnimationFrame(step);
        return;
      }

      const cars = carsRef.current;

      if (running && !winner) {
        const controls = [
          { up: "z", down: "s", left: "q", right: "d", alt: ["w", "arrowup-ignore"] },
          { up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright" },
        ];
        // also accept w/a/s/d for P1
        const p1Alt = { up: "w", down: "s", left: "a", right: "d" };

        cars.forEach((car, i) => {
          const k = keysRef.current;
          const c = controls[i];
          let accel = 0;
          let turn = 0;
          if (i === 0) {
            if (k[c.up] || k[p1Alt.up]) accel = 1;
            if (k[c.down] || k[p1Alt.down]) accel = -1;
            if (k[c.left] || k[p1Alt.left]) turn = -1;
            if (k[c.right] || k[p1Alt.right]) turn = 1;
          } else {
            if (k[c.up]) accel = 1;
            if (k[c.down]) accel = -1;
            if (k[c.left]) turn = -1;
            if (k[c.right]) turn = 1;
          }

          const maxSpeed = 220;
          const accelRate = 180;
          const brakeRate = 260;
          const friction = 60;

          if (accel > 0) car.speed = Math.min(maxSpeed, car.speed + accelRate * dt);
          else if (accel < 0) car.speed = Math.max(-maxSpeed * 0.5, car.speed - brakeRate * dt);
          else {
            if (car.speed > 0) car.speed = Math.max(0, car.speed - friction * dt);
            else if (car.speed < 0) car.speed = Math.min(0, car.speed + friction * dt);
          }

          // Turning scales with speed
          const turnRate = 2.6 * (car.speed / maxSpeed);
          car.angle += turn * turnRate * dt;

          const nx = car.x + Math.cos(car.angle) * car.speed * dt;
          const ny = car.y + Math.sin(car.angle) * car.speed * dt;

          if (onTrack(nx, ny)) {
            car.x = nx;
            car.y = ny;
          } else {
            // Off-track: slow down hard but allow nudging back
            const sx = car.x + Math.cos(car.angle) * car.speed * dt * 0.3;
            const sy = car.y + Math.sin(car.angle) * car.speed * dt * 0.3;
            if (onTrack(sx, sy)) {
              car.x = sx;
              car.y = sy;
            }
            car.speed *= 0.85;
          }

          // Checkpoints: split track into 4 quadrants relative to center
          const ax = car.x - CX;
          const ay = car.y - CY;
          let quad = 0;
          if (ax >= 0 && ay < 0) quad = 0; // top-right
          else if (ax >= 0 && ay >= 0) quad = 1; // bottom-right
          else if (ax < 0 && ay >= 0) quad = 2; // bottom-left
          else quad = 3; // top-left

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
        force((n) => (n + 1) % 1000);
      }

      // Draw
      ctx.fillStyle = resolve("var(--grass)");
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      // Track
      ctx.fillStyle = resolve("var(--track)");
      ctx.beginPath();
      ctx.ellipse(CX, CY, OUTER_RX, OUTER_RY, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = resolve("var(--grass)");
      ctx.beginPath();
      ctx.ellipse(CX, CY, INNER_RX, INNER_RY, 0, 0, Math.PI * 2);
      ctx.fill();

      // Track edges
      ctx.strokeStyle = resolve("var(--track-line)");
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 12]);
      ctx.beginPath();
      ctx.ellipse(CX, CY, (OUTER_RX + INNER_RX) / 2, (OUTER_RY + INNER_RY) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Start/finish line
      ctx.fillStyle = "#fff";
      const lineX = CX;
      const lineTop = CY - OUTER_RY + (OUTER_RY - INNER_RY) * 0.05;
      const lineBot = CY - INNER_RY;
      for (let y = lineTop; y < lineBot; y += 12) {
        ctx.fillStyle = ((y / 12) | 0) % 2 === 0 ? "#fff" : "#111";
        ctx.fillRect(lineX - 18, y, 18, 12);
        ctx.fillStyle = ((y / 12) | 0) % 2 === 0 ? "#111" : "#fff";
        ctx.fillRect(lineX, y, 18, 12);
      }

      // Cars
      cars.forEach((car) => {
        ctx.save();
        ctx.translate(car.x, car.y);
        ctx.rotate(car.angle);
        ctx.fillStyle = resolve(car.color);
        ctx.fillRect(-14, -8, 28, 16);
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillRect(2, -6, 8, 12);
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(-12, -8, 4, 16);
        ctx.restore();
      });

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running, winner]);

  const cars = carsRef.current;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center py-6 gap-4">
      <h1 className="text-4xl font-bold tracking-tight">Course de bolides 2D</h1>
      <p className="text-muted-foreground text-sm">Premier à {TOTAL_LAPS} tours gagne</p>

      <div className="flex gap-8 text-sm">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-sm" style={{ background: "oklch(0.7 0.22 25)" }} />
          <span>P1 (Z Q S D) — tour {cars[0].lap}/{TOTAL_LAPS}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-sm" style={{ background: "oklch(0.75 0.18 230)" }} />
          <span>P2 (Flèches) — tour {cars[1].lap}/{TOTAL_LAPS}</span>
        </div>
      </div>

      <div className="relative rounded-xl overflow-hidden shadow-2xl border border-border">
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className="block" />
        {(countdown !== null || winner || !running) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            {winner ? (
              <div className="text-center">
                <div className="text-5xl font-bold mb-4">🏁 {winner} gagne !</div>
                <button
                  onClick={reset}
                  className="px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90"
                >
                  Rejouer
                </button>
              </div>
            ) : countdown !== null ? (
              <div className="text-8xl font-bold">{countdown === 0 ? "GO!" : countdown}</div>
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

      <div className="text-xs text-muted-foreground max-w-xl text-center">
        Joueur 1 : Z/Q/S/D (ou W/A/S/D) — Joueur 2 : flèches directionnelles.
        Restez sur la piste pour garder votre vitesse !
      </div>
    </div>
  );
}