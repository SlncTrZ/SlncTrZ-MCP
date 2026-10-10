/** Shared native dashboard shell for the authenticated owner surfaces. */
import { APP_VERSION } from "../shared/build-info.js";
import { thinkingOrbHtml, thinkingOrbCss, thinkingOrbScript } from "./thinking-orb.js";

export type DashboardPage = "owner" | "usage" | "debate";

const icons: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  connections:
    '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>',
  mcp: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01M12 6h5M12 17h5"/>',
  usage: '<path d="M4 20h17M6 16v-5M12 16V4M18 16V8"/>',
  debate:
    '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8Z"/><path d="M7 8h10M7 12h7"/>',
  access: '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z"/><path d="m8 12 3 3 5-6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'
};
function icon(name: string): string {
  return (
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    icons[name] +
    "</svg>"
  );
}
export function dashboardChrome(page: DashboardPage): string {
  const links: [string, string, string][] = [
    ["overview", "Overview", "/#overview"],
    ["connections", "Connections", "/#connections"],
    ["mcp", "MCP Servers", "/#mcp"],
    ["debate", "Debate", "/debate"],
    ["usage", "Usage", "/usage"],
    ["access", "Access & permissions", "/#access"],
    ["settings", "Settings", "/#settings"]
  ];
  return `<a class="skip-link" href="#dashboard-main">Skip to content</a>
<aside class="dashboard-sidebar" id="dashboard-sidebar" aria-label="Main navigation">
<a class="dashboard-brand" href="${page === "owner" ? "#overview" : "/#overview"}"><span class="brand-symbol" aria-hidden="true">S</span><span><b>SlncTrZ</b><small>MCP WORKSPACE</small></span></a>
<div class="workspace-label" id="workspace-card"><div id="workspace-meilin" class="workspace-meilin" aria-hidden="true"></div><span class="workspace-copy"><span id="workspace-greeting" class="workspace-greeting">Welcome back!</span><span class="workspace-name-row"><b id="workspace-name" class="workspace-name">Owner workspace</b><button type="button" id="workspace-edit-btn" class="workspace-edit-btn" aria-label="Edit workspace name" title="Edit workspace name"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z"/></svg></button></span><form id="workspace-edit-form" class="workspace-edit-form" hidden><input id="workspace-name-input" class="workspace-name-input" type="text" maxlength="64" autocomplete="off" aria-label="Workspace name"><span class="workspace-edit-actions"><button type="submit" id="workspace-name-save" class="workspace-name-save">Save</button><button type="button" id="workspace-name-cancel" class="workspace-name-cancel">Cancel</button></span></form><span id="workspace-name-feedback" class="workspace-name-feedback" role="status" aria-live="polite" hidden></span><small class="workspace-subtitle">Private gateway</small></span></div>
<div class="nav-caption">WORKSPACE</div><nav class="dashboard-nav"><span class="nav-indicator" aria-hidden="true"></span>${links
    .map(([key, label, target]) => {
      const href = page === "owner" && target.startsWith("/#") ? target.slice(1) : target;
      return `<a href="${href}"${page === key || (page === "owner" && key === "overview") ? ' aria-current="page"' : ""} data-section="${key}">${icon(key)}<span>${label}</span></a>`;
    })
    .join("")}</nav>
<div class="sidebar-bottom"><span class="sidebar-footer" aria-label="Release version">v${APP_VERSION}</span></div></aside>
<div class="dashboard-body"><header class="dashboard-header"><button type="button" id="nav-toggle" aria-controls="dashboard-sidebar" aria-expanded="false" aria-label="Toggle navigation"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><span id="dashboard-title" hidden>${page === "owner" ? "Overview" : page === "usage" ? "Usage" : "Debate"}</span><div class="header-quote" id="header-quote">Today was a tough day, but also a great day!</div><div class="gateway-status" id="gateway-status" role="status" aria-live="polite" aria-label="SlncTrZ gateway ready" title="SlncTrZ gateway ready" data-state="ready"><span class="gateway-status-dot" aria-hidden="true"></span></div></header>
<div id="thinking-orb-container" class="thinking-orb-container" aria-hidden="true">${thinkingOrbHtml}</div>
<main id="dashboard-main" class="dashboard-main" tabindex="-1">`;
}
export const dashboardEnd = `</main></div><div class="startup-intro hidden" id="startup-intro" aria-hidden="true"><div class="intro-orbit"></div><div class="intro-copy"><span class="intro-kicker">YOUR AI. CONNECTED.</span><span class="intro-wordmark">SlncTrZ</span><span class="intro-rule"></span><span class="intro-tagline">One gateway. Endless possibilities.</span></div><button type="button" id="intro-skip" aria-label="Skip introduction">Skip intro</button></div>`;

