// 模型纪元 · 与数据无关的界面交互：外观切换、顶栏状态、滚动定位、入场动效、时间地图拖拽、快捷键。
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- 外观切换：跟随系统 → 浅色 → 深色 ----------
const THEMES = [['auto', '◐', '外观：跟随系统'], ['light', '☀', '外观：浅色'], ['dark', '☾', '外观：深色']];
const readTheme = () => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } };
const saveTheme = (value) => { try { value === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', value); } catch { /* 存不了就只在本次生效 */ } };

function initTheme(button) {
  if (!button) return;
  const paint = (value) => {
    const [, icon, label] = THEMES.find(([key]) => key === value) || THEMES[0];
    button.textContent = icon; button.title = label; button.setAttribute('aria-label', label);
  };
  paint(readTheme());
  button.addEventListener('click', () => {
    const next = THEMES[(THEMES.findIndex(([key]) => key === readTheme()) + 1) % THEMES.length][0];
    if (next === 'auto') delete root.dataset.theme; else root.dataset.theme = next;
    saveTheme(next); paint(next);
  });
}

// ---------- 顶栏：滚动后加底线；导航高亮当前版块 ----------
function initHeader(header) {
  if (!header) return;
  const onScroll = () => header.classList.toggle('stuck', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  const links = [...header.querySelectorAll('nav a[href^="#"]')];
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  if (!sections.length || !('IntersectionObserver' in window)) return;
  const visible = new Map();
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((entry) => visible.set(entry.target.id, entry.isIntersecting));
    const current = sections.find((s) => visible.get(s.id));
    links.forEach((a) => (current && a.getAttribute('href') === `#${current.id}` ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
  }, { rootMargin: '-35% 0px -55% 0px' });
  sections.forEach((s) => spy.observe(s));
}

// ---------- 版块入场 ----------
function initReveal(targets) {
  if (reduced || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('in'); io.unobserve(entry.target);
  }), { rootMargin: '0px 0px -8% 0px' });
  targets.forEach((el) => {
    if (el.getBoundingClientRect().top < innerHeight) return; // 首屏内容不藏
    el.classList.add('rv'); io.observe(el);
  });
}

// ---------- 时间地图：按住拖动，松手带一点惯性 ----------
function initDragScroll(el) {
  if (!el) return;
  let startX = 0, startLeft = 0, lastX = 0, velocity = 0, moved = false, pointer = null, frame = 0;
  const glide = () => {
    if (Math.abs(velocity) < 0.4) return;
    el.scrollLeft -= velocity; velocity *= 0.94; frame = requestAnimationFrame(glide);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return; // 触屏交给原生滚动
    cancelAnimationFrame(frame);
    pointer = e.pointerId; startX = lastX = e.clientX; startLeft = el.scrollLeft; velocity = 0; moved = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < 5) return;
    if (!moved) { moved = true; el.classList.add('drag'); el.setPointerCapture(pointer); }
    velocity = e.clientX - lastX; lastX = e.clientX; el.scrollLeft = startLeft - dx;
  });
  const end = (e) => {
    if (e.pointerId !== pointer) return;
    pointer = null; el.classList.remove('drag');
    if (moved && !reduced) frame = requestAnimationFrame(glide);
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  // 拖动结束时落在节点上，不当成点击
  el.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}

// ---------- 快捷键：/ 聚焦搜索 ----------
function initShortcuts(search) {
  if (!search) return;
  addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
    e.preventDefault(); search.focus(); search.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  });
}

initTheme(document.querySelector('#theme'));
initHeader(document.querySelector('header'));
initReveal([...document.querySelectorAll('main > section, .prose > h2')]);
initDragScroll(document.querySelector('#sc'));
initShortcuts(document.querySelector('#q'));
