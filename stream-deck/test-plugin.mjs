import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = mkdtempSync(path.join(os.tmpdir(), 'poe2-deck-sdk-'));
const directory = path.join(root, 'poe2-trade-companion', 'stream-deck'); mkdirSync(directory, {recursive:true});
const session = 'test-session', token = 'a'.repeat(64);
let state = 'idle', posts = 0, ackDelay = 0;
const app = createServer(async (req,res) => {
  if (req.url === '/v1/status') { res.end(JSON.stringify({version:1,session,dryRun:true,killLatched:false,buttons:{'rings.gamble':{state,detail:'Synthetic ring fixture',count:state === 'active' ? 3 : undefined}}})); return; }
  let body=''; for await (const chunk of req) body+=chunk; posts++;
  const cmd=JSON.parse(body); await new Promise(resolve=>setTimeout(resolve,ackDelay));
  state='active'; res.end(JSON.stringify({id:cmd.id,ok:true,phase:'accepted',reason:'Synthetic fixture'}));
});
await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
writeFileSync(path.join(directory,'connection.json'),JSON.stringify({version:1,port:app.address().port,token,session}));
const ws = new WebSocketServer({host:'127.0.0.1',port:0}); await new Promise(resolve=>ws.on('listening',resolve));
const messages=[]; let socket; let errors='';
ws.on('connection',s=>{socket=s;s.on('message',data=>messages.push(JSON.parse(String(data))));});
const info = {application:{version:'7.5.1',platform:'windows',platformVersion:'10',language:'en',font:'Arial'},plugin:{version:'1.0.0',uuid:'com.poe2companion.deck'},devices:[{id:'synthetic-xl',name:'Stream Deck XL',type:2,size:{columns:8,rows:4}}],colors:{}};
const child=spawn(process.execPath,['bin/plugin.js','-port',String(ws.address().port),'-pluginUUID','synthetic-plugin','-registerEvent','registerPlugin','-info',JSON.stringify(info)],{cwd:path.resolve('com.poe2companion.deck.sdPlugin'),env:{...process.env,APPDATA:root},windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stderr.on('data',data=>{errors+=data;});
async function until(predicate) { const deadline=Date.now()+10000; while(!predicate()){ if(Date.now()>deadline) throw new Error('Timed out: '+errors+' '+JSON.stringify(messages.slice(-3))); await new Promise(r=>setTimeout(r,30)); } }
const event=(event)=>({event,action:'com.poe2companion.deck.rings-gamble',context:'synthetic-key',device:'synthetic-xl',payload:{settings:{},controller:'Keypad',coordinates:{column:0,row:0},state:0,isInMultiAction:false}});
const sawImage=state=>messages.some(m=>m.event==='setImage' && m.payload.image.includes('/'+state+'.png'));
try {
  await until(()=>messages.some(m=>m.event==='registerPlugin'));
  socket.send(JSON.stringify(event('willAppear'))); await until(()=>sawImage('idle'));
  for(const s of ['unavailable','paused','error']) { state=s; await until(()=>sawImage(s)); }
  state='idle'; await new Promise(r=>setTimeout(r,850));
  ackDelay=900; socket.send(JSON.stringify(event('keyDown'))); socket.send(JSON.stringify(event('keyDown')));
  await until(()=>sawImage('active')); assert.equal(posts,1); await until(()=>messages.some(m=>m.event==='setTitle' && m.payload.title==='3'));
  app.closeAllConnections(); await new Promise(resolve=>app.close(resolve)); await until(()=>sawImage('disconnected'));
  socket.send(JSON.stringify(event('keyDown'))); await until(()=>messages.some(m=>m.event==='showAlert')); assert.equal(posts,1);
  assert.equal(errors,''); console.log('PASS: packaged SDK registration, key routing, duplicate press, count, idle/active/paused/unavailable/error/disconnected images and missing-app alert. Synthetic WebSocket/device; no game input.');
} finally { child.kill(); socket?.terminate(); ws.close(); app.closeAllConnections(); app.close(); await new Promise(r=>child.once('exit',r)); rmSync(root,{recursive:true,force:true}); }
