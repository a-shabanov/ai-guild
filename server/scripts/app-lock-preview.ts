// Local, disposable QA server. No production keys/accounts or database are used.
import pg from 'pg';
import express from 'express';
import { writeFileSync, existsSync } from 'node:fs';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
process.env.DATABASE_URL='postgres://aitracker:aitracker@127.0.0.1:5433/aitracker_app_lock_preview';
process.env.PORT='4618';process.env.PUBLIC_URL='http://127.0.0.1:4618';process.env.DATA_DIR='/private/tmp/ait-app-lock-preview-data';
const {pool,migrate,q}=await import('../src/db.ts');
const svc=await import('../src/service.ts');const auth=await import('../src/auth.ts');const lock=await import('../src/app-lock.ts');
const {buildApp}=await import('../src/server.ts');
const maintenance=new pg.Client({connectionString:'postgres://aitracker:aitracker@127.0.0.1:5433/postgres'});
await maintenance.connect();
if(!(await maintenance.query("select datname from pg_database where datname='aitracker_app_lock_preview'")).rows.length)await maintenance.query('create database aitracker_app_lock_preview');
await maintenance.end();await migrate();
const account=await svc.createAccount({name:`passcode-preview-${Date.now()}`,kind:'human',role:'admin'});
const actor=await auth.authenticate(account.key);
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
const cose=Buffer.concat([Buffer.from([0xa5,0x01,0x02,0x03,0x26,0x20,0x01,0x21,0x58,0x20]),Buffer.from(jwk.x!,'base64url'),Buffer.from([0x22,0x58,0x20]),Buffer.from(jwk.y!,'base64url')]);
await q(`insert into passkeys(account_id,credential_id,public_key,counter,transports,device_type,backed_up,name) values($1,$2,$3,0,'{}','singleDevice',false,'Test preview passkey')`,[actor.id,randomBytes(32).toString('base64url'),cose]);
const native=await auth.createSession(actor.id,'key');
writeFileSync('/private/tmp/ait-app-lock-preview-session.json',JSON.stringify({token:native,url:'http://127.0.0.1:4618'}),{mode:0o600});
const app=express();
let previewUpdate=process.env.AITRACKER_PREVIEW_UPDATE==='1';
app.get('/api/config',(_req,res,next)=>existsSync('/private/tmp/ait-preview-update-error')?res.status(503).json({error:'Preview update check unavailable'}):previewUpdate?res.json({version:'99.0.0',build:999,apns:false,vapid_public_key:null,providers:{google:false,telegram:false},passkeys:{rp_id:'127.0.0.1',origins:['http://127.0.0.1:4618']},two_factor:{email:false,telegram:false}}):next());
app.get('/api/auth/__preview/:mode',async(req,res)=>{
 if(req.params.mode==='update')previewUpdate=true;
 if(req.params.mode==='current')previewUpdate=false;
 const token=await auth.createSession(actor.id,'key');
 if(req.params.mode!=='setup'){
  await lock.configure(actor,token,{code:'123456',biometric:req.params.mode==='biometric'});
 }
 res.cookie('ait_session',token,{httpOnly:true,sameSite:'strict',path:'/'});
 res.redirect('/?lang=ru#/settings');
});
app.use(buildApp());
const server=app.listen(4618,'127.0.0.1',()=>console.log('Disposable passcode preview ready at http://127.0.0.1:4618/api/auth/__preview/setup'));
process.on('SIGTERM',()=>{server.close();pool.end();});
