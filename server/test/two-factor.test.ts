import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { AddressInfo } from 'node:net';
import { fakeOidc } from './helpers/oidc.ts';

const database=new URL(process.env.DATABASE_URL??'postgres://aitracker:aitracker@127.0.0.1:5433/aitracker');
database.pathname='/aitracker_2fa_test';process.env.DATABASE_URL=database.href;
const {config}=await import('../src/config.ts');
const db=await import('../src/db.ts');
const svc=await import('../src/service.ts');
const auth=await import('../src/auth.ts');
const otp=await import('../src/two-factor.ts');
const social=await import('../src/social-auth.ts');
const {buildApp}=await import('../src/server.ts');
const oidc=await fakeOidc();
const deliveries:Array<{channel:string;destination:string;code:string}>=[];
const gatewayDelivery=otp.delivery.telegram;
otp.delivery.email=async(destination,code)=>{deliveries.push({channel:'email',destination,code});};
otp.delivery.telegram=async(destination,code)=>{deliveries.push({channel:'telegram',destination,code});};
let server:ReturnType<ReturnType<typeof buildApp>['listen']>,url:string,index=0;
before(async()=>{
 const maintenance=new URL(database);maintenance.pathname='/postgres';const client=new pg.Client({connectionString:maintenance.href});
 await client.connect();await client.query('drop database if exists aitracker_2fa_test with (force)');await client.query('create database aitracker_2fa_test');await client.end();await db.migrate();
 Object.assign(config.twoFactor,{secret:'test-secret-with-at-least-32-characters',smtpHost:'smtp.example.test',emailFrom:'AI Tracker <tracker@example.test>',telegramGatewayToken:'gateway-test-token'});
 for(const provider of ['google','telegram'] as const){Object.assign(config.socialAuth[provider],{clientId:'test-client',clientSecret:'test-secret'});social.providers[provider].token=`${oidc.url}/${provider}/token`;social.providers[provider].jwks=`${oidc.url}/jwks`;}
 server=buildApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;config.publicUrl=url;
});
after(async()=>{server?.close();await oidc.close();await db.pool.end();});
const cookies=(r:Response)=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
const lastCode=()=>deliveries.at(-1)!.code;
async function request(path:string,body?:unknown,cookie?:string,key?:string,method='POST',origin?:string){
 return fetch(url+'/api'+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(key?{Authorization:`Bearer ${key}`}:{ }),...(origin?{Origin:origin}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'manual'});
}
async function person(role:'member'|'admin'='member',kind:'human'|'agent'='human'){
 const created=await svc.createAccount({name:`otp-${++index}`,kind,role});
 const actor=await auth.authenticate(created.key);const session=await auth.createSession(actor.id,'key');
 return {actor,key:created.key,session,cookie:`ait_session=${session}`};
}
async function cool(id:number){await db.q('update accounts set two_factor_sent_at=now()-interval \'61 seconds\' where id=$1',[id]);}
async function enabled(){const p=await person();const enroll=await request('/auth/2fa/enroll',{channel:'email',email:`${p.actor.name}@example.test`},p.cookie);assert.equal(enroll.status,200);const data=await enroll.json();assert.equal((await request('/auth/2fa/enroll/verify',{enrollment_token:data.enrollment_token,code:lastCode()},p.cookie)).status,200);return p;}
async function login(p:Awaited<ReturnType<typeof person>>){const result=await request('/session',{key:p.key});assert.equal(result.status,200);const data=await result.json();assert.equal(data.two_factor_required,true);assert.equal(data.session_token,undefined);return {token:data.challenge_token as string,cookie:cookies(result),data};}
async function send(flow:Awaited<ReturnType<typeof login>>,channel='email'){return request('/auth/2fa/send',{challenge_token:flow.token,channel});}
async function verify(flow:Awaited<ReturnType<typeof login>>,code=lastCode()){return request('/auth/2fa/verify',{challenge_token:flow.token,code});}

