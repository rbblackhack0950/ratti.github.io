(() => {
  'use strict';
  const MAX = 8;
  const KEY = 'multikick.channels';
  const $ = (id) => document.getElementById(id);
  const grid = $('grid'), input = $('add-input');
  let channels = [];
  let audio = null;   // channel with sound on
  let maxed = null;   // channel shown fullscreen

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} },
  };

  // Accepts "https://kick.com/name", "kick.com/name/...", or a bare name.
  function parse(text) {
    const m = text.trim().match(/^(?:https?:\/\/)?(?:www\.|player\.)?kick\.com\/(?:video\/)?([\w-]+)/i);
    const name = (m ? m[1] : text.trim()).toLowerCase();
    return /^[\w-]{1,25}$/.test(name) ? name : null;
  }

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('on'), 2200);
  }

  function layout() {
    const n = channels.length;
    const portrait = innerHeight > innerWidth;
    let cols = n <= 1 ? 1 : n <= 2 ? (portrait ? 1 : 2) : n <= 4 ? 2 : (portrait ? 2 : 4);
    if (!portrait && n > 4) cols = 4;
    const rows = Math.ceil(n / cols) || 1;
    grid.style.setProperty('--cols', cols);
    grid.style.setProperty('--rows', rows);
  }

  function src(name, muted) {
    return `https://player.kick.com/${encodeURIComponent(name)}?autoplay=true&muted=${muted}`;
  }

  function makeCell(name) {
    const el = document.createElement('div');
    el.className = 'cell'; el.dataset.name = name;
    el.innerHTML = `
      <div class="tools">
        <span class="name"></span>
        <button class="snd" title="เปิดเสียงช่องนี้">🔊</button>
        <button class="left" title="เลื่อนก่อนหน้า">◀</button>
        <button class="right" title="เลื่อนถัดไป">▶</button>
        <button class="chat" title="เปิดแชทในแท็บใหม่">💬</button>
        <button class="max" title="เต็มจอ">⛶</button>
        <button class="rm" title="ลบ">✕</button>
      </div>
      <iframe allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe>`;
    el.querySelector('.name').textContent = name;
    const f = el.querySelector('iframe');
    f.title = name; f.src = src(name, true);
    // Touch: first tap shows controls (iframe swallows taps, so use an overlay-free approach via focus tap on cell border/tools).
    return el;
  }

  function render(rebuild) {
    if (rebuild) {
      grid.textContent = '';
      channels.forEach((c) => grid.appendChild(makeCell(c)));
    }
    layout();
    [...grid.children].forEach((el) => {
      el.classList.toggle('audio', el.dataset.name === audio);
      el.classList.toggle('max', el.dataset.name === maxed);
    });
    $('count').textContent = `${channels.length}/${MAX}`;
    $('empty').hidden = channels.length > 0;
    store.set(channels);
  }

  function add(text) {
    const names = text.split(/[\s,]+/).filter(Boolean).map(parse);
    let added = 0, bad = 0, dup = 0, full = 0;
    for (const n of names) {
      if (!n) bad++;
      else if (channels.includes(n)) dup++;
      else if (channels.length >= MAX) full++;
      else { channels.push(n); added++; }
    }
    if (added) render(true);
    const notes = [];
    if (added) notes.push(`เพิ่ม ${added} ช่อง`);
    if (dup) notes.push(`ซ้ำ ${dup}`);
    if (bad) notes.push(`ลิงก์ไม่ถูกต้อง ${bad}`);
    if (full) notes.push(`เต็ม ${MAX} ช่อง`);
    if (notes.length) toast(notes.join(' · '));
  }

  function setAudio(name) {
    audio = audio === name ? null : name;
    // Reload only the two affected iframes so other streams keep playing.
    [...grid.children].forEach((el) => {
      const n = el.dataset.name;
      if (n === name || el.classList.contains('audio')) {
        el.querySelector('iframe').src = src(n, n === audio ? 'false' : 'true');
      }
    });
    render(false);
  }

  function move(name, d) {
    const i = channels.indexOf(name), j = i + d;
    if (j < 0 || j >= channels.length) return;
    [channels[i], channels[j]] = [channels[j], channels[i]];
    render(true);
  }

  grid.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const name = b.closest('.cell').dataset.name;
    if (b.classList.contains('snd')) setAudio(name);
    else if (b.classList.contains('left')) move(name, -1);
    else if (b.classList.contains('right')) move(name, 1);
    else if (b.classList.contains('chat')) window.open(`https://kick.com/${name}/chatroom`, '_blank', 'noopener');
    else if (b.classList.contains('max')) { maxed = maxed === name ? null : name; render(false); }
    else if (b.classList.contains('rm')) {
      channels = channels.filter((c) => c !== name);
      if (audio === name) audio = null;
      if (maxed === name) maxed = null;
      render(true);
    }
  });

  // On touch screens the iframe captures taps, so show controls on a tap at the very top edge strip
  // and via a long-press-free toggle: tapping a cell border area. Simplest reliable option: always show tools on touch.
  if (matchMedia('(hover: none)').matches) {
    const style = document.createElement('style');
    style.textContent = '.tools{opacity:.85;pointer-events:none}.tools button{pointer-events:auto}.tools .name{pointer-events:none}';
    document.head.appendChild(style);
  }

  $('add-form').addEventListener('submit', (e) => { e.preventDefault(); add(input.value); input.value = ''; });
  input.addEventListener('paste', () => setTimeout(() => { if (/\s|,/.test(input.value.trim())) { add(input.value); input.value = ''; } }));
  $('clear').addEventListener('click', () => {
    if (channels.length && confirm('ลบทุกช่อง?')) { channels = []; audio = maxed = null; render(true); }
  });
  $('share').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?c=${channels.join(',')}`;
    try { await navigator.clipboard.writeText(url); toast('คัดลอกลิงก์แล้ว'); } catch { prompt('คัดลอกลิงก์:', url); }
  });
  $('hide-bar').addEventListener('click', () => { $('bar').hidden = true; $('show-bar').hidden = false; layout(); });
  $('show-bar').addEventListener('click', () => { $('bar').hidden = false; $('show-bar').hidden = true; });
  addEventListener('resize', layout);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && maxed) { maxed = null; render(false); } });

  const q = new URLSearchParams(location.search).get('c');
  channels = [];
  (q ? q.split(',') : store.get()).forEach((t) => { const n = parse(t); if (n && !channels.includes(n) && channels.length < MAX) channels.push(n); });
  render(true);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
