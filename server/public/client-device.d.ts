export function classifyClient(input:{userAgent:string;touchPoints:number;standalone:boolean}): {
  platform:'ios'|'android'|'macos'|'windows'|'linux'|'unknown';
  client_type:'mobile_pwa'|'desktop_pwa'|'mobile_browser'|'desktop_browser';
};
