// Own only a downward drag at the top of an installed app. The page never moves.
export function installPullToRefresh({ enabled, refresh, failed, labels }) {
  const indicator = document.createElement('div');
  indicator.className = 'pull-refresh';
  indicator.hidden = true;
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  const icon = document.createElement('span');
  icon.className = 'pull-refresh-icon';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  indicator.append(icon, text);
  document.body.append(indicator);
  let gesture = null;
  let busy = false;
  const reset = () => {
    gesture = null;
    if (!busy) indicator.hidden = true;
  };
  const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const available = () => installed() && enabled() && !document.querySelector('dialog[open], .viewer');
  const nestedScroll = (target) => {
    for (let el = target; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const css = getComputedStyle(el);
      if ((/(auto|scroll)/.test(css.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
          (/(auto|scroll)/.test(css.overflowX) && el.scrollWidth > el.clientWidth + 1)) return true;
    }
    return false;
  };
  document.addEventListener('touchstart', (event) => {
    reset();
    document.documentElement.classList.toggle('pwa-refresh', installed());
    if (!available() || event.touches.length !== 1 || window.scrollY > 0 ||
        !event.target.closest('main, .topbar') ||
        event.target.closest('input, textarea, select, button, [contenteditable], .nav, .profile-link') || nestedScroll(event.target)) return;
    const touch = event.touches[0];
    gesture = { x: touch.clientX, y: touch.clientY, key: location.hash, captured: false, distance: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (event) => {
    if (!gesture) return;
    if (event.touches.length !== 1 || !available() || gesture.key !== location.hash) { reset(); return; }
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (!gesture.captured) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dy <= 0 || dy < Math.abs(dx) * 1.2 || window.scrollY > 0) { reset(); return; }
      gesture.captured = true;
    }
    if (!event.cancelable) { reset(); return; }
    event.preventDefault(); // Also suppress WebKit's elastic page/header overscroll.
    if (busy) return;
    gesture.distance = Math.max(0, Math.min(88, dy * 0.5));
    indicator.hidden = gesture.distance < 4;
    indicator.style.top = `${Math.max(0, document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 10}px`;
    indicator.classList.toggle('is-ready', gesture.distance >= 60);
    icon.style.transform = `rotate(${gesture.distance * 4}deg)`;
    text.textContent = gesture.distance >= 60 ? labels.release : labels.pull;
  }, { passive: false });
  document.addEventListener('touchend', async (event) => {
    if (event.touches.length) return;
    const ready = gesture?.captured && gesture.distance >= 60 && gesture.key === location.hash;
    reset();
    if (!ready || busy || !available()) return;
    busy = true;
    indicator.hidden = false;
    indicator.classList.add('is-refreshing');
    indicator.setAttribute('aria-busy', 'true');
    icon.style.transform = '';
    text.textContent = labels.refreshing;
    try { await refresh(); } catch (error) { failed(error); }
    finally {
      busy = false;
      indicator.classList.remove('is-refreshing', 'is-ready');
      indicator.setAttribute('aria-busy', 'false');
      reset();
    }
  }, { passive: true });
  document.addEventListener('touchcancel', reset, { passive: true });
  addEventListener('hashchange', () => { gesture = null; indicator.hidden = true; });
  document.documentElement.classList.toggle('pwa-refresh', installed());
}
