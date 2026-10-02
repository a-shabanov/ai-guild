import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

function fixture(mode = 'create') {
 const root = mkdtempSync(join(tmpdir(), 'ai-guild-release-test-'));
 mkdirSync(join(root,'scripts'));mkdirSync(join(root,'docs/releases'),{recursive:true});
 copyFileSync(new URL('../../scripts/releases.mjs',import.meta.url),join(root,'scripts/releases.mjs'));
 const git = (...args:string[]) => execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','--quiet');git('config','user.name','Release fixture');git('config','user.email','release@example.test');
 const commits:string[]=[];
 for (const [version,build] of [['0.3.2',10],['0.3.3',11]] as const) {
  writeFileSync(join(root,'version.json'),JSON.stringify({version,build}));
  git('add','version.json');git('commit','--quiet','-m',`version ${version}`);commits.push(git('rev-parse','HEAD'));
  writeFileSync(join(root,`docs/releases/v${version}.md`),`Changes in ${version}.\nValidation and limitations.`);
 }
 writeFileSync(join(root,'docs/releases/index.json'),JSON.stringify([{version:'0.3.2',build:10},{version:'0.3.3',build:11}]));
 const requests=join(root,'requests.json');
 const preload=join(root,'fake-github.mjs');
 writeFileSync(preload,`import {writeFileSync} from 'node:fs';
const calls=[];const commits=${JSON.stringify(commits)};const mode=${JSON.stringify(mode)};
globalThis.fetch=async(url,options={})=>{
 if(!url.startsWith('https://api.github.com/repos/a-shabanov/ai-guild/'))throw new Error('Unexpected destination');
 calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});
 writeFileSync(${JSON.stringify(requests)},JSON.stringify(calls));
 let status=404,body={};
 if(url.includes('/git/ref/tags/')&&mode==='collision'){status=200;body={object:{type:'commit',sha:'wrong'}};}
 if(url.includes('/releases/tags/')&&mode==='existing'){status=200;body={html_url:'https://github.com/a-shabanov/ai-guild/releases/tag/existing'};}
 if(options.method==='POST') {status=201;body={html_url:'https://github.com/a-shabanov/ai-guild/releases/tag/'+JSON.parse(options.body).tag_name};}
 return new Response(JSON.stringify(body),{status});
};`);
 return {root,commits,git,
  run:(publish=false)=>spawnSync(process.execPath,['--import',preload,'scripts/releases.mjs',...(publish?['--publish']:[])],
   {cwd:root,encoding:'utf8',env:{...process.env,GITHUB_TOKEN:'fixture-only',GITHUB_REPOSITORY:'a-shabanov/ai-guild'}}),
  calls:()=>JSON.parse(readFileSync(requests,'utf8')),
  cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('release dry run resolves exact historical version/build commits without contacting GitHub',()=>{
 const f=fixture();try {const r=f.run();assert.equal(r.status,0,r.stderr);assert(r.stdout.includes(f.commits[0]));assert(r.stdout.includes(f.commits[1]));}
 finally{f.cleanup();}
});
test('publishing uses immutable version commits and makes only the last release latest',()=>{
 const f=fixture();try {const r=f.run(true);assert.equal(r.status,0,r.stderr);const created=f.calls().filter((call:any)=>call.method==='POST');
 assert.equal(created.length,2);assert.equal(created[0].body.target_commitish,f.commits[0]);
 assert.equal(created[1].body.target_commitish,f.commits[1]);assert.equal(created[0].body.make_latest,'false');assert.equal(created[1].body.make_latest,'true');}
 finally{f.cleanup();}
});
test('existing releases are preserved; conflicting tags stop publication',()=>{
 const existing=fixture('existing');try{assert.equal(existing.run(true).status,0);assert.equal(existing.calls().filter((call:any)=>call.method==='POST').length,0);}finally{existing.cleanup();}
 const collision=fixture('collision');try{const r=collision.run(true);assert.notEqual(r.status,0);assert.match(r.stderr,/refusing to move/);assert.equal(collision.calls().filter((call:any)=>call.method==='POST').length,0);}finally{collision.cleanup();}
});
test('missing committed build or empty notes fail the whole batch before mutation',()=>{
 const f=fixture();try{writeFileSync(join(f.root,'docs/releases/v0.3.3.md'),'');const r=f.run(true);assert.notEqual(r.status,0);assert.match(r.stderr,/Empty release notes/);}
 finally{f.cleanup();}
 const mismatch=fixture();try{writeFileSync(join(mismatch.root,'version.json'),JSON.stringify({version:'0.3.4',build:12}));const r=mismatch.run(true);assert.notEqual(r.status,0);assert.match(r.stderr,/notes are missing/);}
 finally{mismatch.cleanup();}
});
