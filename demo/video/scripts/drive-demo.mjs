// Drives the installed MultAI (started with --remote-debugging-port=9334) for the demo takes.
// Usage: node scripts/drive-demo.mjs <steps.json> [marks.jsonl]
// Steps: {click:{text|sel, within?, nth?}}, {type:"text", cps?}, {key:"Enter"}, {wait:ms},
//        {waitFor:{text|sel, timeout?, gone?}}, {shot:path}, {eval:"js"}, {mark:"label", text?|sel?}
// Every click and mark is appended to marks.jsonl with a wall-clock time and the element's
// rectangle in CSS pixels, so the edit can zoom onto the exact control.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const marksFile = process.argv[3];
const port = process.env.CDP_PORT ?? '9334';
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && (!process.env.CDP_URL || t.url.includes(process.env.CDP_URL)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const send = (method, params = {}) => new Promise((resolve) => {
  const mine = ++id;
  const listener = (e) => { const m = JSON.parse(e.data); if (m.id === mine) { ws.removeEventListener('message', listener); resolve(m.result); } };
  ws.addEventListener('message', listener);
  ws.send(JSON.stringify({ id: mine, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result.value;
};

// Finds the element for {text|sel}: by selector, or the smallest visible clickable element whose text matches.
const finder = (target) => `(() => {
  const t = ${JSON.stringify(target)};
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const scope = t.within ? [...document.querySelectorAll(t.within)].filter(visible).pop() ?? document : document;
  let list;
  if (t.sel) list = [...scope.querySelectorAll(t.sel)].filter(visible);
  else {
    const want = t.text.toLowerCase();
    const label = (e) => ((e.getAttribute('aria-label') ?? '') + ' ' + (e.innerText ?? e.textContent ?? '')).trim().toLowerCase();
    const clickable = 'button,a,[role=button],[role=menuitem],[role=menuitemradio],[role=option],[role=tab],[role=radio],[role=checkbox],label,li,summary,input,textarea';
    list = [...scope.querySelectorAll(t.any ? '*' : clickable)].filter((e) => visible(e) && (t.exact ? label(e) === want || (e.getAttribute('aria-label') ?? '').toLowerCase() === want : label(e).includes(want)));
    list.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
  }
  const e = list[t.nth ?? 0];
  if (!e) return null;
  e.scrollIntoView({ block: 'nearest' });
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, tag: e.tagName, text: (e.innerText ?? '').slice(0, 40) };
})()`;

const marks = [];
const mark = (label, rect) => {
  const entry = { t: Date.now(), label, ...(rect ? { rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } } : {}) };
  marks.push(entry);
  if (marksFile) appendFileSync(marksFile, JSON.stringify(entry) + '\n');
};

async function find(target, timeout = 15000) {
  const until = Date.now() + timeout;
  for (;;) {
    const rect = await evaluate(finder(target));
    if (rect) return rect;
    if (Date.now() > until) throw new Error(`not found: ${JSON.stringify(target)}`);
    await sleep(250);
  }
}

async function click(target) {
  const rect = await find(target, target.timeout);
  // at: [fx, fy] clicks that fraction of the element (a point inside an image), not its centre.
  const [fx, fy] = target.at ?? [0.5, 0.5];
  const x = rect.x + rect.w * fx, y = rect.y + rect.h * fy;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  mark(target.label ?? `click ${target.text ?? target.sel}`, rect);
}

const keyCodes = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 };
for (const step of steps) {
  if (step.click) await click(step.click);
  if (step.type !== undefined) {
    const cps = step.cps ?? 22;
    for (const ch of step.type) { await send('Input.insertText', { text: ch }); await sleep(1000 / cps * (ch === ' ' ? 1.4 : 0.6 + Math.random() * 0.8)); }
  }
  if (step.paste !== undefined) await send('Input.insertText', { text: step.paste });
  if (step.key) {
    const k = { key: step.key, code: step.key, windowsVirtualKeyCode: keyCodes[step.key], nativeVirtualKeyCode: keyCodes[step.key], ...(step.key === 'Enter' ? { text: '\r' } : {}), ...(step.modifiers ? { modifiers: step.modifiers } : {}) };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    mark(`key ${step.key}`);
  }
  if (step.wait) await sleep(step.wait);
  if (step.waitFor) {
    const { timeout = 120000, gone, ...target } = step.waitFor;
    const until = Date.now() + timeout;
    for (;;) {
      const rect = await evaluate(finder({ any: true, ...target }));
      if (gone ? !rect : rect) { mark(`seen ${target.text ?? target.sel}${gone ? ' gone' : ''}`, gone ? undefined : rect); break; }
      if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(step.waitFor)}`);
      await sleep(400);
    }
  }
  if (step.mark) mark(step.mark, step.text || step.sel ? await find({ any: true, text: step.text, sel: step.sel }) : undefined);
  if (step.eval) console.log(JSON.stringify(await evaluate(step.eval)));
  if (step.shot) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(step.shot, Buffer.from(r.data, 'base64')); }
}
ws.close();
process.exit(0);
