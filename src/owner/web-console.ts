/**
 * Owner Web Console — the product surface is Paths, Commands, and MCP Servers.
 * Every mutation is a typed intent; no command-string bridge or policy ceremony exists here.
 */

import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { FixedWindowRateLimiter } from "../auth/fixed-window-rate-limiter.js";
import { validateConnectionLabel } from "../auth/oauth-grant-store.js";
import type { OwnerConnectionService } from "../auth/owner-connection-service.js";
import { verifyOwnerSecret } from "../auth/owner-verifier.js";
import { DebateError, type DebateService } from "../debate/index.js";
import { compileCommandCatalog, parseCommandAllowlist } from "../kernel/command-catalog.js";
import type { ExtensionManifestV1 } from "../extension/manifest.js";
import { readBoundedJson } from "../shared/http-body.js";
import type { PolicySnapshotStore } from "../policy/policy-store.js";
import type { ManagedStatePaths } from "./managed-state.js";
import type { PolicyMutationService } from "./policy-mutation.js";
import type { McpCredentialStore } from "./mcp-credential-store.js";
import type { McpProviderService } from "./mcp-provider-service.js";
import type { McpOwnerCredentialIntent, McpOwnerOrchestrator } from "./mcp-owner-orchestrator.js";
import { deriveProviderStatus, summarizeProviderStatuses } from "./mcp-presentation.js";
import type { UsageReader } from "../observability/usage-query.js";
import { parseUsageRange } from "../observability/usage-query.js";
import { sendDebatePage } from "./debate-page.js";
import { sendUsagePage } from "./usage-page.js";

const SESSION_IDLE_TTL_MS = 3 * 60 * 60_000;
const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60_000;
const MAX_BODY_BYTES = 65_536;
const SESSION_COOKIE = "slnctrz_owner_session";

interface SessionRecord {
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
  readonly csrf: string;
}

