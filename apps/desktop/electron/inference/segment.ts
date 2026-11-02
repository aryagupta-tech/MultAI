// "Point at the bug": the host clicks the broken element on a screenshot and SAM 3.1 (Meta Model API)
// finds that element's exact bounds, which the app then outlines on the screenshot sent to the agent.
// Only the box tokens of SAM's output are read; masks aren't needed to draw an outline.
import type {ConnectionSummary} from '../../src/bridge/inference';

export const SAM_MODEL = 'sam-3.1';

export class SegmentError extends Error {
  constructor(readonly code:string, message:string) {super(message); this.name = 'SegmentError';}
}

export interface Box {x1:number; y1:number; x2:number; y2:number}
export interface Point {x:number; y:number; width:number; height:number}

export function metaConnection(connections:readonly ConnectionSummary[], selectedId:string|null):ConnectionSummary|null {
  const ready = connections.filter(item => item.status === 'ready' && item.provider === 'meta');
  return ready.find(item => item.id === selectedId) ?? ready[0] ?? null;
}

/** SAM's point prompt for one object on an image: frame 0, object 1, in the image's own pixels. */
export function pointPrompt(point:Point):string {
  const {x, y, width, height} = checkPoint(point);
  return `<0f>1<|point;x=${x};y=${y};w=${width};h=${height}|>`;
}

function checkPoint(point:Point):Point {
  const int = (value:number, max:number) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  if (!int(point.width, 20_000) || !int(point.height, 20_000) || point.width < 1 || point.height < 1 || !int(point.x, point.width - 1) || !int(point.y, point.height - 1)) {
    throw new SegmentError('SEGMENT_INVALID', 'That point isn’t on the screenshot.');
  }
  return point;
}

/** Every `<|box;…|>` token in SAM's output lane, in source pixels. */
export function parseBoxes(text:string):Box[] {
  const boxes:Box[] = [];
  for (const match of text.matchAll(/<\|box;([^|]*)\|>/gu)) {
    const fields = Object.fromEntries(match[1]!.split(';').map(pair => pair.split('=')).filter(pair => pair.length === 2).map(([key, value]) => [key, Number(value)]));
    const {x1, y1, x2, y2} = fields as Record<string, number>;
    if ([x1, y1, x2, y2].every(value => Number.isFinite(value)) && x2! >= x1! && y2! >= y1!) boxes.push({x1: x1!, y1: y1!, x2: x2!, y2: y2!});
  }
  return boxes;
}

/** The box that contains the point, smallest first (the element, not its container); else the nearest. */
export function pickBox(boxes:readonly Box[], point:{x:number; y:number}):Box|null {
  const inside = boxes.filter(box => point.x >= box.x1 && point.x <= box.x2 && point.y >= box.y1 && point.y <= box.y2);
  const area = (box:Box) => (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1);
  if (inside.length) return [...inside].sort((a, b) => area(a) - area(b))[0]!;
  const distance = (box:Box) => Math.hypot(Math.max(box.x1 - point.x, 0, point.x - box.x2), Math.max(box.y1 - point.y, 0, point.y - box.y2));
  return [...boxes].sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/** The output lane of a Responses result, from a JSON body or a stream of `output_text` events. */
export function outputText(body:string, contentType:string):string {
  if (/event-stream/iu.test(contentType)) {
    let text = '';
    for (const line of body.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5).trim()) as {type?:string; delta?:unknown};
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
      } catch {/* [DONE] and keep-alives */}
    }
    return text;
  }
  const json = JSON.parse(body) as {output_text?:unknown; output?:{content?:{type?:string; text?:unknown}[]}[]};
  if (typeof json.output_text === 'string') return json.output_text;
  return (json.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text as string).join('');
}

/** One SAM 3.1 call: a point or concept prompt on the screenshot, answered with boxes. */
async function ask(credentials:{apiKey:string}, image:string, prompt:string, fetcher:typeof fetch, signal:AbortSignal):Promise<Box[]> {
  const response = await fetcher('https://api.meta.ai/v1/responses', {
    method: 'POST', signal, redirect: 'error',
    headers: {'content-type': 'application/json', authorization: `Bearer ${credentials.apiKey}`},
    body: JSON.stringify({model: SAM_MODEL, stream: false, metadata: {mask_encoding: 'one_bit'},
      input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: prompt}, {type: 'input_image', image_url: image}]}]}),
  });
  if (response.status === 401) throw new SegmentError('provider_credentials_invalid', 'This Meta key was refused. Check it in Settings.');
  if (!response.ok) throw new SegmentError('SEGMENT_FAILED', `SAM 3.1 couldn’t look at that screenshot (HTTP ${response.status}). Drag a box around the problem instead.`);
  return parseBoxes(outputText(await response.text(), response.headers.get('content-type') ?? ''));
}

/** Every instance of a short noun phrase ("checkout button") on the screenshot, top to bottom. */
export async function segmentConcept(credentials:{apiKey:string}, image:string, concept:string, fetcher:typeof fetch, signal:AbortSignal):Promise<Box[]> {
  const text = concept.replace(/[<>|]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 100);
  if (!text) throw new SegmentError('SEGMENT_INVALID', 'Say what to find, in a few words.');
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(image) || image.length > 12_000_000) throw new SegmentError('SEGMENT_INVALID', 'That screenshot can’t be read.');
  return (await ask(credentials, image, text, fetcher, signal)).sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
}

/** Concepts SAM is asked to find on an app screenshot, so a click on a label outlines its whole control. */
export const UI_CONCEPTS = ['button'];

/**
 * Asks SAM 3.1 which element is at this point of the screenshot. A point prompt alone tends to outline
 * just the word or icon clicked, so the controls around it are asked for at the same time: the smallest
 * one that contains the click (and isn't most of the screen) wins, else the point's own outline.
 */
export async function segmentPoint(credentials:{apiKey:string}, image:string, point:Point, fetcher:typeof fetch, signal:AbortSignal):Promise<Box|null> {
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(image) || image.length > 12_000_000) throw new SegmentError('SEGMENT_INVALID', 'Attach a PNG, JPEG or WebP screenshot first.');
  const prompt = pointPrompt(point);
  const [own, ...controls] = await Promise.allSettled([ask(credentials, image, prompt, fetcher, signal), ...UI_CONCEPTS.map(concept => ask(credentials, image, concept, fetcher, signal))]);
  if (own!.status === 'rejected') throw own!.reason;
  const area = (box:Box) => (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1);
  const around = controls.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    .filter(box => point.x >= box.x1 && point.x <= box.x2 && point.y >= box.y1 && point.y <= box.y2 && area(box) < point.width * point.height * 0.4)
    .sort((a, b) => area(a) - area(b))[0];
  return around ?? pickBox(own!.value, point);
}
