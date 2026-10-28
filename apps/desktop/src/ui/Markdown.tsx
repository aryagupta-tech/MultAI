import { Fragment, type ReactNode } from 'react';

// Inert Markdown subset rendered as React elements: paragraphs, lists, fenced code, inline
// code, bold and italic. No raw HTML, no images and no live links are ever produced, so a
// preview cannot load remote resources or execute anything.

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\n]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith('`')) out.push(<code key={key} className="md-code">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('_')) out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    else {
      const label = tok.slice(1, tok.indexOf(']'));
      const href = tok.slice(tok.indexOf('](') + 2, -1);
      out.push(<span key={key} className="md-link" title={href}>{label}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) body.push(lines[i++] ?? '');
      i++;
      blocks.push(
        <pre key={b++} className="md-pre" data-lang={lang || undefined}><code>{body.join('\n')}</code></pre>,
      );
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i] ?? '')) items.push((lines[i++] ?? '').replace(/^\s*([-*]|\d+\.)\s/, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={b++} className="md-list">{items.map((it, j) => <li key={j}>{inline(it, `${b}-${j}`)}</li>)}</Tag>);
    } else if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^>\s?/, ''));
      blocks.push(<blockquote key={b++} className="md-quote">{inline(quote.join(' '), `q${b}`)}</blockquote>);
    } else if (/^#{1,3}\s/.test(line)) {
      blocks.push(<p key={b++} className="md-heading">{inline(line.replace(/^#+\s/, ''), `h${b}`)}</p>);
      i++;
    } else if (line.trim() === '') {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(```|\s*([-*]|\d+\.)\s|>|#{1,3}\s)/.test(lines[i] ?? '')) para.push(lines[i++] ?? '');
      blocks.push(
        <p key={b++}>
          {para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, `${b}-${j}`)}</Fragment>)}
        </p>,
      );
    }
  }
  return <div className={streaming ? 'md is-streaming' : 'md'}>{blocks}</div>;
}
