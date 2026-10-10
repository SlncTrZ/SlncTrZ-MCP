/** Isolated Owner Debate page shell. Shared route/auth wiring belongs to the integration owner. */

import type { ServerResponse } from "node:http";
import { dashboardChrome, dashboardCss, dashboardEnd, dashboardScript } from "./dashboard-shell.js";
import { ownerSessionMarkup, ownerSessionScript } from "./dashboard-session.js";

export const DEBATE_OWNER_API_BASE = "/owner/api/debates";

export function debatePageHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SlncTrZ Debate</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
button,a{font:inherit}button:focus-visible,a:focus-visible{outline:3px solid color-mix(in srgb,var(--focus) 55%,transparent);outline-offset:2px}
.hidden{display:none!important}.shell{max-width:76rem;margin:auto;padding:2rem 1rem 3rem}.topbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.1rem}.brand{font-family:"SlncHertine",system-ui,sans-serif;font-size:2rem;font-weight:600;letter-spacing:.02em}.nav{display:flex;gap:.5rem;align-items:center}.nav a,.action{display:inline-flex;align-items:center;justify-content:center;min-height:2.35rem;text-decoration:none;border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:9px;padding:.5rem .75rem;font-weight:650;font-size:.82rem;cursor:pointer;white-space:nowrap;transition:transform .15s ease,border-color .15s ease,background .15s ease}.nav a[aria-current="page"]{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));background:var(--accent-soft);color:var(--accent)}.nav a:hover,.action:hover{border-color:var(--line-strong)}.nav a:active,.action:active{transform:translateY(1px)}
.hero{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin:0 0 1rem}.hero h1{font-size:1.65rem;line-height:1.2;margin:.1rem 0 .35rem;letter-spacing:-.015em}.hero p{margin:0;color:var(--muted);max-width:46rem;font-size:.9rem}
.notice{padding:1rem;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--muted);font-size:.86rem}.notice strong{color:var(--text)}.error{border-color:#e8a9b2;background:#fff1f2;color:#8f1f31}
.workspace{display:grid;grid-template-columns:minmax(15rem,19rem) minmax(0,1fr);min-height:36rem;background:linear-gradient(var(--surface),var(--surface)) padding-box,linear-gradient(90deg,var(--cyan),var(--violet)) border-box;border:1px solid transparent;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.sidebar{border-right:1px solid var(--line);background:var(--surface2);min-width:0}.sidebar-head{padding:1rem 1rem .7rem}.sidebar-head h2{margin:0;font-size:.92rem}.sidebar-head p{margin:.2rem 0 0;color:var(--muted);font-size:.76rem}.debate-list{display:flex;flex-direction:column;padding:.35rem .45rem .75rem;gap:.25rem;max-height:42rem;overflow:auto}.debate-item{appearance:none;width:100%;text-align:left;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--text);padding:.7rem .65rem;cursor:pointer}.debate-item:hover{background:var(--surface)}.debate-item.active{background:var(--surface);border-color:var(--line)}.debate-topic{display:block;font-weight:650;font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.debate-meta{display:flex;justify-content:space-between;gap:.55rem;color:var(--muted);font-size:12px;margin-top:.25rem}.debate-meta span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.main{min-width:0;display:flex;flex-direction:column}.state-pane{min-height:36rem;display:grid;place-items:center;padding:2rem}.state-copy{max-width:28rem;text-align:center}.state-copy h2{margin:0 0 .35rem;font-size:1rem}.state-copy p{margin:0;color:var(--muted);font-size:.84rem}.skeleton{width:min(32rem,90%);display:grid;gap:.65rem}.skeleton i{display:block;height:.75rem;border-radius:8px;background:var(--surface3)}.skeleton i:nth-child(2){width:72%}.skeleton i:nth-child(3){width:88%}
.conversation{min-height:36rem;display:flex;flex-direction:column}.conversation-head{padding:1rem 1.1rem;border-bottom:1px solid var(--line);background:var(--surface)}.title-row{display:flex;gap:1rem;align-items:flex-start;justify-content:space-between}.title-copy{min-width:0}.title-copy h2{font-size:1rem;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.debate-id{margin:.22rem 0 0;color:var(--muted);font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:.4rem;flex-wrap:wrap;justify-content:flex-end}.action.primary{background:var(--accent);border-color:var(--accent);color:#f8fbff}.action.danger{color:var(--bad)}.action[disabled]{cursor:not-allowed;opacity:.48}
.fact-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.55rem;margin-top:.85rem}.fact{min-width:0;padding:.55rem .65rem;background:var(--surface2);border-radius:9px}.fact-label{display:block;color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.045em}.fact-value{display:block;margin-top:.1rem;font-size:.78rem;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status-active{color:var(--good)}.status-waiting,.status-paused_timeout{color:var(--warn)}.status-stopped{color:var(--bad)}.status-completed{color:var(--violet)}
.transcript{list-style:none;margin:0;padding:.35rem 1.1rem 1rem;display:flex;flex-direction:column;gap:0}.message{padding:1rem 0;border-bottom:1px solid var(--line)}.message:last-child{border-bottom:0}.message-head{display:flex;align-items:baseline;justify-content:space-between;gap:.75rem;margin-bottom:.3rem}.speaker{font-size:.8rem;font-weight:720}.timestamp{color:var(--muted);font-size:12px;white-space:nowrap}.message-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.86rem;line-height:1.58}.final-summary{margin:.8rem 0;padding:1rem;border:1px solid color-mix(in srgb,var(--violet) 35%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--violet) 7%,var(--surface))}.final-summary .speaker{color:var(--violet)}
.turn-note{margin:auto 1.1rem 1rem;padding:.72rem .8rem;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--muted);font-size:.76rem}.turn-note strong{color:var(--text)}
@media(prefers-color-scheme:dark){.workspace{box-shadow:none}.error{background:#35171e;border-color:#71303d;color:#f2a7b5}}
@media(max-width:768px){.workspace{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid var(--line)}.debate-list{max-height:13rem}.fact-row{grid-template-columns:repeat(2,minmax(0,1fr))}.hero{align-items:start;flex-direction:column}}
@media(max-width:375px){.shell{padding-top:1rem}.topbar{align-items:flex-start}.brand{font-size:1.6rem}.nav{flex-wrap:wrap;justify-content:flex-end}.title-row{flex-direction:column}.actions{justify-content:flex-start}.fact-row{grid-template-columns:1fr 1fr}.state-pane,.conversation{min-height:28rem}.message-head{align-items:flex-start;flex-direction:column;gap:.1rem}}
@media(prefers-reduced-motion:reduce){.nav a,.action{transition:none}.nav a:active,.action:active{transform:none}}
${dashboardCss}
</style></head><body>${dashboardChrome("debate")}<div class="shell">

${ownerSessionMarkup}
<section id="auth-required" class="notice hidden"><strong>Owner sign-in required.</strong> Debate history stays private to the Owner Console session. <a href="/">Sign in at the homepage</a>, then return here.</section>
<div id="app" class="hidden">
<section class="hero"><div><div class="eyebrow">COLLABORATION</div><h1>Debate</h1><p>Live and historical two-participant discussions with durable turn state and explicit deadlines.</p></div></section>
<section id="page-error" class="notice error hidden" role="alert"></section>
<section class="workspace" aria-label="Debate workspace">
<aside class="sidebar"><div class="sidebar-head"><h2>Conversations</h2><p>Active and historical debates</p></div><div id="debate-list" class="debate-list" aria-label="Debate history"></div></aside>
<div class="main" aria-live="polite">
<section id="loading-state" class="state-pane" data-state="loading"><div class="skeleton" aria-label="Loading debates"><i></i><i></i><i></i></div></section>
<section id="empty-state" class="state-pane hidden" data-state="empty"><div class="state-copy"><h2>No debates yet</h2><p>New debates will appear here after they are created through the Debate tools.</p></div></section>
<section id="conversation" class="conversation hidden" data-state="active">
<header class="conversation-head"><div class="title-row"><div class="title-copy"><h2 id="topic">Debate</h2><p id="debate-id" class="debate-id"></p></div><div class="actions"><button id="copy-id-action" class="action" type="button">Copy ID</button><button id="resume-action" class="action primary hidden" type="button">Resume</button><button id="stop-action" class="action danger" type="button">Stop</button><button id="delete-action" class="action danger hidden" type="button">Delete</button></div></div>
<div class="fact-row"><div class="fact"><span class="fact-label">State</span><span id="status" class="fact-value">waiting</span></div><div class="fact"><span class="fact-label">Turns</span><span id="turns" class="fact-value">0 / 0</span></div><div class="fact"><span class="fact-label">Current speaker</span><span id="speaker" class="fact-value">waiting</span></div><div class="fact"><span class="fact-label">Deadline</span><span id="deadline" class="fact-value">waiting</span></div></div></header>
<ol id="transcript" class="transcript" aria-label="Debate transcript"></ol>
<div id="turn-note" class="turn-note"><strong>waiting</strong> for debate activity.</div>
</section>
</div></section>
<span class="hidden" aria-hidden="true">paused_timeout stopped completed error</span>
</div></div>
<script>
const API='/owner/api/debates',POLL_MS=2500;
let csrf='',currentId=null,lastSequence=0,pollTimer=null,currentSnapshot=null,ownerSession;
${ownerSessionScript}
const q=id=>document.getElementById(id);
async function api(path,opt={}){return ownerSession?ownerSession.request(path,opt,csrf):ownerApiRequest(path,opt,csrf)}
function showError(error){if(ownerSession&&!ownerSession.authenticated)return;q('page-error').textContent='Debate data unavailable: '+(error?.message||String(error));q('page-error').classList.remove('hidden')}
function clearError(){q('page-error').classList.add('hidden');q('page-error').textContent=''}
function participantLabel(snapshot,id,fallbackNickname){if(!id)return fallbackNickname||'Waiting';const participant=snapshot?.participants?.find(x=>x.participantId===id);const nickname=fallbackNickname||participant?.nickname||id;const identity=participant?.role||String(id);return nickname+' · '+identity}
function fmtTime(value){if(!value)return 'None';const d=new Date(value);return Number.isNaN(d.getTime())?'Unknown':d.toLocaleString()}
function deadlineText(snapshot){const value=snapshot?.responseDeadlineAt||snapshot?.pickupDeadlineAt;if(!value)return snapshot?.status==='active'?'Awaiting turn':'None';const ms=Date.parse(value)-Date.now();if(ms<=0)return 'Due';const seconds=Math.ceil(ms/1000);if(seconds<60)return seconds+'s';return Math.ceil(seconds/60)+'m'}
function stateClass(status){return 'status-'+String(status||'waiting').replace(/[^a-z_]/g,'')}
function renderList(rows){
  const root=q('debate-list');root.replaceChildren();
  for(const row of rows){
    const b=document.createElement('button');b.type='button';b.className='debate-item'+(row.debateId===currentId?' active':'');b.dataset.id=row.debateId;
    const topic=document.createElement('span');topic.className='debate-topic';topic.textContent=row.topic||'Untitled debate';
    const meta=document.createElement('span');meta.className='debate-meta';
    const status=document.createElement('span');status.textContent=String(row.status||'waiting');
    const turns=document.createElement('span');turns.textContent=String(row.completedTurns||0)+' / '+String(row.maxTurns||0);
    meta.append(status,turns);b.append(topic,meta);root.appendChild(b)
  }
}
function appendMessages(snapshot,messages){
  const root=q('transcript');
  for(const message of messages||[]){
    if(root.querySelector('[data-sequence="'+String(message.sequence)+'"]'))continue;
    const li=document.createElement('li');li.dataset.sequence=String(message.sequence);li.className='message'+(message.isFinal?' final-summary':'');
    const head=document.createElement('div');head.className='message-head';
    const speaker=document.createElement('span');speaker.className='speaker';speaker.textContent=participantLabel(snapshot,message.participantId,message.nickname||undefined);
    const time=document.createElement('time');time.className='timestamp';time.textContent=fmtTime(message.createdAt);if(message.createdAt)time.dateTime=message.createdAt;
    const body=document.createElement('div');body.className='message-body';body.textContent=message.content||'';
    head.append(speaker,time);li.append(head,body);root.appendChild(li)
  }
}
function renderSnapshot(snapshot,resetTranscript){
  currentSnapshot=snapshot;currentId=snapshot.debateId;
  q('loading-state').classList.add('hidden');q('empty-state').classList.add('hidden');q('conversation').classList.remove('hidden');
  q('conversation').dataset.state=snapshot.status||'waiting';q('topic').textContent=snapshot.topic||'Untitled debate';q('debate-id').textContent=snapshot.debateId||'';
  const status=q('status');status.textContent=snapshot.status||'waiting';status.className='fact-value '+stateClass(snapshot.status);
  q('turns').textContent=String(snapshot.completedTurns||0)+' / '+String(snapshot.maxTurns||0);
  q('speaker').textContent=participantLabel(snapshot,snapshot.currentParticipantId);
  q('deadline').textContent=deadlineText(snapshot);
  q('resume-action').disabled=false;q('delete-action').disabled=false;
  q('resume-action').classList.toggle('hidden',snapshot.status!=='paused_timeout');
  q('stop-action').disabled=snapshot.status==='stopped'||snapshot.status==='completed';
  q('delete-action').classList.toggle('hidden',snapshot.status==='active');
  if(resetTranscript)q('transcript').replaceChildren();appendMessages(snapshot,snapshot.messages);
  lastSequence=Math.max(lastSequence,Number(snapshot.sequence||0));
  const note=q('turn-note'),statusText=String(snapshot.status||'waiting');
  if(statusText==='active'){note.replaceChildren();const strong=document.createElement('strong');strong.textContent='active';note.append(strong,document.createTextNode(' with '+participantLabel(snapshot,snapshot.currentParticipantId)+' on turn.'))}
  else if(statusText==='paused_timeout'){note.replaceChildren();const strong=document.createElement('strong');strong.textContent='paused_timeout';note.append(strong,document.createTextNode(' after '+String(snapshot.pauseReason||'deadline')+'. Owner can resume or stop.'))}
  else if(statusText==='completed'){note.replaceChildren();const strong=document.createElement('strong');strong.textContent='completed';note.append(strong,document.createTextNode(' with the final summary persisted in the transcript.'))}
  else if(statusText==='stopped'){note.replaceChildren();const strong=document.createElement('strong');strong.textContent='stopped';note.append(strong,document.createTextNode(' by a participant or Owner.'))}
  else{note.replaceChildren();const strong=document.createElement('strong');strong.textContent='waiting';note.append(strong,document.createTextNode(' for the second participant.'))}
}
async function loadList(){
  const generation=selectionGeneration;
  const payload=await api(API);const rows=Array.isArray(payload)?payload:(payload.debates||[]);
  if(generation!==selectionGeneration)return rows;
  renderList(rows);
  if(!rows.length){q('loading-state').classList.add('hidden');q('conversation').classList.add('hidden');q('empty-state').classList.remove('hidden');currentId=null;lastSequence=0;return rows}
  if(!currentSnapshot||!currentId||!rows.some(x=>x.debateId===currentId)){await openDebate(rows[0].debateId,true)}
  return rows
}
let selectionGeneration=0;
async function openDebate(id,reset){
  const generation=++selectionGeneration;
  currentId=id;currentSnapshot=null;if(reset)lastSequence=0;
  q('stop-action').disabled=true;q('resume-action').disabled=true;q('delete-action').disabled=true;
  const suffix=reset?'':'?afterSequence='+encodeURIComponent(String(lastSequence));
  const snapshot=await api(API+'/'+encodeURIComponent(id)+suffix);
  if(generation!==selectionGeneration||currentId!==id)return;
  renderSnapshot(snapshot,reset);
  const rows=await listOnly();if(generation===selectionGeneration&&currentId===id)renderList(rows)
}
async function listOnly(){const payload=await api(API);return Array.isArray(payload)?payload:(payload.debates||[])}
async function refreshCurrent(){
  if(!currentId||!currentSnapshot)return;
  const id=currentId,generation=selectionGeneration;
  const snapshot=await api(API+'/'+encodeURIComponent(id)+'?afterSequence='+encodeURIComponent(String(lastSequence)));
  if(generation===selectionGeneration&&currentId===id)renderSnapshot(snapshot,false)
}
async function scheduleRefresh(){
  try{if(!document.hidden){await loadList();await refreshCurrent();clearError()}}catch(error){showError(error)}
  finally{if(ownerSession?.authenticated)pollTimer=setTimeout(scheduleRefresh,POLL_MS)}
}
q('debate-list').addEventListener('click',async event=>{const b=event.target.closest('button[data-id]');if(!b)return;try{clearError();await openDebate(b.dataset.id,true)}catch(error){showError(error)}});
q('copy-id-action').addEventListener('click',async()=>{if(!currentId)return;try{await navigator.clipboard.writeText(currentId);q('copy-id-action').textContent='Copied';setTimeout(()=>{q('copy-id-action').textContent='Copy ID'},1200)}catch(error){showError(error)}});
q('stop-action').addEventListener('click',()=>mutateCurrent('/stop'));
async function mutateCurrent(action){if(!currentId||currentSnapshot?.debateId!==currentId)return;const id=currentId,generation=selectionGeneration;try{const snapshot=await api(API+'/'+encodeURIComponent(id)+action,{method:'POST',body:'{}'});if(generation===selectionGeneration&&currentId===id){renderSnapshot(snapshot,false);clearError()}}catch(error){if(generation===selectionGeneration&&currentId===id)showError(error)}}
q('resume-action').addEventListener('click',()=>mutateCurrent('/resume'));
q('delete-action').addEventListener('click',async()=>{if(!currentId||currentSnapshot?.debateId!==currentId)return;if(!confirm('Delete this debate and its transcript? This cannot be undone.'))return;const id=currentId,generation=selectionGeneration;try{await api(API+'/'+encodeURIComponent(id),{method:'DELETE'});if(generation===selectionGeneration&&currentId===id){selectionGeneration++;currentId=null;lastSequence=0;currentSnapshot=null;q('transcript').replaceChildren();await loadList();clearError()}}catch(error){if(generation===selectionGeneration&&currentId===id)showError(error)}});
async function boot(){
 ownerSession??=createOwnerSession({contentId:'app',loginId:'auth-required',onInvalidate:()=>{csrf='';selectionGeneration++;currentSnapshot=null;clearTimeout(pollTimer);pollTimer=null},onAuthenticated:async data=>{csrf=data.csrf||'';await loadList();pollTimer=setTimeout(scheduleRefresh,POLL_MS)}});
 return ownerSession.run()
}
boot();
</script>${dashboardEnd}${dashboardScript}</body></html>`;
}

export function sendDebatePage(res: ServerResponse): void {
  const payload = debatePageHtml();
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}
