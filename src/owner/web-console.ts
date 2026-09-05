/**
 * Owner Web Console — the product surface is Paths, Commands, and MCP Servers.
 * Every mutation is a typed intent; no command-string bridge or policy ceremony exists here.
 */

import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { FixedWindowRateLimiter } from "../auth/fixed-window-rate-limiter.js";
import { verifyOwnerSecret } from "../auth/owner-verifier.js";
import { compileCommandCatalog, parseCommandAllowlist } from "../kernel/command-catalog.js";
import type { ExtensionManifestV1 } from "../extension/manifest.js";
import { readBoundedJson } from "../shared/http-body.js";
import type { PolicySnapshotStore } from "../policy/policy-store.js";
import type { ManagedStatePaths } from "./managed-state.js";
import type { PolicyMutationService } from "./policy-mutation.js";
import type { McpCredentialStore } from "./mcp-credential-store.js";
import type { McpProviderService } from "./mcp-provider-service.js";
import type { McpOwnerCredentialIntent, McpOwnerOrchestrator } from "./mcp-owner-orchestrator.js";
import { deriveProviderStatus } from "./mcp-presentation.js";

const SESSION_TTL_MS = 15 * 60_000;
const MAX_BODY_BYTES = 65_536;
const SESSION_COOKIE = "slnctrz_owner_session";

interface SessionRecord {
  readonly expiresAt: number;
  readonly csrf: string;
}

