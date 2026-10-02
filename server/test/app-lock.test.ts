import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type {AddressInfo} from 'node:net';
import {generateKeyPairSync,createSign,randomBytes} from 'node:crypto';

const database=new URL('postgres://aitracker:aitracker@127.0.0.1:5433/aitracker_app_lock_test');
process.env.DATABASE_URL=database.href;
const {config}=await import('../src/config.ts');
const db=await import('../src/db.ts');const svc=await import('../src/service.ts');const auth=await import('../src/auth.ts');
const {buildApp}=await import('../src/server.ts');
let server:ReturnType<ReturnType<typeof buildApp>['listen']>,url:string,index=0;
before(async()=>{
 const maintenance=new URL(database);maintenance.pathname='/postgres';const client=new pg.Client({connectionString:maintenance.href});
 await client.connect();await client.query('drop database if exists aitracker_app_lock_test with (force)');await client.query('create database aitracker_app_lock_test');await client.end();await db.migrate();
 server=buildApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 config.publicUrl=url;config.webauthn.origins=[url];config.webauthn.rpId='127.0.0.1';
});
after(async()=>{server?.close();await db.pool.end();});
async function person(){
 const result=await svc.createAccount({name:`app-lock-${++index}`,kind:'human',role:'member'});const actor=await auth.authenticate(result.key);
 return {actor,key:result.key,token:await auth.createSession(actor.id,'key')};
}
async function request(path:string,token:string,method='GET',body?:unknown,origin=url,headers:Record<string,string>={}){
 return fetch(url+'/api'+path,{method,headers:{Cookie:`ait_session=${token}`,Origin:origin,...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'});
}
const setup=(token:string,biometric=false)=>request('/app-lock/settings',token,'PUT',{code:'123456',biometric});
const lock=(token:string)=>request('/app-lock/lock',token,'POST');
const unlock=(token:string,code='123456')=>request('/app-lock/unlock',token,'POST',{code});

test('session PIN hash, no token or secret exposure, server access denied while locked',async()=>{
 const p=await person();assert.equal((await setup(p.token)).status,200);
 const row=await db.q1('select * from sessions where token_hash=$1',[auth.hashKey(p.token)]);
 assert.ok(row!.app_passcode_hash);assert.ok(!row!.app_passcode_hash.includes('123456'));
 const status=await request('/app-lock/status',p.token);assert.equal(status.headers.get('cache-control'),'no-store');
 const metadata=await status.json();assert.equal(metadata.configured,true);assert.equal(metadata.locked,false);assert.ok(!JSON.stringify(metadata).includes(p.token));assert.equal(metadata.app_passcode_hash,undefined);
 assert.equal((await lock(p.token)).status,200);
 for(const path of ['/me','/tasks','/accounts','/devices'])assert.equal((await request(path,p.token)).status,423);
 await assert.rejects(auth.authenticate(p.token),{status:423});
 assert.equal((await request('/me',p.token,'GET',undefined,url,{'X-Device-Id':'c9e9d2e2-d883-4c5d-8ef7-273133be8a89'})).status,423);
 assert.equal((await unlock(p.token)).status,200);assert.equal((await request('/me',p.token)).status,200);
});
test('five failures commit a persistent cooldown, including concurrent requests; correct code cannot bypass it',async()=>{
 const p=await person();await setup(p.token);await lock(p.token);
 const responses=await Promise.all(Array.from({length:5},()=>unlock(p.token,'000000')));
 assert.deepEqual(responses.map(r=>r.status).sort(),[400,400,400,400,429]);assert.equal((await unlock(p.token)).status,429);
 assert.equal((await lock(p.token)).status,200);assert.equal((await unlock(p.token)).status,429);
 await db.q("update sessions set app_passcode_retry_at=now()-interval '1 second' where token_hash=$1",[auth.hashKey(p.token)]);
 assert.equal((await unlock(p.token)).status,200);
 const row=await db.q1('select app_passcode_attempts,app_passcode_retry_at from sessions where token_hash=$1',[auth.hashKey(p.token)]);
 assert.equal(row!.app_passcode_attempts,0);assert.equal(row!.app_passcode_retry_at,null);
});
test('settings changes require current PIN and unlocked session; fresh sign-in is needed for initial enrollment',async()=>{
 const p=await person();await setup(p.token);
 assert.equal((await request('/app-lock/settings',p.token,'PUT',{code:'654321'})).status,400);
 assert.equal((await request('/app-lock/settings',p.token,'PUT',{code:'654321',current_code:'123456'})).status,200);
 await lock(p.token);assert.equal((await setup(p.token)).status,423);
 assert.equal((await unlock(p.token)).status,400);assert.equal((await unlock(p.token,'654321')).status,200);
 const old=await person();await db.q("update sessions set created_at=now()-interval '11 minutes' where token_hash=$1",[auth.hashKey(old.token)]);
 assert.equal((await setup(old.token)).status,403);
});
test('PIN input validation, origin binding, API-key rejection, expired and revoked sessions',async()=>{
 const p=await person();
 assert.equal((await request('/app-lock/settings',p.token,'PUT',{code:'123'})).status,400);
 assert.equal((await request('/app-lock/settings',p.token,'PUT',{code:'123456'},'https://attacker.test')).status,403);
 assert.equal((await request('/app-lock/status',p.key)).status,403);
 await setup(p.token);await lock(p.token);await auth.destroySession(p.token);
 assert.equal((await unlock(p.token)).status,401);
 const expired=await person();await db.q("update sessions set expires_at=now()-interval '1 second' where token_hash=$1",[auth.hashKey(expired.token)]);
 assert.equal((await request('/app-lock/status',expired.token)).status,401);
});

async function credential(accountId:number){
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
 // COSE EC2 key: {1:2,3:-7,-1:1,-2:x,-3:y} with two 32-byte byte strings.
 const cose=Buffer.concat([Buffer.from([0xa5,0x01,0x02,0x03,0x26,0x20,0x01,0x21,0x58,0x20]),Buffer.from(jwk.x!,'base64url'),Buffer.from([0x22,0x58,0x20]),Buffer.from(jwk.y!,'base64url')]);
 const id=randomBytes(32).toString('base64url');await db.q(`insert into passkeys(account_id,credential_id,public_key,counter,transports,device_type,backed_up,name) values($1,$2,$3,0,'{}','singleDevice',false,'Test')`,[accountId,id,cose]);
 let counter=0;
 return {id,assertion(options:any){
  const clientDataJSON=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin:url,crossOrigin:false}));
  const data=Buffer.alloc(37);data.set(Buffer.from(auth.hashKey('127.0.0.1'),'hex'));data[32]=5;data.writeUInt32BE(++counter,33);
  const signature=createSign('SHA256').update(Buffer.concat([data,Buffer.from(auth.hashKey(clientDataJSON.toString()),'hex')])).sign(pair.privateKey);
  return {id,rawId:id,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:clientDataJSON.toString('base64url'),authenticatorData:data.toString('base64url'),signature:signature.toString('base64url')}};
 }};
}
test('passkey confirmation unlocks the same session without replacing its account or sign-in method',async()=>{
 const p=await person(),key=await credential(p.actor.id);await setup(p.token,true);await lock(p.token);
 const challenge=await (await request('/app-lock/passkey/options',p.token,'POST')).json();
 assert.deepEqual(challenge.options.allowCredentials.map((c:any)=>c.id),[key.id]);
 const proof={challenge_id:challenge.challenge_id,response:key.assertion(challenge.options)};
 assert.equal((await request('/app-lock/passkey/verify',p.token,'POST',proof)).status,200);
 assert.equal((await request('/me',p.token)).status,200);
 const row=await db.q1('select method,account_id from sessions where token_hash=$1',[auth.hashKey(p.token)]);assert.equal(row!.method,'key');assert.equal(row!.account_id,p.actor.id);
 assert.equal((await request('/app-lock/passkey/verify',p.token,'POST',proof)).status,400);
});
test('unlock proof cannot log in, unlock another session, or accept another account; failed proof preserves PIN fallback',async()=>{
 const p=await person(),key=await credential(p.actor.id),other=await person(),wrong=await credential(other.actor.id);
 await setup(p.token,true);await lock(p.token);
 const get=async()=> (await request('/app-lock/passkey/options',p.token,'POST')).json();
 let c=await get();assert.equal((await request('/passkeys/login/verify',p.token,'POST',{challenge_id:c.challenge_id,response:key.assertion(c.options)})).status,400);
 c=await get();const second=await auth.createSession(p.actor.id,'key');await setup(second,true);await lock(second);
 assert.equal((await request('/app-lock/passkey/verify',second,'POST',{challenge_id:c.challenge_id,response:key.assertion(c.options)})).status,400);
 c=await get();assert.equal((await request('/app-lock/passkey/verify',p.token,'POST',{challenge_id:c.challenge_id,response:wrong.assertion(c.options)})).status,401);
 assert.equal((await request('/me',p.token)).status,423);assert.equal((await unlock(p.token)).status,200);
 const noShortcut=await person();await setup(noShortcut.token);await lock(noShortcut.token);
 assert.equal((await request('/app-lock/passkey/options',noShortcut.token,'POST')).status,403);
});
