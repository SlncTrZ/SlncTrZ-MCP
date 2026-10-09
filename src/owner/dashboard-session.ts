/** Shared browser request and session states for the native Owner surfaces. */
export const ownerSessionMarkup = `<section id="owner-session-status" class="card owner-session-feedback" role="status" aria-live="polite" data-state="checking-session"><span id="owner-session-message">Checking owner session…</span><button id="owner-session-retry" type="button" class="btn-deny" hidden>Retry</button></section>`;

export const ownerSessionScript = String.raw`
function ownerHttpError(response,data){const error=new Error(data?.error?.message||('HTTP '+response.status));error.status=response.status;error.code=data?.error?.code;return error}
async function ownerApiRequest(path,opt={},csrfValue=''){
 const headers={...(opt.body?{'content-type':'application/json'}:{}),...(opt.method&&opt.method!=='GET'?{'x-slnctrz-csrf':csrfValue}:{}),...(opt.headers||{})};
 const response=await fetch(path,{...opt,headers});let data;
 try{data=await response.json()}catch{
  if(!response.ok)throw ownerHttpError(response);
  const error=new Error('Invalid JSON response.');error.status=response.status;error.code='invalid_response';throw error
 }
 if(!response.ok)throw ownerHttpError(response,data);return data
}
function createOwnerSession({contentId,loginId,onAuthenticated,onInvalidate}){
 const content=document.getElementById(contentId),login=document.getElementById(loginId),feedback=document.getElementById('owner-session-status'),message=document.getElementById('owner-session-message'),retry=document.getElementById('owner-session-retry');
 let authenticated=false,generation=0,abort=null,pending=null;
 function state(name,text='',canRetry=false){
  feedback.dataset.state=name;feedback.classList.toggle('hidden',name==='ready'||name==='unauthenticated');
  message.textContent=text;retry.hidden=!canRetry;retry.disabled=!!pending;
  content.classList.toggle('hidden',!authenticated);login.classList.toggle('hidden',name!=='unauthenticated')
 }
 function invalidate(){generation++;abort?.abort();abort=new AbortController();authenticated=false;onInvalidate?.()}
 function expire(){invalidate();state('unauthenticated')}
 function reportError(error){
  if(error?.name==='AbortError')return;
  if(error?.status===401){expire();return}
  if(authenticated)state('data-error',error?.code==='csrf_denied'?'This action could not be verified. Retry to refresh the session, then try the action again.':'Could not load or update this page. Retry to load the data again.',true)
 }
 async function request(path,opt={},csrfValue=''){
  const current=generation;
  try{const data=await ownerApiRequest(path,{...opt,signal:opt.signal??abort?.signal},csrfValue);
   if(current!==generation||!authenticated){const error=new Error('Request no longer belongs to the active session.');error.name='AbortError';throw error}
   return data
  }catch(error){if(current===generation)reportError(error);throw error}
 }
 function ready(){if(authenticated)state('ready')}
 function run(){
  if(pending)return pending;
  invalidate();state('checking-session','Checking owner session…');
  const current=generation;
  pending=(async()=>{
   try{
    const data=await ownerApiRequest('/owner/api/session',{signal:abort.signal});
    if(current!==generation)return;
    if(data?.authenticated!==true)throw new Error('Invalid session response.');
    authenticated=true;state('authenticated-loading','Loading page data…');
    await onAuthenticated(data);if(current===generation&&authenticated)ready()
   }catch(error){
    if(current!==generation)return;
    if(error?.status===401)expire();
    else if(authenticated)reportError(error);
    else state('session-check-error','Could not check the owner session. Retry to check again.',true)
   }finally{pending=null;retry.disabled=false}
  })();
  retry.disabled=true;return pending
 }
 retry.onclick=run;
 globalThis.addEventListener?.('pagehide',()=>{invalidate();state('checking-session','Checking owner session…')});
 globalThis.addEventListener?.('pageshow',event=>{if(event.persisted){if(pending)pending.finally(run);else run()}});
 return {run,request,reportError,expire,ready,get authenticated(){return authenticated}}
}
`;
