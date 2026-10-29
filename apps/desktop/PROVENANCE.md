# Provenance

All source, styles and the logo in this package were written new for this repository on
2026-10-29. No code, CSS, icons, artwork or bundles were copied from a previous MultAI project.

## Brand

- Stacked-layer mark (`src/ui/Logo.tsx`): new inline SVG of three isometric layers.
- App icon (`build/icon.svg`, rendered to `build/icon.icns` with AppKit and `iconutil`): the same mark on a dark tile.
- Colors and type: system font stacks only; no font files are bundled.

## Third-party dependencies

Versions are pinned exactly in `package.json`. Licenses were checked against the npm registry at
selection time; recheck before any distribution.

| Package | Version | License | Use |
| --- | --- | --- | --- |
| react, react-dom | 19.3.1 | MIT | Renderer UI |
| zustand | 5.0.16 | MIT | Renderer state |
| lucide-react | 1.60.0 | ISC | Icons |
| electron | 44.9.3 | MIT | Desktop shell (dev dependency; bundled at packaging) |
| vite | 8.3.5 | MIT | Renderer build |
| @vitejs/plugin-react | 6.1.2 | MIT | React transform for Vite |
| esbuild | 0.28.2 | MIT | Main/preload bundling |
| vitest | 5.0.5 | MIT | Unit tests |
| typescript | 7.0.2 | Apache-2.0 | Type checking |
| ws | 8.18.3 | MIT | Live session stream from the main process |
| zod | 4.6.7 | MIT | IPC and service response validation |
| @types/ws | 8.18.2 | MIT | Types for ws |
| @electron/packager | 20.3.0 | BSD-2-Clause | Builds the installable app |
