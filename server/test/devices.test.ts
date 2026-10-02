import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {AddressInfo} from 'node:net';

const database=new URL(process.env.DATABASE_URL??'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker');
database.pathname='/aitracker_devices_test';process.env.DATABASE_URL=database.href;
const {config}=await import('../src/config.ts');
const db=await import('../src/db.ts');const svc=await import('../src/service.ts');const auth=await import('../src/auth.ts');
const devices=await import('../src/devices.ts');const otp=await import('../src/two-factor.ts');
const {buildApp}=await import('../src/server.ts');
let server:ReturnType<ReturnType<typeof buildApp>['listen']>,url:string,index=0;
before(async()=>{
 const maintenance=new URL(database);maintenance.pathname='/postgres';const client=new pg.Client({connectionString:maintenance.href});
 await client.connect();await client.query('drop database if exists aitracker_devices_test with (force)');await client.query('create database aitracker_devices_test');await client.end();await db.migrate();
 server=buildApp().listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;config.publicUrl=url;
});
after(async()=>{server?.close();await db.pool.end();});
const descriptor=(client_type='desktop_browser')=>({'x-device-id':randomUUID(),'x-client-type':client_type,'x-client-platform':client_type==='mobile_pwa'?'ios':'macos'});
async function person(kind:'human'|'agent'='human'){
 const result=await svc.createAccount({name:`device-${++index}`,kind,role:'member'});const actor=await auth.authenticate(result.key);
 return {actor,key:result.key,token:await auth.createSession(actor.id,'key')};
}
async function request(path:string,token:string,metadata:Record<string,string>={},method='GET',body?:unknown,origin?:string){
 return fetch(url+'/api'+path,{method,headers:{Authorization:`Bearer ${token}`,...metadata,...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'});
}
test('stable installation groups sessions; PWA mode updates and rename survives future logins',async()=>{
 const p=await person(),meta=descriptor();const first=await request('/devices',p.token,meta);assert.equal(first.status,200);const [device]=await first.json();
 assert.equal(device.client_type,'desktop_browser');assert.equal(device.current,true);assert.equal(device.sessions,1);assert.equal(device.installation_id,undefined);assert.equal(device.token_hash,undefined);
 const token2=await auth.createSession(p.actor.id,'key');const [grouped]=await (await request('/devices',token2,meta)).json();assert.equal(grouped.id,device.id);assert.equal(grouped.sessions,2);
 assert.equal((await request(`/devices/${device.id}`,p.token,meta,'PATCH',{name:'Рабочий Mac'})).status,200);
 const changed={...meta,'x-client-type':'desktop_pwa'};const [updated]=await (await request('/devices',token2,changed)).json();assert.equal(updated.client_type,'desktop_pwa');assert.equal(updated.name,'Рабочий Mac');
 assert.equal((await request(`/devices/${device.id}`,p.token,meta,'PATCH',{name:''})).status,400);
});
test('different clients and accounts stay separate; installation id never authenticates',async()=>{
 const p=await person(),meta=descriptor('mobile_pwa');const [phone]=await (await request('/devices',p.token,meta)).json();
 const token=await auth.createSession(p.actor.id,'key'),desktop=descriptor();const rows=await (await request('/devices',token,desktop)).json();assert.equal(rows.length,2);assert.equal(rows.filter((d:any)=>d.current).length,1);
 assert.equal(rows.find((d:any)=>d.id===phone.id).client_type,'mobile_pwa');
 const other=await person();const [otherDevice]=await (await request('/devices',other.token,meta)).json();assert.notEqual(otherDevice.id,phone.id);
 assert.equal((await request(`/devices/${phone.id}`,other.token,meta,'DELETE')).status,404);
 assert.equal((await request(`/devices/${phone.id}`,other.token,meta,'PATCH',{name:'not mine'})).status,404);
 assert.equal((await request('/me',meta['x-device-id'],meta)).status,401);
});
test('session cannot be moved to another device by spoofing its headers',async()=>{
 const p=await person(),meta=descriptor();const [first]=await (await request('/devices',p.token,meta)).json();
 const token=await auth.createSession(p.actor.id,'key'),other=descriptor('mobile_pwa');await request('/me',token,other);
 const rows=await (await request('/devices',p.token,other)).json();assert.equal(rows.find((d:any)=>d.current).id,first.id);assert.equal(rows.find((d:any)=>d.id===first.id).client_type,'desktop_browser');
});
test('revoking a device ends all its sessions and notifications but preserves other device',async()=>{
 const p=await person(),meta=descriptor();const [target]=await (await request('/devices',p.token,meta)).json();
 const token2=await auth.createSession(p.actor.id,'key');await request('/me',token2,meta);
 const otherToken=await auth.createSession(p.actor.id,'key'),other=descriptor('mobile_pwa');await request('/me',otherToken,other);
 const sub={endpoint:'https://fcm.googleapis.com/device-fixture',keys:{p256dh:'fixture-key',auth:'fixture-auth'}};
 assert.equal((await request('/push/subscriptions',p.token,meta,'POST',sub)).status,201);
 await db.q(`insert into apns_devices(account_id,token,environment,device_id) values($1,'fixture-token','sandbox',$2)`,[p.actor.id,target.id]);
 assert.equal((await request(`/devices/${target.id}`,otherToken,other,'DELETE')).status,200);
 assert.equal((await request('/me',p.token,meta)).status,401);assert.equal((await request('/me',token2,meta)).status,401);assert.equal((await request('/me',otherToken,other)).status,200);
 assert.equal((await db.q('select id from push_subscriptions where account_id=$1',[p.actor.id])).length,0);assert.equal((await db.q('select id from apns_devices where account_id=$1',[p.actor.id])).length,0);
});
test('current device revocation clears browser cookie and cannot recreate a revoked session',async()=>{
 const p=await person(),meta=descriptor();const [device]=await (await request('/devices',p.token,meta)).json();
 const r=await request(`/devices/${device.id}`,p.token,meta,'DELETE');assert.equal(r.status,200);assert.match(r.headers.get('set-cookie')!,/ait_session=;/);
 await assert.rejects(devices.associate(p.actor,p.token,devices.fromHeaders(meta)),{status:401});
 assert.equal((await request('/devices',p.token,meta)).status,401);
});
test('legacy clients work without headers; agent API use does not create human devices',async()=>{
 const p=await person();const [legacy]=await (await request('/devices',p.token)).json();assert.equal(legacy.client_type,'desktop_browser');
 const metadata=descriptor('mobile_pwa');const [adopted]=await (await request('/devices',p.token,metadata)).json();assert.equal(adopted.client_type,'mobile_pwa');
 const second=await auth.createSession(p.actor.id,'key');const [same]=await (await request('/devices',second,metadata)).json();assert.equal(same.id,adopted.id);assert.equal(same.sessions,2);
 assert.equal((await request('/devices',p.token,{'x-device-id':'bad'})).status,400);
 const agent=await person('agent');assert.equal((await request('/me',agent.key)).status,200);assert.equal((await request('/devices',agent.key)).status,403);
 assert.equal((await db.q('select id from account_devices where account_id=$1',[agent.actor.id])).length,0);
 assert.equal((await request(`/devices/${legacy.id}`,p.token,{},'DELETE',undefined,'https://attacker.test')).status,403);
});
test('second-step challenge cannot register a device until verification succeeds',async()=>{
 const p=await person(),meta=descriptor('mobile_pwa');
 Object.assign(config.twoFactor,{secret:'devices-test-HMAC-secret-at-least-32',smtpHost:'fixture',emailFrom:'fixture@example.test'});
 await db.q(`insert into account_second_factors(account_id,channel,destination) values($1,'email','fixture@example.test')`,[p.actor.id]);
 const challenge=await otp.beginLogin(p.actor,'key',undefined,p.key);assert.ok(challenge);let code='';otp.delivery.email=async(_destination,sent)=>{code=sent;};
 assert.equal((await request('/me',challenge.challenge_token,meta)).status,401);assert.equal((await db.q('select id from account_devices where account_id=$1',[p.actor.id])).length,0);
 await otp.sendLogin(challenge.challenge_token,'email');const verified=await otp.verifyLogin(challenge.challenge_token,code);
 const [device]=await (await request('/devices',verified.session,meta)).json();assert.equal(device.client_type,'mobile_pwa');assert.equal(device.sessions,1);
});