interface AuthenticatedSession extends SessionRecord {
  readonly token: string;
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
body{margin:0;min-height:100dvh;padding:2.5rem 1rem;background:radial-gradient(circle at 15% 10%,rgba(34,211,238,.055),transparent 28rem),radial-gradient(circle at 88% 18%,rgba(168,85,247,.055),transparent 26rem),#eef0f3;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1d21;-webkit-font-smoothing:antialiased;line-height:1.5}
.brandmark{font-family:"SlncHertine","Segoe UI",system-ui,sans-serif;font-size:2.1rem;font-weight:600;letter-spacing:.02em;color:#1a1d21;text-align:center;background:linear-gradient(45deg,#22d3ee 0%,#a855f7 50%,#22d3ee 100%);background-size:200% 200%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 0 6px rgba(34,211,238,.30)) drop-shadow(0 0 8px rgba(168,85,247,.30));animation:wordmark-flow 3s linear infinite;margin-bottom:1rem}
@keyframes wordmark-flow{0%{background-position:0% 50%}100%{background-position:200% 50%}}
.neon-frame{position:relative;width:100%;max-width:75rem;margin:auto;padding:1px;border-radius:12px;background:conic-gradient(from var(--angle),#22d3ee 0deg,#22d3ee 170deg,#a855f7 190deg,#a855f7 350deg,#22d3ee 360deg);animation:neon-spin 2.6s linear infinite;box-shadow:0 0 6px rgba(168,85,247,.14),0 0 6px rgba(34,211,238,.10),0 1px 2px rgba(16,24,40,.04);filter:drop-shadow(0 0 2px rgba(168,85,247,.12))}
@keyframes neon-spin{to{--angle:360deg}}
.login-frame{max-width:26rem;margin:1.5rem auto}
.card{position:relative;isolation:isolate;width:100%;background:linear-gradient(180deg,rgba(251,252,253,.98) 0%,rgba(233,237,243,.96) 100%);border:1px solid rgba(255,255,255,.78);border-radius:16px;box-shadow:0 12px 32px rgba(31,42,62,.08),inset 0 1px 0 rgba(255,255,255,.92);padding:1.3rem 1.4rem;margin:0 0 1rem}
.card::before{content:"";position:absolute;inset:-1px;z-index:-1;border-radius:17px;padding:1px;background:linear-gradient(118deg,rgba(34,211,238,.72),rgba(168,85,247,.62) 48%,rgba(34,211,238,.34));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.58;pointer-events:none;transition:opacity .35s cubic-bezier(.32,.72,0,1),filter .35s cubic-bezier(.32,.72,0,1)}
.card::after{content:"";position:absolute;inset:-4px;z-index:-2;border-radius:20px;background:linear-gradient(118deg,rgba(34,211,238,.12),rgba(168,85,247,.10));filter:blur(10px);opacity:.3;pointer-events:none;transition:opacity .35s cubic-bezier(.32,.72,0,1)}
.card:hover::before{opacity:.82;filter:saturate(1.08)}
.card:hover::after{opacity:.52}
.card:last-child{margin-bottom:0}
.panel{background:rgba(248,250,252,.78);border:1px solid rgba(148,163,184,.22);border-radius:12px;padding:1rem;box-shadow:inset 0 1px 0 rgba(255,255,255,.72)}
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
.overview-stats{display:grid;grid-template-columns:minmax(0,.78fr) minmax(0,1.22fr);gap:1rem;margin-top:.95rem;padding-top:1rem;border-top:1px solid rgba(100,116,139,.16)}
.stat-block{min-width:0;padding:.1rem .25rem .2rem}
.stat-block+.stat-block{border-left:1px solid rgba(100,116,139,.16);padding-left:1.25rem}
.stat-label{font-size:.7rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#7b8492}
.stat-value{margin-top:.28rem;font-size:2rem;font-weight:680;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.04em}
.stat-note{margin-top:.45rem;font-size:.78rem;color:#697586}
.health-list{display:flex;flex-wrap:wrap;gap:.45rem .9rem;margin-top:.55rem}
.health-item{display:inline-flex;align-items:center;gap:.38rem;font-size:.78rem;color:#5f6977;font-variant-numeric:tabular-nums}
.status-dot{width:.48rem;height:.48rem;border-radius:50%;background:#667085;box-shadow:0 0 0 3px rgba(102,112,133,.08)}
.status-dot.working{background:#279b78;box-shadow:0 0 0 3px rgba(39,155,120,.10),0 0 8px rgba(39,155,120,.26)}
.status-dot.attention{background:#c98a22;box-shadow:0 0 0 3px rgba(201,138,34,.10),0 0 8px rgba(201,138,34,.22)}
.status-dot.error-dot{background:#c44444;box-shadow:0 0 0 3px rgba(196,68,68,.10),0 0 8px rgba(196,68,68,.22)}
.status-dot.disabled{background:#8a94a3}
.advanced-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem 1rem;padding-top:.9rem;border-top:1px solid rgba(100,116,139,.16)}
.advanced-item{min-width:0}
.advanced-key{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7b8492}
.advanced-value{margin-top:.18rem;font-size:.84rem;color:#344054;word-break:break-word}
.advanced-actions{display:flex;justify-content:flex-end;margin-top:1rem;padding-top:.9rem;border-top:1px solid rgba(100,116,139,.16)}
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
button,.button-link{display:inline-flex;align-items:center;justify-content:center;padding:.6rem .85rem;font-size:.9rem;font-weight:650;border-radius:9px;cursor:pointer;font-family:inherit;border:1px solid transparent;transition:background-color .24s cubic-bezier(.32,.72,0,1),color .24s cubic-bezier(.32,.72,0,1),border-color .24s cubic-bezier(.32,.72,0,1),transform .16s cubic-bezier(.32,.72,0,1),box-shadow .24s cubic-bezier(.32,.72,0,1);white-space:nowrap;text-decoration:none}
button:active,.button-link:active{transform:translateY(1px) scale(.985)}
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
.conn-item{align-items:flex-start;gap:.8rem;flex-wrap:wrap}
.conn-top{display:flex;align-items:center;gap:.5rem;min-width:0}
.conn-title{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conn-badge{flex:none;font-size:.64rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#697586;border:1px solid #d0d5dd;border-radius:999px;padding:.12rem .55rem}
.conn-badge.full{color:#2f5a9e;border-color:#2f5a9e}
.conn-controls{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.conn-controls select{width:auto}
.conn-edit{border:0;background:transparent;color:#697586;font-size:.95rem;line-height:1;padding:.2rem .35rem;border-radius:6px;cursor:pointer;flex:none}
.conn-edit:hover{color:#2f5a9e;background:rgba(47,90,158,.08)}
.conn-rename{width:11rem;flex:none}
.commands-grid{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
#commands-card{display:flex;flex-direction:column;overflow:hidden}
#commands{flex:1;min-height:0;overflow-y:auto}
.cmd-chip{display:inline-flex;align-items:center;gap:.4rem;background:#f8fafc;border:1px solid #eaedf1;border-radius:9px;padding:.5rem .65rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.78rem;line-height:1.3;color:#344054;white-space:nowrap}
.chip-x{border:0;background:transparent;color:#697586;font-size:.95rem;line-height:1;padding:0 .12rem;border-radius:6px;cursor:pointer}
.chip-x:hover{color:#b42318}
.note{font-size:.78rem;color:#697586;margin:.8rem 0 0;line-height:1.5}
.error{margin:.5rem 0 0;padding:.6rem .8rem;background:#fef3f2;border:1px solid #fda29b;border-radius:10px;color:#b42318;font-size:.86rem}
.hidden{display:none!important}
.collapsible{display:grid;grid-template-rows:1fr;transition:grid-template-rows .28s cubic-bezier(.32,.72,0,1)}
.collapsible.collapsed{grid-template-rows:0fr}
.collapsible-inner{overflow:hidden;min-height:0;min-width:0}
.empty{font-size:.85rem;color:#8b94a3}
@media (prefers-color-scheme:dark){
body{background:radial-gradient(circle at 15% 10%,rgba(34,211,238,.055),transparent 28rem),radial-gradient(circle at 88% 18%,rgba(168,85,247,.06),transparent 26rem),#0f1115;color:#e6e8eb}
.brandmark{color:#e6e8eb}
.neon-frame{box-shadow:0 0 6px rgba(168,85,247,.16),0 0 6px rgba(34,211,238,.12)}
.card{background:linear-gradient(180deg,rgba(26,30,37,.98) 0%,rgba(19,22,28,.98) 100%);border-color:rgba(255,255,255,.06);box-shadow:0 14px 34px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.035)}
.card::before{opacity:.46}.card:hover::before{opacity:.75}.card::after{opacity:.26}.card:hover::after{opacity:.46}
.panel{background:rgba(27,31,38,.88);border-color:rgba(255,255,255,.07)}
.brand{color:#9aa4b2}.brand .dot{background:#5b8def}
.muted{color:#9aa4b2}
.stat-label,.advanced-key{color:#8f99a8}.stat-note,.health-item{color:#9aa4b2}.advanced-value{color:#c8ced7}
.overview-stats,.stat-block+.stat-block,.advanced-grid,.advanced-actions{border-color:rgba(148,163,184,.14)}
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
.conn-badge{color:#8f99a8;border-color:#333a44}.conn-badge.full{color:#5b8def;border-color:#5b8def}.conn-edit{color:#9aa4b2}.conn-edit:hover{color:#e6e8eb;background:rgba(91,141,239,.12)}
}
@media (prefers-reduced-motion:reduce){.brandmark{animation:none}.neon-frame{animation:none;background:conic-gradient(from 0deg,#22d3ee 0deg,#22d3ee 170deg,#a855f7 190deg,#a855f7 350deg,#22d3ee 360deg)}button,.button-link,.card::before,.card::after,.collapsible{transition:none}}
@media (max-width:900px){.app-grid{grid-template-columns:1fr}}
@media (max-width:640px){.row{flex-direction:column;align-items:stretch}.item{align-items:stretch;flex-direction:column}.item button{width:100%}.overview-stats,.advanced-grid{grid-template-columns:1fr}.stat-block+.stat-block{border-left:0;border-top:1px solid rgba(100,116,139,.16);padding-left:.25rem;padding-top:1rem}.button-link{width:auto}.conn-rename{flex:1;min-width:0}}
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
<section class="card"><div class="toolbar"><div class="grow"><h1>Overview</h1></div><div class="row"><a href="/usage" class="btn-deny button-link">Usage</a><a href="/debate" class="btn-deny button-link">Debate</a></div></div><div class="overview-stats"><div class="stat-block"><div class="stat-label">Commands</div><div id="overview-command-count" class="stat-value">—</div><div id="overview-command-note" class="stat-note">Catalog status</div></div><div class="stat-block"><div class="stat-label">MCP servers</div><div id="overview-mcp-count" class="stat-value">—</div><div class="health-list"><div class="health-item"><span class="status-dot working" aria-hidden="true"></span><span id="overview-mcp-working">0 working</span></div><div class="health-item"><span class="status-dot error-dot" aria-hidden="true"></span><span id="overview-mcp-error">0 error</span></div><div id="overview-mcp-attention-row" class="health-item hidden"><span class="status-dot attention" aria-hidden="true"></span><span id="overview-mcp-attention">0 attention</span></div><div id="overview-mcp-disabled-row" class="health-item hidden"><span class="status-dot disabled" aria-hidden="true"></span><span id="overview-mcp-disabled">0 disabled</span></div></div></div></div></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>Autonomy</h1></div></div><div class="row"><select id="authority"><option value="restricted">Restricted — selected Paths + approved Commands</option><option value="autonomous">Autonomous — full runtime OS-user authority</option></select><button id="set-authority" class="btn-approve">Apply</button></div><p class="note">Restricted is recommended. Shells/interpreters can still exercise the runtime account's OS permissions.</p></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>Connections</h1><span class="muted">Tool surface per OAuth grant</span></div><button id="toggle-connections" class="btn-deny" aria-expanded="true">Hide</button></div><div id="connections-body" class="collapsible"><div class="collapsible-inner"><div id="connections"></div></div></div><p class="note">Gateway-only hides coding tools. Rename changes display names only.</p></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>Paths</h1></div><button id="toggle-paths" class="btn-deny" aria-expanded="true">Hide</button></div><div id="paths-body" class="collapsible"><div class="collapsible-inner"><div id="paths"></div><div class="row"><input id="path" placeholder="/absolute/path"><button id="add-path" class="btn-approve">Add Path</button></div></div></div><p class="note">Built-in file tools stay inside these Paths in Restricted mode. OS permissions still apply.</p></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>MCP Servers</h1></div><button id="toggle-mcp" class="btn-deny" aria-expanded="true">Hide</button><button id="show-add-mcp" class="btn-approve">Add MCP</button></div><div id="mcp-body" class="collapsible"><div class="collapsible-inner"><div id="mcp"></div><div id="mcp-form" class="hidden panel"><div class="row"><input id="mcp-name" placeholder="Name"><input id="mcp-id" placeholder="provider-id"></div><div class="row"><input id="mcp-desc" placeholder="Description (optional) — what is this MCP server for?"></div><div class="row"><select id="mcp-transport"><option value="streamable-http">Remote URL</option><option value="stdio">Local command</option></select><input id="mcp-target" placeholder="https://service.example.com/mcp"></div><div class="row" id="mcp-args-row"><input id="mcp-args" placeholder="args (space separated, stdio only)"></div><div class="row"><select id="mcp-auth"><option value="none">No auth</option><option value="bearer">Bearer</option><option value="http-header">HTTP header</option></select><input id="mcp-auth-name" placeholder="Header name"><input id="mcp-auth-value" type="password" placeholder="Credential"></div><div class="row"><button id="add-mcp" class="btn-approve">Probe &amp; Add</button><button id="cancel-mcp" class="btn-deny">Cancel</button></div></div></div></div></section>
<section class="card"><div class="toolbar"><div class="grow"><h1>Advanced</h1></div><button id="toggle-advanced" class="btn-deny" aria-expanded="false">Show</button></div><div id="advanced-content" class="collapsible collapsed"><div class="collapsible-inner"><div class="advanced-grid"><div class="advanced-item"><div class="advanced-key">Version</div><div id="advanced-version" class="advanced-value">—</div></div><div class="advanced-item"><div class="advanced-key">Build</div><div id="advanced-build" class="advanced-value mono">—</div></div><div class="advanced-item"><div class="advanced-key">Authority</div><div id="advanced-authority" class="advanced-value">—</div></div><div class="advanced-item"><div class="advanced-key">Paths</div><div id="advanced-paths" class="advanced-value">—</div></div><div class="advanced-item"><div class="advanced-key">State root</div><div id="advanced-state" class="advanced-value mono">—</div></div><div class="advanced-item"><div class="advanced-key">Passphrase recovery</div><div id="advanced-recovery" class="advanced-value">—</div></div></div><div class="advanced-actions"><button id="logout" class="btn-deny">Sign out</button></div></div></div></section>
</div>
<aside class="col"><section class="card" id="commands-card"><div class="toolbar"><div class="grow"><h1>Commands</h1></div><button id="toggle-commands" class="btn-deny" aria-expanded="true">Hide</button></div><div id="commands-body" class="collapsible"><div class="collapsible-inner"><div id="commands" class="commands-grid"></div><div class="row"><input id="command-input" placeholder="command"><button id="add-command" class="btn-approve">Add command</button></div></div></div></section></aside>
</main></div>
<script>
let csrf='';const q=id=>document.getElementById(id);
async function api(path,opt={}){const headers={...(opt.body?{'content-type':'application/json','x-slnctrz-csrf':csrf}:{}),...(opt.headers||{})};const r=await fetch(path,{...opt,headers});const d=await r.json();if(!r.ok)throw new Error(d?.error?.message||('HTTP '+r.status));return d}
function btn(text,cls,fn){const b=document.createElement('button');b.textContent=text;b.className=cls||'btn-deny';b.onclick=fn;return b}
function showError(el,msg){el.textContent=msg;el.classList.remove('hidden')}
function clearError(el){el.classList.add('hidden')}
function renderOverview(d){const commands=d.commands||[];const commandStatus=d.commandCatalog?.status||'unknown';q('overview-command-count').textContent=String(commands.length);q('overview-command-note').textContent=commandStatus==='ready'?'ready':commandStatus;const s=d.mcpSummary||{total:(d.mcpServers||[]).length,working:0,attention:0,error:0,disabled:0};q('overview-mcp-count').textContent=String(s.total);q('overview-mcp-working').textContent=String(s.working)+' working';q('overview-mcp-error').textContent=String(s.error)+' error';q('overview-mcp-attention').textContent=String(s.attention)+' attention';q('overview-mcp-disabled').textContent=String(s.disabled)+' disabled';q('overview-mcp-attention-row').classList.toggle('hidden',!s.attention);q('overview-mcp-disabled-row').classList.toggle('hidden',!s.disabled)}
function renderAdvanced(d){const p=d.product||{};q('advanced-version').textContent=p.version||'unknown';q('advanced-build').textContent=p.buildCommit?String(p.buildCommit).slice(0,8):'unknown';q('advanced-authority').textContent=d.authorityMode||'restricted';q('advanced-paths').textContent=String((d.paths||[]).length);q('advanced-state').textContent=p.stateRoot||'unknown';q('advanced-recovery').textContent=p.ownerPassphraseFile?'configured':'unavailable'}
function renderConnections(list){const el=q('connections');el.replaceChildren();for(const c of list||[]){const grantId=String(c.grantId||c.connectionId||'');const label=String(c.label||c.clientId||'OAuth client');const profile=c.surfaceProfile||'full';const row=document.createElement('div');row.className='item conn-item';const main=document.createElement('div');main.className='grow';const top=document.createElement('div');top.className='conn-top';const title=document.createElement('div');title.className='conn-title';title.textContent=label;title.title=label;const badge=document.createElement('span');badge.className='conn-badge'+(profile==='full'?' full':'');badge.textContent=profile==='full'?'Full':'Gateway-only';const edit=document.createElement('button');edit.type='button';edit.className='conn-edit';edit.textContent='✎';edit.title='Rename connection';edit.setAttribute('aria-label','Rename '+label);const rename=document.createElement('input');rename.className='conn-rename hidden';rename.value=String(c.label||'');rename.maxLength=64;rename.placeholder='Agent name';rename.setAttribute('aria-label','New display name for '+label);const confirm=btn('Apply','btn-approve hidden',async()=>{await api('/owner/api/connections/label',{method:'PUT',body:JSON.stringify({grantId,label:rename.value})});await refresh()});const cancelEdit=()=>{rename.classList.add('hidden');confirm.classList.add('hidden');title.classList.remove('hidden');edit.classList.remove('hidden')};edit.onclick=()=>{const opening=rename.classList.contains('hidden');if(opening){title.classList.add('hidden');edit.classList.add('hidden');rename.classList.remove('hidden');confirm.classList.remove('hidden');rename.value=String(c.label||'');rename.focus();rename.select()}else cancelEdit()};rename.addEventListener('keydown',(event)=>{if(event.key==='Escape')cancelEdit();if(event.key==='Enter'){event.preventDefault();confirm.click()}});top.append(title,badge,edit,rename,confirm);main.append(top);const controls=document.createElement('div');controls.className='conn-controls';const select=document.createElement('select');select.setAttribute('aria-label','Tool surface for '+label);for(const value of ['full','gateway-only']){const option=document.createElement('option');option.value=value;option.textContent=value==='full'?'Full':'Gateway-only';select.appendChild(option)}select.value=profile;const apply=btn('Apply','btn-approve',async()=>{await api('/owner/api/connections/profile',{method:'PUT',body:JSON.stringify({grantId,surfaceProfile:select.value})});await refresh()});controls.append(select,apply);row.append(main,controls);el.appendChild(row)}if(!(list||[]).length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No active OAuth connections.';el.appendChild(empty)}}
async function refresh(){const d=await api('/owner/api/state');q('authority').value=d.authorityMode||'restricted';renderOverview(d);renderAdvanced(d);renderConnections(d.connections||[]);const paths=q('paths');paths.innerHTML='';(d.paths||[]).forEach(p=>{const r=document.createElement('div');r.className='item';const t=document.createElement('div');t.className='grow mono';t.textContent=p;r.appendChild(t);r.appendChild(btn('Remove','btn-danger',async()=>{if(!confirm('Remove path '+p+'?'))return;await api('/owner/api/paths',{method:'DELETE',body:JSON.stringify({path:p})});await refresh()}));paths.appendChild(r)});if((d.paths||[]).length===0){const e=document.createElement('div');e.className='empty';e.textContent='No paths configured.';paths.appendChild(e)}renderCommands(d.commands||[],d.commandCatalog);renderMcp(d.mcpServers||[]);syncCommandHeight()}
function syncCommandHeight(){const card=q('commands-card'),col=document.querySelector('.app-grid > .col');if(card&&col)card.style.maxHeight=(col.offsetHeight)+'px'}
window.addEventListener('resize',syncCommandHeight);
function renderCommands(list,state){const el=q('commands');el.innerHTML='';if(state&&state.status!=='ready'){const e=document.createElement('div');e.className='error';e.textContent=state.message||('Command catalog '+state.status+'.');el.appendChild(e)}const risky=new Set(['bash','sh','powershell','cmd','python','python3','node','perl','ruby','sudo','su','docker','systemctl','apt','apt-get']);list.forEach(c=>{const name=String(c[0]||'');const chip=document.createElement('span');chip.className='cmd-chip';const label=document.createElement('span');label.textContent=c.join(' ')+(risky.has(name)?' ⚠':'');if(risky.has(name))label.title='This command can exercise the full OS permissions of the SlncTrZ runtime account.';const x=document.createElement('button');x.className='chip-x';x.title='Remove '+name;x.textContent='×';x.onclick=async()=>{if(!confirm('Remove command '+name+'?'))return;await removeCommand(name);await refresh()};chip.append(label,x);el.appendChild(chip)});if(list.length===0&&(!state||state.status==='ready')){const e=document.createElement('div');e.className='empty';e.textContent='No commands allowed.';el.appendChild(e)}}
function renderMcp(list){const el=q('mcp');el.innerHTML='';list.forEach(p=>{const r=document.createElement('div');r.className='item';const main=document.createElement('div');main.className='grow';const title=document.createElement('div');title.textContent=p.name||p.id;const meta=document.createElement('div');meta.className='muted';meta.textContent=(p.tools||0)+' tools · '+(p.status||'Unavailable');main.append(title,meta);r.appendChild(main);r.appendChild(btn('Test','btn-deny',async()=>{await api('/owner/api/mcp/'+encodeURIComponent(p.id)+'/test',{method:'POST',body:'{}'});await refresh()}));r.appendChild(btn(p.enabled?'Disable':'Enable','btn-deny',async()=>{await api('/owner/api/mcp/'+encodeURIComponent(p.id),{method:'PATCH',body:JSON.stringify({enabled:!p.enabled})});await refresh()}));r.appendChild(btn('Sync','btn-deny',async()=>{await api('/owner/api/mcp/'+encodeURIComponent(p.id)+'/sync',{method:'POST',body:'{}'});await refresh()}));r.appendChild(btn('Remove','btn-danger',async()=>{if(!confirm('Remove MCP server '+p.id+'?'))return;await api('/owner/api/mcp/'+encodeURIComponent(p.id),{method:'DELETE',body:'{}'});await refresh()}));el.appendChild(r)});if(list.length===0){const e=document.createElement('div');e.className='empty';e.textContent='No MCP servers configured.';el.appendChild(e)}}
async function session(){try{const d=await api('/owner/api/session');csrf=d.csrf;q('login').classList.add('hidden');q('app').classList.remove('hidden');await refresh()}catch{q('login').classList.remove('hidden');q('app').classList.add('hidden')}}
q('signin').onclick=async()=>{clearError(q('login-error'));try{const d=await api('/owner/api/login',{method:'POST',body:JSON.stringify({secret:q('secret').value})});csrf=d.csrf;q('secret').value='';await session()}catch(e){showError(q('login-error'),String(e))}};
q('secret').addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();q('signin').click()}});
function wireToggle(buttonId,bodyId){q(buttonId).onclick=()=>{const body=q(bodyId);const collapsed=body.classList.toggle('collapsed');const button=q(buttonId);button.textContent=collapsed?'Show':'Hide';button.setAttribute('aria-expanded',String(!collapsed))}}
wireToggle('toggle-connections','connections-body');
wireToggle('toggle-paths','paths-body');
wireToggle('toggle-mcp','mcp-body');
wireToggle('toggle-advanced','advanced-content');
wireToggle('toggle-commands','commands-body');
q('logout').onclick=async()=>{await api('/owner/api/logout',{method:'POST',body:'{}'}).catch(()=>{});location.reload()};
q('set-authority').onclick=async()=>{const authorityMode=q('authority').value;if(authorityMode==='autonomous'&&!confirm('Autonomous mode gives SlncTrZ the full filesystem and command authority of the runtime OS account. Continue?'))return;try{await api('/owner/api/authority',{method:'PUT',body:JSON.stringify({authorityMode})});await refresh()}catch(e){alert(e.message||String(e))}};
q('add-path').onclick=async()=>{const path=q('path').value.trim();if(!path)return;try{await api('/owner/api/paths',{method:'POST',body:JSON.stringify({path})});q('path').value='';await refresh()}catch(e){alert(e.message||String(e))}};
async function readCommands(){return api('/owner/api/commands')}
async function saveCommands(parsed){await api('/owner/api/commands',{method:'PUT',body:JSON.stringify({content:JSON.stringify(parsed)})})}
async function addCommand(name){let d=await readCommands();let parsed=d.content?JSON.parse(d.content):{};parsed.shell=parsed.shell||{};parsed.shell.allowlist=parsed.shell.allowlist||{};parsed.shell.allowlist.added=parsed.shell.allowlist.added||[];const key=(e)=>((typeof e==='string')?e:e[0]);if(!parsed.shell.allowlist.added.some(e=>key(e)===name))parsed.shell.allowlist.added.push(name);await saveCommands(parsed)}
async function removeCommand(name){let d=await readCommands();if(!d.content)return;const parsed=JSON.parse(d.content);parsed.shell=parsed.shell||{};parsed.shell.allowlist=parsed.shell.allowlist||{};parsed.shell.allowlist.added=(parsed.shell.allowlist.added||[]).filter(e=>((typeof e==='string')?e:e[0])!==name);await saveCommands(parsed)}
q('add-command').onclick=async()=>{const name=q('command-input').value.trim();if(!name)return;try{await addCommand(name);q('command-input').value='';await refresh()}catch(e){const m=String(e?.message||e).toLowerCase();alert(m.includes("not found")||m.includes("unresolved")?("Command "+name+" is not on this machine (not found on PATH). Only already-installed commands may be added: bash, git, node, npm, npx, python3, docker, sqlite3… Install it first (e.g. apt install "+name+" or npm install -g "+name+"), then add it again.") : String(e?.message||e))}};

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
  readonly connections?: Pick<
    OwnerConnectionService,
    "listConnections" | "setGrantProfile" | "setClientDefault" | "setConnectionLabel"
  >;
  readonly debates?: Pick<
    DebateService,
    "listForOwner" | "readForOwner" | "stopAsOwner" | "resumeAsOwner" | "deleteAsOwner"
  >;
  readonly secureCookies?: boolean;
  readonly usage?: UsageReader;
  readonly now?: () => number;
  readonly productInfo?: {
    readonly version: string;
    readonly buildCommit: string;
    readonly stateRoot: string;
    readonly ownerPassphraseFile: string;
  };
}): OwnerWebConsole {
  const sessions = new Map<string, SessionRecord>();
  const limiter = new FixedWindowRateLimiter({ limit: 10, windowSeconds: 60 });
  const now = options.now ?? Date.now;
  const cookie = (token: string, expiresAt: number, at: number): string =>
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/owner; HttpOnly; ${options.secureCookies === false ? "" : "Secure; "}SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - at) / 1000))}`;
  const expireCookie = (): string =>
    `${SESSION_COOKIE}=; Path=/owner; HttpOnly; ${options.secureCookies === false ? "" : "Secure; "}SameSite=Strict; Max-Age=0`;
  const pruneExpiredSessions = (at: number): void => {
    for (const [token, session] of sessions) {
      if (session.idleExpiresAt <= at || session.absoluteExpiresAt <= at) sessions.delete(token);
    }
  };
  let commandMutationTail: Promise<void> = Promise.resolve();
  const serializeCommandMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = commandMutationTail.catch(() => undefined).then(operation);
    commandMutationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
  const sessionFor = (req: IncomingMessage): AuthenticatedSession | undefined => {
    const encodedToken = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    if (encodedToken === undefined) return undefined;
    let token: string;
    try {
      token = decodeURIComponent(encodedToken);
    } catch {
      return undefined;
    }
    const at = now();
    pruneExpiredSessions(at);
    const session = sessions.get(token);
    if (session === undefined) return undefined;
    if (session.idleExpiresAt <= at || session.absoluteExpiresAt <= at) {
      sessions.delete(token);
      return undefined;
    }
    return { token, ...session };
  };
  const requireSession = (
    req: IncomingMessage,
    res: ServerResponse
  ): AuthenticatedSession | undefined => {
    const active = sessionFor(req);
    if (active === undefined) {
      sendJson(res, 401, { error: { code: "unauthorized", message: "Owner session required" } });
      return undefined;
    }
    const at = now();
    const idleExpiresAt = Math.min(at + SESSION_IDLE_TTL_MS, active.absoluteExpiresAt);
    const renewed = {
      token: active.token,
      csrf: active.csrf,
      idleExpiresAt,
      absoluteExpiresAt: active.absoluteExpiresAt
    };
    sessions.set(active.token, {
      csrf: renewed.csrf,
      idleExpiresAt: renewed.idleExpiresAt,
      absoluteExpiresAt: renewed.absoluteExpiresAt
    });
    res.setHeader("set-cookie", cookie(active.token, idleExpiresAt, at));
    return renewed;
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
  const commandsState = async (): Promise<
    | {
        readonly status: "ready";
        readonly content: string;
        readonly entries: readonly (readonly string[])[];
      }
    | {
        readonly status: "missing" | "unreadable" | "invalid";
        readonly content: string;
        readonly entries: readonly (readonly string[])[];
        readonly message: string;
      }
  > => {
    let content: string;
    try {
      content = await readFile(options.statePaths.commandCatalogFile, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        status: code === "ENOENT" ? "missing" : "unreadable",
        content: "",
        entries: [],
        message:
          code === "ENOENT"
            ? "Command catalog is missing. Run repair to restore the discovered default catalog."
            : `Command catalog is unreadable: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    let entries: readonly (readonly string[])[];
    try {
      entries = parseCommandAllowlist(JSON.parse(content) as unknown);
    } catch (error) {
      return {
        status: "invalid",
        content,
        entries: [],
        message: `Command catalog is invalid: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    try {
      compileCommandCatalog(entries);
      return { status: "ready", content, entries };
    } catch (error) {
      return {
        status: "invalid",
        content,
        entries,
        message: `Command catalog is invalid: ${error instanceof Error ? error.message : String(error)}`
      };
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
      if (
        pathname !== "/owner" &&
        pathname !== "/usage" &&
        pathname !== "/debate" &&
        !pathname.startsWith("/owner/api/")
      )
        return false;
      const method = req.method ?? "GET";
      if (method === "GET" && pathname === "/usage") {
        sendUsagePage(res);
        return true;
      }
      if (method === "GET" && pathname === "/debate") {
        sendDebatePage(res);
        return true;
      }
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
        const at = now();
        pruneExpiredSessions(at);
        const idleExpiresAt = at + SESSION_IDLE_TTL_MS;
        const absoluteExpiresAt = at + SESSION_ABSOLUTE_TTL_MS;
        sessions.set(token, { idleExpiresAt, absoluteExpiresAt, csrf });
        res.setHeader("set-cookie", cookie(token, idleExpiresAt, at));
        sendJson(res, 200, { authenticated: true, csrf });
        return true;
      }
      const session = requireSession(req, res);
      if (session === undefined) return true;
      if (method === "GET" && pathname === "/owner/api/session") {
        sendJson(res, 200, {
          authenticated: true,
          csrf: session.csrf,
          expiresAt: new Date(session.idleExpiresAt).toISOString(),
          absoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString()
        });
        return true;
      }
      if (method === "GET" && pathname === "/owner/api/connections") {
        if (options.connections === undefined) {
          sendJson(res, 503, {
            error: {
              code: "connections_unavailable",
              message: "Connection profiles are unavailable"
            }
          });
          return true;
        }
        sendJson(res, 200, { connections: options.connections.listConnections() });
        return true;
      }
      if (
        method === "PUT" &&
        (pathname === "/owner/api/connections/profile" ||
          pathname === "/owner/api/connections/default")
      ) {
        if (!requireCsrf(req, res, session)) return true;
        if (options.connections === undefined) {
          sendJson(res, 503, {
            error: {
              code: "connections_unavailable",
              message: "Connection profiles are unavailable"
            }
          });
          return true;
        }
        const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as {
          grantId?: unknown;
          clientId?: unknown;
          surfaceProfile?: unknown;
        };
        if (body.surfaceProfile !== "full" && body.surfaceProfile !== "gateway-only") {
          sendJson(res, 400, {
            error: { code: "invalid_surface_profile", message: "Surface profile is invalid" }
          });
          return true;
        }
        if (pathname.endsWith("/profile")) {
          if (typeof body.grantId !== "string" || body.grantId.length === 0) {
            sendJson(res, 400, {
              error: { code: "invalid_grant_id", message: "grantId is required" }
            });
            return true;
          }
          options.connections.setGrantProfile(body.grantId, body.surfaceProfile);
          sendJson(res, 200, {
            grantId: body.grantId,
            surfaceProfile: body.surfaceProfile
          });
          return true;
        }
        if (typeof body.clientId !== "string" || body.clientId.length === 0) {
          sendJson(res, 400, {
            error: { code: "invalid_client_id", message: "clientId is required" }
          });
          return true;
        }
        options.connections.setClientDefault(body.clientId, body.surfaceProfile);
        sendJson(res, 200, {
          clientId: body.clientId,
          surfaceProfile: body.surfaceProfile
        });
        return true;
      }
      if (method === "PUT" && pathname === "/owner/api/connections/label") {
        if (!requireCsrf(req, res, session)) return true;
        if (options.connections === undefined) {
          sendJson(res, 503, {
            error: {
              code: "connections_unavailable",
              message: "Connection profiles are unavailable"
            }
          });
          return true;
        }
        const body = (await readBoundedJson(req, MAX_BODY_BYTES)) as {
          grantId?: unknown;
          label?: unknown;
        };
        if (typeof body.grantId !== "string" || body.grantId.length === 0) {
          sendJson(res, 400, {
            error: { code: "invalid_grant_id", message: "grantId is required" }
          });
          return true;
        }
        let label: string;
        try {
          label = validateConnectionLabel(body.label);
        } catch {
          sendJson(res, 400, {
            error: { code: "invalid_label", message: "Label must be 1-64 characters" }
          });
          return true;
        }
        try {
          options.connections.setConnectionLabel(body.grantId, label);
        } catch (error) {
          if (error instanceof Error && error.message === "oauth_grant_not_found") {
            sendJson(res, 404, {
              error: { code: "unknown_grant", message: "Connection grant no longer exists" }
            });
            return true;
          }
          throw error;
        }
        sendJson(res, 200, { grantId: body.grantId, label });
        return true;
      }
      if (pathname === "/owner/api/debates" && method === "GET") {
        if (options.debates === undefined) {
          sendJson(res, 503, {
            error: { code: "debate_unavailable", message: "Debate service is unavailable" }
          });
          return true;
        }
        sendJson(res, 200, { debates: options.debates.listForOwner() });
        return true;
      }
      if (pathname.startsWith("/owner/api/debates/")) {
        if (options.debates === undefined) {
          sendJson(res, 503, {
            error: { code: "debate_unavailable", message: "Debate service is unavailable" }
          });
          return true;
        }
        const suffix = pathname.slice("/owner/api/debates/".length);
        const parts = suffix.split("/");
        let debateId: string;
        try {
          debateId = decodeURIComponent(parts[0] ?? "");
        } catch {
          sendJson(res, 400, {
            error: { code: "invalid_debate_id", message: "Debate ID is invalid" }
          });
          return true;
        }
        if (debateId.length === 0) {
          sendJson(res, 400, {
            error: { code: "invalid_debate_id", message: "Debate ID is required" }
          });
          return true;
        }
        try {
          if (method === "GET" && parts.length === 1) {
            const url = new URL(req.url ?? pathname, "http://localhost");
            const rawAfter = url.searchParams.get("afterSequence");
            let afterSequence: number | undefined;
            if (rawAfter !== null) {
              afterSequence = Number(rawAfter);
              if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
                sendJson(res, 400, {
                  error: {
                    code: "invalid_after_sequence",
                    message: "afterSequence must be a non-negative integer"
                  }
                });
                return true;
              }
            }
            sendJson(
              res,
              200,
              options.debates.readForOwner(
                debateId,
                ...(afterSequence === undefined ? [] : [afterSequence])
              )
            );
            return true;
          }
          if (
            method === "POST" &&
            parts.length === 2 &&
            (parts[1] === "stop" || parts[1] === "resume")
          ) {
            if (!requireCsrf(req, res, session)) return true;
            const snapshot =
              parts[1] === "stop"
                ? options.debates.stopAsOwner(debateId)
                : options.debates.resumeAsOwner(debateId);
            sendJson(res, 200, snapshot);
            return true;
          }
          if (method === "DELETE" && parts.length === 1) {
            if (!requireCsrf(req, res, session)) return true;
            sendJson(res, 200, options.debates.deleteAsOwner(debateId));
            return true;
          }
        } catch (error) {
          if (error instanceof DebateError) {
            const status =
              error.code === "debate_not_found" ? 404 : error.code === "invalid_input" ? 400 : 409;
            sendJson(res, status, { error: { code: error.code, message: error.message } });
            return true;
          }
          throw error;
        }
      }
      if (method === "POST" && pathname === "/owner/api/logout") {
        if (!requireCsrf(req, res, session)) return true;
        sessions.delete(session.token);
        res.setHeader("set-cookie", expireCookie());
        sendJson(res, 200, { authenticated: false });
        return true;
      }
      if (method === "GET" && pathname.startsWith("/owner/api/usage/")) {
        if (options.usage === undefined) {
          sendJson(res, 503, {
            error: { code: "usage_unavailable", message: "Usage telemetry is unavailable" }
          });
          return true;
        }
        if (pathname === "/owner/api/usage/health") {
          sendJson(res, 200, options.usage.health());
          return true;
        }
        let range;
        try {
          const url = new URL(req.url ?? pathname, "http://localhost");
          range = parseUsageRange(url.searchParams.get("range"));
        } catch {
          sendJson(res, 400, {
            error: { code: "invalid_usage_range", message: "Range must be 24h, 7d, 30d, or all" }
          });
          return true;
        }
        try {
          if (pathname === "/owner/api/usage/summary") {
            sendJson(res, 200, options.usage.summary(range));
            return true;
          }
          if (pathname === "/owner/api/usage/timeseries") {
            sendJson(res, 200, options.usage.timeseries(range));
            return true;
          }
          if (pathname === "/owner/api/usage/tools") {
            sendJson(res, 200, options.usage.tools(range));
            return true;
          }
          if (pathname === "/owner/api/usage/savings") {
            sendJson(res, 200, options.usage.savings(range));
            return true;
          }
        } catch (error) {
          sendJson(res, 503, {
            error: {
              code: "usage_unavailable",
              message: error instanceof Error ? error.message : "Usage telemetry is unavailable"
            }
          });
          return true;
        }
      }
      if (method === "GET" && pathname === "/owner/api/state") {
        const snapshot = options.policyStore.capture();
        const commands = await commandsState();
        const mcpServers = await providerState();
        sendJson(res, 200, {
          policyVersion: snapshot.version,
          authorityMode: snapshot.normalized.kernelPolicy.authorityMode,
          paths: snapshot.normalized.kernelPolicy.readRoots ?? [],
          capabilities: snapshot.normalized.kernelPolicy.capabilities,
          commands: commands.entries,
          commandCatalog: {
            status: commands.status,
            ...(commands.status === "ready" ? {} : { message: commands.message })
          },
          mcpServers,
          mcpSummary: summarizeProviderStatuses(mcpServers.map((provider) => provider.status)),
          connections: options.connections?.listConnections() ?? [],
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
