// YouTube thumbnail (render at 1920x1080, downscale to 1280x720): the headline on the left, the
// real Mac app with SAM 3.1's box on the Pay button magnified, and the phone approving a step.
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { Backdrop, BLUE, FONT, Mark, PhoneFrame } from './Video';

const MAC = staticFile('media/thumb/mac.png'); // 2880x1800 frame of look-hero
const PHONE = staticFile('media/thumb/phone.png'); // 720x1560 frame of phone-approve

const MAC_W = 1060; // shown width of the cropped window
const CROP_W = 2150; // source pixels kept from the left of the window
const S = MAC_W / CROP_W;
const MAC_POS = { left: 790, top: 120 };

function Chip({ style, children }: { style: CSSProperties; children: ReactNode }) {
  return (
    <div style={{ position: 'absolute', display: 'flex', alignItems: 'center', gap: 16, padding: '16px 26px 16px 16px', borderRadius: 22, background: 'rgba(16,19,28,0.92)', border: '1.5px solid rgba(255,255,255,0.16)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)', fontSize: 34, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', ...style }}>
      {children}
    </div>
  );
}

const avatar = (text: string, bg: string): ReactNode => (
  <span style={{ width: 56, height: 56, borderRadius: 28, background: bg, display: 'grid', placeItems: 'center', fontSize: 24, fontWeight: 800 }}>{text}</span>
);

export function Thumbnail() {
  // SAM's numbered box on the hidden-browser "Pay now" button, in source pixels.
  const target = { x: 1378, y: 1440 };
  const zoom = 2.1, lens = 300;
  const LENS = { left: 560, top: 735 };
  const look = { x: 1376, y: 1430 }; // lens centre: the button plus a little of the card around it
  const page = { x: MAC_POS.left + target.x * S, y: MAC_POS.top + target.y * S };
  return (
    <AbsoluteFill style={{ fontFamily: FONT, color: '#fff' }}>
      <Backdrop />
      <AbsoluteFill style={{ background: 'radial-gradient(700px 520px at 22% 48%, rgba(47,124,255,0.28), transparent 70%)' }} />

      {/* Mac app */}
      <div style={{ position: 'absolute', ...MAC_POS, width: MAC_W, height: 1800 * S, borderRadius: 26, overflow: 'hidden', border: '2px solid rgba(255,255,255,0.14)', boxShadow: '0 60px 160px rgba(0,0,0,0.75), 0 0 120px rgba(47,124,255,0.18)' }}>
        <Img src={MAC} style={{ width: 2880 * S, height: 1800 * S, display: 'block' }} />
      </div>

      {/* SAM magnifier */}
      <svg style={{ position: 'absolute', left: 0, top: 0 }} width={1920} height={1080}>
        <line x1={page.x} y1={page.y} x2={LENS.left + lens / 2} y2={LENS.top + lens / 2} stroke="#ff4d4d" strokeWidth={5} strokeDasharray="4 10" strokeLinecap="round" />
        <rect x={page.x - 44} y={page.y - 26} width={88} height={52} rx={8} fill="none" stroke="#ff4d4d" strokeWidth={6} />
      </svg>
      <div style={{ position: 'absolute', ...LENS, width: lens, height: lens, borderRadius: lens / 2, border: '8px solid #ff4d4d', boxShadow: '0 0 0 6px rgba(0,0,0,0.5), 0 30px 80px rgba(0,0,0,0.7), 0 0 70px rgba(255,77,77,0.5)', backgroundImage: `url(${MAC})`, backgroundSize: `${2880 * zoom}px ${1800 * zoom}px`, backgroundPosition: `${lens / 2 - 8 - look.x * zoom}px ${lens / 2 - 8 - look.y * zoom}px` }} />
      <Chip style={{ left: 90, top: 860, fontSize: 32, padding: '12px 22px', background: '#ff4d4d', border: 'none' }}>SAM 3.1 sees the bug</Chip>

      {/* Phone */}
      <div style={{ position: 'absolute', left: 1560, top: 300, transform: 'rotate(4deg)' }}>
        <PhoneFrame height={680}>
          <Img src={PHONE} style={{ width: '100%', display: 'block', marginTop: -32 }} />
        </PhoneFrame>
      </div>

      {/* Teammates */}
      <Chip style={{ left: 1130, top: 60 }}>
        <span style={{ display: 'flex' }}>{avatar('AG', '#7c3aed')}<span style={{ marginLeft: -14, border: '3px solid #10131c', borderRadius: 31 }}>{avatar('AL', '#0f9f6e')}</span></span>
        Alex joined from a browser
      </Chip>
      <Chip style={{ left: 1500, top: 990, fontSize: 30, padding: '12px 24px 12px 12px' }}>
        <span style={{ width: 48, height: 48, borderRadius: 24, background: '#16a34a', display: 'grid', placeItems: 'center', fontSize: 30 }}>✓</span>
        Approved from phone
      </Chip>

      {/* Headline */}
      <div style={{ position: 'absolute', left: 90, top: 150, width: 860 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Mark size={84} progress={1} />
          <span style={{ fontSize: 64, fontWeight: 800, letterSpacing: -2 }}>Mult<span style={{ color: BLUE }}>AI</span></span>
        </div>
        <div style={{ marginTop: 40, fontSize: 70, fontWeight: 700, letterSpacing: -1.5, color: 'rgba(255,255,255,0.9)', lineHeight: 1.05 }}>Your AI coding agent,</div>
        <div style={{ fontSize: 158, fontWeight: 900, letterSpacing: -6, lineHeight: 0.95, marginTop: 10, textShadow: '0 10px 40px rgba(0,0,0,0.6)' }}>
          now<br /><span style={{ color: BLUE, textShadow: `0 0 60px rgba(47,124,255,0.55)` }}>multiplayer.</span>
        </div>
        <div style={{ marginTop: 46, display: 'inline-flex', alignItems: 'center', gap: 14, padding: '14px 28px', borderRadius: 999, background: 'rgba(47,124,255,0.16)', border: '2px solid rgba(47,124,255,0.6)', fontSize: 34, fontWeight: 700 }}>
          <span style={{ width: 14, height: 14, borderRadius: 7, background: BLUE, boxShadow: `0 0 16px ${BLUE}` }} />Built on Meta Muse + SAM 3.1
        </div>
      </div>
    </AbsoluteFill>
  );
}
