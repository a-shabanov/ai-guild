import * as i18n from './i18n.js';

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(value => value != null));
  return node;
};
let cleanup = () => {};
export function disposePasscodeView() { cleanup(); cleanup = () => {}; }

// Inline SVGs avoid a font dependency and keep the keypad clear at every display density.
export function biometricIcon(touch = false) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('aria-hidden', 'true');
  for (const data of touch ? [
    'M7 13a9 9 0 0 1 18 0v6m-22-6a13 13 0 0 1 26 0',
    'M11 14a5 5 0 0 1 10 0v5c0 5-2 8-4 10M15 14v5c0 4-1 7-3 10',
    'M7 17v3c0 3-1 6-2 8M11 18v2c0 3-1 5-2 7M25 22c0 3-1 6-2 8',
  ] : [
    'M3 11V7a4 4 0 0 1 4-4h4m10 0h4a4 4 0 0 1 4 4v4m0 10v4a4 4 0 0 1-4 4h-4m-10 0H7a4 4 0 0 1-4-4v-4',
    'M10 11v3m12-3v3m-6-3v8h-3m-3 3c4 3 8 3 12 0',
  ]) {
    const path = document.createElementNS(ns, 'path'); path.setAttribute('d', data);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6'); path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
  }
  return svg;
}

export function passcodeView({ mode = 'unlock', biometric = false, available = false, biometricName = 'passkey', touch = false,
  submit, unlockBiometric, cancel, autoBiometric = false, initialError = '', initialBiometric = false }) {
  disposePasscodeView();
  const controller = new AbortController();
  let digits = '', first = '', current = '', busy = false;
  let step = mode === 'change' || mode === 'biometric' ? 'current' : mode === 'setup' ? 'new' : 'unlock';
  const title = el('h1');
  const subtitle = el('p', { class: 'muted passcode-subtitle' }, i18n.t(mode === 'unlock' ? 'Разблокировать приложение' : 'Шесть цифр для доступа на этом устройстве'));
  const dots = el('div', { class: 'passcode-dots', role: 'status', 'aria-live': 'polite' });
  const error = el('p', { class: 'error passcode-error', role: 'alert' }, initialError);
  const enabled = el('input', { type: 'checkbox' }); enabled.checked = initialBiometric;
  const choice = el('label', { class: 'passcode-choice' }, enabled, i18n.t`Быстрая разблокировка через ${biometricName}`);
  const keys = el('div', { class: 'passcode-keypad', 'aria-label': i18n.t('Цифровая клавиатура') });
  const back = el('button', { type: 'button', class: 'passcode-action', 'aria-label': i18n.t('Удалить цифру'), onclick: () => { if (!busy) { digits = digits.slice(0,-1); paint(); } } }, '⌫');
  const bio = el('button', { type: 'button', class: 'passcode-action', 'aria-label': i18n.t`Разблокировать через ${biometricName}`, onclick: () => runBiometric() }, biometricIcon(touch));
  if (!biometric || mode !== 'unlock') { bio.style.visibility = 'hidden'; bio.disabled = true; }
  const buttons = [];
  const addDigit = value => {
    if (busy || digits.length >= 6) return;
    digits += value; error.textContent = ''; paint();
    if (digits.length === 6) complete();
  };
  for (const value of ['1','2','3','4','5','6','7','8','9']) {
    const button = el('button', { type: 'button', class: 'passcode-digit', onclick: () => addDigit(value) }, value);
    buttons.push(button); keys.append(button);
  }
  const zero = el('button', { type:'button',class:'passcode-digit',onclick:()=>addDigit('0') }, '0'); buttons.push(zero);
  keys.append(bio,zero,back);
  const cancelButton = el('button', { type:'button',class:'ghost passcode-cancel',onclick:()=>{ if(!busy) cancel(); } }, i18n.t(mode === 'unlock' ? 'Забыли код-пароль?' : mode === 'setup' ? 'Выйти из аккаунта' : 'Отмена'));
  const root = el('main', { class: 'passcode-screen' }, el('section', { class:'passcode-panel' },
    el('img', {src:'/icons/favicon-32.png?v=c76fb7f1fa02',alt:'',class:'passcode-brand-icon'}),
    el('div', {class:'passcode-brand'}, 'AI Guild'), title, subtitle, dots, error,
    ...(available && (mode === 'setup' || mode === 'change' || mode === 'biometric') ? [choice] : []), keys, cancelButton));
  function paint() {
    title.textContent = i18n.t(({unlock:'Введите код-пароль',new:'Создайте код-пароль',confirm:'Повторите код-пароль',current:'Введите текущий код-пароль'})[step]);
    dots.replaceChildren(...Array.from({length:6},(_,index)=>el('span',{class:index<digits.length?'filled':''})));
    dots.setAttribute('aria-label',i18n.t`Введено ${digits.length} из шести цифр`);
    for(const button of buttons)button.disabled=busy;
    back.disabled=busy||!digits.length; cancelButton.disabled=busy; enabled.disabled=busy;
    if(biometric && mode==='unlock')bio.disabled=busy;
    root.setAttribute('aria-busy',String(busy));
  }
  async function complete() {
    if(step==='new'){first=digits;digits='';step='confirm';paint();return;}
    if(step==='confirm' && first!==digits){digits='';error.textContent=i18n.t('Коды не совпадают. Повторите код-пароль');paint();return;}
    busy=true;paint();
    try {
      if(step==='current' && mode==='change') {
        await submit({action:'verify',code:digits}); current=digits; digits='';step='new';
      } else {
        await submit({code:step==='confirm'?first:digits,current_code:current||undefined,biometric:enabled.checked});
      }
    } catch(failure) {
      if(!controller.signal.aborted)error.textContent=failure.message;
    } finally {busy=false;digits='';if(!controller.signal.aborted)paint();}
  }
  async function runBiometric() {
    if(busy || !biometric || mode!=='unlock')return;
    busy=true;error.textContent='';paint();
    try{await unlockBiometric();}catch(failure){if(!controller.signal.aborted)error.textContent=failure.message;}
    finally{busy=false;digits='';if(!controller.signal.aborted)paint();}
  }
  document.addEventListener('keydown',event=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.target===enabled)return;
    if(/^[0-9]$/.test(event.key)){event.preventDefault();addDigit(event.key);}
    else if(event.key==='Backspace'){event.preventDefault();if(!busy){digits=digits.slice(0,-1);paint();}}
  },{signal:controller.signal});
  const auto = autoBiometric && biometric ? setTimeout(()=>{if(root.isConnected)runBiometric();},300) : null;
  cleanup=()=>{controller.abort();clearTimeout(auto);};
  paint();return root;
}
