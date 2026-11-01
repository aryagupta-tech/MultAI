// The public replay page: plain HTML, CSS and JS served by the service (no build step, no third-party
// code). It reads the token from the URL fragment, loads the cleaned-up timeline page by page and can
// play it back. Everything from the session is inserted as text nodes, never parsed as HTML.

export const REPLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>MultAI replay</title>
<link rel="stylesheet" href="/replay.css">
</head>
<body>
<header class="top">
  <div class="brand">MultAI <span>replay</span></div>
  <div class="controls">
    <button type="button" id="play" disabled>Play</button>
    <input type="range" id="scrub" min="0" max="0" value="0" aria-label="Replay position" disabled>
    <span id="position" class="muted"></span>
  </div>
</header>
<main>
  <h1 id="title">Loading replay…</h1>
  <p id="meta" class="muted"></p>
  <ol id="timeline" class="timeline" aria-live="polite"></ol>
  <p id="status" class="muted"></p>
</main>
<footer class="muted">A read-only replay shared by the session’s host. Screenshots, commands and account details are left out.</footer>
<script src="/replay.js"></script>
</body>
</html>`;

export const REPLAY_CSS = `:root{--bg:#0b0b0c;--panel:#141416;--line:#26262a;--text:#ececef;--muted:#8d8d96;--accent:#7c9cff;--ok:#3ecf8e;--bad:#ff6b6b;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--panel:#fff;--line:#e4e4e8;--text:#17171a;--muted:#6b6b74;--accent:#3355dd;--ok:#118a57;--bad:#c62828;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.top{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 16px;background:var(--bg);border-bottom:1px solid var(--line)}
.brand{font-weight:700}.brand span{color:var(--muted);font-weight:500}
.controls{display:flex;align-items:center;gap:10px;flex:1;justify-content:flex-end;min-width:0}
#scrub{flex:1;max-width:360px;accent-color:var(--accent)}
button{font:inherit;color:var(--bg);background:var(--text);border:0;border-radius:999px;padding:6px 16px;cursor:pointer}button:disabled{opacity:.4;cursor:default}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}
.muted{color:var(--muted);font-size:13px}footer{text-align:center;padding:16px;border-top:1px solid var(--line)}
.timeline{list-style:none;margin:20px 0 0;padding:0;display:grid;gap:10px}
.item{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 14px;animation:in .25s ease}
.item.hidden{display:none}.item.line{background:none;border:0;padding:2px 14px;color:var(--muted);font-size:13px}
.item .who{font-weight:600;font-size:13px}.item .when{color:var(--muted);font-size:12px;margin-left:6px}
.item.agent{border-left:3px solid var(--accent)}.item.failed{color:var(--bad)}
.text{margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere}.text code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--line);padding:1px 5px;border-radius:5px}
.text a{color:var(--accent)}.plan{margin:6px 0 0;padding:0;list-style:none}.plan li::before{content:"○ ";color:var(--muted)}.plan li.done::before{content:"✓ ";color:var(--ok)}.plan li.active::before{content:"● ";color:var(--accent)}
.tag{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:999px;padding:0 7px;margin-left:6px;color:var(--muted)}
@keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.item{animation:none}}
@media (max-width:560px){.top{flex-wrap:wrap}.controls{justify-content:flex-start}}`;

export const REPLAY_JS = `(()=>{"use strict";
const $=id=>document.getElementById(id);
const token=decodeURIComponent(location.hash.slice(1));
const items=[];let shown=0;let timer=null;let events=[];
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const time=at=>new Date(at).toLocaleString([], {hour:'numeric',minute:'2-digit',month:'short',day:'numeric'});
// A small, safe subset of Markdown: **bold**, \`code\`, https links, line breaks. Text nodes only.
function rich(text){
  const box=el('div','text');
  const pattern=/(\\*\\*[^*]+\\*\\*|\`[^\`]+\`|\\[[^\\]]+\\]\\(https:\\/\\/[^\\s)]+\\))/g;
  let last=0;let m;
  while((m=pattern.exec(text))){
    if(m.index>last)box.append(document.createTextNode(text.slice(last,m.index)));
    const t=m[0];
    if(t.startsWith('**'))box.append(el('strong',null,t.slice(2,-2)));
    else if(t.startsWith('\`'))box.append(el('code',null,t.slice(1,-1)));
    else{const close=t.indexOf('](');const a=el('a',null,t.slice(1,close));a.href=t.slice(close+2,-1);a.rel='noopener noreferrer nofollow';a.target='_blank';box.append(a);}
    last=m.index+t.length;
  }
  if(last<text.length)box.append(document.createTextNode(text.slice(last)));
  return box;
}
const LINES={'run.started':'The agent started working','run.completed':'The agent finished','run.failed':'The agent run failed','run.stopped':'The host stopped the agent','instruction.claimed':'The agent picked up a new direction','participant.admitted':'Someone joined the session'};
function render(e){
  if(LINES[e.type])return el('li','item line',LINES[e.type]);
  if(e.type==='session.mode_changed')return el('li','item line',(e.who||'Someone')+' switched to '+(e.data.mode==='build'?'Build':'Plan')+' mode');
  if(e.type==='activity.completed'||e.type==='activity.failed'){
    const li=el('li','item line'+(e.data.failed?' failed':''),e.data.summary+(e.data.path?' · '+e.data.path:''));return li;
  }
  const li=el('li','item'+(e.who==='Agent'?' agent':''));
  const head=el('div');head.append(el('span','who',e.who||'Someone'));
  const kinds={'message.instruction':'to the agent','message.discussion':'team chat','brief.created':'brief','decision.saved':'decision','plan':'plan'};
  if(kinds[e.type])head.append(el('span','tag',kinds[e.type]));
  if(e.data.screenshot)head.append(el('span','tag','screenshot not shared'));
  head.append(el('span','when',time(e.at)));li.append(head);
  if(e.type==='plan'){const ol=el('ol','plan');for(const s of e.data.steps)ol.append(el('li',s.state,s.text));li.append(ol);}
  else if(e.data.text)li.append(rich(e.data.text));
  return li;
}
function show(n){
  shown=Math.max(0,Math.min(items.length,n));
  items.forEach((li,i)=>li.classList.toggle('hidden',i>=shown));
  $('scrub').value=String(shown);$('position').textContent=shown+' / '+items.length;
  if(shown&&shown<=items.length)items[shown-1].scrollIntoView({block:'nearest',behavior:'smooth'});
}
function stop(){clearTimeout(timer);timer=null;$('play').textContent=shown>=items.length?'Replay':'Play';}
function step(){
  if(shown>=items.length){stop();return;}
  show(shown+1);
  const gap=shown<events.length?new Date(events[shown].at)-new Date(events[shown-1].at):0;
  // Real pauses, compressed: between a quarter and one and a half seconds.
  timer=setTimeout(step,Math.min(1500,Math.max(250,gap/20)));
}
$('play').onclick=()=>{if(timer){stop();return;}if(shown>=items.length)show(0);$('play').textContent='Pause';step();};
$('scrub').oninput=()=>{stop();show(Number($('scrub').value));};
async function load(){
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)){$('title').textContent='This replay link is incomplete';$('status').textContent='Copy the whole link, including the part after #.';return;}
  let after=0;
  for(let page=0;page<500;page++){
    const res=await fetch('/v1/replays/view',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,after})});
    const body=await res.json().catch(()=>null);
    if(!res.ok){$('title').textContent=res.status===429?'Too many requests':'This replay isn’t available';$('status').textContent=body&&body.error?body.error.message:'Try again later.';return;}
    if(page===0){document.title=body.replay.title+' · MultAI replay';$('title').textContent=body.replay.title;$('meta').textContent='Started '+time(body.replay.createdAt)+' · link expires '+time(body.replay.expiresAt);}
    for(const e of body.events){events.push(e);const li=render(e);items.push(li);$('timeline').append(li);}
    after=body.next;if(body.done)break;
  }
  $('scrub').max=String(items.length);$('scrub').disabled=$('play').disabled=!items.length;
  show(items.length);$('play').textContent='Replay';
  if(!items.length)$('status').textContent='Nothing has happened in this session yet.';
}
load().catch(()=>{$('title').textContent='The replay couldn’t load';$('status').textContent='Check your connection and reload.';});
})();`;
