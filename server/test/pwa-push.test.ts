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
 const storage=new Map<string,Response>();
 const caches={open:async()=>({match:async(key:string)=>storage.get(key)?.clone(),put:async(key:string,value:Response)=>storage.set(key,value),delete:async(key:string)=>storage.delete(key)})};
 const self:any={location:{origin:'https://tracker.test'},navigator:{setAppBadge:async()=>{}},registration:{showNotification:async(title:string,options:any)=>shown.push({title,options}),getNotifications:async()=>shown},clients:{matchAll:async()=>[{focus:async()=>{},postMessage:(m:any)=>messages.push(m)}],openWindow:async(url:string)=>{opened.push(url);return null;}},addEventListener:(name:string,fn:any)=>listeners[name]=fn};
 const context={self,URL,Response,caches};vm.createContext(context);vm.runInContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context);
 let pending:Promise<any>=Promise.resolve();listeners.push({data:{json:()=>({title:'Результат',body:'Готово',url:'/#/tasks/42',tag:'task-42'})},waitUntil:(p:Promise<any>)=>pending=p});await pending;
 assert.equal(shown[0].title,'Результат');assert.equal(shown[0].options.data.url,'/#/tasks/42');
 listeners.notificationclick({notification:{close:()=>{},data:shown[0].options.data},waitUntil:(p:Promise<any>)=>pending=p});await pending;assert.equal(messages[0].url,'https://tracker.test/#/tasks/42');
 self.clients.matchAll=async()=>[];listeners.notificationclick({notification:{close:()=>{},data:{url:'https://external.test'}},waitUntil:(p:Promise<any>)=>pending=p});await pending;assert.equal(opened[0],'https://tracker.test/#/inbox');
});

function pushNavigationFixture(storage = new Map<string, Response>()) {
 const listeners: any = {}, delivered: any[] = [], opened: string[] = [];
 let windows: any[] = [];
 const cache = {match: async (key: string) => storage.get(key)?.clone(),
  put: async (key: string, value: Response) => {storage.set(key, value);},
  delete: async (key: string) => storage.delete(key)};
 const caches = {open: async () => cache, delete: async () => {storage.clear();return true;}};
 const self: any = {location: {origin: 'https://tracker.test'},
  clients: {matchAll: async () => windows, openWindow: async (url: string) => {opened.push(url);return null;}},
  addEventListener: (name: string, fn: any) => listeners[name] = fn};
 const context = {self, URL, Response, caches};
 vm.createContext(context);
 vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
 const dispatch = async (name: string, event: any) => {
  let pending = Promise.resolve(); listeners[name]({...event, waitUntil: (p: Promise<any>) => pending = p}); await pending;
 };
 const source = {id: 'app', postMessage: (message: any) => delivered.push(message)};
 return {storage, cache, delivered, opened, dispatch, source,
  setWindows: (value: any[]) => {windows = value;},
  tap: (url: string) => dispatch('notificationclick', {notification: {close() {}, data: {url}}}),
  ready: (client = source) => dispatch('message', {data: {type: 'navigation-ready'}, source: client}),
  ack: (url: string) => dispatch('message', {data: {type: 'navigation-ack', url}, source}),
 };
}

test('cold iOS launch retains the task across worker restart and consumes it only after acknowledgement', async () => {
 const f = pushNavigationFixture();
 await f.tap('/#/tasks/42');
 assert.deepEqual(f.opened, ['https://tracker.test/#/tasks/42']);
 const restarted = pushNavigationFixture(f.storage);
 await restarted.ready();
 assert.equal(restarted.delivered[0].url, 'https://tracker.test/#/tasks/42');
 await restarted.ack('https://tracker.test/#/tasks/41');
 assert.equal(f.storage.size, 1);
 await restarted.ack('https://tracker.test/#/tasks/42');
 await restarted.ready();
 assert.equal(restarted.delivered.length, 1);
 assert.equal(f.storage.size, 0);
});

test('focus failure on an inert iOS client does not lose the task intent', async () => {
 const f = pushNavigationFixture();
 f.setWindows([{id: 'inert', postMessage() {}, focus: async () => {throw new Error('inert');}}]);
 await f.tap('/#/tasks/123');
 assert.equal(f.opened[0], 'https://tracker.test/#/tasks/123');
 await f.ready();
 assert.equal(f.delivered[0].url, 'https://tracker.test/#/tasks/123');
});

test('pending navigation belongs to the selected window, expires, and is removed on logout', async () => {
 const f = pushNavigationFixture();
 f.setWindows([{...f.source, focus: async () => {}}]);
 await f.tap('/#/tasks/42');
 await f.ready({id: 'unrelated', postMessage: () => {throw new Error('wrong window');}});
 assert.equal(f.storage.size, 1);
 const key = [...f.storage.keys()][0];
 const target = await f.storage.get(key)!.clone().json();
 await f.cache.put(key, new Response(JSON.stringify({...target, at: Date.now() - 180000})));
 await f.ready(); assert.equal(f.storage.size, 0);
 await f.tap('/#/tasks/42');
 await f.dispatch('message', {data: {type: 'logout'}});
 assert.equal(f.storage.size, 0);
});

test('the app registers its listener before requesting a pending task and acknowledges only same-origin routes', async () => {
 const listeners: any = {}, posted: any[] = [], routes: string[] = [];
 const worker = {postMessage: (m: any) => posted.push(m)};
 const context: any = {navigator: {serviceWorker: {
  addEventListener: (name: string, fn: any) => listeners[name] = fn,
  register: async () => ({active: worker})}},
  location: {origin: 'https://tracker.test'}, URL,
  document: {addEventListener() {}}, addEventListener() {},
 };
 vm.createContext(context);
 const source = readFileSync(new URL('../public/pwa.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
 vm.runInContext(source + '\nglobalThis.register = registerServiceWorker;', context);
 await context.register((url: string) => routes.push(url));
 assert.equal(posted[0].type, 'navigation-ready');
 listeners.message({data: {type: 'navigate', url: 'https://external.test/#/tasks/42'}, source: worker});
 assert.equal(routes.length, 0);
 listeners.message({data: {type: 'navigate', url: '/#/tasks/42'}, source: worker});
 assert.equal(routes[0], 'https://tracker.test/#/tasks/42');
 assert.equal(posted.at(-1).type, 'navigation-ack');
});
