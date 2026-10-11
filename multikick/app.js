(() => {
  'use strict';
  const MAX = 25;
  const HEAVY = 9;                       // warn about bandwidth above this many streams
  const KEY = 'multikick.v2';
  const OLD_KEY = 'multikick.channels';  // v1 stored just the channel array
  const $ = (s) => document.querySelector(s);
  const grid = $('#grid');

  // Everything here is persisted, so reopening the app restores the same screens in the same order.
  const state = { channels: [], layout: 'grid', main: null, favorites: [], sets: [] };
  let audio = null;     // channel with sound on (session only: browsers block unmuted autoplay)
  let maxed = null;     // channel shown fullscreen
  let sheetFor = null;  // channel whose action sheet is open
  const cells = new Map();

  // ---------- helpers ----------
  // Accepts "https://kick.com/name", "kick.com/name/...", "player.kick.com/name" or a bare name.
  function parse(text) {
    const t = String(text || '').trim();
    const m = t.match(/^(?:https?:\/\/)?(?:www\.|player\.|m\.)?kick\.com\/(?:popout\/)?([\w-]+)/i);
    const name = (m ? m[1] : t).toLowerCase();
    return /^[\w-]{1,30}$/.test(name) ? name : null;
  }
  const uniq = (list, limit = Infinity) => {
    const out = [];
    for (const x of list || []) { const n = parse(x); if (n && !out.includes(n) && out.length < limit) out.push(n); }
    return out;
  };
  const src = (name, muted) => `https://player.kick.com/${encodeURIComponent(name)}?autoplay=true&muted=${muted}`;
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('on'), 2400);
  }

  // ---------- persistence ----------
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && typeof s === 'object') Object.assign(state, s);
      else state.channels = JSON.parse(localStorage.getItem(OLD_KEY)) || [];
    } catch { /* private mode or corrupt data: start empty */ }
    const q = new URLSearchParams(location.search);
    if (q.get('c')) {
      state.channels = q.get('c').split(',');
      state.layout = q.get('l') || state.layout;
      state.main = q.get('m') || null;
      history.replaceState(null, '', location.href.split(/[?#]/)[0]);
    }
    state.channels = uniq(state.channels, MAX);
    state.favorites = uniq(state.favorites);
    state.layout = state.layout === 'focus' ? 'focus' : 'grid';
    state.main = parse(state.main);
    state.sets = (Array.isArray(state.sets) ? state.sets : [])
      .filter((s) => s && s.name)
      .map((s) => ({ name: String(s.name).slice(0, 40), channels: uniq(s.channels, MAX),
        layout: s.layout === 'focus' ? 'focus' : 'grid', main: parse(s.main) }));
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable */ } }

  // ---------- video cells ----------
  // A cell's iframe is never moved in the DOM (moving reloads the stream);
  // order and size are set with CSS grid placement instead.
  function makeCell(name) {
    const more = el('button', { type: 'button', className: 'more', title: 'ตัวเลือก', textContent: '⋯' });
    more.dataset.name = name;
    const exit = el('button', { type: 'button', className: 'exit-max', textContent: 'ออกจากเต็มจอ ✕' });
    exit.dataset.name = name;
    const frame = el('iframe', { title: name, src: src(name, true), allowFullscreen: true, referrerPolicy: 'no-referrer' });
    frame.allow = 'autoplay; fullscreen; picture-in-picture';
    const cell = el('div', { className: 'cell' },
      frame,
      el('div', { className: 'ov' }, el('span', { className: 'tag' }, el('span', { className: 'snd-ic', textContent: '🔊 ' }), name), more),
      exit);
    cell.dataset.name = name;
    return cell;
  }
  const frameOf = (name) => cells.get(name)?.querySelector('iframe');
  const reload = (name) => { const f = frameOf(name); if (f) f.src = src(name, name !== audio); };

  // Picks the arrangement that shows the most 16:9 video.
  function layout() {
    const n = state.channels.length;
    const W = grid.clientWidth - 8, H = grid.clientHeight - 8;
    cells.forEach((c) => { c.style.gridColumn = ''; c.style.gridRow = ''; });
    if (!n || W <= 0 || H <= 0) return;
    const fitW = (w, h) => Math.min(w, (h * 16) / 9);  // width of a 16:9 video fitted in w x h
    let best = null;
    if (state.layout === 'focus' && n > 1) {
      // Unit grid C x R; the main screen spans a x b cells at top-left, small screens fill the rest.
      // The main screen keeps at least 65% of the full-screen video width; within that,
      // small screens are made as large as possible, then wasted cells minimised.
      const k = n - 1, full = fitW(W, H);
      for (let C = 1; C <= 9; C++) for (let R = 1; R <= 9; R++) {
        const t = Math.round(fitW(W / C, H / R));
        for (let a = 1; a <= C; a++) for (let b = 1; b <= R; b++) {
          const free = C * R - a * b, m = Math.round(fitW((a * W) / C, (b * H) / R));
          if (free < k || m < 0.65 * full || m < 1.5 * t) continue;
          const waste = free - k;
          if (!best || t > best.t || (t === best.t && (waste < best.waste || (waste === best.waste && m > best.m)))) {
            best = { C, R, a, b, t, m, waste };
          }
        }
      }
    }
    if (!best) {
      for (let C = 1; C <= n; C++) {
        const R = Math.ceil(n / C);
        const score = fitW(W / C, H / R) - (C * R - n) * 0.01;
        if (!best || score > best.score) best = { C, R, score };
      }
    }
    grid.style.gridTemplateColumns = `repeat(${best.C}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${best.R}, minmax(0, 1fr))`;
    if (best.a) {
      const m = cells.get(state.main);
      m.style.gridColumn = `1 / span ${best.a}`;
      m.style.gridRow = `1 / span ${best.b}`;
    }
  }

  // ---------- rendering ----------
  function render() {
    if (!state.channels.includes(state.main)) state.main = state.channels[0] || null;
    if (!state.channels.includes(audio)) audio = null;
    if (!state.channels.includes(maxed)) maxed = null;
    for (const [n, c] of cells) if (!state.channels.includes(n)) { c.remove(); cells.delete(n); }
    state.channels.forEach((n, i) => {
      let c = cells.get(n);
      if (!c) { c = makeCell(n); cells.set(n, c); grid.appendChild(c); }
      c.style.order = i;
      c.classList.toggle('audio', n === audio);
      c.classList.toggle('max', n === maxed);
    });
    layout();
    document.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('on', b.dataset.layout === state.layout));
    $('#count').textContent = `${state.channels.length}/${MAX}`;
    $('#d-count').textContent = `(${state.channels.length}/${MAX})`;
    $('#empty').hidden = state.channels.length > 0;
    grid.hidden = !state.channels.length;
    renderList();
    renderFavs();
    renderSets();
    if (sheetFor) renderSheet();
    save();
  }

  function iconBtn(act, name, text, title, on = false, disabled = false) {
    const b = el('button', { type: 'button', textContent: text, title, disabled, className: on ? 'on' : '' });
    b.dataset.act = act; b.dataset.name = name;
    return b;
  }

  function renderList() {
    const list = $('#d-list'); list.textContent = '';
    const last = state.channels.length - 1;
    state.channels.forEach((n, i) => {
      list.append(el('li', {},
        el('span', { className: 'idx', textContent: i + 1 }),
        el('span', { className: 'nm', textContent: n }),
        iconBtn('main', n, '◧', 'ตั้งเป็นจอหลัก', state.layout === 'focus' && n === state.main),
        iconBtn('sound', n, n === audio ? '🔊' : '🔈', 'เปิด/ปิดเสียง', n === audio),
        iconBtn('fav', n, state.favorites.includes(n) ? '★' : '☆', 'ช่องโปรด'),
        iconBtn('left', n, '▲', 'เลื่อนขึ้น', false, i === 0),
        iconBtn('right', n, '▼', 'เลื่อนลง', false, i === last),
        iconBtn('rm', n, '✕', 'ลบ')));
    });
    if (!state.channels.length) list.append(el('li', { className: 'hint', textContent: 'ยังไม่มีช่อง' }));
  }

  function favChips(box) {
    box.textContent = '';
    for (const n of state.favorites) {
      const t = el('button', { type: 'button', textContent: n, title: 'เปิด/ปิดบนจอ' }); t.dataset.favToggle = n;
      const x = el('button', { type: 'button', className: 'x', textContent: '✕', title: 'เอาออกจากช่องโปรด' }); x.dataset.favDel = n;
      box.append(el('span', { className: `chip${state.channels.includes(n) ? ' on' : ''}` }, t, x));
    }
    if (!state.favorites.length) box.append(el('span', { className: 'hint', textContent: 'ยังไม่มี กด ☆ ที่ช่องเพื่อเพิ่ม' }));
  }
  function renderFavs() {
    favChips($('#fav-list'));
    favChips($('#empty-favs'));
    $('#empty-favs-wrap').hidden = !state.favorites.length;
    $('#fav-all').hidden = !state.favorites.length;
  }

  function setRows(box) {
    box.textContent = '';
    state.sets.forEach((s, i) => {
      const load = el('button', { type: 'button' }, s.name, ' ',
        el('small', { textContent: `${s.channels.length} ช่อง · ${s.layout === 'focus' ? 'จอหลัก' : 'เท่ากัน'}` }));
      load.dataset.setLoad = i;
      const del = el('button', { type: 'button', className: 'danger', textContent: '✕', title: 'ลบชุดนี้' });
      del.dataset.setDel = i;
      box.append(el('li', {}, load, del));
    });
  }
  function renderSets() {
    setRows($('#set-list'));
    setRows($('#empty-sets'));
    $('#empty-sets-wrap').hidden = !state.sets.length;
  }

  function renderSheet() {
    const n = sheetFor;
    if (!state.channels.includes(n)) return closePanels();
    $('#sheet-title').textContent = n;
    $('#sheet').querySelectorAll('[data-act]').forEach((b) => { b.dataset.name = n; });
    $('#sheet [data-act="sound"]').textContent = n === audio ? '🔇 ปิดเสียงช่องนี้' : '🔊 เปิดเสียงช่องนี้';
    $('#sheet [data-act="fav"]').textContent = state.favorites.includes(n) ? '★ เอาออกจากช่องโปรด' : '☆ เพิ่มเป็นช่องโปรด';
    $('#sheet [data-act="max"]').textContent = n === maxed ? '⛶ ออกจากเต็มจอ' : '⛶ เต็มจอ';
    const i = state.channels.indexOf(n);
    $('#sheet [data-act="left"]').disabled = i === 0;
    $('#sheet [data-act="right"]').disabled = i === state.channels.length - 1;
  }

  // ---------- actions ----------
  function add(text) {
    const before = state.channels.length;
    let added = 0, bad = 0, dup = 0, full = 0;
    for (const raw of String(text).split(/[\s,]+/).filter(Boolean)) {
      const n = parse(raw);
      if (!n) bad++;
      else if (state.channels.includes(n)) dup++;
      else if (state.channels.length >= MAX) full++;
      else { state.channels.push(n); added++; }
    }
    if (added) render();
    const notes = [];
    if (added) notes.push(`เพิ่ม ${added} ช่อง`);
    if (dup) notes.push(`มีอยู่แล้ว ${dup}`);
    if (bad) notes.push(`ลิงก์ไม่ถูกต้อง ${bad}`);
    if (full) notes.push(`เต็ม ${MAX} ช่องแล้ว`);
    if (before <= HEAVY && state.channels.length > HEAVY) notes.push('เปิดหลายช่องจะใช้เน็ตและแบตมาก');
    if (notes.length) toast(notes.join(' · '));
  }

  function setAudio(name) {
    const prev = audio;
    audio = prev === name ? null : name;
    if (prev) reload(prev);
    if (audio) reload(audio);
    render();
  }

  // Reloads every player muted: also silences channels unmuted from inside Kick's own player.
  function muteAll() {
    if (!state.channels.length) return;
    audio = null;
    state.channels.forEach(reload);
    render();
    toast('ปิดเสียงทุกช่องแล้ว');
  }

  function move(name, d) {
    const i = state.channels.indexOf(name), j = i + d;
    if (i < 0 || j < 0 || j >= state.channels.length) return;
    [state.channels[i], state.channels[j]] = [state.channels[j], state.channels[i]];
    render();
  }

  function remove(name) {
    state.channels = state.channels.filter((c) => c !== name);
    render();
  }

  function toggleFav(name) {
    state.favorites = state.favorites.includes(name)
      ? state.favorites.filter((f) => f !== name)
      : [...state.favorites, name];
    render();
  }

  function act(action, name) {
    switch (action) {
      case 'sound': setAudio(name); break;
      case 'main': state.main = name; state.layout = 'focus'; maxed = null; render(); break;
      case 'max': maxed = maxed === name ? null : name; closePanels(); render(); break;
      case 'fav': toggleFav(name); break;
      case 'left': move(name, -1); break;
      case 'right': move(name, 1); break;
      case 'reload': reload(name); toast(`โหลด ${name} ใหม่`); break;
      case 'chat': window.open(`https://kick.com/popout/${name}/chat`, '_blank', 'noopener'); break;
      case 'open': window.open(`https://kick.com/${name}`, '_blank', 'noopener'); break;
      case 'rm': remove(name); break;
    }
  }

  function saveSet() {
    if (!state.channels.length) return toast('ยังไม่มีช่องบนจอ');
    const name = (prompt('ตั้งชื่อชุดนี้', `ชุดที่ ${state.sets.length + 1}`) || '').trim().slice(0, 40);
    if (!name) return;
    const set = { name, channels: [...state.channels], layout: state.layout, main: state.main };
    const i = state.sets.findIndex((s) => s.name === name);
    if (i >= 0) state.sets[i] = set; else state.sets.push(set);
    render();
    toast(`บันทึก "${name}" แล้ว`);
  }

  function loadSet(i) {
    const s = state.sets[i]; if (!s) return;
    Object.assign(state, { channels: [...s.channels], layout: s.layout, main: s.main });
    maxed = null;
    closePanels();
    render();
    toast(`เปิดชุด "${s.name}"`);
  }

  // ---------- panels ----------
  function openPanel(id) {
    $('#backdrop').hidden = false;
    $(id).hidden = false;
  }
  function closePanels() {
    sheetFor = null;
    ['#backdrop', '#drawer', '#sheet'].forEach((id) => { $(id).hidden = true; });
  }

  // ---------- events ----------
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('more')) { sheetFor = b.dataset.name; renderSheet(); openPanel('#sheet'); }
    else if (b.classList.contains('exit-max')) { maxed = null; render(); }
  });

  // One handler for the drawer, the action sheet and the empty-state shortcuts.
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || grid.contains(b)) return;
    const d = b.dataset;
    if ('close' in d) closePanels();
    else if (d.act) act(d.act, d.name);
    else if (d.favToggle) { state.channels.includes(d.favToggle) ? remove(d.favToggle) : add(d.favToggle); }
    else if (d.favDel) toggleFav(d.favDel);
    else if (d.setLoad) loadSet(+d.setLoad);
    else if (d.setDel) {
      const s = state.sets[+d.setDel];
      if (s && confirm(`ลบชุด "${s.name}"?`)) { state.sets.splice(+d.setDel, 1); render(); }
    } else if (d.layout) { state.layout = d.layout; maxed = null; render(); }
  });
  $('#backdrop').addEventListener('click', closePanels);

  const input = $('#add-input');
  $('#add-form').addEventListener('submit', (e) => { e.preventDefault(); add(input.value); input.value = ''; });
  input.addEventListener('paste', () => setTimeout(() => {
    if (/\s|,/.test(input.value.trim())) { add(input.value); input.value = ''; }
  }));
  $('#fav-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const names = uniq($('#fav-input').value.split(/[\s,]+/)).filter((n) => !state.favorites.includes(n));
    if (!names.length) return toast('ลิงก์ไม่ถูกต้องหรือมีอยู่แล้ว');
    state.favorites.push(...names);
    $('#fav-input').value = '';
    render();
  });
  $('#fav-all').addEventListener('click', () => add(state.favorites.join(' ')));
  $('#set-save').addEventListener('click', saveSet);
  $('#mute-all').addEventListener('click', muteAll);
  $('#open-drawer').addEventListener('click', () => openPanel('#drawer'));
  $('#clear').addEventListener('click', () => {
    if (state.channels.length && confirm('ลบทุกช่องบนจอ? (ช่องโปรดและชุดที่บันทึกยังอยู่)')) { state.channels = []; closePanels(); render(); }
  });
  $('#share').addEventListener('click', async () => {
    const p = new URLSearchParams({ c: state.channels.join(','), l: state.layout });
    if (state.main) p.set('m', state.main);
    const url = `${location.href.split(/[?#]/)[0]}?${p.toString().replace(/%2C/g, ',')}`;
    try { await navigator.clipboard.writeText(url); toast('คัดลอกลิงก์แล้ว'); } catch { prompt('คัดลอกลิงก์:', url); }
  });
  $('#hide-bar').addEventListener('click', () => { $('#bar').hidden = true; $('#show-bar').hidden = false; });
  $('#show-bar').addEventListener('click', () => { $('#bar').hidden = false; $('#show-bar').hidden = true; });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#backdrop').hidden) closePanels();
    else if (maxed) { maxed = null; render(); }
  });
  new ResizeObserver(layout).observe(grid);

  load();
  render();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
