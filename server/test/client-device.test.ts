import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyClient} from '../public/client-device.js';

test('iPhone Safari becomes mobile PWA only when launched as installed app',()=>{
 const input={userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1',touchPoints:5};
 assert.deepEqual(classifyClient({...input,standalone:false}),{platform:'ios',client_type:'mobile_browser'});
 assert.deepEqual(classifyClient({...input,standalone:true}),{platform:'ios',client_type:'mobile_pwa'});
});
test('iPad with desktop user agent stays mobile, actual Mac stays desktop',()=>{
 const input={userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15',standalone:true};
 assert.deepEqual(classifyClient({...input,touchPoints:5}),{platform:'ios',client_type:'mobile_pwa'});
 assert.deepEqual(classifyClient({...input,touchPoints:0}),{platform:'macos',client_type:'desktop_pwa'});
});
test('Android installed app differs from desktop browser, including touch laptops',()=>{
 assert.deepEqual(classifyClient({userAgent:'Mozilla/5.0 (Linux; Android 16) Chrome Mobile',touchPoints:5,standalone:true}),{platform:'android',client_type:'mobile_pwa'});
 assert.deepEqual(classifyClient({userAgent:'Mozilla/5.0 (Windows NT 10.0) Chrome',touchPoints:10,standalone:false}),{platform:'windows',client_type:'desktop_browser'});
});
