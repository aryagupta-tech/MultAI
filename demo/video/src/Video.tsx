// The MultAI demo: narration-timed beats of real screen recordings, framed and zoomed onto the
// control that matters, with captions, model labels and a music bed. Everything is driven by
// timeline.json (built from edit.json, the cut shots and the HeyGen narration timings).
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Audio, Easing, Freeze, Img, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import timeline from './timeline.json';

type Rect = [number, number, number, number];
type Shot = { id: string; kind: string; label?: string; start: number; duration: number; zoom?: [number, Rect][]; mac?: { zoom: Rect } };
type Beat = { id: string; scene: string; start: number; length: number; voice: { file: string; at: number; duration: number; words: { word: string; start: number; end: number }[] }; shots: Shot[] };

const beats = timeline.beats as Beat[];
const FPS = timeline.fps;
const W = 1920, H = 1080;
const BLUE = '#2f7cff';
const FONT = '-apple-system, "SF Pro Display", "Inter", system-ui, sans-serif';
const ease = Easing.bezier(0.45, 0, 0.2, 1);
const sec = (s: number) => Math.round(s * FPS);

// ---------------------------------------------------------------- background
function Backdrop() {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 240) * 40;
  return (
    <AbsoluteFill style={{ background: '#05060a' }}>
      <AbsoluteFill style={{ background: `radial-gradient(900px 600px at ${18 + drift / 40}% 12%, rgba(47,124,255,0.22), transparent 70%), radial-gradient(800px 600px at ${85 - drift / 50}% 95%, rgba(124,58,237,0.16), transparent 70%)` }} />
      <AbsoluteFill style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)', backgroundSize: '64px 64px', maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)' }} />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------- footage
const ASPECT: Record<string, number> = { mac: 1.6, browser: 1.5625, phone: 1080 / 2340 };

function lerpRect(zoom: [number, Rect][] | undefined, p: number): Rect {
  if (!zoom?.length) return [0, 0, 1, 1];
  if (p <= zoom[0][0]) return zoom[0][1];
  for (let i = 1; i < zoom.length; i++) {
    const [t1, r1] = zoom[i], [t0, r0] = zoom[i - 1];
    if (p <= t1) {
      const k = ease((p - t0) / Math.max(0.0001, t1 - t0));
      return r0.map((v, j) => v + (r1[j] - v) * k) as Rect;
    }
  }
  return zoom[zoom.length - 1][1];
}

/** A clip that holds its last frame if the beat outlasts it. */
function Clip({ id, frames, style }: { id: string; frames: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const video = <OffthreadVideo src={staticFile(`media/clips/${id}.mp4`)} muted style={{ width: '100%', height: '100%', display: 'block', ...style }} />;
  return frame >= frames - 1 ? <Freeze frame={frames - 2}>{video}</Freeze> : video;
}

/** A screen recording in a window frame, zoomed onto rect (normalized to the recording). */
function Screen({ shot, length }: { shot: Shot; length: number }) {
  const frame = useCurrentFrame();
  const p = Math.min(1, frame / Math.max(1, sec(shot.duration)));
  const [rx, ry, rw, rh] = lerpRect(shot.zoom, p);
  const aspect = ASPECT[shot.kind] ?? 1.6;
  const boxW = 1640, boxH = boxW / aspect;
  const left = (W - boxW) / 2, top = (H - boxH) / 2 - 20;
  const scale = Math.min(3.2, Math.max(1, Math.min((W * 0.9) / (rw * boxW), (H * 0.8) / (rh * boxH))));
  const cx = left + (rx + rw / 2) * boxW, cy = top + (ry + rh / 2) * boxH;
  const targetX = W / 2, targetY = H / 2 - 30;
  const tx = targetX - (left + (cx - left) * scale), ty = targetY - (top + (cy - top) * scale);
  const appear = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity: appear }}>
      <div style={{ position: 'absolute', left, top, width: boxW, height: boxH, transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        borderRadius: 14, overflow: 'hidden', boxShadow: '0 40px 120px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.09)', background: '#000' }}>
        <Clip id={shot.id} frames={sec(shot.duration)} />
      </div>
      <Sequence from={0} durationInFrames={length}><Label text={shot.label} /></Sequence>
    </AbsoluteFill>
  );
}

