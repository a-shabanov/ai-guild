/** Classify the actual launch mode, including iPadOS's desktop user agent. */
export function classifyClient({userAgent,touchPoints,standalone}) {
  const platform=/iPhone|iPad/.test(userAgent)||(/Macintosh/.test(userAgent)&&touchPoints>1)?'ios':
    /Android/.test(userAgent)?'android':/Macintosh|Mac OS/.test(userAgent)?'macos':/Windows/.test(userAgent)?'windows':/Linux/.test(userAgent)?'linux':'unknown';
  const mobile=platform==='ios'||platform==='android'||/Mobile/.test(userAgent);
  return {platform,client_type:standalone?(mobile?'mobile_pwa':'desktop_pwa'):(mobile?'mobile_browser':'desktop_browser')};
}
