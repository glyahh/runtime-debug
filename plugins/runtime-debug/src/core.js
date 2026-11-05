import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
const ID = /^[a-zA-Z0-9-]{1,80}$/;
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = message => { throw new Error(message); };
const within = (root, file) => { const r=path.relative(root,file); return !r || (!r.startsWith('..'+path.sep) && r!=='..' && !path.isAbsolute(r)); };
export function redact(value, depth=0) {
  if(depth>12) return '[depth limit]';
  if(typeof value==='string') return value.replace(/\bBearer\s+\S+/gi,'Bearer [REDACTED]').slice(0,8192);
  if(Array.isArray(value)) return value.slice(0,100).map(v=>redact(v,depth+1));
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).slice(0,100).map(([k,v])=>[k,/password|secret|token|authorization|cookie|api.?key|email|phone/i.test(k)?'[REDACTED]':redact(v,depth+1)]));
  return value;
}
export class DebugRuntime {
  constructor(dataRoot) { this.root=dataRoot; this.sessions=new Map(); this.queue=Promise.resolve(); }
  exclusive(fn) { const p=this.queue.then(fn,fn); this.queue=p.catch(()=>{}); return p; }
  async init() {
    await fs.mkdir(this.root,{recursive:true});
    this.server=http.createServer((req,res)=>this.handle(req,res));
    this.server.requestTimeout=10000; this.server.headersTimeout=10000;
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});
    this.origin='http://127.0.0.1:'+this.server.address().port;
    return this;
  }
  session(id) { if(!ID.test(id)) fail('Invalid session ID'); return this.sessions.get(id) ?? fail('Open this project session first'); }
  async save(s) { const {token,...state}=s; const file=path.join(this.root,s.id,'session.json'); await fs.writeFile(file+'.tmp',JSON.stringify(state,null,2)); await fs.rename(file+'.tmp',file); }
  async file(s,file) { const real=await fs.realpath(path.resolve(s.projectRoot,file)); if(!within(s.projectRoot,real)) fail('Path outside project'); return real; }
  async audit(s) {
    const result=[];
    for(const p of s.probes) {
      try { const text=await fs.readFile(await this.file(s,p.file),'utf8'); const block=this.block(text,p.marker);
        result.push({file:p.file,marker:p.marker,status:block===null?'removed':hash(block)===p.fingerprint?'present':'conflict',fingerprint:p.fingerprint});
      } catch(e) { result.push({file:p.file,marker:p.marker,status:'unavailable',error:e.message}); }
    } return result;
  }
  block(text, marker) {
    const start='runtime-debug:'+marker+':begin', end='runtime-debug:'+marker+':end';
    const a=text.indexOf(start), b=text.indexOf(end);
    if(a<0 && b<0) return null;
    if(a<0||b<a||text.indexOf(start,a+start.length)>=0||text.indexOf(end,b+end.length)>=0) fail('Ambiguous or incomplete probe markers');
    const from=text.lastIndexOf('\n',a)+1, newline=text.indexOf('\n',b);
    return text.slice(from,newline<0?text.length:newline+1);
  }
  async open_session({projectRoot,sessionId}) {
    const real=await fs.realpath(projectRoot); if(!(await fs.stat(real)).isDirectory()) fail('Project must be a directory');
    if(sessionId && !ID.test(sessionId)) fail('Invalid session ID');
    const id=sessionId||randomUUID();
    if(this.sessions.has(id)) { const s=this.session(id); if(s.projectRoot!==real) fail('Project mismatch'); return this.info(s); }
    const dir=path.join(this.root,id); await fs.mkdir(dir,{recursive:true});
    const lock=path.join(dir,'owner.lock');
    try { const h=await fs.open(lock,'wx'); await h.writeFile(String(process.pid)); await h.close(); }
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      const pid=Number(await fs.readFile(lock,'utf8'));
      if(!Number.isInteger(pid)||pid<1) fail('Invalid ownership lock; inspect manually');
      try { process.kill(pid,0); fail('Session owned by a live process'); } catch(e) { if(e.code!=='ESRCH') throw e; }
      await fs.unlink(lock);
      const h=await fs.open(lock,'wx'); await h.writeFile(String(process.pid)); await h.close();
    }
    let s;
    try {
      if(sessionId) {
        s=JSON.parse(await fs.readFile(path.join(dir,'session.json'),'utf8'));
        if(s.id!==id||s.projectRoot!==real) fail('Project mismatch');
        s.status='needs-review'; s.activeRun=null;
      } else s={id,projectRoot:real,status:'open',runs:[],probes:[],activeRun:null};
      this.sessions.set(id,s); await this.save(s); return this.info(s);
    } catch(e) { await fs.unlink(lock).catch(()=>{}); throw e; }
  }
  async info(s) { return {sessionId:s.id,projectRoot:s.projectRoot,status:s.status,runs:s.runs,probes:await this.audit(s),resumeWarning:s.status==='needs-review'?'Old endpoints are invalid. Review probes and start a NEW run; never replay commands.':undefined}; }
  async begin_run({sessionId,phase,hypotheses,allowedOrigins=[]}) {
    const s=this.session(sessionId);
    if(s.status==='completed'||s.status==='cancelled') fail('Session is closed');
    if(phase==='verify'&&!s.runs.some(r=>r.phase==='baseline'&&r.evidenceCount>0)) fail('Read baseline evidence before verification');
    for(const origin of allowedOrigins) {
      const u=new URL(origin);
      if(!['http:','https:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.origin!==origin) fail('Only exact local HTTP origins allowed');
    }
    if(s.activeRun) this.run(s,s.activeRun).sealed=true;
    const run={id:randomUUID(),phase,hypotheses,allowedOrigins,createdAt:new Date().toISOString(),evidenceCount:0,sealed:false};
    s.runs.push(run); s.activeRun=run.id; s.token=randomBytes(32).toString('hex'); s.status='awaiting-reproduction';
    await fs.writeFile(this.logPath(s,run),'',{flag:'wx'}); await this.save(s);
    return {sessionId:s.id,runId:run.id,endpoint:this.origin+'/ingest/'+s.id+'/'+run.id,token:s.token,logPath:this.logPath(s,run),requiredFields:['sessionId','runId','hypothesisId','location','message','data','timestamp'],note:'Configuration is not evidence. Send an actual probe event, then read_logs.'};
  }
  run(s,id) { if(!ID.test(id)) fail('Invalid run ID'); return s.runs.find(r=>r.id===id)??fail('Unknown run'); }
  logPath(s,r) { return path.join(this.root,s.id,r.id+'.ndjson'); }
  async register_probes({sessionId,probes}) {
    const s=this.session(sessionId); if(!s.activeRun) fail('Start a run first');
    if(s.status==='completed'||s.status==='cancelled') fail('Session is closed');
    const pending=[];
    for(const p of probes) {
      const file=await this.file(s,p.file); const text=await fs.readFile(file,'utf8'); const block=this.block(text,p.marker);
      if(!block) fail('Probe markers not found');
      const existing=s.probes.find(x=>x.marker===p.marker);
      if(existing && (existing.file!==file||existing.fingerprint!==hash(block))) fail('Registered probe changed; audit and remove old probe before using a new marker');
      if(!p.hypothesisIds.every(id=>this.run(s,s.activeRun).hypotheses.some(h=>h.id===id))) fail('Unknown hypothesis');
      if(pending.some(x=>x.marker===p.marker)) fail('Duplicate probe marker');
      if(!existing) pending.push({...p,file,fingerprint:hash(block)});
    } s.probes.push(...pending); await this.save(s); return {probes:await this.audit(s)};
  }
  validate(s,r,event) {
    if(!event||event.sessionId!==s.id||event.runId!==r.id) fail('Event session/run mismatch');
    if(!r.hypotheses.some(h=>h.id===event.hypothesisId)) fail('Unknown hypothesis');
    if(!['location','message'].every(k=>typeof event[k]==='string')||!Number.isFinite(event.timestamp)||!event.data||typeof event.data!=='object') fail('Invalid event schema');
    return redact(Object.fromEntries(['sessionId','runId','hypothesisId','timestamp','location','message','data','id'].filter(k=>Object.hasOwn(event,k)).map(k=>[k,event[k]])));
  }
  async read_logs({sessionId,runId,cursor=0,hypothesisId,limit=200}) {
    const s=this.session(sessionId),r=this.run(s,runId),file=this.logPath(s,r);
    if((await fs.stat(file)).size>20*1024*1024) fail('Run exceeds 20 MiB; start a new run');
    const lines=(await fs.readFile(file,'utf8')).split('\n'); const pendingLine=lines.at(-1)!==''; lines.pop();
    const entries=[],errors=[],seen=new Set(); let duplicates=0, validCount=0, next=cursor;
    // Re-read the bounded run to deduplicate consistently across pages and direct-file writers.
    for(let i=0;i<lines.length;i++) {
      let event;
      try { if(Buffer.byteLength(lines[i])>65536) fail('Entry exceeds 64 KiB'); event=this.validate(s,r,JSON.parse(lines[i])); }
      catch(e) { if(i>=cursor && errors.length<200) errors.push({line:i+1,error:e.message}); continue; }
      const key=typeof event.id==='string'?event.id:hash(lines[i]); if(seen.has(key)){duplicates++;continue;} seen.add(key);validCount++;
      if(i<cursor) continue;
      next=i+1;
      if(!hypothesisId||event.hypothesisId===hypothesisId) entries.push({ref:s.id+'/'+r.id+':L'+(i+1),...event});
      if(entries.length>=limit) break;
    }
    if(entries.length<limit) next=lines.length;
    r.evidenceCount=Math.max(r.evidenceCount,validCount); await this.save(s);
    return {entries,errors,duplicates,nextCursor:next,hasMore:next<lines.length,empty:entries.length===0,pendingLine};
  }
  async close_session({sessionId,outcome,userConfirmed=false}) {
    const s=this.session(sessionId), audit=await this.audit(s);
    if(outcome==='completed') {
      if(!userConfirmed) fail('User confirmation required');
      if(!s.runs.some(r=>r.phase==='verify'&&r.evidenceCount>0)) fail('Read verification evidence first');
      if(audit.some(p=>p.status!=='removed')) fail('Probe cleanup incomplete or conflicted');
    }
    s.activeRun=null; delete s.token;
    s.status=audit.some(p=>p.status!=='removed')?'pending-cleanup':outcome;
    await this.save(s); return {status:s.status,probes:audit,note:'No source files were modified by MCP.'};
  }
  async handle(req,res) {
    try {
      const u=new URL(req.url,this.origin), parts=u.pathname.split('/');
      if(parts.length!==4||parts[1]!=='ingest') {res.writeHead(404).end();return;}
      const s=this.session(parts[2]),r=this.run(s,parts[3]),origin=req.headers.origin;
      if(origin && !r.allowedOrigins.includes(origin)) {res.writeHead(403).end('origin-denied');return;}
      if(origin) {res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS') {res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Debug-Token');res.writeHead(204).end();return;}
      const token=req.headers['x-debug-token'];
      if(typeof token!=='string'||!s.token||Buffer.byteLength(token)!==Buffer.byteLength(s.token)||!timingSafeEqual(Buffer.from(token),Buffer.from(s.token))) {res.writeHead(401).end('invalid-token');return;}
      if(req.method!=='POST') {res.writeHead(405).end();return;}
      const chunks=[]; let bytes=0; for await(const chunk of req) {bytes+=chunk.length;if(bytes>65536) {res.writeHead(413).end('entry-too-large');return;} chunks.push(chunk);}
      const event=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await this.exclusive(async()=>{
        if(s.activeRun!==r.id||r.sealed) fail('Run is sealed');
        const clean=this.validate(s,r,event),file=this.logPath(s,r),line=JSON.stringify(clean)+'\n';
        if((await fs.stat(file)).size+Buffer.byteLength(line)>20*1024*1024) fail('Run storage limit reached');
        await fs.appendFile(file,line);
      });res.writeHead(204).end();
    } catch(e) {if(!res.headersSent)res.writeHead(400);res.end(e.message);}
  }
  async shutdown() {
    this.server.closeAllConnections(); await new Promise(resolve=>this.server.close(resolve));
    await this.queue;
    for(const s of this.sessions.values()) { if(s.activeRun){s.activeRun=null;s.status='interrupted';delete s.token;await this.save(s);} await fs.unlink(path.join(this.root,s.id,'owner.lock')).catch(()=>{}); }
  }
}