export const workspaceCardControllerScript = String.raw`
function createWorkspaceCard(options){
options=options||{};
const request=options.request||function(path,opt,csrfValue){return typeof ownerSession!=='undefined'&&ownerSession?ownerSession.request(path,opt):ownerApiRequest(path,opt,csrfValue)};
const getCsrf=options.getCsrf||function(){try{return typeof csrf==='string'?csrf:''}catch(_){return ''}};
const greetings=options.greetings||["Welcome back!","Have a nice day!","How’s your day going?","Ready when you are."];
const intervalMs=typeof options.intervalMs==='number'?options.intervalMs:30000;
const savedMessageMs=typeof options.savedMessageMs==='number'?options.savedMessageMs:2000;
const reducedMotion=typeof options.reducedMotion==='boolean'?options.reducedMotion:(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
const nameEl=document.getElementById('workspace-name');
const editBtn=document.getElementById('workspace-edit-btn');
const form=document.getElementById('workspace-edit-form');
const input=document.getElementById('workspace-name-input');
const saveBtn=document.getElementById('workspace-name-save');
const cancelBtn=document.getElementById('workspace-name-cancel');
const feedback=document.getElementById('workspace-name-feedback');
const greetingEl=document.getElementById('workspace-greeting');
if(!nameEl)return null;
let savedName=nameEl.textContent||greetings[0];
let generation=0,editing=false,saving=false,savedTimer=null,greetingTimer=null,greetingIndex=0,greetingPaused=false;
function setFeedback(text,state){feedback.textContent=text;feedback.dataset.state=state||'';feedback.hidden=!text}
function setGreeting(text){greetingEl.textContent=text}
function openEdit(){
if(editing)return;
editing=true;nameEl.hidden=true;editBtn.hidden=true;form.hidden=false;input.value=savedName;
clearTimeout(savedTimer);setFeedback('','');greetingPaused=true;input.focus();if(input.select)input.select();
}
function closeEdit(){
editing=false;form.hidden=true;nameEl.hidden=false;editBtn.hidden=false;input.value=savedName;greetingPaused=false;
}
async function submit(){
if(saving)return;
const value=input.value.trim();
const codePoints=[...value];
if(codePoints.length<1||codePoints.length>64){setFeedback('Enter a name between 1 and 64 characters.','error');input.focus();return}
const current= generation;
saving=true;input.disabled=true;saveBtn.disabled=true;cancelBtn.disabled=true;setFeedback('Saving...','saving');
try{
const result=await request('/owner/api/workspace',{method:'PATCH',body:JSON.stringify({displayName:value})},getCsrf());
if(current!==generation)return;
const next=(result&&typeof result.displayName==='string')?result.displayName:value;
savedName=next;nameEl.textContent=next;closeEdit();setFeedback('Saved','saved');
savedTimer=setTimeout(function(){if(feedback.dataset.state==='saved')setFeedback('','')},savedMessageMs);
}catch(error){
if(current!==generation)return;
setFeedback((error&&error.message)?error.message:'Could not save the workspace name.','error');input.focus();
}finally{
if(current===generation){saving=false;input.disabled=false;saveBtn.disabled=false;cancelBtn.disabled=false;}
}
}
function reset(){generation++;saving=false;input.disabled=false;saveBtn.disabled=false;cancelBtn.disabled=false;closeEdit();setFeedback('','')}
async function reload(){
const current=generation;
try{
const data=await request('/owner/api/workspace');
if(current===generation&&data&&typeof data.displayName==='string'){savedName=data.displayName;nameEl.textContent=data.displayName;if(!editing)setFeedback('','')}
}catch(error){
if(current!==generation)return;
if(error?.status===401||error?.name==='AbortError')throw error;
setFeedback('Could not load the workspace name. Reload this page to retry.','error');
}
}
function rotateGreeting(){
if(reducedMotion){setGreeting(greetings[0]);return}
if(greetingPaused)return;
if(document.visibilityState==='hidden')return;
greetingIndex=(greetingIndex+1)%greetings.length;setGreeting(greetings[greetingIndex]);
}
function startGreetings(){
if(reducedMotion){setGreeting(greetings[0]);return}
if(greetingTimer!==null)return;
greetingTimer=setInterval(rotateGreeting,intervalMs);
}
function stopGreetings(){if(greetingTimer!==null){clearInterval(greetingTimer);greetingTimer=null}}
editBtn.addEventListener('click',openEdit);
cancelBtn.addEventListener('click',closeEdit);
form.addEventListener('submit',function(e){e.preventDefault();submit()});
input.addEventListener('keydown',function(e){
if(e.key==='Escape'){e.preventDefault();closeEdit()}
else if(e.key==='Enter'&&!e.isComposing){e.preventDefault();submit()}
});
if(options.request||typeof ownerSession==='undefined'||ownerSession?.authenticated){Promise.resolve().then(reload).catch(function(){})}
startGreetings();
globalThis.addEventListener('pagehide',stopGreetings);
globalThis.addEventListener('beforeunload',stopGreetings);
return {reload:reload,reset:reset,openEdit:openEdit,closeEdit:closeEdit,submit:submit,startGreetings:startGreetings,stopGreetings:stopGreetings,rotateGreeting:rotateGreeting,get savedName(){return savedName},get editing(){return editing},get reducedMotion(){return reducedMotion}};
}
`;

