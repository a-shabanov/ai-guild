// Visited tabs live in memory, including their controls and scroll position.
// Nothing private is persisted across sessions.
export function createNavigation({ load, show, loading, error, changed, getScroll, setScroll,
  cacheable, limit = 8 }) {
  const cache = new Map();
  let active = null;
  let generation = 0;

  function forget(entry) {
    if (cache.get(entry.key) === entry) cache.delete(entry.key);
  }
  function remember(entry) {
    if (!cacheable(entry.key)) return;
    cache.delete(entry.key);
    cache.set(entry.key, entry);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  }
  function mount(entry, restoring = false) {
    if (active !== entry) return;
    const top = restoring ? entry.scroll : getScroll();
    show(entry.view);
    setScroll(top);
    changed(entry);
  }
  function build(entry) {
    if (entry.pending) return entry.pending;
    const started = generation;
    const context = {
      isActive: () => active === entry && generation === started,
      setPoll: (poll) => { entry.poll = poll; },
      setTitle: (title) => {
        entry.title = title;
        if (context.isActive()) changed(entry);
      },
      failed: false,
    };
    entry.pending = Promise.resolve().then(() => load(entry.key, context)).then((view) => {
      if (generation !== started) return;
      entry.view = view;
      if (context.failed) forget(entry);
      mount(entry);
    }).catch((err) => {
      if (generation !== started) return;
      // A failed background update must not discard an already readable tab.
      if (entry.view) return;
      forget(entry);
      entry.view = error(entry.key, err);
      mount(entry);
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  }
  function refreshEntry(entry, rebuild = false) {
    if (!entry || entry.pending) return entry?.pending;
    if (!entry.poll) return rebuild ? build(entry) : undefined;
    if (entry.refreshing) return entry.refreshing;
    entry.refreshing = Promise.resolve().then(entry.poll).finally(() => { entry.refreshing = null; });
    return entry.refreshing;
  }
  return {
    navigate(key, { reload = false } = {}) {
      const previous = active;
      if (previous) previous.scroll = getScroll();
      let entry = reload ? null : cache.get(key);
      if (!entry) {
        entry = { key, view: null, scroll: 0, title: 'AI Guild', poll: null, pending: null };
        // Explicit refreshes retain the current screen until its replacement is ready.
        if (previous?.key === key) {
          entry.view = previous.view;
          entry.scroll = previous.scroll;
        }
        remember(entry);
      } else remember(entry);
      active = entry;
      changed(entry);
      if (entry.view) mount(entry, true);
      else { loading(key); setScroll(0); }
      return entry.view && !reload ? refreshEntry(entry, true) : build(entry);
    },
    refresh() { return refreshEntry(active); },
    clear() {
      ++generation;
      cache.clear();
      active = null;
      changed(null);
    },
  };
}
