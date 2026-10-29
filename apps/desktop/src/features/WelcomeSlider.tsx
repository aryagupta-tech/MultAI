import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { cx } from '../ui/primitives';
import { ParticleField } from '../ui/ParticleField';

// The welcome hero: four slides about the product, with the stacked-layer mark drawn as real 3D
// slabs (Host, Worktree, Conversation, Agent) that pull apart differently on each slide.

const SLIDES = [
  {
    tab: 'Shared',
    title: 'One agent.\nThe whole team.',
    body: 'Work on the **same AI coding session** together. Everyone sees the conversation, decisions and changes **as they happen**.',
    capHead: '04 — Agent',
    cap: 'One session and one agent, with every teammate’s direction attributed.',
  },
  {
    tab: 'Context',
    title: 'Join mid-task,\nnot from scratch.',
    body: 'Pick up a teammate’s session with its **full context**: objective, saved decisions, activity and the **current diff**.',
    capHead: '03 — Conversation',
    cap: 'Ordered, attributed history that every participant can replay.',
  },
  {
    tab: 'Local',
    title: 'Your code stays\non your machine.',
    body: 'The host’s computer **keeps the files and runs the agent**. Each chat gets its own **private worktree**, so your checkout is never touched.',
    capHead: '01 — Host',
    cap: 'Teammates can direct the work without getting your files or shell.',
  },
  {
    tab: 'Approval',
    title: 'Every command,\napproved exactly.',
    body: 'Before anything runs, the host sees the **exact command, folder and connection**. Change one argument and it **needs approval again**.',
    capHead: 'Approval',
    cap: 'Bound to one command, one run and one host. Used once.',
  },
] as const;

const LAYERS = [
  { name: 'Host', lines: [72, 48, 60, 30] },
  { name: 'Worktree', lines: [64, 82, 40, 70, 52] },
  { name: 'Conversation', lines: [80, 56, 68, 44] },
  { name: 'Agent', lines: [58, 76, 36] },
] as const;

type Pose = { layers: [x: number, y: number, z: number, rot: number][]; lit: number; keyLift: number; keyRot: number };

// Per slide: where each slab sits, which one is lit, and how far the approval key rises.
const POSES: Pose[] = [
  { layers: [[0, 0, 0, 0], [0, 0, 34, 0], [0, 0, 68, 0], [0, 0, 102, 0]], lit: 3, keyLift: 0, keyRot: 0 },
  { layers: [[0, 0, 0, 0], [18, -18, 95, -6], [36, -36, 190, -12], [54, -54, 285, -18]], lit: 2, keyLift: 0, keyRot: 0 },
  { layers: [[0, 0, 0, 0], [-70, -70, 190, 4], [-90, -90, 240, 8], [-110, -110, 290, 12]], lit: 0, keyLift: 0, keyRot: 0 },
  { layers: [[0, 0, 0, 0], [0, 0, 46, 10], [0, 0, 92, 20], [0, 0, 138, 30]], lit: 3, keyLift: 120, keyRot: -30 },
];

const pad = (n: number) => String(n).padStart(3, '0');

// Body copy marks its key phrases with **…**; render those bold.
const emphasize = (text: string) => text.split('**').map((part, n) => (n % 2 ? <strong key={n}>{part}</strong> : part));

