// Drag the sidebar's right edge to resize it; double-click to reset. Arrow keys work when focused.
// The width is remembered on this device.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

const KEY = 'multai.sidebar-width.v1';
const MIN = 200;
const MAX = 440;
const DEFAULT = 256;
const clamp = (value: number) => Math.round(Math.min(MAX, Math.max(MIN, value)));

function apply(width: number | null): void {
  if (width === null) document.documentElement.style.removeProperty('--sidebar-w');
  else document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
}
function stored(): number | null {
  try { const value = Number(localStorage.getItem(KEY)); return Number.isFinite(value) && value > 0 ? clamp(value) : null; } catch { return null; }
}
function save(width: number | null): void {
  try { if (width === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(width)); } catch { /* per-device convenience only */ }
}

export function SidebarResizer() {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => { apply(stored()); }, []);
  const current = () => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? DEFAULT;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: current() };
    document.body.classList.add('is-resizing');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    apply(clamp(drag.current.startWidth + e.clientX - drag.current.startX));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove('is-resizing');
    save(clamp(current()));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 16;
    const delta = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (!delta) return;
    e.preventDefault();
    const next = clamp(current() + delta);
    apply(next); save(next);
  };

  return (
    <div
      className="sidebar-resizer no-drag"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => { apply(null); save(null); }}
      onKeyDown={onKeyDown}
    />
  );
}
