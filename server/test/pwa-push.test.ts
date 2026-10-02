import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function platform(){
 let subscription:any=null,unsubscribed=0,permissionCalls=0,subscribes=0,standalone=true;
 const key=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,7)]).toString('base64url');
 const registration={active:true,pushManager:{getSubscription:async()=>subscription,subscribe:async(options:any)=>{subscribes++;return subscription={endpoint:'https://web.push.apple.com/fixture',options,toJSON:()=>({endpoint:'https://web.push.apple.com/fixture',keys:{p256dh:'key',auth:'auth'}}),unsubscribe:async()=>{unsubscribed++;subscription=null;return true;}};}}};
 const notification={permission:'default',requestPermission:()=>{permissionCalls++;return Promise.resolve(notification.permission='granted');}};
 const context:any={window:{PushManager:{},Notification:notification},Notification:notification,navigator:{userAgent:'iPhone',serviceWorker:{getRegistration:async()=>registration}},matchMedia:()=>({matches:standalone}),isSecureContext:true,Uint8Array,atob:(s:string)=>Buffer.from(s,'base64').toString('binary'),btoa:(s:string)=>Buffer.from(s,'binary').toString('base64'),addEventListener:()=>{},i18n:{t:(s:any)=>typeof s==='string'?s:s.join('')}};
 vm.createContext(context);
 const source=readFileSync(new URL('../public/pwa.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
 vm.runInContext(source+'\nglobalThis.apiFunctions={pushEnabled,enablePush,disablePush,testPush,pushBlocker};',context);
 const calls:any[]=[];const api=async(method:string,path:string,body?:unknown)=>{calls.push({method,path,body});return {key};};
 return {fn:context.apiFunctions,context,api,calls,notification,registration,get subscription(){return subscription;},get unsubscribed(){return unsubscribed;},get subscribes(){return subscribes;},get permissionCalls(){return permissionCalls;},browser:()=>{standalone=false;}};
}
test('iOS asks permission on the tap before network work; reuses and restores the subscription',async()=>{
 const p=platform();const enabling=p.fn.enablePush(p.api);assert.equal(p.permissionCalls,1);assert.equal(p.calls.length,0);await enabling;
 assert.equal(p.subscribes,1);assert.equal(p.subscription.options.userVisibleOnly,true);
 await p.fn.enablePush(p.api);assert.equal(p.subscribes,1);
 p.calls.length=0;assert.equal(await p.fn.pushEnabled(p.api),true);assert.equal(p.calls[0].path,'/push/subscriptions');
 await p.fn.testPush(p.api);assert.equal(p.calls.at(-1).path,'/push/test');
 await p.fn.disablePush(p.api);assert.equal(p.unsubscribed,1);assert.equal(await p.fn.pushEnabled(p.api),false);
});
test('unsupported iOS browser and denied permission show actionable blockers without throwing',async()=>{
 const p=platform();p.browser();assert.match(p.fn.pushBlocker(),/Домой/);await assert.rejects(p.fn.enablePush(p.api),/Домой/);assert.equal(p.permissionCalls,0);
 delete p.context.window.Notification;assert.equal(await p.fn.pushEnabled(p.api),false);
});
test('failed subscription registration cleans only newly created subscription; failed disable stays enabled',async()=>{
 const p=platform();const fail=async(method:string,path:string)=>{if(method==='POST')throw new Error('offline');return p.api(method,path);};
 await assert.rejects(p.fn.enablePush(fail),/offline/);assert.equal(p.unsubscribed,1);
 await p.fn.enablePush(p.api);await assert.rejects(p.fn.enablePush(fail),/offline/);assert.ok(p.subscription);assert.equal(p.unsubscribed,1);
 await assert.rejects(p.fn.disablePush(async()=>{throw new Error('offline');}),/offline/);assert.ok(p.subscription);
});
test('service worker displays received push and notification tap opens same-origin task',async()=>{
 const listeners:any={},shown:any[]=[],messages:any[]=[],opened:string[]=[];
 const self:any={location:{origin:'https://tracker.test'},navigator:{setAppBadge:async()=>{}},registration:{showNotification:async(title:string,options:any)=>shown.push({title,options}),getNotifications:async()=>shown},clients:{matchAll:async()=>[{focus:async()=>{},postMessage:(m:any)=>messages.push(m)}],openWindow:async(url:string)=>opened.push(url)},addEventListener:(name:string,fn:any)=>listeners[name]=fn};
 const context={self,URL,Response};vm.createContext(context);vm.runInContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context);
 let pending:Promise<any>=Promise.resolve();listeners.push({data:{json:()=>({title:'Результат',body:'Готово',url:'/#/tasks/42',tag:'task-42'})},waitUntil:(p:Promise<any>)=>pending=p});await pending;
 assert.equal(shown[0].title,'Результат');assert.equal(shown[0].options.data.url,'/#/tasks/42');
 listeners.notificationclick({notification:{close:()=>{},data:shown[0].options.data},waitUntil:(p:Promise<any>)=>pending=p});await pending;assert.equal(messages[0].url,'https://tracker.test/#/tasks/42');
 self.clients.matchAll=async()=>[];listeners.notificationclick({notification:{close:()=>{},data:{url:'https://external.test'}},waitUntil:(p:Promise<any>)=>pending=p});await pending;assert.equal(opened[0],'https://tracker.test/');
});
