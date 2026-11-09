import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Execute the actual cold sign-in view without a settings route or saved session.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('function loginView()');
const view=source.slice(start,source.indexOf('\n}\n',start)+2);
for(const supported of [true,false]) test(`cold sign-in renders with passkeys ${supported?'available':'unavailable'}`,()=>{
 const context=vm.createContext({
  state:{config:{providers:{google:false,telegram:false}}},
  pwa:{passkeyBlocker:()=>supported?null:'unavailable'},
  i18n:{t:(text:string|string[])=>typeof text==='string'?text:text.join(''),languagePicker:()=>({tag:'select'})},
  providerButtons:()=>null,release:()=>'',
  h:(tag:string,props:unknown,...children:unknown[])=>({tag,props,children}),
 });
 const result=vm.runInContext(view+';loginView()',context);
 const text=JSON.stringify(result);
 assert.match(text,/Войти по ключу/);
 assert.match(text,/API-ключ/);
 assert.equal(text.includes('Войти с passkey'),supported);
 assert.doesNotMatch(text,/Войти с Face ID|Войти с Touch ID/);
});

// The start of the app decides what a failed answer means: only 401 says someone is not signed in.
const problemStart=source.indexOf('async function serverProblem(res)');
const problem=source.slice(problemStart,source.indexOf('\n}\n',problemStart)+2);
const answer=(status:number,body:unknown,headers:string[]=[])=>({status,headers:{has:(name:string)=>headers.includes(name)},clone:()=>({json:async()=>{if(body===undefined)throw new Error('not JSON');return body;}})});
const judge=(res:unknown)=>{
 const context=vm.createContext({i18n:{t:(text:string)=>text},res});
 return vm.runInContext(`${problem};serverProblem(res)`,context) as Promise<{message:string,serverProblem:boolean}|null>;
};

test('too many requests and server errors are problems of the server, in its own words when it gives any',async()=>{
 const limited=await judge(answer(429,{error:'Подождите 30 с'}));
 assert.equal(limited?.serverProblem,true);
 assert.equal(limited?.message,'Подождите 30 с');
 assert.match((await judge(answer(500,undefined)))?.message??'',/Сервер временно недоступен/);
 assert.equal((await judge(answer(503,{})))?.serverProblem,true);
});

test('what says something about the person stays what it was, and so do answers made up while offline',async()=>{
 for(const status of [200,401,403,404,423]) assert.equal(await judge(answer(status,{})),null,String(status));
 assert.equal(await judge(answer(503,{},['X-Offline'])),null);
 assert.equal(await judge(answer(500,{},['X-From-Cache'])),null);
});

test('the start stops at a problem of the server instead of showing the sign-in screen',()=>{
 const start=source.slice(source.indexOf('async function boot('),source.indexOf('booting=false;',source.indexOf('async function boot(')));
 assert.match(start,/const lockProblem=await serverProblem\(lock\);\s*if\(lockProblem\)throw lockProblem;/);
 assert.match(start,/const meProblem=await serverProblem\(res\);\s*if\(meProblem\)throw meProblem;/);
 assert.match(start,/if\(error\.serverProblem\)state\.bootProblem=error\.message;/);
 const render=source.slice(source.indexOf('async function render('));
 assert.ok(render.indexOf('state.bootProblem')<render.indexOf('loginView()'),'it is looked at before the sign-in screen');
});