export function WelcomeSlider({ brand, action, footer }: { brand: ReactNode; action: ReactNode; footer: ReactNode }) {
  const [index, setIndex] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const go = (n: number) => setIndex((n + SLIDES.length) % SLIDES.length);
  const pose = POSES[index] ?? POSES[0]!;

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTilt({ x: (e.clientX - r.left) / r.width - 0.5, y: (e.clientY - r.top) / r.height - 0.5 });
  };

  // Arrow keys move between slides while focus is inside the slider (never while typing).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || (e.target as HTMLElement).closest('input, textarea')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
  };

  const phase = (k: number) => (k === index ? 'is-current' : k < index ? 'is-before' : 'is-after');

  return (
    <div className="slider" onPointerMove={onPointerMove} onKeyDown={onKeyDown}>
      <header className="slider-top">
        <div className="slider-brand">{brand}</div>
        <nav className="slider-tabs no-drag" aria-label="Welcome slides">
          {SLIDES.map((s, k) => (
            <button key={s.tab} type="button" className={cx('slider-tab', k === index && 'is-current')} aria-current={k === index ? 'step' : undefined} onClick={() => go(k)}>
              {s.tab}
            </button>
          ))}
        </nav>
        <span className="slider-build">Development build</span>
      </header>

      <main className="slider-main">
        <section className="slider-copy no-drag" aria-roledescription="carousel" aria-label="About MultAI">
          <span className="slider-count" aria-live="polite">{pad(index + 1)} / {pad(SLIDES.length)}</span>
          <div className="slider-stack slider-titles">
            {SLIDES.map((s, k) => (
              <h1 key={s.tab} className={cx('slider-title', phase(k))} aria-hidden={k !== index}>
                {s.title.split('\n').map((line, n) => <span key={n} className={cx(n === 0 && 'is-outline')}>{line}</span>)}
              </h1>
            ))}
          </div>
          <div className="slider-stack slider-bodies">
            {SLIDES.map((s, k) => (
              <p key={s.tab} className={cx('slider-body', phase(k))} aria-hidden={k !== index}>{emphasize(s.body)}</p>
            ))}
          </div>
          <div className="slider-action">{action}</div>
        </section>

        <section className="slider-stage" aria-hidden>
          <ParticleField slide={index} />
          <div className="rig" style={{ transform: `rotateX(${56 - tilt.y * 8}deg) rotateZ(${-38 + tilt.x * 14}deg)` }}>
            <div className="rig-shadow" />
            {LAYERS.map((layer, k) => {
              const [x, y, z, r] = pose.layers[k] ?? [0, 0, 0, 0];
              return (
                <div
                  key={layer.name}
                  className={cx('slab', pose.lit === k && 'is-lit')}
                  style={{ transform: `translate3d(${x}px, ${y}px, ${z}px) rotateZ(${r}deg)`, transitionDelay: `${k * 60}ms` }}
                >
                  <i className="slab-side slab-back" />
                  <i className="slab-side slab-front" />
                  <i className="slab-side slab-left" />
                  <i className="slab-side slab-right" />
                  <div className="slab-top">
                    <span className="slab-label">{pad(k + 1).slice(1)} — {layer.name}</span>
                    {layer.lines.map((w, n) => <span key={n} className="slab-line" style={{ width: `${w}%` }} />)}
                  </div>
                  {k === LAYERS.length - 1 && (
                    <div className={cx('key', pose.keyLift > 0 && 'is-raised')} style={{ transform: `translateZ(${22 + pose.keyLift}px) rotateZ(${pose.keyRot}deg)` }}>
                      <i className="key-side key-back" />
                      <i className="key-side key-front" />
                      <i className="key-side key-left" />
                      <i className="key-side key-right" />
                      <div className="key-top"><Check size={26} strokeWidth={2.4} /></div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="slider-stack slider-captions">
            {SLIDES.map((s, k) => (
              <p key={s.tab} className={cx('slider-caption', phase(k))}><span>{s.capHead}</span>{s.cap}</p>
            ))}
          </div>
        </section>
      </main>

      <footer className="slider-bottom">
        <button type="button" className="slider-step no-drag" onClick={() => go(index - 1)}><ArrowLeft size={16} strokeWidth={1.6} aria-hidden />Back</button>
        <div className="slider-progress no-drag">
          {SLIDES.map((s, k) => (
            <button key={s.tab} type="button" className="slider-pip" aria-label={`Go to slide ${k + 1}: ${s.tab}`} onClick={() => go(k)}>
              <span className={cx(k <= index && 'is-filled')} />
            </button>
          ))}
        </div>
        <button type="button" className="slider-step no-drag" onClick={() => go(index + 1)}>Next<ArrowRight size={16} strokeWidth={1.6} aria-hidden /></button>
      </footer>
      <div className="slider-meta no-drag">{footer}</div>
    </div>
  );
}
