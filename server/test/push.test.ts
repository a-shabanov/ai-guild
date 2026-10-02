import {before,after,test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import webpush from 'web-push';

const database=new URL(process.env.DATABASE_URL??'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker');
database.pathname='/aitracker_push_test';process.env.DATABASE_URL=database.href;
const db=await import('../src/db.ts');const svc=await import('../src/service.ts');const auth=await import('../src/auth.ts');
const S=await import('../src/schemas.ts');
const push=await import('../src/push.ts');const {buildApp}=await import('../src/server.ts');
let server:ReturnType<ReturnType<typeof buildApp>['listen']>,url:string,index=0;
const sent:{endpoint:string;message:any;headers:Record<string,string>}[]=[];
let status=201;
before(async()=>{
 const maintenance=new URL(database);maintenance.pathname='/postgres';const client=new pg.Client({connectionString:maintenance.href});
 await client.connect();await client.query('drop database if exists aitracker_push_test with (force)');await client.query('create database aitracker_push_test');await client.end();await db.migrate();
 // Exercise real encryption and VAPID generation; replace only the provider's transport.
 mock.method(webpush,'sendNotification',async(subscription:any,payload:string,options:any)=>{
  const request=webpush.generateRequestDetails(subscription,payload,options);
  assert.equal(request.headers['Content-Encoding'],'aes128gcm');assert.ok(request.body!.length>payload.length);
  assert.match(request.headers.Authorization,/^vapid t=/);
  sent.push({endpoint:subscription.endpoint,message:JSON.parse(payload),headers:request.headers as Record<string,string>});
  if(status>=400)throw Object.assign(new Error('provider rejected'),{statusCode:status});
  return {statusCode:status,body:'',headers:{}};
 });
 server=buildApp().listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{mock.restoreAll();server?.close();await db.pool.end();});
async function person(kind:'human'|'agent'='human'){
 const result=await svc.createAccount({name:`push-${++index}`,kind,role:'member'});return {actor:await auth.authenticate(result.key),key:result.key};
}
function sub(){const ecdh=createECDH('prime256v1');ecdh.generateKeys();return {endpoint:`https://web.push.apple.com/test-${++index}`,keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};}
async function request(key:string,body:unknown){return fetch(url+'/api/push/test',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});}
test('test notification uses only caller subscription and real encrypted Web Push',async()=>{
 const p=await person(),other=await person(),s=sub();await push.subscribe(p.actor,s);
 const prior=sent.length;
 assert.equal((await request(other.key,{endpoint:s.endpoint})).status,404);assert.equal(sent.length,prior);
 assert.equal((await request('',{endpoint:s.endpoint})).status,401);
 assert.equal((await request(p.key,{endpoint:'not-a-url'})).status,400);
 assert.equal((await request(p.key,{endpoint:s.endpoint})).status,200);
 assert.equal(sent.length,prior+1);assert.equal(sent.at(-1)!.message.url,'/#/settings');assert.equal(sent.at(-1)!.endpoint,s.endpoint);
});
test('expired provider subscription is removed, transient failure remains retryable',async()=>{
 const p=await person(),s=sub();await push.subscribe(p.actor,s);status=503;
 assert.equal((await request(p.key,{endpoint:s.endpoint})).status,502);
 assert.ok(await db.q1('select id from push_subscriptions where endpoint=$1',[s.endpoint]));
 status=410;assert.equal((await request(p.key,{endpoint:s.endpoint})).status,409);
 assert.equal(await db.q1('select id from push_subscriptions where endpoint=$1',[s.endpoint]),undefined);status=201;
});
test('task replies reach involved account and mentions, never the acting agent or unrelated people',async()=>{
 const owner=await person(),agent=await person('agent'),mentioned=await person('agent'),unrelated=await person('agent');
 const endpoints=new Map<number,string>();for(const p of [owner,agent,mentioned,unrelated]){const s=sub();endpoints.set(p.actor.id,s.endpoint);await push.subscribe(p.actor,s);}
 const task=await svc.createTask({...owner.actor,history:true},S.CreateTask.parse({title:'push audience fixture'}));
 const event=await db.q1(`insert into events(task_id,actor_id,type,data) values($1,$2,'comment_added',$3) returning id`,[task.id,agent.actor.id,JSON.stringify({body:`Ответ @${mentioned.actor.name}`})]);
 const prior=sent.length;await push.notifyEvent(event!.id);
 const delivered=sent.slice(prior);assert.deepEqual(new Set(delivered.map(s=>s.endpoint)),new Set([endpoints.get(owner.actor.id),endpoints.get(mentioned.actor.id)]));
 assert.equal(delivered[0].message.url,`/#/tasks/${task.id}`);assert.match(delivered[0].message.body,/Ответ/);
});

async function preferences(key:string,method='GET',body?:unknown,extra:Record<string,string>={}) {
 return fetch(url+'/api/push/preferences',{method,headers:{Authorization:`Bearer ${key}`,...(body!==undefined&&{'Content-Type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
}
test('notification preferences are private, strict and merge independent changes atomically',async()=>{
 const owner=await person(),other=await person();
 assert.equal((await preferences('')).status,401);
 const first=await preferences(owner.key);assert.equal(first.headers.get('cache-control'),'no-store');
 const defaults=await first.json();assert.deepEqual(Object.values(defaults),Array(7).fill(true));
 for(const body of [{},{attachments:'false'},{account_id:other.actor.id,attachments:false},{unknown:false}])assert.equal((await preferences(owner.key,'PATCH',body)).status,400);
 assert.equal((await preferences(owner.key,'PATCH',{attachments:false},{Origin:'https://external.test'})).status,403);
 await Promise.all([preferences(owner.key,'PATCH',{attachments:false}),preferences(owner.key,'PATCH',{comments:false})]);
 const saved=await(await preferences(owner.key)).json();assert.equal(saved.attachments,false);assert.equal(saved.comments,false);assert.equal(saved.results,true);
 assert.deepEqual(await(await preferences(other.key)).json(),defaults);
 const restored=await(await preferences(owner.key,'PATCH',{attachments:true})).json();assert.equal(restored.attachments,true);assert.equal(restored.comments,false);
});
test('muted event categories suppress all Web Push devices while inbox and explicit test push remain available',async()=>{
 const owner=await person(),agent=await person('agent');const endpoints=[sub(),sub()];
 for(const endpoint of endpoints)await push.subscribe(owner.actor,endpoint);
 const task=await svc.createTask({...owner.actor,history:true},S.CreateTask.parse({title:'notification categories'}));
 const types=['comment_added','result_submitted','status_changed','task_assigned','task_created','attachment_added','link_added'];
 const settings=Object.fromEntries(['comments','results','statuses','assignments','tasks','attachments','activity'].map(key=>[key,false]));
 assert.equal((await preferences(owner.key,'PATCH',settings)).status,200);
 const emit=async(type:string)=>{
  const event=await db.q1(`insert into events(task_id,actor_id,type,data) values($1,$2,$3,$4) returning id`,[task.id,agent.actor.id,type,JSON.stringify({body:'important reply',filename:'screen.png',from:'in_progress',to:'review',assignee:agent.actor.name})]);
  await push.notifyEvent(event!.id);return event!.id;
 };
 const prior=sent.length;const ids:number[]=[];for(const type of types)ids.push(await emit(type));
 assert.equal(sent.slice(prior).filter(s=>endpoints.some(e=>e.endpoint===s.endpoint)).length,0);
 const inbox=await fetch(url+'/api/inbox',{headers:{Authorization:`Bearer ${owner.key}`}});
 assert((await inbox.json()).events.some((event:any)=>ids.includes(event.id)&&event.type==='attachment_added'));
 assert.equal((await request(owner.key,{endpoint:endpoints[0].endpoint})).status,200,'explicit test bypasses event preferences');
 await preferences(owner.key,'PATCH',{attachments:true});const enabled=sent.length;await emit('attachment_added');
 assert.deepEqual(new Set(sent.slice(enabled).map(s=>s.endpoint)),new Set(endpoints.map(s=>s.endpoint)));
 assert((await db.q1('select count(*)::int as count from push_subscriptions where account_id=$1',[owner.actor.id]))!.count===2);
});
