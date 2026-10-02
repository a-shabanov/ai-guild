import {test} from 'node:test';
import assert from 'node:assert/strict';

// Small DOM double: exercise the real keypad and offer callbacks without real credentials.
class Element {
  tag: string; attrs:Record<string,string>={}; children:any[]=[]; events:Record<string,Function[]>={};
  style:Record<string,string>={}; disabled=false; hidden=false; ownText=''; isConnected=true;
  constructor(tag:string){this.tag=tag;}
  setAttribute(name:string,value:any){this.attrs[name]=String(value);}
  addEventListener(name:string,fn:Function){(this.events[name]??=[]).push(fn);}
  append(...children:any[]){this.children.push(...children);}
  replaceChildren(...children:any[]){this.children=children;}
  set textContent(value:string){this.ownText=value;this.children=[];}
  get textContent():string{return this.ownText+this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
  all():Element[]{return [this,...this.children.filter(c=>c instanceof Element).flatMap(c=>c.all())];}
  querySelector(selector:string){return this.all().find(c=>c.attrs.class?.split(' ').includes(selector.slice(1)))??null;}
  async click(){if(this.disabled)return;for(const fn of this.events.click??[])await fn();}
}
(globalThis as any).location={search:"?lang=ru"};
(globalThis as any).document={documentElement:{lang:""},createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag),addEventListener:()=>{}};
// @ts-expect-error Browser-only JavaScript module has no TypeScript declaration.
const {passcodeView,quickUnlockView,disposePasscodeView}=await import('../public/app-lock-view.js');
const button=(root:Element,text:string)=>root.all().find(c=>c.tag==='button'&&c.textContent===text)!;
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('PIN setup has skip, no checkbox; mismatched confirmation does not save; a confirmed PIN saves before any biometric request',async()=>{
 let saved:any;let skips=0;
 const root=passcodeView({mode:'setup',skip:async()=>{skips++;},submit:async(input:any)=>{saved=input;},cancel:()=>{}}) as Element;
 assert.equal(root.all().some(c=>c.tag==='input'),false);
 for(const digit of '123456')await button(root,digit).click();
 assert.equal(saved,undefined);
 for(const digit of '654321')await button(root,digit).click();await settle();
 assert.equal(saved,undefined);assert.ok(root.textContent.includes('Коды не совпадают'));
 for(const digit of '123456')await button(root,digit).click();await settle();
 const result=saved as unknown as {code:string;biometric:boolean};
 assert.equal(result.code,'123456');assert.equal(result.biometric,false);
 await button(root,'Пропустить').click();assert.equal(skips,1);disposePasscodeView();
});
test('quick unlock waits for explicit Connect; a cancelled prompt leaves Not now usable',async()=>{
 let requests=0,declines=0;
 const root=quickUnlockView({biometricName:'Touch ID',enable:async()=>{requests++;throw new Error('Cancelled');},later:()=>{declines++;}}) as Element;
 assert.equal(requests,0);assert.ok(root.textContent.includes('PIN-код сохранён'));
 await button(root,'Подключить').click();assert.equal(requests,1);assert.ok(root.textContent.includes('Cancelled'));
 assert.equal(button(root,'Не сейчас').disabled,false);
 await button(root,'Не сейчас').click();assert.equal(declines,1);disposePasscodeView();
});