test('availability contains no secrets and enrollment requires a fresh human session',async()=>{
 const p=await person();const available=await (await request('/config',undefined,undefined,undefined,'GET')).text();assert.ok(!available.includes(config.twoFactor.secret));
 assert.equal((await request('/auth/2fa/enroll',{channel:'email',email:'person@example.test'},undefined,p.key)).status,403);
 await db.q('update sessions set created_at=now()-interval \'11 minutes\' where token_hash=$1',[auth.hashKey(p.session)]);
 assert.equal((await request('/auth/2fa/enroll',{channel:'email',email:'person@example.test'},p.cookie)).status,403);
 const agent=await person('member','agent');assert.equal((await request('/auth/2fa/enroll',{channel:'email',email:'person@example.test'},agent.cookie)).status,401);
});
test('email is confirmed before enabling; codes are HMACed, bound to session and used once',async()=>{
 const p=await person();const r=await request('/auth/2fa/enroll',{channel:'email',email:'Owner@Example.Test'},p.cookie);const e=await r.json();const code=lastCode();
 assert.equal(deliveries.at(-1)!.destination,'owner@example.test');assert.equal((await otp.settings(p.actor)).enabled,false);
 const row=await db.q1('select * from two_factor_codes where account_id=$1',[p.actor.id]);assert.notEqual(row!.code_hash,auth.hashKey(code));assert.ok(!JSON.stringify(e).includes(code));
 const otherSession=await auth.createSession(p.actor.id,'key');assert.equal((await request('/auth/2fa/enroll/verify',{enrollment_token:e.enrollment_token,code},`ait_session=${otherSession}`)).status,400);
 assert.equal((await request('/auth/2fa/enroll/verify',{enrollment_token:e.enrollment_token,code},p.cookie)).status,200);
 assert.equal((await otp.settings(p.actor)).enabled,true);assert.equal((await request('/me',undefined,`ait_session=${otherSession}`,undefined,'GET')).status,401);
 assert.equal((await request('/auth/2fa/enroll/verify',{enrollment_token:e.enrollment_token,code},p.cookie)).status,400);
});
test('pending first step cannot access data; raw human key cannot bypass 2FA; agents still work',async()=>{
 const p=await enabled(),flow=await login(p);assert.match(flow.cookie,/ait_two_factor=/);assert.ok(!flow.cookie.includes('ait_session=ats_'));
 assert.equal((await request('/me',undefined,flow.cookie,undefined,'GET')).status,401);assert.equal((await request('/me',undefined,undefined,p.key,'GET')).status,401);
 assert.equal((await request('/me',undefined,undefined,flow.token,'GET')).status,401);
 await assert.rejects(auth.createSession(p.actor.id,'key'));
 const agent=await person('member','agent');assert.equal((await request('/me',undefined,undefined,agent.key,'GET')).status,200);
});
test('browser challenge token is HttpOnly and browser confirmation does not expose session token',async()=>{
 const p=await enabled();const result=await request('/session',{key:p.key},undefined,undefined,'POST',url);const data=await result.json();assert.equal(data.challenge_token,undefined);
 const cookie=cookies(result);assert.match(result.headers.get('set-cookie')!,/HttpOnly/);assert.match(result.headers.get('set-cookie')!,/SameSite=Strict/);
 assert.equal((await request('/auth/2fa/pending',undefined,cookie,undefined,'GET')).status,200);await cool(p.actor.id);
 assert.equal((await request('/auth/2fa/send',{channel:'email'},cookie,undefined,'POST',url)).status,200);
 const verified=await request('/auth/2fa/verify',{code:lastCode()},cookie,undefined,'POST',url);assert.equal(verified.status,200);assert.equal((await verified.json()).session_token,undefined);
 assert.equal((await request('/me',undefined,cookies(verified),undefined,'GET')).status,200);
});
test('correct code issues session once, including concurrent verification',async()=>{
 const p=await enabled(),flow=await login(p);await cool(p.actor.id);assert.equal((await send(flow)).status,200);const code=lastCode();
 const result=await Promise.all([verify(flow,code),verify(flow,code)]);assert.deepEqual(result.map(r=>r.status).sort(),[200,401]);
 const token=(await result.find(r=>r.status===200)!.json()).session_token;assert.ok(token.startsWith('ats_'));assert.equal((await request('/me',undefined,undefined,token,'GET')).status,200);
});
test('expiry and malformed codes fail; pending flow expires independently',async()=>{
 const p=await enabled(),flow=await login(p);await cool(p.actor.id);await send(flow);
 assert.equal((await verify(flow,'12')).status,400);await db.q('update two_factor_codes set expires_at=now()-interval \'1 second\' where account_id=$1',[p.actor.id]);assert.equal((await verify(flow)).status,400);
 await db.q('update two_factor_logins set expires_at=now()-interval \'1 second\' where account_id=$1',[p.actor.id]);assert.equal((await verify(flow)).status,401);
});
test('five failed attempts lock the account across new primary logins, then recover after timeout',async()=>{
 const p=await enabled(),flow=await login(p);await cool(p.actor.id);await send(flow);const wrong=lastCode()==='000000'?'999999':'000000';
 for(let i=0;i<5;i++)assert.equal((await verify(flow,wrong)).status,400);
 assert.equal((await verify(flow)).status,429);assert.equal((await request('/session',{key:p.key})).status,429);
 await db.q('update accounts set two_factor_locked_until=now()-interval \'1 second\' where id=$1',[p.actor.id]);assert.equal((await verify(flow)).status,200);
});
test('resend invalidates older code; cooldown and hourly limit cannot be reset by primary login',async()=>{
 const p=await enabled(),flow=await login(p);assert.equal((await send(flow)).status,429);await cool(p.actor.id);assert.equal((await send(flow)).status,200);const old=lastCode();
 const next=await login(p);assert.equal((await send(next)).status,429);await cool(p.actor.id);assert.equal((await send(flow)).status,200);
 if(old!==lastCode())assert.equal((await verify(flow,old)).status,400);
 await cool(p.actor.id);await db.q('update accounts set two_factor_send_count=5 where id=$1',[p.actor.id]);assert.equal((await send(next)).status,429);
});
test('disabled account or rotated human key invalidates pending login',async()=>{
 const p=await enabled(),flow=await login(p);await cool(p.actor.id);await send(flow);await db.q('update accounts set key_hash=$2 where id=$1',[p.actor.id,auth.hashKey(auth.generateKey())]);assert.equal((await verify(flow)).status,401);
 const p2=await enabled(),flow2=await login(p2);await cool(p2.actor.id);await send(flow2);await db.q('update accounts set disabled=true where id=$1',[p2.actor.id]);assert.equal((await verify(flow2)).status,401);
});
test('delivery failure gives safe error and never enables factor or leaks a code/token',async()=>{
 const p=await person(),original=otp.delivery.email;otp.delivery.email=async()=>{throw new Error('SMTP secret or code must never escape');};
 try{const r=await request('/auth/2fa/enroll',{channel:'email',email:'owner@example.test'},p.cookie);assert.equal(r.status,502);assert.ok(!(await r.text()).includes('SMTP secret'));assert.equal((await otp.settings(p.actor)).enabled,false);
   assert.equal((await request('/auth/2fa/enroll',{channel:'email',email:'owner@example.test'},p.cookie)).status,429);
   assert.equal((await db.q('select token_hash from two_factor_codes where account_id=$1',[p.actor.id])).length,0);}
 finally{otp.delivery.email=original;}
});
test('Telegram Gateway confirms E.164 phone before enabling; login uses confirmed destination',async()=>{
 const p=await person();assert.equal((await request('/auth/2fa/enroll',{channel:'telegram'},p.cookie)).status,400);
 assert.equal((await request('/auth/2fa/enroll',{channel:'telegram',phone:'@username'},p.cookie)).status,400);
 assert.equal((await request('/auth/2fa/enroll',{channel:'telegram',phone:'79991234567'},p.cookie)).status,400);
 const e=await (await request('/auth/2fa/enroll',{channel:'telegram',phone:'+79991234567'},p.cookie)).json();assert.equal(deliveries.at(-1)!.destination,'+79991234567');
 assert.equal((await otp.settings(p.actor)).enabled,false);assert.ok(!JSON.stringify(e).includes('+79991234567'));
 assert.equal((await request('/auth/2fa/enroll/verify',{enrollment_token:e.enrollment_token,code:lastCode()},p.cookie)).status,200);
 const flow=await login(p);await cool(p.actor.id);assert.equal((await request('/auth/2fa/send',{challenge_token:flow.token,channel:'telegram',phone:'+78888888888'})).status,200);
 assert.equal(deliveries.at(-1)!.destination,'+79991234567');assert.equal((await verify(flow)).status,200);
});
test('Gateway sends server code with TTL via bearer header; provider errors fail safely',async()=>{
 const original=globalThis.fetch;let captured:Request|undefined;
 globalThis.fetch=async(input,init)=>{captured=new Request(input,init);return Response.json({ok:true,result:{request_id:'fixture'}});};
 try{
  await gatewayDelivery('+79991234567','001234');
  assert.equal(captured!.url,'https://gatewayapi.telegram.org/sendVerificationMessage');assert.equal(captured!.method,'POST');
  assert.equal(captured!.headers.get('authorization'),'Bearer gateway-test-token');assert.equal(captured!.redirect,'error');
  assert.deepEqual(await captured!.json(),{phone_number:'+79991234567',code:'001234',ttl:300});
  globalThis.fetch=async()=>Response.json({ok:false,error:'ACCESS_TOKEN_INVALID gateway-test-token'}, {status:200});
  await assert.rejects(gatewayDelivery('+79991234567','001234'),{message:'delivery failed'});
  globalThis.fetch=async()=>Response.json({ok:true},{status:503});await assert.rejects(gatewayDelivery('+79991234567','001234'));
 }finally{globalThis.fetch=original;}
});
test('Google callback and native exchange are gated before creating session; unlink revokes pending',async()=>{
 const p=await enabled();const identity=await db.q1(`insert into account_identities(account_id,provider,subject,label) values($1,'google',$2,'owner') returning id`,[p.actor.id,`google-${p.actor.id}`]);
 const start=await request('/auth/google/start',{});const flow=await start.json();const callback=await fetch(oidc.issue('google',flow.authorization_url,{sub:`google-${p.actor.id}`}),{headers:{Cookie:cookies(start)},redirect:'manual'});
 assert.equal(callback.headers.get('location'),'/#/two-factor');assert.ok(!cookies(callback).includes('ait_session=ats_'));const pending=cookies(callback);await cool(p.actor.id);
 assert.equal((await request('/auth/2fa/send',{channel:'email'},pending)).status,200);assert.equal((await request('/auth/2fa/verify',{code:lastCode()},pending)).status,200);
 const verifier='native-verifier-with-enough-entropy-123456789';const code=await social.nativeResult(p.actor,'google',{native_challenge:social.pkceChallenge(verifier)},identity!.id);
 const exchanged=await request('/auth/exchange',{code,code_verifier:verifier});const native=await exchanged.json();assert.equal(native.two_factor_required,true);assert.equal(native.session_token,undefined);
 await db.q('delete from account_identities where id=$1',[identity!.id]);assert.equal((await request('/auth/2fa/send',{challenge_token:native.challenge_token,channel:'email'})).status,401);
});
test('removal requires recent 2FA; administrative recovery revokes every target session',async()=>{
 const p=await enabled();await db.q('update sessions set two_factor_at=now()-interval \'6 minutes\' where token_hash=$1',[auth.hashKey(p.session)]);
 assert.equal((await request('/auth/2fa/settings/email',undefined,p.cookie,undefined,'DELETE')).status,403);
 const admin=await person('admin');assert.equal((await request(`/accounts/${p.actor.id}/reset-2fa`,undefined,admin.cookie)).status,200);
 assert.equal((await request('/me',undefined,p.cookie,undefined,'GET')).status,401);assert.equal((await request('/session',{key:p.key})).status,200);
 const p2=await enabled();assert.equal((await request('/auth/2fa/settings/email',undefined,p2.cookie,undefined,'DELETE')).status,200);assert.equal((await otp.settings(p2.actor)).enabled,false);
 assert.equal((await request(`/accounts/${p2.actor.id}/reset-2fa`,undefined,p2.cookie)).status,403);
});
test('cross-site confirmation, enrollment and deletion are denied; no configured channel fails closed',async()=>{
 const p=await enabled(),flow=await login(p);assert.equal((await request('/auth/2fa/send',{challenge_token:flow.token,channel:'email'},undefined,undefined,'POST','https://attacker.test')).status,403);
 assert.equal((await request('/auth/2fa/settings/email',undefined,p.cookie,undefined,'DELETE','https://attacker.test')).status,403);
 const old=config.twoFactor.secret;config.twoFactor.secret='';try{await cool(p.actor.id);assert.equal((await send(flow)).status,503);assert.equal((await request('/me',undefined,undefined,p.key,'GET')).status,401);}finally{config.twoFactor.secret=old;}
});