export interface OwnerWebConsole {
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function page(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SlncTrZ Owner</title>
<style>
:root{color-scheme:light dark}
@font-face{font-family:"SlncHertine";src:url(/assets/fonts/SlncHertine.woff2) format("woff2");font-display:swap;font-weight:400;font-style:normal}
@property --angle{syntax:"<angle>";initial-value:0deg;inherits:false}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;padding:2.5rem 1rem;background:#eef0f3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1d21;-webkit-font-smoothing:antialiased;line-height:1.5}
.brandmark{font-family:"SlncHertine","Segoe UI",system-ui,sans-serif;font-size:2.1rem;font-weight:600;letter-spacing:.02em;color:#1a1d21;text-align:center;background:linear-gradient(45deg,#22d3ee 0%,#a855f7 50%,#22d3ee 100%);background-size:200% 200%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 0 6px rgba(34,211,238,.30)) drop-shadow(0 0 8px rgba(168,85,247,.30));animation:wordmark-flow 3s linear infinite;margin-bottom:1rem}
@keyframes wordmark-flow{0%{background-position:0% 50%}100%{background-position:200% 50%}}
.neon-frame{position:relative;width:100%;max-width:75rem;margin:auto;padding:1px;border-radius:12px;background:conic-gradient(from var(--angle),#22d3ee 0deg,#22d3ee 170deg,#a855f7 190deg,#a855f7 350deg,#22d3ee 360deg);animation:neon-spin 2.6s linear infinite;box-shadow:0 0 6px rgba(168,85,247,.14),0 0 6px rgba(34,211,238,.10),0 1px 2px rgba(16,24,40,.04);filter:drop-shadow(0 0 2px rgba(168,85,247,.12))}
@keyframes neon-spin{to{--angle:360deg}}
.login-frame{max-width:26rem;margin:1.5rem auto}
.card{width:100%;background:linear-gradient(180deg,#fbfcfd 0%,#e9edf3 100%);border:none;border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 10px 28px rgba(16,24,40,.07);padding:1.3rem 1.4rem;margin:0 0 1rem}
.card:last-child{margin-bottom:0}
.panel{background:#f8fafc;border:1px solid #eaedf1;border-radius:11px;padding:1rem}
.brand{display:flex;align-items:center;gap:.5rem;font-size:.72rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#697586;margin:0 0 .6rem}
.brand .dot{width:.5rem;height:.5rem;border-radius:50%;background:#2f5a9e}
h1{font-size:1.12rem;font-weight:650;line-height:1.25;margin:0}
.login-frame h1{margin:0 0 1.15rem}
.toolbar{display:flex;justify-content:space-between;gap:.6rem;align-items:center;margin:0 0 .7rem}
.toolbar .grow{display:flex;align-items:baseline;gap:.55rem}
.app-grid{display:grid;grid-template-columns:1fr 35rem;gap:1rem;align-items:start;max-width:75rem;margin:auto}
.app-grid .col{min-width:0}
.muted{font-size:.8rem;color:#697586}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.84rem;word-break:break-word}
label{display:block;font-size:.82rem;font-weight:600;color:#1a1d21;margin:0 0 .35rem}
input,textarea,select{width:100%;padding:.6rem .75rem;font-size:.9rem;color:#1a1d21;background:#fff;border:1px solid #d0d5dd;border-radius:9px;font-family:inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:#2f5a9e;box-shadow:0 0 0 3px rgba(47,90,158,.18)}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-height:140px}
.row{display:flex;gap:.6rem;align-items:center}
#commands+.row{margin-top:.9rem}
.row input,.row select,.row textarea,.row button{flex:1}
.login-form{display:flex;gap:.8rem;align-items:center}
.login-form input{flex:1;min-width:0}
.login-form button{flex:none}
button{padding:.6rem .85rem;font-size:.9rem;font-weight:600;border-radius:9px;cursor:pointer;font-family:inherit;border:1px solid transparent;transition:background-color .15s ease,transform .05s ease;white-space:nowrap}
button:active{transform:translateY(1px)}
.btn-approve{background:#2f5a9e;color:#fff}
.btn-approve:hover{background:#274d88}
.btn-approve:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(47,90,158,.4)}
.btn-deny{background:#fff;color:#475467;border-color:#d0d5dd}
.btn-deny:hover{background:#f8fafc;color:#1a1d21}
.btn-deny:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(16,24,40,.12)}
.btn-danger{background:#b42318;color:#fff}
.btn-danger:hover{background:#9a1c12}
.item{display:flex;align-items:center;gap:.6rem;padding:.6rem 0;border-top:1px solid #eaedf1}
.item:first-child{border-top:0}
.item .grow{flex:1;min-width:0}
.commands-grid{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
#commands-card{display:flex;flex-direction:column;overflow:hidden}
#commands{flex:1;min-height:0;overflow-y:auto}
#commands.collapsed{display:none}
.cmd-chip{display:inline-flex;align-items:center;gap:.4rem;background:#f8fafc;border:1px solid #eaedf1;border-radius:9px;padding:.5rem .65rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.78rem;line-height:1.3;color:#344054;white-space:nowrap}
.chip-x{border:0;background:transparent;color:#697586;font-size:.95rem;line-height:1;padding:0 .12rem;border-radius:6px;cursor:pointer}
.chip-x:hover{color:#b42318}
.note{font-size:.78rem;color:#697586;margin:.8rem 0 0;line-height:1.5}
.error{margin:.5rem 0 0;padding:.6rem .8rem;background:#fef3f2;border:1px solid #fda29b;border-radius:10px;color:#b42318;font-size:.86rem}
.hidden{display:none!important}
.empty{font-size:.85rem;color:#8b94a3}
@media (prefers-color-scheme:dark){
body{background:#0f1115;color:#e6e8eb}
.brandmark{color:#e6e8eb}
.neon-frame{box-shadow:0 0 6px rgba(168,85,247,.16),0 0 6px rgba(34,211,238,.12)}
.card{background:linear-gradient(180deg,#1a1e25 0%,#13161c 100%);border-color:#262b33;box-shadow:0 1px 2px rgba(0,0,0,.4),0 10px 28px rgba(0,0,0,.5)}
.panel{background:#1b1f26;border-color:#262b33}
.brand{color:#9aa4b2}.brand .dot{background:#5b8def}
.muted{color:#9aa4b2}
label{color:#e6e8eb}
input,textarea,select{background:#0f1115;color:#e6e8eb;border-color:#333a44}
input:focus,textarea:focus,select:focus{border-color:#5b8def;box-shadow:0 0 0 3px rgba(91,141,239,.25)}
.btn-approve{background:#3b6fd4}.btn-approve:hover{background:#3461bd}.btn-approve:focus-visible{box-shadow:0 0 0 3px rgba(91,141,239,.45)}
.btn-deny{background:#1b1f26;color:#c2c8d0;border-color:#333a44}.btn-deny:hover{background:#22272f;color:#e6e8eb}
.btn-danger{background:#b42318}
.item{border-top-color:#262b33}
.cmd-chip{background:#1b1f26;border-color:#262b33;color:#c2c8d0}
.chip-x{color:#9aa4b2}.chip-x:hover{color:#f29b9b}
.error{background:#2a1416;border-color:#7a2e2e;color:#f29b9b}
.empty{color:#6b7480}
.note{color:#9aa4b2}
}
@media (prefers-reduced-motion:reduce){.brandmark{animation:none}.neon-frame{animation:none;background:conic-gradient(from 0deg,#22d3ee 0deg,#22d3ee 170deg,#a855f7 190deg,#a855f7 350deg,#22d3ee 360deg)}button{transition:none}}
@media (max-width:900px){.app-grid{grid-template-columns:1fr}}
@media (max-width:640px){.row{flex-direction:column;align-items:stretch}.item{align-items:stretch;flex-direction:column}.item button{width:100%}}
</style></head><body>
<div class="brandmark">&nbsp;&nbsp;&nbsp;&nbsp;SlncTrZ&nbsp;&nbsp;&nbsp;&nbsp;</div>
<!-- LOGIN: neon frame chỉ quanh card login nhỏ -->
<div id="login" class="neon-frame login-frame"><main class="card">
<div class="brand"><span class="dot" aria-hidden="true"></span>SlncTrZ-MCP Owner</div>
<h1>Owner sign in</h1>
<form id="login-form" class="login-form" onsubmit="event.preventDefault();document.getElementById('signin').click();return false"><input id="secret" type="password" autocomplete="current-password" placeholder="Owner passphrase"><button type="submit" id="signin" class="btn-approve">Sign in</button></form>
<div id="login-error" class="error hidden"></div>
</main></div>
<!-- APP -->
<div id="app" class="hidden"><main class="app-grid">
<div class="col">
<section class="card"><div class="toolbar"><div class="grow"><h1>Overview</h1></div></div><div id="overview" class="muted"></div></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>Autonomy</h1></div></div><div class="row"><select id="authority"><option value="restricted">Restricted — selected Paths + approved Commands</option><option value="autonomous">Autonomous — full runtime OS-user authority</option></select><button id="set-authority" class="btn-approve">Apply</button></div><p class="note">Restricted is recommended. Shells/interpreters can still exercise the runtime account's OS permissions.</p></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>Paths</h1></div></div><div id="paths"></div><div class="row"><input id="path" placeholder="/absolute/path"><button id="add-path" class="btn-approve">Add Path</button></div><p class="note">Built-in file tools stay inside these Paths in Restricted mode. OS permissions still apply.</p></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>MCP Servers</h1></div><button id="show-add-mcp" class="btn-approve">Add MCP</button></div><div id="mcp"></div><div id="mcp-form" class="hidden panel"><div class="row"><input id="mcp-name" placeholder="Name"><input id="mcp-id" placeholder="provider-id"></div><div class="row"><input id="mcp-desc" placeholder="Description (optional) — what is this MCP server for?"></div><div class="row"><select id="mcp-transport"><option value="streamable-http">Remote URL</option><option value="stdio">Local command</option></select><input id="mcp-target" placeholder="https://service.example.com/mcp"></div><div class="row" id="mcp-args-row"><input id="mcp-args" placeholder="args (space separated, stdio only)"></div><div class="row"><select id="mcp-auth"><option value="none">No auth</option><option value="bearer">Bearer</option><option value="http-header">HTTP header</option></select><input id="mcp-auth-name" placeholder="Header name"><input id="mcp-auth-value" type="password" placeholder="Credential"></div><div class="row"><button id="add-mcp" class="btn-approve">Probe &amp; Add</button><button id="cancel-mcp" class="btn-deny">Cancel</button></div></div></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>Advanced</h1></div><button id="logout" class="btn-deny">Sign out</button></div><div id="status" class="muted"></div></section>
</div>
<aside class="col"><section class="card" id="commands-card"><div class="toolbar"><div class="grow"><h1>Commands</h1></div><button id="toggle-commands" class="btn-deny">Hide</button></div><div id="commands" class="commands-grid"></div><div class="row"><input id="command-input" placeholder="command"><button id="add-command" class="btn-approve">Add command</button></div></section></aside>
</main></div>
<script>
let csrf='';const q=id=>document.getElementById(id);
async function api(path,opt={}){const headers={...(opt.body?{'content-type':'application/json','x-slnctrz-csrf':csrf}:{}),...(opt.headers||{})};const r=await fetch(path,{...opt,headers});const d=await r.json();if(!r.ok)throw new Error(d?.error?.message||('HTTP '+r.status));return d}
function btn(text,cls,fn){const b=document.createElement('button');b.textContent=text;b.className=cls||'btn-deny';b.onclick=fn;return b}
function showError(el,msg){el.textContent=msg;el.classList.remove('hidden')}
function clearError(el){el.classList.add('hidden')}
async function refresh(){const d=await api('/owner/api/state');q('status').textContent='Policy '+d.policyVersion;q('authority').value=d.authorityMode||'restricted';q('overview').textContent=['Version '+(d.product?.version||'unknown')+(d.product?.buildCommit?' ('+d.product.buildCommit+')':''),'Authority '+(d.authorityMode||'restricted'),'Paths '+((d.paths||[]).length),'Commands '+((d.commands||[]).length),'MCP Servers '+((d.mcpServers||[]).length),'State '+(d.product?.stateRoot||''),'Passphrase recovery '+(d.product?.ownerPassphraseFile||'')].filter(Boolean).join(' · ');const paths=q('paths');paths.innerHTML='';(d.paths||[]).forEach(p=>{const r=document.createElement('div');r.className='item';const t=document.createElement('div');t.className='grow mono';t.textContent=p;r.appendChild(t);r.appendChild(btn('Remove','btn-danger',async()=>{if(!confirm('Remove path '+p+'?'))return;await api('/owner/api/paths',{method:'DELETE',body:JSON.stringify({path:p})});await refresh()}));paths.appendChild(r)});if((d.paths||[]).length===0){const e=document.createElement('div');e.className='empty';e.textContent='No paths configured.';paths.appendChild(e)}renderCommands(d.commands||[]);renderMcp(d.mcpServers||[]);syncCommandHeight()}
function syncCommandHeight(){const card=q('commands-card'),col=document.querySelector('.app-grid > .col');if(card&&col)card.style.maxHeight=(col.offsetHeight)+'px'}
window.addEventListener('resize',syncCommandHeight);
function renderCommands(list){const el=q('commands');el.innerHTML='';const risky=new Set(['bash','sh','powershell','cmd','python','python3','node','perl','ruby','sudo','su','docker','systemctl','apt','apt-get']);list.forEach(c=>{const name=String(c[0]||'');const chip=document.createElement('span');chip.className='cmd-chip';const label=document.createElement('span');label.textContent=c.join(' ')+(risky.has(name)?' ⚠':'');if(risky.has(name))label.title='This command can exercise the full OS permissions of the SlncTrZ runtime account.';const x=document.createElement('button');x.className='chip-x';x.title='Remove '+name;x.textContent='×';x.onclick=async()=>{if(!confirm('Remove command '+name+'?'))return;await removeCommand(name);await refresh()};chip.append(label,x);el.appendChild(chip)});if(list.length===0){const e=document.createElement('div');e.className='empty';e.textContent='No commands allowed.';el.appendChild(e)}}
function renderMcp(list){const el=q('mcp');el.innerHTML='';list.forEach(p=>{const r=document.createElement('div');r.className='item';const main=document.createElement('div');main.className='grow';const title=document.createElement('div');title.textContent=p.name||p.id;const meta=document.createElement('div');meta.className='muted';meta.textContent=(p.tools||0)+' tools · '+(p.status||'Unavailable');main.append(title,meta);r.appendChild(main);r.appendChild(btn('Test','btn-deny',async()=>{await api('/owner/api/mcp/'+encodeURIComponent(p.id)+'/test',{method:'POST',body:'{}'});await refresh()}));r.appendChild(btn(p.enabled?'Disable':'Enable','btn-deny',async()=>{await api('/owner/api/mcp/'+encodeURIComponent(p.id),{method:'PATCH',body:JSON.stringify({enabled:!p.enabled})});await refresh()}));r.appendChild(btn('Sync','btn-deny',async()=>{await api('/owner/api/mcp/'+encodeURIComponent(p.id)+'/sync',{method:'POST',body:'{}'});await refresh()}));r.appendChild(btn('Remove','btn-danger',async()=>{if(!confirm('Remove MCP server '+p.id+'?'))return;await api('/owner/api/mcp/'+encodeURIComponent(p.id),{method:'DELETE',body:'{}'});await refresh()}));el.appendChild(r)});if(list.length===0){const e=document.createElement('div');e.className='empty';e.textContent='No MCP servers configured.';el.appendChild(e)}}
async function session(){try{const d=await api('/owner/api/session');csrf=d.csrf;q('login').classList.add('hidden');q('app').classList.remove('hidden');await refresh()}catch{q('login').classList.remove('hidden');q('app').classList.add('hidden')}}
q('signin').onclick=async()=>{clearError(q('login-error'));try{const d=await api('/owner/api/login',{method:'POST',body:JSON.stringify({secret:q('secret').value})});csrf=d.csrf;q('secret').value='';await session()}catch(e){showError(q('login-error'),String(e))}};
q('secret').addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();q('signin').click()}});
q('logout').onclick=async()=>{await api('/owner/api/logout',{method:'POST',body:'{}'}).catch(()=>{});location.reload()};
q('set-authority').onclick=async()=>{const authorityMode=q('authority').value;if(authorityMode==='autonomous'&&!confirm('Autonomous mode gives SlncTrZ the full filesystem and command authority of the runtime OS account. Continue?'))return;try{await api('/owner/api/authority',{method:'PUT',body:JSON.stringify({authorityMode})});await refresh()}catch(e){alert(e.message||String(e))}};
q('add-path').onclick=async()=>{const path=q('path').value.trim();if(!path)return;try{await api('/owner/api/paths',{method:'POST',body:JSON.stringify({path})});q('path').value='';await refresh()}catch(e){alert(e.message||String(e))}};
async function readCommands(){return api('/owner/api/commands')}
async function saveCommands(parsed){await api('/owner/api/commands',{method:'PUT',body:JSON.stringify({content:JSON.stringify(parsed)})})}
async function addCommand(name){let d=await readCommands();let parsed=d.content?JSON.parse(d.content):{};parsed.shell=parsed.shell||{};parsed.shell.allowlist=parsed.shell.allowlist||{};parsed.shell.allowlist.added=parsed.shell.allowlist.added||[];const key=(e)=>((typeof e==='string')?e:e[0]);if(!parsed.shell.allowlist.added.some(e=>key(e)===name))parsed.shell.allowlist.added.push(name);await saveCommands(parsed)}
async function removeCommand(name){let d=await readCommands();if(!d.content)return;const parsed=JSON.parse(d.content);parsed.shell=parsed.shell||{};parsed.shell.allowlist=parsed.shell.allowlist||{};parsed.shell.allowlist.added=(parsed.shell.allowlist.added||[]).filter(e=>((typeof e==='string')?e:e[0])!==name);await saveCommands(parsed)}
q('add-command').onclick=async()=>{const name=q('command-input').value.trim();if(!name)return;try{await addCommand(name);q('command-input').value='';await refresh()}catch(e){const m=String(e?.message||e).toLowerCase();alert(m.includes("not found")||m.includes("unresolved")?("Command "+name+" is not on this machine (not found on PATH). Only already-installed commands may be added: bash, git, node, npm, npx, python3, docker, sqlite3… Install it first (e.g. apt install "+name+" or npm install -g "+name+"), then add it again.") : String(e?.message||e))}};
q('toggle-commands').onclick=()=>{const body=q('commands');const hide=body.classList.toggle('collapsed');q('toggle-commands').textContent=hide?'Show':'Hide'};
q('show-add-mcp').onclick=()=>q('mcp-form').classList.remove('hidden');
q('cancel-mcp').onclick=()=>q('mcp-form').classList.add('hidden');
q('mcp-transport').onchange=()=>{const stdio=q('mcp-transport').value==='stdio';q('mcp-target').placeholder=stdio?'/absolute/command':'https://service.example.com/mcp';q('mcp-args-row').classList.toggle('hidden',!stdio)};
q('add-mcp').onclick=async()=>{const id=q('mcp-id').value.trim(),name=q('mcp-name').value.trim(),transport=q('mcp-transport').value,target=q('mcp-target').value.trim();if(!id||!target)return;const manifest={id,version:'managed',transport,tools:[]};const desc=q('mcp-desc').value.trim();if(desc)manifest.description=desc;if(transport==='stdio'){manifest.command=target;const args=q('mcp-args').value.trim();manifest.args=args?args.split(/\\s+/):[]}else manifest.endpoint=target;let auth;const kind=q('mcp-auth').value,value=q('mcp-auth-value').value,nameField=q('mcp-auth-name').value.trim();if(kind!=='none'){auth={kind,value};if(kind==='http-header'||kind==='env')auth.name=nameField}try{await api('/owner/api/mcp',{method:'POST',body:JSON.stringify({manifest,name:name||undefined,auth})});q('mcp-form').classList.add('hidden');q('mcp-auth-value').value='';await refresh()}catch(e){alert(e.message||String(e))}};
session();
</script></body></html>`;
}

function sendPage(res: ServerResponse): void {
  const payload = page();
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function parseCredential(raw: unknown): McpOwnerCredentialIntent | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid_credential");
  }
  const value = raw as { kind?: unknown; name?: unknown; value?: unknown };
  if (typeof value.value !== "string" || value.value.length === 0)
    throw new Error("invalid_credential");
  if (value.kind === "bearer") return { kind: "bearer", value: value.value };
  if (value.kind === "http-header" || value.kind === "env") {
    if (typeof value.name !== "string" || value.name.length === 0)
      throw new Error("invalid_credential");
    return { kind: value.kind, name: value.name, value: value.value };
  }
  throw new Error("invalid_credential");
}

export function createOwnerWebConsole(options: {
  readonly ownerSecretHash: string;
  readonly policyStore: Pick<PolicySnapshotStore, "capture" | "reload">;
  readonly statePaths: ManagedStatePaths;
  readonly mutation: PolicyMutationService;
  readonly mcpProviders?: McpProviderService;
  readonly mcpCredentials?: McpCredentialStore;
  readonly mcpOrchestrator?: McpOwnerOrchestrator;
  readonly secureCookies?: boolean;
  readonly productInfo?: {
    readonly version: string;
    readonly buildCommit: string;
    readonly stateRoot: string;
    readonly ownerPassphraseFile: string;
  };
}): OwnerWebConsole {
  const sessions = new Map<string, SessionRecord>();
  const limiter = new FixedWindowRateLimiter({ limit: 10, windowSeconds: 60 });
  let commandMutationTail: Promise<void> = Promise.resolve();
  const serializeCommandMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = commandMutationTail.catch(() => undefined).then(operation);
    commandMutationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  const sessionFor = (req: IncomingMessage): SessionRecord | undefined => {
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (token === undefined) return undefined;
    const session = sessions.get(decodeURIComponent(token));
    if (session !== undefined && session.expiresAt > Date.now()) return session;
    return undefined;
  };
  const requireSession = (req: IncomingMessage, res: ServerResponse): SessionRecord | undefined => {
    const session = sessionFor(req);
    if (session === undefined)
      sendJson(res, 401, { error: { code: "unauthorized", message: "Owner session required" } });
    return session;
  };
  const requireCsrf = (
    req: IncomingMessage,
    res: ServerResponse,
    session: SessionRecord
  ): boolean => {
    if (req.headers["x-slnctrz-csrf"] !== session.csrf) {
      sendJson(res, 403, { error: { code: "csrf_denied", message: "CSRF token required" } });
      return false;
    }
    return true;
  };
  const commandsState = async (): Promise<{
    readonly content: string;
    readonly entries: readonly (readonly string[])[];
  }> => {
    try {
      const content = await readFile(options.statePaths.commandCatalogFile, "utf8");
      return { content, entries: parseCommandAllowlist(JSON.parse(content) as unknown) };
    } catch {
      return { content: "", entries: [] };
    }
  };
  const providerState = async () => {
    if (options.mcpProviders === undefined) return [];
    const providers = await options.mcpProviders.list();
    const health = options.policyStore.capture().extensionStatus?.() ?? [];
    const credentials =
      options.mcpCredentials === undefined ? [] : await options.mcpCredentials.list();
    return providers.map((provider) => {
      const runtime = health.find((entry) => entry.providerId === provider.id);
      const refs = provider.manifest.credentialRefs ?? [];
      const credentialMissing =
        refs.length > 0 && !refs.some((ref) => credentials.some((item) => item.ref === ref));
      return {
        id: provider.id,
        ...(provider.name === undefined ? {} : { name: provider.name }),
        enabled: provider.enabled,
        status: deriveProviderStatus({
          enabled: provider.enabled,
          runtime:
            runtime === undefined ? undefined : { state: runtime.state, health: runtime.health },
          credentialMissing,
          toolDrift: options.mcpProviders?.getDiscovered(provider.id)?.diff.hasChanges ?? false
        }),
        tools: provider.manifest.tools.length,
        transport: provider.manifest.transport
      };
    });
  };

  return Object.freeze({
    async handle(req: IncomingMessage, res: ServerResponse, pathname: string) {
      if (pathname !== "/owner" && !pathname.startsWith("/owner/api/")) return false;
      const method = req.method ?? "GET";
      if (method === "GET" && pathname === "/owner") {
        sendPage(res);
        return true;
      }
      if (method === "POST" && pathname === "/owner/api/login") {
        const peer = req.socket.remoteAddress ?? "unknown";
        const rate = limiter.consume(peer);
        if (!rate.allowed) {
          res.setHeader("retry-after", String(rate.retryAfterSeconds));
          sendJson(res, 429, { error: { code: "rate_limited", message: "Rate limit exceeded" } });
          return true;
        }
        const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as { secret?: unknown };
        if (
          typeof body.secret !== "string" ||
          !verifyOwnerSecret(body.secret, options.ownerSecretHash)
        ) {
          sendJson(res, 401, {
            error: { code: "unauthorized", message: "Owner authentication failed" }
          });
          return true;
        }
        const token = randomBytes(32).toString("base64url");
        const csrf = randomBytes(24).toString("base64url");
        sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, csrf });
        res.setHeader(
          "set-cookie",
          `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/owner; HttpOnly; ${options.secureCookies === false ? "" : "Secure; "}SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
        );
        sendJson(res, 200, { authenticated: true, csrf });
        return true;
      }
      const session = requireSession(req, res);
      if (session === undefined) return true;
      if (method === "GET" && pathname === "/owner/api/session") {
        sendJson(res, 200, {
          authenticated: true,
          csrf: session.csrf,
          expiresAt: new Date(session.expiresAt).toISOString()
        });
        return true;
      }
      if (method === "POST" && pathname === "/owner/api/logout") {
        if (!requireCsrf(req, res, session)) return true;
        sessions.clear();
        res.setHeader(
          "set-cookie",
          `${SESSION_COOKIE}=; Path=/owner; HttpOnly; ${options.secureCookies === false ? "" : "Secure; "}SameSite=Strict; Max-Age=0`
        );
        sendJson(res, 200, { authenticated: false });
        return true;
      }
      if (method === "GET" && pathname === "/owner/api/state") {
        const snapshot = options.policyStore.capture();
        const commands = await commandsState();
        sendJson(res, 200, {
          policyVersion: snapshot.version,
          authorityMode: snapshot.normalized.kernelPolicy.authorityMode,
          paths: snapshot.normalized.kernelPolicy.readRoots ?? [],
          capabilities: snapshot.normalized.kernelPolicy.capabilities,
          commands: commands.entries,
          mcpServers: await providerState(),
          ...(options.productInfo === undefined ? {} : { product: options.productInfo })
        });
        return true;
      }
      if (method === "PUT" && pathname === "/owner/api/authority") {
        if (!requireCsrf(req, res, session)) return true;
        const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as { authorityMode?: unknown };
        if (body.authorityMode !== "restricted" && body.authorityMode !== "autonomous") {
          sendJson(res, 400, {
            error: {
              code: "invalid_authority_mode",
              message: "Authority must be restricted or autonomous"
            }
          });
          return true;
        }
        const result = await options.mutation.apply({
          kind: "set-authority-mode",
          authorityMode: body.authorityMode
        });
        sendJson(res, result.activated ? 200 : 409, result);
        return true;
      }
      if ((method === "POST" || method === "DELETE") && pathname === "/owner/api/paths") {
        if (!requireCsrf(req, res, session)) return true;
        const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as { path?: unknown };
        if (typeof body.path !== "string" || body.path.length === 0) {
          sendJson(res, 400, {
            error: { code: "invalid_path", message: "Absolute path is required" }
          });
          return true;
        }
        const result = await options.mutation.apply({
          kind: method === "POST" ? "add-path" : "remove-path",
          path: body.path
        });
        sendJson(res, result.activated ? 200 : 409, result);
        return true;
      }
      if (method === "GET" && pathname === "/owner/api/commands") {
        sendJson(res, 200, await commandsState());
        return true;
      }
      if (method === "PUT" && pathname === "/owner/api/commands") {
        if (!requireCsrf(req, res, session)) return true;
        const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as { content?: unknown };
        if (typeof body.content !== "string" || body.content.length === 0) {
          sendJson(res, 400, {
            error: { code: "invalid_commands", message: "command.json content is required" }
          });
          return true;
        }
        const commandContent = body.content;
        let entries: readonly (readonly string[])[];
        try {
          entries = parseCommandAllowlist(JSON.parse(commandContent) as unknown);
          compileCommandCatalog(entries);
        } catch (error) {
          sendJson(res, 400, {
            error: {
              code: "invalid_commands",
              message: error instanceof Error ? error.message : "Invalid command.json"
            }
          });
          return true;
        }
        const outcome = await serializeCommandMutation(async () => {
          const target = options.statePaths.commandCatalogFile;
          const priorRaw = await readFile(target, "utf8").catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          });
          const restorePrior = async (): Promise<void> => {
            if (priorRaw === undefined) {
              await rm(target, { force: true });
              return;
            }
            const restoreTemporary = `${target}.tmp-${randomBytes(8).toString("hex")}`;
            try {
              await writeFile(restoreTemporary, priorRaw, {
                encoding: "utf8",
                mode: 0o600,
                flag: "wx"
              });
              await rename(restoreTemporary, target);
            } finally {
              await rm(restoreTemporary, { force: true }).catch(() => undefined);
            }
          };
          const temporary = `${target}.tmp-${randomBytes(8).toString("hex")}`;
          try {
            await writeFile(temporary, commandContent, {
              encoding: "utf8",
              mode: 0o600,
              flag: "wx"
            });
            await rename(temporary, target);
            try {
              const result = await options.policyStore.reload();
              if (!result.activated) {
                try {
                  await restorePrior();
                } catch {
                  return { kind: "recovery_failed" as const };
                }
              }
              return { kind: "reload_result" as const, result };
            } catch {
              try {
                await restorePrior();
              } catch {
                return { kind: "recovery_failed" as const };
              }
              return { kind: "reload_threw" as const };
            }
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
        });
        if (outcome.kind === "recovery_failed") {
          sendJson(res, 500, {
            error: {
              code: "commands_recovery_failed",
              message: "Command catalog activation failed and prior state could not be restored"
            }
          });
          return true;
        }
        if (outcome.kind === "reload_threw") {
          sendJson(res, 500, {
            error: { code: "commands_reload_failed", message: "Command catalog activation failed" }
          });
          return true;
        }
        sendJson(res, outcome.result.activated ? 200 : 409, { ...outcome.result, entries });
        return true;
      }
      if (method === "POST" && pathname === "/owner/api/mcp") {
        if (!requireCsrf(req, res, session)) return true;
        if (options.mcpOrchestrator === undefined) {
          sendJson(res, 404, {
            error: { code: "not_found", message: "MCP management unavailable" }
          });
          return true;
        }
        const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as {
          manifest?: unknown;
          name?: unknown;
          auth?: unknown;
        };
        if (
          typeof body.manifest !== "object" ||
          body.manifest === null ||
          Array.isArray(body.manifest)
        ) {
          sendJson(res, 400, {
            error: { code: "invalid_provider", message: "Provider manifest is required" }
          });
          return true;
        }
        const auth = parseCredential(body.auth);
        const result = await options.mcpOrchestrator.add({
          manifest: body.manifest as ExtensionManifestV1,
          ...(typeof body.name === "string" && body.name.length > 0 ? { name: body.name } : {}),
          ...(auth === undefined ? {} : { auth }),
          enabled: true
        });
        sendJson(res, result.status === "committed" ? 201 : 409, result);
        return true;
      }
      const match = /^\/owner\/api\/mcp\/([^/]+)(?:\/(test|sync|auth))?$/u.exec(pathname);
      if (match !== null) {
        if (!requireCsrf(req, res, session)) return true;
        if (options.mcpProviders === undefined) {
          sendJson(res, 404, {
            error: { code: "not_found", message: "MCP management unavailable" }
          });
          return true;
        }
        const providerId = decodeURIComponent(match[1] ?? "");
        const action = match[2];
        if (method === "PATCH" && action === undefined) {
          const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as { enabled?: unknown };
          if (typeof body.enabled !== "boolean") {
            sendJson(res, 400, {
              error: { code: "invalid_provider", message: "Enabled state is required" }
            });
            return true;
          }
          const result = await options.mcpProviders.setEnabled(providerId, body.enabled);
          sendJson(res, result.reload.activated ? 200 : 409, result);
          return true;
        }
        if (method === "DELETE" && action === undefined) {
          const result =
            options.mcpOrchestrator === undefined
              ? await options.mcpProviders.remove(providerId)
              : await options.mcpOrchestrator.remove({ providerId });
          sendJson(res, 200, result);
          return true;
        }
        if (method === "POST" && action === "test") {
          sendJson(res, 200, await options.mcpProviders.discover(providerId));
          return true;
        }
        if (method === "POST" && action === "sync") {
          const result = await options.mcpProviders.syncToDiscovered(providerId);
          sendJson(res, result.reload.activated ? 200 : 409, result);
          return true;
        }
        if (method === "POST" && action === "auth" && options.mcpOrchestrator !== undefined) {
          const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as { auth?: unknown };
          const auth = parseCredential(body.auth);
          if (auth === undefined) {
            sendJson(res, 400, {
              error: { code: "invalid_credential", message: "Credential is required" }
            });
            return true;
          }
          sendJson(res, 200, await options.mcpOrchestrator.updateAuth({ providerId, auth }));
          return true;
        }
      }
      sendJson(res, 404, { error: { code: "not_found", message: "Owner route not found" } });
      return true;
    }
  });
}
