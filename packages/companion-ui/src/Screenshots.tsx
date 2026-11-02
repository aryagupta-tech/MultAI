// A screenshot the host chose to share, with a rectangle marked by drag (touch, pen or mouse). The
// region is kept in normalized 0–1 coordinates and clamped to the image, exactly as the service checks.
import {useRef, useState, type PointerEvent} from 'react';
import type {Region, SharedScreenshot} from '@multai/companion-core';
import {Button, Field} from './ui';
import {useRequestId} from './hooks';

const clamp = (value: number) => Math.min(1, Math.max(0, value));
/** Normalizes a drag into a region inside the image, or null when it is too small to mean anything. */
export function regionFrom(a: {x: number; y: number}, b: {x: number; y: number}): Region | null {
  const x = clamp(Math.min(a.x, b.x)), y = clamp(Math.min(a.y, b.y));
  const width = Math.min(1 - x, clamp(Math.max(a.x, b.x)) - x), height = Math.min(1 - y, clamp(Math.max(a.y, b.y)) - y);
  if (width < 0.01 || height < 0.01) return null;
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  const region = {x: round(x), y: round(y), width: round(width), height: round(height)};
  // Rounding must never push the box past the edge.
  if (region.x + region.width > 1) region.width = round(1 - region.x);
  if (region.y + region.height > 1) region.height = round(1 - region.y);
  return region;
}

export function ScreenshotMarker({shot, onSubmit, disabled}: {shot: SharedScreenshot; disabled?: boolean; onSubmit: (input: {requestId: string; text: string; screenshotId: string; region: Region}) => Promise<void>}) {
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<{x: number; y: number} | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId, renew] = useRequestId(`${shot.id}:${JSON.stringify(region)}:${text}`);
  const point = (event: PointerEvent) => {
    const rect = box.current!.getBoundingClientRect();
    return {x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height)};
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = point(event);
    setRegion(null);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {if (start.current) setRegion(regionFrom(start.current, point(event)));};
  const up = (event: PointerEvent<HTMLDivElement>) => {if (start.current) setRegion(regionFrom(start.current, point(event))); start.current = null;};
  const send = async () => {
    if (!region || !text.trim()) return;
    setBusy(true);
    try {await onSubmit({requestId, text: text.trim(), screenshotId: shot.id, region}); setText(''); setRegion(null); renew();}
    finally {setBusy(false);}
  };
  const id = `shot-${shot.id}`;
  return (
    <figure className="c-shot">
      <figcaption>{shot.label}</figcaption>
      <div ref={box} className="c-shot-frame" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => {start.current = null;}}
        role="img" aria-label={`${shot.label}. Drag on the image to mark the problem.`}>
        <img src={shot.image} alt="" draggable={false} />
        {region && <div className="c-mark" style={{left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%`}} aria-hidden />}
      </div>
      <div className="c-row">
        <Button variant="ghost" onClick={() => setRegion({x: 0, y: 0, width: 1, height: 1})} disabled={disabled}>Mark the whole screenshot</Button>
        {region && <span className="c-muted" aria-live="polite">Marked {Math.round(region.width * 100)}% × {Math.round(region.height * 100)}% of the image</span>}
      </div>
      <Field id={id} label="What’s wrong here?">
        <textarea id={id} rows={2} maxLength={4000} value={text} onChange={event => setText(event.target.value)} disabled={disabled} enterKeyHint="send" />
      </Field>
      <Button variant="primary" busy={busy} disabled={disabled || !region || !text.trim()} onClick={() => void send()}>Send marked feedback</Button>
    </figure>
  );
}