function PhoneFrame({ children, height = 840 }: { children: ReactNode; height?: number }) {
  const width = height * ASPECT.phone;
  return (
    <div style={{ width: width + 28, height: height + 28, borderRadius: 58, padding: 14, background: 'linear-gradient(145deg, #2a2d34, #0d0f13)', boxShadow: '0 50px 140px rgba(0,0,0,0.7), 0 0 0 2px rgba(255,255,255,0.08)' }}>
      <div style={{ width, height, borderRadius: 46, overflow: 'hidden', background: '#000' }}>{children}</div>
    </div>
  );
}

function Phone({ shot, length }: { shot: Shot; length: number }) {
  const frame = useCurrentFrame();
  const rise = spring({ frame, fps: FPS, config: { damping: 200 } });
  const withMac = Boolean(shot.mac);
  const macRect = shot.mac?.zoom ?? [0, 0, 1, 1];
  const macW = 1640 * 0.62, macH = macW / 1.6;
  const s = Math.min(2.6, (macW * 0.95) / (macRect[2] * macW));
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 70, paddingBottom: 90 }}>
        <div style={{ transform: `translateY(${(1 - rise) * 60}px)`, opacity: rise }}>
          <PhoneFrame><Clip id={shot.id} frames={sec(shot.duration)} style={{ objectFit: 'cover' }} /></PhoneFrame>
        </div>
        {withMac && (
          <div style={{ opacity: interpolate(frame, [4, 14], [0, 1], { extrapolateRight: 'clamp' }) }}>
            <div style={{ fontFamily: FONT, color: 'rgba(255,255,255,0.6)', fontSize: 24, marginBottom: 14, letterSpacing: 0.3 }}>On the Mac</div>
            <div style={{ width: macW, height: macH * 0.62, borderRadius: 18, overflow: 'hidden', boxShadow: '0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.1)', position: 'relative', background: '#000' }}>
              <div style={{ position: 'absolute', width: macW, height: macH, transformOrigin: '0 0', transform: `scale(${s}) translate(${-macRect[0] * macW}px, ${-macRect[1] * macH}px)` }}>
                <Clip id={`${shot.id}-mac`} frames={sec(shot.duration)} />
              </div>
            </div>
          </div>
        )}
      </AbsoluteFill>
      <Sequence from={0} durationInFrames={length}><Label text={shot.label} /></Sequence>
    </AbsoluteFill>
  );
}

function Label({ text }: { text?: string }) {
  const frame = useCurrentFrame();
  if (!text) return null;
  const show = spring({ frame: frame - 4, fps: FPS, config: { damping: 200 } });
  return (
    <div style={{ position: 'absolute', left: 64, top: 52, display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', borderRadius: 999,
      background: 'rgba(10,12,18,0.78)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(14px)', fontFamily: FONT, fontSize: 28, fontWeight: 600,
      color: '#fff', letterSpacing: 0.2, opacity: show, transform: `translateX(${(1 - show) * -24}px)` }}>
      <span style={{ width: 12, height: 12, borderRadius: 6, background: BLUE, boxShadow: `0 0 16px ${BLUE}` }} />
      {text}
    </div>
  );
}

// ---------------------------------------------------------------- captions
function captionGroups(words: Beat['voice']['words']) {
  const groups: { text: string; start: number; end: number }[] = [];
  let current: typeof words = [];
  const flush = () => { if (current.length) groups.push({ text: current.map((w) => w.word).join(' '), start: current[0].start, end: current[current.length - 1].end }); current = []; };
  for (const w of words) {
    current.push(w);
    if (/[.,:?!]$/.test(w.word) && current.length >= 3 || current.length >= 8) flush();
  }
  flush();
  return groups;
}

