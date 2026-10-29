// Newly drawn stacked-layer mark: three isometric layers, the top one lit in the accent color,
// standing for several people working on one shared session.
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className="logo-mark">
      <path d="M16 21.5 4.5 15.75 16 10l11.5 5.75L16 21.5Z" transform="translate(0 6)" fill="currentColor" opacity="0.22" />
      <path d="M16 21.5 4.5 15.75 16 10l11.5 5.75L16 21.5Z" transform="translate(0 2)" fill="currentColor" opacity="0.5" />
      <path d="M16 21.5 4.5 15.75 16 10l11.5 5.75L16 21.5Z" transform="translate(0 -2)" fill="var(--accent)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <LogoMark />
      <span>Mult<span className="wordmark-ai">AI</span></span>
    </span>
  );
}

/** A softly lit violet sphere used as the hero mark and the agent's avatar. */
export function Orb({ size = 64, still }: { size?: number; still?: boolean }) {
  return <span className={still ? 'orb is-still' : 'orb'} style={{ width: size, height: size }} aria-hidden />;
}
