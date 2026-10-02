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