export const dashboardScript = `<script>(()=>{
const root=document.getElementById('dashboard-sidebar'),toggle=document.getElementById('nav-toggle');
const compact=matchMedia('(max-width:767px)');function syncNav(){root.inert=compact.matches&&!document.body.classList.contains('nav-open')}function closeNav(){document.body.classList.remove('nav-open');toggle.setAttribute('aria-expanded','false');syncNav()}compact.addEventListener('change',closeNav);syncNav();
toggle.addEventListener('click',()=>{const open=document.body.classList.toggle('nav-open');toggle.setAttribute('aria-expanded',String(open));syncNav()});
root.addEventListener('click',e=>{if(e.target.closest('a'))closeNav()});document.addEventListener('click',e=>{if(document.body.classList.contains('nav-open')&&!root.contains(e.target)&&!toggle.contains(e.target))closeNav()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(document.body.classList.contains('nav-open'))toggle.focus();closeNav();hideIntro()}});
const nav=root.querySelector('.dashboard-nav'),indicator=nav.querySelector('.nav-indicator');
let hoveredLink=null,focusedLink=null;
function syncIndicator(){const selected=hoveredLink||focusedLink||nav.querySelector('[aria-current=page]');nav.querySelectorAll('a').forEach(a=>a.toggleAttribute('data-highlighted',a===selected));if(!selected)return;indicator.style.height=selected.offsetHeight+'px';indicator.style.transform='translateY('+selected.offsetTop+'px)';indicator.style.opacity='1'}
nav.addEventListener('pointerover',e=>{const a=e.target.closest('a');if(a&&nav.contains(a)){hoveredLink=a;syncIndicator()}});
nav.addEventListener('pointerleave',()=>{hoveredLink=null;syncIndicator()});
nav.addEventListener('focusin',e=>{focusedLink=e.target.closest('a');syncIndicator()});
nav.addEventListener('focusout',e=>{focusedLink=e.relatedTarget&&nav.contains(e.relatedTarget)?e.relatedTarget.closest('a'):null;syncIndicator()});
window.addEventListener('resize',syncIndicator);
const navObserver=new ResizeObserver(syncIndicator);navObserver.observe(nav);
window.addEventListener('pagehide',()=>navObserver.disconnect());
syncIndicator();
const quote=document.getElementById('header-quote'),quotes=["Today was a tough day, but also a great day!","Nothing is perfect, but we can get it better day by day!","Small steps today, better possibilities tomorrow.","Progress takes patience. Keep going."];
let quoteIndex=0,quoteTimer=null;
function stopQuotes(){if(quoteTimer!==null){clearInterval(quoteTimer);quoteTimer=null}}
function startQuotes(){stopQuotes();if(document.hidden)return;quoteTimer=setInterval(()=>{quoteIndex=(quoteIndex+1)%quotes.length;quote.textContent=quotes[quoteIndex];quote.title=quotes[quoteIndex]},10000)}
quote.title=quotes[0];document.addEventListener('visibilitychange',startQuotes);window.addEventListener('pagehide',stopQuotes);window.addEventListener('pageshow',startQuotes);startQuotes();
const titles={overview:'Overview',connections:'Connections',mcp:'MCP Servers',access:'Access & permissions',settings:'Settings'};
function selectSection(){if(location.pathname!=='/'&&location.pathname!=='/owner')return;const key=Object.hasOwn(titles,location.hash.slice(1))?location.hash.slice(1):'overview';document.querySelectorAll('[data-owner-panel]').forEach(el=>{el.hidden=el.dataset.ownerPanel!==key});root.querySelectorAll('[data-section]').forEach(el=>{if(el.dataset.section===key)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current')});document.getElementById('dashboard-title').textContent=titles[key];syncIndicator();document.title='SlncTrZ Owner · '+titles[key]}
window.addEventListener('hashchange',selectSection);window.addEventListener('popstate',selectSection);selectSection();
const intro=document.getElementById('startup-intro');let timer;
function hideIntro(){clearTimeout(timer);intro.classList.add('hidden');intro.setAttribute('aria-hidden','true')}
function playIntro(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;hideIntro();intro.classList.remove('hidden');intro.setAttribute('aria-hidden','false');timer=setTimeout(hideIntro,2600)}
document.getElementById('intro-skip').addEventListener('click',hideIntro);
try{if(!sessionStorage.getItem('slnctrz-intro-seen')){sessionStorage.setItem('slnctrz-intro-seen','1');playIntro()}}catch{}
const meilin=document.getElementById('workspace-meilin'),motion=matchMedia('(prefers-reduced-motion: reduce)');
let emoteTimer=null,emoteStep=0;
const emoteFrames=[0,0,0,0,0,1,0,0,0,2,0,0,0,0,1,0,0,3,0,0,0,4];
function stopEmote(){if(emoteTimer!==null){clearInterval(emoteTimer);emoteTimer=null}}
function syncEmote(){stopEmote();if(!meilin)return;if(motion.matches){emoteStep=0;meilin.style.backgroundPosition='0% 0';return}if(document.visibilityState==='hidden')return;emoteTimer=setInterval(()=>{emoteStep=(emoteStep+1)%emoteFrames.length;meilin.style.backgroundPosition=(emoteFrames[emoteStep]*25)+'% 0'},300)}
document.addEventListener('visibilitychange',syncEmote);motion.addEventListener('change',syncEmote);window.addEventListener('pagehide',stopEmote);window.addEventListener('pageshow',syncEmote);syncEmote();
${workspaceCardControllerScript}
globalThis.SlncTrZWorkspaceCard=createWorkspaceCard();
${thinkingOrbScript}
})();</script>`;

