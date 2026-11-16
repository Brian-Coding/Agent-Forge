import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.argv[2] || process.cwd();
const forge=true;
const median=(a:number[])=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
const startup:number[]=[], builds:number[]=[], requests:number[]=[];
for(let i=0;i<7;i++) {
  const state=await mkdtemp('/tmp/portfolio-perf-');
  const socket=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')});const port=socket.port!;await socket.stop(true);
  const entry=join(state,'entry.ts');
  await writeFile(entry,forge?`const mod=await import(${JSON.stringify(pathToFileURL(root+'/src/server/index.ts').href)});await Bun.stdin.text();await mod.shutdown({reason:'benchmark'});`:`import viewer from ${JSON.stringify(root+'/src/viewer/index.html')};import {startServer} from ${JSON.stringify(root+'/src/server/server.ts')};import {FakeBrowserDriver} from ${JSON.stringify(root+'/src/browser/fake-driver.ts')};const s=startServer({driver:new FakeBrowserDriver(),port:${port},staticRoutes:{'/':viewer},routes:[(r,u)=>u.pathname==='/ready'?new Response('ready'):null]});await Bun.stdin.text();await s.stop();`);
  const t=performance.now();
  const proc=Bun.spawn([process.execPath,entry],{cwd:state,stdin:'pipe',stdout:'ignore',stderr:'ignore',env:{...process.env,PORT:String(port),HOST:'127.0.0.1',AI_HARNESS_CLAUDE_CREDENTIALS_JSON:join(state,'no-credentials'),AI_HARNESS_CLAUDE_LIMITS_JSON:join(state,'no-limits'),AI_HARNESS_CODEX_SESSIONS_DIR:join(state,'no-sessions'),ATLAS_QA_DATA_DIR:join(state,'user-data')}});
  const url=`http://127.0.0.1:${port}`;
  for(let n=0;n<1000;n++){try{if((await fetch(url+(forge?'/api/harness/instructions':'/ready'))).ok)break;}catch{}await Bun.sleep(5);}
  startup.push(performance.now()-t);
  for(let n=0;n<10;n++){const q=performance.now();await (await fetch(url+(forge?'/api/harness/instructions':'/ready'))).text();requests.push(performance.now()-q);}
  proc.stdin.end();await proc.exited;await rm(state,{recursive:true,force:true});
  const b=performance.now();
  const result=await Bun.build({entrypoints:[root+(forge?(root.includes('baseline')?'/src/client/index.html':'/src/client/vendor.ts'):'/src/viewer/index.html')],target:'browser',minify:true,...(forge&&!root.includes('baseline')?{format:'iife' as const,define:{'process.env.NODE_ENV':JSON.stringify('production')}}:{})});
  if(!result.success) throw new Error('benchmark build failed'); builds.push(performance.now()-b);
}
console.log(JSON.stringify({project:forge?'forge':'atlas',copy:root.includes('baseline')?'before':'after',startup_ms:median(startup),build_ms:median(builds),request_ms:median(requests),samples:7}));
