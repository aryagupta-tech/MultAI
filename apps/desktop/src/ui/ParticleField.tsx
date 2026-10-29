import { useEffect, useRef } from 'react';

// A slow orbiting cloud of points around the welcome stack, plus faint background stars.
// Drawn on one canvas from theme colors; motion stops when reduced motion is on.

type Dot = { a: number; r: number; h: number; s: number; tone: number; tw: number };

const COUNT = 420;
const STARS = 140;
// Orbit radius (relative to the canvas's shorter side) for each slide.
const SPREAD = [0.42, 0.5, 0.46, 0.38];

function reducedMotion() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'reduce') return true;
  if (pref === 'full') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ParticleField({ slide }: { slide: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const slideRef = useRef(slide);
  slideRef.current = slide;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const rand = (min: number, max: number) => min + Math.random() * (max - min);
    const dots: Dot[] = Array.from({ length: COUNT }, () => ({
      a: rand(0, Math.PI * 2),
      r: Math.pow(Math.random(), 0.6) * 0.45 + 0.55,
      h: rand(-1, 1) * rand(0, 1),
      s: rand(0.6, 1.4),
      tone: Math.random(),
      tw: rand(0, Math.PI * 2),
    }));
    const stars = Array.from({ length: STARS }, () => ({ x: Math.random(), y: Math.random(), s: rand(0.4, 1.2), tw: rand(0, Math.PI * 2) }));

    let w = 0, h = 0, dpr = 1, spread = SPREAD[slideRef.current] ?? 0.42, frame = 0, t = 0;
    let accent = '#a78bfa', ink = '#ededf0';
    const still = reducedMotion();

    const readColors = () => {
      const css = getComputedStyle(canvas);
      accent = css.getPropertyValue('--accent').trim() || accent;
      ink = css.getPropertyValue('--text').trim() || ink;
    };
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      readColors();
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const target = SPREAD[slideRef.current] ?? 0.42;
      spread += (target - spread) * 0.04;
      const cx = w * 0.5, cy = h * 0.58, base = Math.min(w, h) * spread;

      for (const s of stars) {
        ctx.globalAlpha = 0.18 + 0.18 * Math.sin(t * 0.6 + s.tw);
        ctx.fillStyle = ink;
        ctx.fillRect(s.x * w, s.y * h, s.s, s.s);
      }

      for (const d of dots) {
        const a = d.a + t * 0.05 * d.s;
        const x = Math.cos(a) * base * d.r;
        const z = Math.sin(a) * base * d.r;
        // Tilted orbit: depth pushes points up and fades the far side.
        const px = cx + x;
        const py = cy + z * 0.32 + d.h * base * 0.22 - base * 0.25;
        const near = (Math.sin(a) + 1) / 2;
        ctx.globalAlpha = (0.15 + near * 0.6) * (0.7 + 0.3 * Math.sin(t * 1.4 + d.tw));
        ctx.fillStyle = d.tone > 0.72 ? accent : ink;
        const size = (0.6 + near * 1.3) * d.s;
        ctx.fillRect(px, py, size, size);
      }
      ctx.globalAlpha = 1;
    };

    const loop = () => {
      t += 1 / 60;
      draw();
      frame = requestAnimationFrame(loop);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    // Theme changes swap the token values; pick them up on the next frame.
    const mo = new MutationObserver(readColors);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (still) draw(); else frame = requestAnimationFrame(loop);

    return () => { cancelAnimationFrame(frame); ro.disconnect(); mo.disconnect(); };
  }, []);

  return <canvas ref={ref} className="particle-field" aria-hidden />;
}