export const dashboardCss = `
.owner-session-feedback{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:72px;margin-bottom:20px}.owner-session-feedback button{flex:none}

@font-face{font-family:"SlncHertine";src:url(/assets/fonts/SlncHertine.woff2) format("woff2");font-display:swap;font-weight:400;font-style:normal}

:root{
color-scheme:light dark;
--canvas:#FFF8E7;
--ink:#12284B;
--navy:#12284B;
--primary:#0055A0;
--interactive:#438BC4;
--sky:#8CC1E9;
--bg:var(--canvas);
--text:var(--ink);
--accent:var(--primary);
--accent2:var(--interactive);
--focus:var(--interactive);
--surface:#FFFDF4;
--surface2:#FAF3DD;
--surface3:#F1E9CE;
--muted:#56637D;
--line:#E6DFC9;
--line-strong:#CEC39E;
--accent-soft:#EAF3FB;
--cyan:var(--interactive);
--violet:var(--primary);
--good:#1F7A55;
--bad:#B23A4A;
--warn:#96620F;
--glass-sidebar:rgba(18,40,75,.86);
--glass-header:rgba(255,253,244,.82);
--glass-border:rgba(140,193,233,.30);
--glass-highlight:rgba(255,255,255,.10);
--glow:rgba(67,139,196,.30);
--motion-ease:cubic-bezier(.22,1,.36,1);
--motion-drawer:240ms;
--motion-modal:180ms
}

html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);margin:0;padding:0;min-height:100dvh;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
[hidden]{display:none!important}
a{color:var(--accent)}
button,input,select{font:inherit}
button,a,input,select{outline-offset:3px}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--interactive);box-shadow:0 0 0 4px var(--glow)}

/* Sidebar - frosted navy glass */
.dashboard-sidebar{position:fixed;inset:0 auto 0 0;width:244px;background:var(--glass-sidebar);-webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5);color:#C7D3E8;padding:32px 20px 20px;display:flex;flex-direction:column;z-index:30;overflow-y:auto;border-right:1px solid var(--glass-border);box-shadow:inset 0 1px 0 var(--glass-highlight)}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.dashboard-sidebar{background:#12284B}}
.dashboard-brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:#FFFFFF;margin:0 8px 32px}
.brand-symbol{display:grid;place-items:center;width:38px;height:42px;background:var(--primary);border-radius:12px 4px 12px 4px;font-size:26px;font-weight:750;color:#fff;box-shadow:0 0 0 1px var(--glass-highlight),0 4px 14px rgba(0,85,160,.35)}
.dashboard-brand b{display:block;font-family:'SlncHertine',sans-serif;font-size:29px;font-weight:400;line-height:1.2}
.dashboard-brand small{display:block;font-size:12px;letter-spacing:2.1px;color:var(--sky);margin-top:5px}
.workspace-label{display:flex;flex-direction:column;flex-shrink:0;padding:0;overflow:hidden;border:1px solid var(--glass-border);border-radius:12px;font-size:12px;color:#E8EEF8;margin-bottom:20px;background:rgba(255,255,255,.04);box-shadow:inset 0 1px 0 var(--glass-highlight)}
.workspace-meilin{width:100%;aspect-ratio:1;flex:none;background-image:url(/assets/meilin/idle-v1.webp);background-size:500% 100%;background-position:0% 0;background-repeat:no-repeat;background-color:rgba(140,193,233,.08)}
.workspace-copy{display:flex;flex-direction:column;min-width:0;width:100%;padding:12px 13px}
.workspace-greeting{display:block;font-size:12px;letter-spacing:.2px;color:#9FC0E2;line-height:1.45}
.workspace-name{display:block;font-size:12px;font-weight:600;color:#FFFFFF;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.workspace-subtitle{display:block;color:#9FB2CE;font-size:12px;margin-top:1px}
.workspace-name-row{display:flex;align-items:center;gap:6px;min-width:0}
.workspace-edit-btn{border:0;background:transparent;color:#9FC0E2;width:22px;height:22px;border-radius:6px;cursor:pointer;flex:none;display:grid;place-items:center;padding:0}
.workspace-edit-btn:hover{background:rgba(67,139,196,.22);color:#fff}
.workspace-edit-form{display:flex;flex-direction:column;gap:7px;margin-top:2px}
.workspace-name-input{width:100%;min-height:30px;padding:6px 8px;font-size:12px;color:#12284B;background:#FFFFFF;border:1px solid var(--glass-border);border-radius:7px}
.workspace-name-input:focus{outline:2px solid var(--sky);outline-offset:1px}
.workspace-edit-actions{display:flex;gap:6px}
.workspace-name-save,.workspace-name-cancel{border:0;border-radius:6px;min-height:26px;font-size:12px;font-weight:600;padding:0 10px;cursor:pointer}
.workspace-name-save{background:var(--sky);color:#12284B}
.workspace-name-save:hover{background:#A9D3F0}
.workspace-name-cancel{background:rgba(255,255,255,.08);color:#C7D3E8}
.workspace-name-cancel:hover{background:rgba(255,255,255,.16);color:#fff}
.workspace-name-save:disabled,.workspace-name-cancel:disabled{opacity:.55;cursor:not-allowed}
.workspace-name-feedback{display:block;font-size:12px;line-height:1.4;margin-top:1px}
.workspace-name-feedback[data-state=error]{color:#FFB4BE}
.workspace-name-feedback[data-state=saving]{color:#9FC0E2}
.workspace-name-feedback[data-state=saved]{color:#7FE0B0}
.nav-caption{font-size:12px;font-weight:700;letter-spacing:1.7px;margin:0 13px 11px;color:var(--sky)}
.dashboard-nav{display:grid;gap:5px;position:relative;isolation:isolate;flex-shrink:0}
.nav-indicator{position:absolute;top:0;left:0;right:0;height:44px;border-radius:8px;background:rgba(0,85,160,.55);box-shadow:inset 3px 0 0 var(--sky);pointer-events:none;z-index:-1;opacity:0;transition:transform var(--motion-drawer) var(--motion-ease),height var(--motion-drawer) var(--motion-ease)}
.dashboard-nav a{color:#C7D3E8;display:flex;align-items:center;gap:12px;text-decoration:none;min-height:44px;padding:11px 13px;border-radius:8px;font-size:12px;font-weight:550;border:1px solid transparent}
.dashboard-nav a[data-highlighted]{color:#FFFFFF}

.sidebar-bottom{margin-top:auto;padding:28px 10px 0}
.sidebar-footer{display:block;font-size:13px;border-top:1px solid var(--glass-border);padding-top:17px;color:#8A9CB8}

/* Header - frosted light glass */
.dashboard-body{margin-left:244px;min-width:0;position:relative;isolation:isolate}
.dashboard-header{position:sticky;top:0;z-index:20;height:78px;display:flex;align-items:center;justify-content:space-between;padding:0 40px;background:var(--glass-header);-webkit-backdrop-filter:blur(12px) saturate(1.4);backdrop-filter:blur(12px) saturate(1.4);border-bottom:1px solid var(--line);box-shadow:inset 0 -1px 0 rgba(255,255,255,.4)}
.header-quote{font-family:"SlncHertine",sans-serif;font-size:clamp(13px,1.8vw,24px);font-weight:400;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;line-height:1.6;padding:0 20px;color:var(--ink)}
.gateway-status{flex:none;display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.4px;color:var(--muted)}
.gateway-status-dot{width:12px;height:12px;flex:none;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px rgba(31,122,85,.15),0 0 8px rgba(31,122,85,.35)}
.gateway-status[data-state=connecting] .gateway-status-dot{background:var(--warn);box-shadow:0 0 0 3px rgba(150,98,15,.15),0 0 8px rgba(150,98,15,.35)}
.gateway-status[data-state=working] .gateway-status-dot{background:var(--interactive);box-shadow:0 0 0 3px rgba(67,139,196,.15),0 0 8px rgba(67,139,196,.35)}
.gateway-status[data-state=error] .gateway-status-dot{background:var(--bad);box-shadow:0 0 0 3px rgba(178,58,74,.15),0 0 8px rgba(178,58,74,.35)}
.thinking-orb-container{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0;opacity:.55}
.thinking-orb-container .slnctrz-orb-canvas{width:100%;height:100%}
small{font-size:12px}
.owner-avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:650}
#nav-toggle{display:none;border:0;background:transparent;color:var(--text);cursor:pointer;border-radius:8px;width:38px;height:38px}
#nav-toggle:hover{background:var(--accent-soft)}

/* Main content */
.dashboard-main{position:relative;z-index:1;max-width:1536px;margin:auto;padding:36px 40px 48px;outline:none;scroll-margin-top:88px}
.shell{max-width:none;padding:0;margin:0}
.hero{margin:0 0 28px;align-items:center;gap:20px}
.hero h1,.page-heading h1{font-size:29px;letter-spacing:-1px;font-weight:650;line-height:1.2;margin:0 0 9px}
.hero p,.page-heading p{font-size:12px;max-width:630px;line-height:1.7;color:var(--muted);margin:0}
.eyebrow{font-size:12px;letter-spacing:1.5px;font-weight:650;color:var(--accent);margin-bottom:10px}
.page-heading{margin-bottom:28px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(18,40,75,.05),0 8px 24px rgba(18,40,75,.05);min-width:0}
.card:before,.card:after{display:none}
.card h1,.card h2{font-size:15px;font-weight:650;letter-spacing:-.2px;margin:0}
.card .toolbar{margin-bottom:22px}
.muted,.note,.sub,.detail,.foot{color:var(--muted);font-size:12px;line-height:1.7}
.note{margin:16px 0 0}
.toolbar>.grow{flex:1;display:block}
.muted[data-status=working]{color:var(--good)}
.muted[data-status=error],.muted[data-status=unavailable]{color:var(--bad)}
.muted[data-status=attention]{color:var(--warn)}
.toolbar .muted{display:block;margin-top:4px}
.row{gap:9px}
.card input,.card select,.price input{border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);color:var(--text);min-height:38px;padding:8px 11px;font-size:12px}
.card input:focus,.card select:focus,.price input:focus{border-color:var(--interactive);box-shadow:0 0 0 3px var(--glow);outline:none}
.card button,.action,.range button,.button-link{border-radius:7px;min-height:34px;font-size:12px;font-weight:600;padding:8px 12px;box-shadow:none;text-decoration:none;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .2s,transform .18s var(--motion-ease)}
.btn-approve,.action.primary{background:var(--primary);color:#fff;border:1px solid var(--primary)}
.btn-deny,.action{background:var(--surface);border:1px solid var(--line-strong);color:var(--text)}
.btn-danger,.action.danger{background:transparent;border:1px solid var(--line);color:var(--bad)}
.item{border-bottom:1px solid var(--line);padding:18px 0;gap:16px}
.empty{padding:36px 20px;background:var(--surface2);border:1px dashed var(--line-strong);border-radius:9px;color:var(--muted);text-align:center;font-size:12px}
.app-grid{display:block;max-width:none;margin:0}
.app-grid>.col{display:contents}
.app-grid .card{margin-bottom:20px}
.owner-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.owner-overview>.card:first-child{grid-column:1/-1}
.provider-health{padding-top:24px}
.provider-health>div{font-size:22px;font-weight:600;letter-spacing:-.5px}
.provider-health .button-link{display:inline-flex;margin-top:25px}
.overview-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0}
.stat-label,.label{font-size:12px;text-transform:none;letter-spacing:0;color:var(--muted);font-weight:500}
.stat-value,.value{font-size:36px;font-weight:600;letter-spacing:-1.2px;line-height:1.3;margin:10px 0}
.stat-note,.health-list{font-size:12px;color:var(--muted)}
.health-list{margin-top:8px;display:flex;flex-wrap:wrap;gap:10px}
.stat-block+.stat-block{border-color:var(--line);border-left:1px solid var(--line);padding-left:22px}
.quick-links{display:grid;gap:0;margin-top:12px}
.quick-links a{display:flex;justify-content:space-between;align-items:center;padding:15px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--text);font-size:12px}
.quick-links a:last-child{border:0}
.quick-links a span{color:var(--muted);font-size:12px}
.overview-banner{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:24px;background:var(--accent-soft);border:1px solid #CFE2F2;border-radius:12px;margin-bottom:24px}
.overview-banner h2{font-size:17px;margin:0 0 5px;color:var(--ink)}
.overview-banner p{margin:0;color:var(--muted);font-size:12px}
.overview-banner a{white-space:nowrap}
.commands-grid{max-height:none!important;overflow:visible}
.cmd-chip{border:1px solid var(--line);background:var(--surface2);color:var(--text);border-radius:7px}
.conn-badge{border-color:var(--line-strong);color:var(--muted)}
.conn-badge.full{border-color:var(--sky);color:var(--primary)}
.brandmark{display:none}
.neon-frame{animation:none;background:var(--line);padding:1px;border-radius:12px}
.login-frame{max-width:480px;margin:70px auto}
.login-frame .brand{font-size:22px;color:var(--text)}
.login-frame .dot{background:var(--accent);box-shadow:none}
.login-frame h1{font-size:20px;margin:24px 0}
.overview-top{margin-bottom:24px}
.grid{gap:18px}
.metric{min-height:155px}
.metric .value{margin:14px 0 6px}
.card.wide,.card.side,.card.full{padding:24px}
.chart-wrap{margin-top:26px}
.saving-box{background:var(--surface2);border-radius:9px;padding:16px}
.range{background:var(--surface);padding:4px;border:1px solid var(--line);border-radius:9px;gap:2px}
.range button{border:0;background:transparent;min-height:30px}
.range button.active{background:var(--accent-soft);color:var(--accent)}
.workspace{border:1px solid var(--line);background:var(--surface);box-shadow:none;border-radius:12px;grid-template-columns:minmax(210px,270px) minmax(0,1fr)}
.sidebar{background:var(--surface2)}
.sidebar-head{padding:23px 20px 16px}
.debate-list{padding:0 10px 16px}
.debate-item{padding:13px 12px;margin-bottom:3px}
.debate-item.active{background:var(--accent-soft);border-color:transparent;box-shadow:inset 3px 0 var(--accent)}
.debate-topic{font-size:12px}
.debate-meta{font-size:12px;margin-top:7px}
.conversation-head{padding:23px}
.fact{background:var(--surface2);padding:12px}
.fact-label{font-size:12px}
.fact-value{font-size:12px;margin-top:5px}
.transcript{padding:8px 24px 24px}
.message{padding:23px 0}
.speaker{font-size:12px;color:var(--accent)}
.message-body{font-size:13px;line-height:1.8}
.timestamp{font-size:12px}
.turn-note{margin:0 24px 24px}
.notice{margin-bottom:20px;border-radius:9px}
.skip-link{position:fixed;top:-70px;left:260px;background:var(--primary);color:#fff;padding:12px;z-index:100}
.skip-link:focus{top:12px}

/* Intro overlay */
.startup-intro{position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:#0E1B33;color:white;animation:intro-away 2.6s both;pointer-events:none;overflow:hidden}
.intro-copy{text-align:center;display:flex;flex-direction:column;align-items:center;z-index:1}
.intro-kicker{font-size:12px;letter-spacing:5px;color:#9FC0E2;animation:intro-rise .65s both}
.intro-wordmark{font-family:'SlncHertine',sans-serif;font-size:clamp(64px,10vw,130px);line-height:1.5;animation:intro-rise .85s .15s both}
.intro-rule{height:2px;width:90px;background:var(--sky);animation:intro-line .8s .35s both}
.intro-tagline{font-size:13px;letter-spacing:2px;color:#A9B8D0;margin-top:24px;animation:intro-rise .7s .5s both}
.intro-orbit{position:absolute;width:600px;height:600px;border-radius:50%;border:1px solid rgba(67,139,196,.2);box-shadow:0 0 0 100px rgba(67,139,196,.03),0 0 0 200px rgba(67,139,196,.015);animation:intro-orbit 2.6s both}
#intro-skip{position:absolute;bottom:30px;right:32px;color:#A9B8D0;border:1px solid #354563;border-radius:7px;background:transparent;padding:8px 15px;font-size:12px;pointer-events:auto;cursor:pointer}
@keyframes intro-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes intro-line{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes intro-orbit{from{transform:scale(.75);opacity:0}40%{opacity:1}to{transform:scale(1.12);opacity:.65}}
@keyframes intro-away{0%,78%{opacity:1}100%{opacity:0;visibility:hidden}}

/* Dark mode */
@media(prefers-color-scheme:dark){
:root{--canvas:#0E1B33;--ink:#E8EEF7;--navy:#0A1528;--primary:#5C9ED6;--interactive:#438BC4;--sky:#8CC1E9;--bg:var(--canvas);--text:var(--ink);--accent:var(--primary);--accent2:#7FB3E0;--focus:var(--interactive);--surface:#15263F;--surface2:#1B2E4A;--surface3:#233752;--muted:#A6B4CC;--line:#2A3E5C;--line-strong:#3D5778;--accent-soft:#1C3554;--cyan:var(--interactive);--violet:var(--primary);--good:#6ECDA4;--bad:#EE8799;--warn:#E7BB74;--glass-sidebar:rgba(10,21,40,.88);--glass-header:rgba(14,27,51,.84);--glass-border:rgba(140,193,233,.22);--glass-highlight:rgba(255,255,255,.06);--glow:rgba(67,139,196,.28)}
.btn-approve,.action.primary{color:#0A1528}
.overview-banner{background:var(--accent-soft);border-color:var(--line-strong)}
.overview-banner h2{color:var(--text)}
.overview-banner p{color:var(--muted)}
.card{box-shadow:none}
}

/* Responsive breakpoints */
@media(min-width:1440px){.dashboard-main{padding:44px 56px}.dashboard-header{padding:0 56px}}
@media(max-width:1024px){.dashboard-sidebar{width:210px;padding-left:14px;padding-right:14px}.dashboard-body{margin-left:210px}.dashboard-main{padding:28px 24px}.dashboard-header{padding:0 24px}.owner-overview{grid-template-columns:1fr}.overview-stats{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:24px}.stat-block:nth-child(3){border-left:0;padding-left:0}.hero{align-items:flex-start;flex-direction:column}.workspace{grid-template-columns:210px minmax(0,1fr)}}
@media(max-width:767px){.dashboard-sidebar{transform:translateX(-100%);transition:transform var(--motion-drawer) var(--motion-ease)}.nav-open .dashboard-sidebar{transform:translateX(0);box-shadow:20px 0 80px rgba(18,40,75,.28)}.dashboard-body{margin-left:0}.dashboard-header{height:64px;padding:0 20px;gap:14px}#nav-toggle{display:grid;place-items:center}.header-quote{padding:0;font-size:13px}.dashboard-main{padding:28px 20px}.workspace{grid-template-columns:1fr}.sidebar{border-bottom:1px solid var(--line);border-right:0}.debate-list{max-height:180px}.owner-overview{grid-template-columns:1fr}.skip-link{left:20px}.overview-banner{align-items:flex-start;flex-direction:column}}
@media(max-width:375px){.dashboard-main{padding:24px 16px}.hero h1,.page-heading h1{font-size:25px}.card{padding:19px}.overview-stats{grid-template-columns:1fr}.stat-block+.stat-block{padding-left:0;border-left:0;border-top:1px solid var(--line);padding-top:16px;margin-top:16px}.overview-banner{padding:20px}.conn-controls{flex-wrap:wrap}.conn-controls select{min-width:0;width:100%}.row{flex-wrap:wrap}.row input,.row select{min-width:0}.intro-tagline{font-size:12px;letter-spacing:1px}.intro-kicker{font-size:12px;letter-spacing:3px}}

/* Motion */
.dashboard-nav a{transition:background var(--motion-drawer) ease,color var(--motion-drawer) ease,box-shadow var(--motion-drawer) ease,border-color var(--motion-drawer) ease}
.dashboard-nav a svg{transition:transform 260ms var(--motion-ease)}
.dashboard-nav a:hover svg{transform:translateX(2px)}
.card button:not(:disabled):hover,.action:not(:disabled):hover,.button-link:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(18,40,75,.10),0 0 0 3px rgba(67,139,196,.14)}
.card button:not(:disabled):active,.action:not(:disabled):active,.button-link:active{transform:translateY(0) scale(.98);box-shadow:none}
.btn-approve:hover,.action.primary:hover{background:var(--primary);box-shadow:0 0 0 3px rgba(67,139,196,.18),0 4px 14px rgba(0,85,160,.30)}
.quick-links a,.debate-item{transition:background 200ms ease,color 200ms ease,border-color 200ms ease}
.quick-links a span{transition:transform 240ms var(--motion-ease)}
.quick-links a:hover span{transform:translateX(3px)}
.quick-links a:hover{background:var(--accent-soft)}
.debate-item:hover{background:var(--surface2)}
[data-owner-panel]:not([hidden]) .page-heading,#dashboard:not(.hidden) .hero,#app:not(.hidden)>.hero{animation:dashboard-enter 380ms var(--motion-ease) both}
[data-owner-panel]:not([hidden]) .card,#dashboard:not(.hidden) .card,#app:not(.hidden)>.workspace{animation:dashboard-enter 480ms var(--motion-ease) both}
.owner-overview .card:nth-child(2),#dashboard .card:nth-child(2){animation-delay:45ms}
.owner-overview .card:nth-child(3),#dashboard .card:nth-child(3){animation-delay:90ms}
#dashboard .card:nth-child(4){animation-delay:135ms}
#dashboard .card:nth-child(n+5){animation-delay:160ms}
.mcp-form,.panel{animation:dashboard-enter var(--motion-modal) var(--motion-ease) both}
.startup-intro{animation-timing-function:cubic-bezier(.4,0,.2,1)}
.intro-kicker,.intro-wordmark,.intro-tagline,.intro-rule,.intro-orbit{animation-timing-function:var(--motion-ease)}
@keyframes dashboard-enter{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}

/* Reduced motion */
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.startup-intro{display:none!important}.dashboard-sidebar,.nav-indicator,button,a{transition:none!important;animation:none!important}[data-owner-panel] .page-heading,[data-owner-panel] .card,#dashboard .hero,#dashboard .card,#app>.hero,#app>.workspace,.panel,.mcp-form,.dashboard-nav a svg,.quick-links a span{animation:none!important;transition:none!important;transform:none!important}.card button,.action,.range button,.button-link,.debate-item{transition:none!important;transform:none!important}}
${thinkingOrbCss}

/* Compact Overview: keep the desktop summary within one viewport. */
[data-owner-panel=overview] .page-heading{margin-bottom:16px}
[data-owner-panel=overview] .eyebrow{margin-bottom:6px}
[data-owner-panel=overview] .overview-banner{padding:14px 18px;gap:14px;margin-bottom:14px}
[data-owner-panel=overview] .owner-overview{gap:14px;align-items:start}
[data-owner-panel=overview] .owner-overview>.card{padding:18px;margin-bottom:0}
[data-owner-panel=overview] .card .toolbar{margin-bottom:10px}
[data-owner-panel=overview] .overview-stats{margin-top:0;padding-top:10px;row-gap:12px}
[data-owner-panel=overview] .stat-block{padding:0}
[data-owner-panel=overview] .stat-block+.stat-block{padding-left:16px}
[data-owner-panel=overview] .stat-value{font-size:32px;line-height:1.15;margin:5px 0}
[data-owner-panel=overview] .stat-note,[data-owner-panel=overview] .health-list{line-height:1.4}
[data-owner-panel=overview] .health-list{margin-top:5px;gap:5px 10px}
[data-owner-panel=overview] .health-item{font-size:12px}
[data-owner-panel=overview] .quick-links{margin-top:8px}
[data-owner-panel=overview] .quick-links a{padding:9px 0;gap:12px}
[data-owner-panel=overview] .provider-health{padding-top:10px}
[data-owner-panel=overview] .provider-health>div{font-size:20px;line-height:1.3}
[data-owner-panel=overview] .provider-health .note{margin:8px 0 0;line-height:1.5}
[data-owner-panel=overview] .provider-health .button-link{margin-top:14px}
@media(min-width:768px){.dashboard-main:has([data-owner-panel=overview]:not([hidden])){padding-top:22px;padding-bottom:22px}[data-owner-panel=overview] .owner-overview{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:1024px){[data-owner-panel=overview] .stat-block:nth-child(3){padding-left:0}}
@media(max-width:767px){[data-owner-panel=overview] .quick-links a{flex-wrap:wrap}}
@media(max-width:375px){[data-owner-panel=overview] .stat-block+.stat-block{padding:12px 0 0;margin-top:0}}

@media(min-width:768px) and (max-height:820px){.dashboard-sidebar{padding-top:16px;padding-bottom:10px}.dashboard-brand{margin-bottom:14px}.workspace-label{margin-bottom:14px}.nav-caption{margin-bottom:8px}.dashboard-nav{gap:4px}.dashboard-nav a{min-height:40px;padding-top:9px;padding-bottom:9px}.sidebar-bottom{padding-top:10px}.sidebar-footer{padding-top:8px}}
`;
