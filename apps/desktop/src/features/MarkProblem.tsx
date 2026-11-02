// "Point at the bug": click the broken element on an attached screenshot, or drag a box around it. With a
// Meta connection, SAM 3.1 finds the element's exact bounds from one click. The outline is drawn into the
// screenshot itself, so every model sees it.
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Crosshair, Loader2 } from 'lucide-react';
import { getBridge } from '../bridge/client';
import { useApp } from '../model/store';
import { describe } from '../live/controller';
import { Button, Dialog } from '../ui/primitives';
import { toScreenshot } from './screenshot';

export interface Box { x1: number; y1: number; x2: number; y2: number }

/** A box around a click when no outline is available: 12% of the image each way, inside its edges. */
export function boxAround(x: number, y: number, width: number, height: number): Box {
  const half = { w: Math.max(12, Math.round(width * 0.06)), h: Math.max(12, Math.round(height * 0.06)) };
  return { x1: Math.max(0, x - half.w), y1: Math.max(0, y - half.h), x2: Math.min(width - 1, x + half.w), y2: Math.min(height - 1, y + half.h) };
}

/** Two corners in any order as a box, clamped to the image. */
export function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }, width: number, height: number): Box {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value)));
  return { x1: clamp(Math.min(a.x, b.x), width - 1), y1: clamp(Math.min(a.y, b.y), height - 1), x2: clamp(Math.max(a.x, b.x), width - 1), y2: clamp(Math.max(a.y, b.y), height - 1) };
}

/** The screenshot with a red outline around the box, compressed like any attached screenshot. */
async function outlined(image: string, box: Box): Promise<string> {
  const picture = new Image();
  picture.src = image;
  await picture.decode();
  const canvas = document.createElement('canvas');
  canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
  const context = canvas.getContext('2d')!;
  context.drawImage(picture, 0, 0);
  const line = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 300));
  const pad = line * 2;
  context.strokeStyle = '#ff2d55'; context.lineWidth = line;
  context.strokeRect(Math.max(0, box.x1 - pad), Math.max(0, box.y1 - pad), box.x2 - box.x1 + pad * 2, box.y2 - box.y1 + pad * 2);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('The outline couldn’t be drawn.'))), 'image/png'));
  return toScreenshot(blob);
}

export function MarkProblem({ image, open, onClose, onDone }: { image: string; open: boolean; onClose: () => void; onDone: (image: string, note: string) => void }) {
  const picture = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [source, setSource] = useState<'sam' | 'hand' | null>(null);
  const [busy, setBusy] = useState(false);
  const [sam, setSam] = useState(false);
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; now: { x: number; y: number } } | null>(null);
  const toast = useApp.getState().toast;
  useEffect(() => {
    if (!open) return;
    setBox(null); setSource(null); setDrag(null);
    void getBridge()?.inference.segmentAvailable().then((result) => setSam(Boolean(result?.ok && result.value)));
  }, [open, image]);
  const at = (event: PointerEvent) => {
    const rect = picture.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * (size?.width ?? 1), y: ((event.clientY - rect.top) / rect.height) * (size?.height ?? 1) };
  };
  const click = async (point: { x: number; y: number }) => {
    if (!size) return;
    const x = Math.min(size.width - 1, Math.max(0, Math.round(point.x))), y = Math.min(size.height - 1, Math.max(0, Math.round(point.y)));
    if (!sam) { setBox(boxAround(x, y, size.width, size.height)); setSource('hand'); return; }
    setBusy(true);
    try {
      const result = await getBridge()!.inference.segment(image, { x, y, width: size.width, height: size.height });
      if (result.ok && result.value) { setBox(result.value); setSource('sam'); return; }
      if (!result.ok) toast(describe(result.error), 'error');
      else toast('SAM 3.1 didn’t find an element there. Drag a box around the problem instead.', 'info');
      setBox(boxAround(x, y, size.width, size.height)); setSource('hand');
    } finally { setBusy(false); }
  };
  const finish = async () => {
    if (!box) return;
    setBusy(true);
    try { onDone(await outlined(image, box), source === 'sam' ? 'The problem is outlined in red on the screenshot (found by SAM 3.1).' : 'The problem is outlined in red on the screenshot.'); onClose(); }
    catch (error) { toast(error instanceof Error ? error.message : 'The outline couldn’t be drawn.', 'error'); }
    finally { setBusy(false); }
  };
  const shown = drag && size ? boxFrom(drag.start, drag.now, size.width, size.height) : box;
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;
  return (
    <Dialog open={open} onClose={onClose} title="Point at the problem" width={760}
      description={sam ? 'Click the broken element and SAM 3.1 outlines it, or drag a box around it yourself. The outline goes into the screenshot the agent sees.' : 'Click the broken element or drag a box around it. The outline goes into the screenshot the agent sees. With a Meta connection, SAM 3.1 finds the element’s exact edges from one click.'}>
      <div className="dialog-body">
        <div className="mark-stage" onPointerDown={(event) => { if (!size || busy) return; event.currentTarget.setPointerCapture(event.pointerId); const point = at(event); setDrag({ start: point, now: point }); }}
          onPointerMove={(event) => { if (drag) setDrag({ ...drag, now: at(event) }); }}
          onPointerUp={(event) => {
            if (!drag || !size) return;
            const end = at(event); setDrag(null);
            const moved = Math.hypot(end.x - drag.start.x, end.y - drag.start.y) / Math.max(size.width, size.height);
            if (moved > 0.01) { setBox(boxFrom(drag.start, end, size.width, size.height)); setSource('hand'); } else void click(end);
          }}>
          <img ref={picture} src={image} alt="Screenshot to mark" draggable={false} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          {shown && size && <span className={`mark-box${source === 'sam' && !drag ? ' is-sam' : ''}`} style={{ left: pct(shown.x1, size.width), top: pct(shown.y1, size.height), width: pct(shown.x2 - shown.x1 + 1, size.width), height: pct(shown.y2 - shown.y1 + 1, size.height) }} />}
          {busy && <span className="mark-busy"><Loader2 size={14} className="spin" aria-hidden /> {sam ? 'SAM 3.1 is looking…' : 'Drawing…'}</span>}
        </div>
        <p className="field-help">{box ? (source === 'sam' ? 'SAM 3.1 outlined this element. Click elsewhere to try again.' : 'Outlined by hand. Click or drag again to change it.') : 'Nothing marked yet.'}</p>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Crosshair} disabled={!box || busy} onClick={() => void finish()}>Use this outline</Button>
        </div>
      </div>
    </Dialog>
  );
}