function Captions({ beat }: { beat: Beat }) {
  const frame = useCurrentFrame();
  const t = frame / FPS - beat.voice.at;
  const groups = captionGroups(beat.voice.words);
  const g = groups.find((x, i) => t >= x.start - 0.05 && t < (groups[i + 1]?.start ?? x.end + 0.6));
  if (!g) return null;
  const into = interpolate(t, [g.start - 0.05, g.start + 0.12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 46 }}>
      <div style={{ maxWidth: 1500, padding: '14px 30px', borderRadius: 16, background: 'rgba(0,0,0,0.62)', fontFamily: FONT, fontSize: 40, fontWeight: 600,
        color: '#fff', textAlign: 'center', lineHeight: 1.25, opacity: into, transform: `translateY(${(1 - into) * 8}px)`, letterSpacing: 0.1 }}>{g.text}</div>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------- scenes
const BUBBLES = [
  { at: 2.7, side: 0, text: 'hey, can you look at this?' },
  { at: 3.5, side: 0, image: true },
  { at: 4.6, side: 1, text: 'what did the agent already try?' },
  { at: 5.6, side: 0, text: 'idk, it changed cart.js I think' },
  { at: 6.5, side: 1, text: 'which branch? can you paste the logs?' },
  { at: 7.4, side: 0, image: true },
  { at: 8.2, side: 1, text: 'ok… explain it from the start' },
];

function Hook() {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const title = spring({ frame: frame - 6, fps: FPS, config: { damping: 200 } });
  const shrink = interpolate(t, [2.2, 3.0], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  const out = interpolate(t, [10.2, 11], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ fontFamily: FONT, fontWeight: 700, color: '#fff', fontSize: 104 - shrink * 44, letterSpacing: -2, textAlign: 'center', lineHeight: 1.05,
          transform: `translateY(${-shrink * 370}px)`, opacity: title }}>
          AI coding agents are <span style={{ color: BLUE }}>single-player.</span>
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 360, right: 360, top: 250, bottom: 150, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 16, overflow: 'hidden' }}>
        {BUBBLES.filter((b) => t >= b.at).map((b, i) => {
          const pop = spring({ frame: frame - sec(b.at), fps: FPS, config: { damping: 14, stiffness: 160 } });
          return (
            <div key={i} style={{ alignSelf: b.side ? 'flex-end' : 'flex-start', transform: `scale(${0.6 + pop * 0.4})`, opacity: pop, transformOrigin: b.side ? 'right bottom' : 'left bottom' }}>
              {b.image ? (
                <div style={{ padding: 8, borderRadius: 18, background: '#1d2230' }}><Img src={staticFile('media/shop.png')} style={{ width: 300, borderRadius: 12, display: 'block' }} /></div>
              ) : (
                <div style={{ fontFamily: FONT, fontSize: 34, color: '#fff', padding: '16px 24px', borderRadius: 22, background: b.side ? BLUE : '#1d2230', maxWidth: 760 }}>{b.text}</div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function Mark({ size, progress }: { size: number; progress: number }) {
  const layer = (i: number) => interpolate(progress, [i * 0.18, i * 0.18 + 0.45], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.back(1.6)) });
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {[6, 2, -2].map((dy, i) => (
        <path key={i} d="M16 21.5 4.5 15.75 16 10l11.5 5.75L16 21.5Z" transform={`translate(0 ${dy - (1 - layer(i)) * 10})`} opacity={layer(i) * [0.25, 0.55, 1][i]} fill={i === 2 ? '#fff' : '#9fb7ff'} />
      ))}
    </svg>
  );
}

function Reveal() {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const mark = interpolate(t, [0.1, 1.6], [0, 1], { extrapolateRight: 'clamp' });
  const word = spring({ frame: frame - sec(1.0), fps: FPS, config: { damping: 200 } });
  const tag = spring({ frame: frame - sec(2.4), fps: FPS, config: { damping: 200 } });
  const meta = spring({ frame: frame - sec(5.0), fps: FPS, config: { damping: 200 } });
  const out = interpolate(t, [7.8, 8.5], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', fontFamily: FONT, color: '#fff', opacity: out }}>
      <div style={{ filter: `drop-shadow(0 0 60px rgba(47,124,255,${0.5 * mark}))` }}><Mark size={220} progress={mark} /></div>
      <div style={{ fontSize: 128, fontWeight: 800, letterSpacing: -4, marginTop: 6, opacity: word, transform: `translateY(${(1 - word) * 30}px)` }}>Mult<span style={{ color: BLUE }}>AI</span></div>
      <div style={{ fontSize: 44, fontWeight: 500, color: 'rgba(255,255,255,0.86)', marginTop: 18, opacity: tag, transform: `translateY(${(1 - tag) * 20}px)` }}>One AI coding agent. Shared by your whole team. Live.</div>
      <div style={{ marginTop: 40, display: 'flex', alignItems: 'center', gap: 14, padding: '12px 26px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.14)', fontSize: 28, color: 'rgba(255,255,255,0.85)', opacity: meta }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: BLUE }} /> Built on Meta's Muse models
      </div>
    </AbsoluteFill>
  );
}

const MODELS = ['Muse Spark 1.3', 'Muse Wonder 1.0', 'SAM 3.1', 'Muse Voice Transcribe', 'Muse Glimmer · local'];
const PROMISES = ['Code, keys and terminal stay on the host', 'Every change waits for approval', 'Phone requests are signed and checked again'];

function Close() {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const first = interpolate(t, [4.4, 5.0], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const end = spring({ frame: frame - sec(5.0), fps: FPS, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ fontFamily: FONT, color: '#fff' }}>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 26, opacity: first }}>
        {PROMISES.map((text, i) => {
          const s = spring({ frame: frame - sec(0.3 + i * 0.6), fps: FPS, config: { damping: 200 } });
          return (
            <div key={text} style={{ fontSize: 56, fontWeight: 700, letterSpacing: -1, opacity: s, transform: `translateY(${(1 - s) * 24}px)`, display: 'flex', alignItems: 'center', gap: 24 }}>
              <span style={{ width: 16, height: 16, borderRadius: 8, background: BLUE, boxShadow: `0 0 20px ${BLUE}` }} />{text}
            </div>
          );
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: end }}>
        <Mark size={150} progress={1} />
        <div style={{ fontSize: 112, fontWeight: 800, letterSpacing: -4 }}>Mult<span style={{ color: BLUE }}>AI</span></div>
        <div style={{ fontSize: 46, fontWeight: 600, marginTop: 8, color: 'rgba(255,255,255,0.9)' }}>Build with AI, together.</div>
        <div style={{ display: 'flex', gap: 14, marginTop: 44, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 1500 }}>
          {MODELS.map((m, i) => {
            const s = spring({ frame: frame - sec(5.6 + i * 0.18), fps: FPS, config: { damping: 200 } });
            return <div key={m} style={{ fontSize: 26, padding: '10px 22px', borderRadius: 999, background: 'rgba(47,124,255,0.14)', border: '1px solid rgba(47,124,255,0.45)', opacity: s, transform: `scale(${0.9 + s * 0.1})` }}>{m}</div>;
          })}
        </div>
        <div style={{ marginTop: 46, fontSize: 30, color: 'rgba(255,255,255,0.75)', letterSpacing: 0.3 }}>app.multai.si  ·  github.com/aryagupta-tech/MultAI</div>
        <div style={{ marginTop: 12, fontSize: 24, color: 'rgba(255,255,255,0.5)' }}>macOS · Android · Web  ·  Meta Global AI Developer Hackathon</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------- assembly
function BeatView({ beat }: { beat: Beat }) {
  const length = sec(beat.length);
  return (
    <AbsoluteFill>
      {beat.scene === 'hook' && <Hook />}
      {beat.scene === 'reveal' && <Reveal />}
      {beat.scene === 'close' && <Close />}
      {beat.shots.map((shot, i) => {
        const from = sec(shot.start);
        const isLast = i === beat.shots.length - 1;
        const duration = isLast ? length - from : sec(shot.duration);
        return (
          <Sequence key={shot.id} from={from} durationInFrames={duration}>
            {shot.kind === 'phone' ? <Phone shot={shot} length={duration} /> : <Screen shot={shot} length={duration} />}
          </Sequence>
        );
      })}
      <Sequence from={sec(beat.voice.at)}><Audio src={staticFile(`media/${beat.voice.file}`)} volume={1} /></Sequence>
      <Captions beat={beat} />
    </AbsoluteFill>
  );
}

function Music({ total, speechAt }: { total: number; speechAt: (t: number) => boolean }) {
  return (
    <Audio src={staticFile('media/music/music.mp3')} volume={(f) => {
      const t = f / FPS;
      const fade = Math.min(1, t / 1.2, Math.max(0, (total - t) / 2.5));
      return fade * (speechAt(t) ? 0.075 : 0.2);
    }} />
  );
}

function Program({ list }: { list: Beat[] }) {
  let at = 0;
  const placed = list.map((beat) => { const start = at; at += beat.length; return { beat, start }; });
  const speechAt = (t: number) => placed.some(({ beat, start }) => t >= start + beat.voice.at - 0.2 && t <= start + beat.voice.at + beat.voice.duration + 0.3);
  return (
    <AbsoluteFill>
      <Backdrop />
      {placed.map(({ beat, start }) => (
        <Sequence key={beat.id} from={sec(start)} durationInFrames={sec(beat.length)}><BeatView beat={beat} /></Sequence>
      ))}
      <Music total={at} speechAt={speechAt} />
    </AbsoluteFill>
  );
}

export const TEASER_BEATS = ['01-hook', '02-reveal', '04-look', '08-phone', '10-close'];
export const teaserLength = (ids: string[]) => beats.filter((b) => ids.includes(b.id)).reduce((sum, b) => sum + b.length, 0);
export const Main = () => <Program list={beats} />;
export const Teaser = () => <Program list={beats.filter((b) => TEASER_BEATS.includes(b.id))} />;
