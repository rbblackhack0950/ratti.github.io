(() => {
  'use strict';
  const MAX = 25;
  const HEAVY = 9;                       // warn about bandwidth above this many streams
  const POLL_MS = 60000;                 // how often live status is re-checked
  const KEY = 'multikick.v2';
  const OLD_KEY = 'multikick.channels';  // v1 stored just the channel array
  const $ = (s) => document.querySelector(s);
  const grid = $('#grid');

  // Everything here is persisted, so reopening the app restores the same screens in the same order.
  const state = {
    channels: [], layout: 'grid', main: null, favorites: [], sets: [],
    hideOffline: true, statusUrl: '', showNames: true, keepAwake: true,
  };
  let audio = null;        // channel whose player is currently loaded unmuted
  let gridAudio = null;    // channel picked for sound in the equal-grid layout
  let userMuted = false;   // focus layout: main screen muted with "mute all" / its sound button
  let maxed = null;        // channel shown fullscreen
  let sheetFor = null;     // channel whose action sheet is open
  let immersive = false;   // video only: no top bar, browser fullscreen
  const cells = new Map();
  const status = new Map(); // name -> 'live' | 'offline' | 'unknown'
  const info = new Map();   // name -> { viewers, title, category } while live (from the Worker)
  let statusOk = null;      // null: not checked yet, false: Kick could not be reached
  let statusErr = '';
  let lastPoll = 0;

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
  const SVG = 'http://www.w3.org/2000/svg';
  function ic(name) {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('class', 'ic');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVG, 'use');
    u.setAttribute('href', `#i-${name}`);
    s.append(u);
    return s;
  }
  const setIcon = (root, name) => root.querySelector('use').setAttribute('href', `#i-${name}`);
  const fmtN = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v)).replace('.0', '');

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('on'), 2600);
  }

  // Offline channels are hidden only when their status is known; unknown ones always show.
  const shown = (n) => !(state.hideOffline && status.get(n) === 'offline');
  const visible = () => state.channels.filter(shown);
  // The main screen falls back to the first visible channel while the chosen one is offline.
  const mainNow = () => { const v = visible(); return v.includes(state.main) ? state.main : v[0] || null; };
  const isLive = (n) => status.get(n) === 'live';

  // One line describing a channel: viewers and title while live.
  function describe(n) {
    const st = status.get(n);
    if (st === 'live') {
      const i = info.get(n) || {};
      return [i.viewers != null ? `${fmtN(i.viewers)} คนดู` : 'ไลฟ์อยู่', i.title].filter(Boolean).join(' · ');
    }
    if (st === 'offline') return shown(n) ? 'ออฟไลน์' : 'ออฟไลน์ · ซ่อนอยู่';
    return '';
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
    state.hideOffline = state.hideOffline !== false;
    state.showNames = state.showNames !== false;
    state.keepAwake = state.keepAwake !== false;
    state.statusUrl = cleanUrl(state.statusUrl);
    state.sets = (Array.isArray(state.sets) ? state.sets : [])
      .filter((s) => s && s.name)
      .map((s) => ({ name: String(s.name).slice(0, 40), channels: uniq(s.channels, MAX),
        layout: s.layout === 'focus' ? 'focus' : 'grid', main: parse(s.main) }));
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable */ } }

  // ---------- live status ----------
  // Browsers usually can't ask Kick directly (no CORS), so the status comes from the user's own
  // Cloudflare Worker (worker/kick-status-worker.js) when one is set up. If nothing answers,
  // every channel stays 'unknown' and is shown.
  const WORKER_CODE_URLS = ['worker/kick-status-worker.js',
    'https://raw.githubusercontent.com/rbblackhack0950/ratti.github.io/main/multikick/worker/kick-status-worker.js'];
  function cleanUrl(u) {
    const t = String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    return /^https:\/\/[^\s/]+(\/\S*)?$/i.test(t) ? t : '';
  }

  // Returns { live: name -> 'live' | 'offline', info } from the Worker, or throws with a readable reason.
  async function checkViaWorker(names) {
    let r;
    try {
      r = await fetch(`${state.statusUrl}/?c=${names.map(encodeURIComponent).join(',')}`, { cache: 'no-store' });
    } catch { throw new Error('ติดต่อ Worker ไม่ได้ (ลิงก์ผิดหรือยังไม่ได้ Deploy)'); }
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`Worker ตอบกลับไม่ถูกต้อง (${r.status})`);
    if (!j.ok) throw new Error(j.error || `Worker error (${r.status})`);
    return {
      live: new Map(Object.entries(j.live || {}).map(([n, v]) => [n, v ? 'live' : 'offline'])),
      info: j.info || {},
    };
  }

  async function checkOne(name) {
    for (const v of ['v2', 'v1']) {
      try {
        const r = await fetch(`https://kick.com/api/${v}/channels/${encodeURIComponent(name)}`,
          { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (r.status === 404) return 'offline';
        if (!r.ok) continue;
        const ls = (await r.json())?.livestream;
        return ls && ls.is_live !== false ? 'live' : 'offline';
      } catch { /* try the next endpoint */ }
    }
    return 'unknown';
  }

  let polling = false, pollAgain = false, pollTimer = 0;
  async function poll() {
    clearTimeout(pollTimer);
    if (polling) { pollAgain = true; return; }
    polling = true;
    lastPoll = Date.now();
    const names = [...new Set([...state.channels, ...state.favorites])].slice(0, 60);
    const wentLive = [];
    let ok = 0;
    const record = (n, s) => {
      if (s === 'unknown') { if (!status.has(n)) status.set(n, s); return; }  // keep last known on a blip
      ok++;
      if (s === 'live' && status.get(n) === 'offline') wentLive.push(n);
      status.set(n, s);
    };
    statusErr = '';
    if (state.statusUrl && names.length) {
      try {
        const res = await checkViaWorker(names.slice(0, 50));
        names.forEach((n) => record(n, res.live.get(n) || 'unknown'));
        info.clear();
        Object.entries(res.info).forEach(([n, v]) => info.set(n, v));
      } catch (e) { statusErr = e.message; }
    } else {
      const queue = [...names];
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) { const n = queue.shift(); record(n, await checkOne(n)); }
      }));
    }
    const wasOk = statusOk;
    if (names.length) statusOk = ok > 0;
    if (statusOk === false && wasOk !== false) {
      toast(state.statusUrl ? `ตรวจสถานะไม่ได้: ${statusErr}` : 'ยังตรวจสถานะออนไลน์ไม่ได้ · ตั้งค่าได้ที่ เมนู → ตั้งค่า');
      if (!state.statusUrl) $('#status-setup').open = true;
    }
    const onScreen = wentLive.filter((n) => state.channels.includes(n));
    if (onScreen.length) toast(`${onScreen.join(', ')} เริ่มไลฟ์แล้ว`);
    polling = false;
    render();
    if (pollAgain) { pollAgain = false; poll(); return; }
    pollTimer = setTimeout(poll, statusOk === false ? POLL_MS * 3 : POLL_MS);
  }
  const pollSoon = () => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 400); };

  // ---------- screen wake lock ----------
  let wakeLock = null, wakePending = false;
  async function syncWakeLock() {
    const want = state.keepAwake && visible().length > 0 && !document.hidden;
    if (wakePending || !('wakeLock' in navigator)) return;
    wakePending = true;
    try {
      if (want && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { wakeLock = null; /* not allowed here (e.g. file://), the screen may sleep */ }
    wakePending = false;
  }

  // ---------- video cells ----------
  // A cell's iframe is never moved in the DOM (moving reloads the stream);
  // order and size are set with CSS grid placement instead.
  function makeCell(name) {
    const more = el('button', { type: 'button', className: 'more', title: 'ตัวเลือก' }, ic('more'));
    more.dataset.name = name;
    const exit = el('button', { type: 'button', className: 'exit-max pill ghost' }, ic('shrink'), 'ออกจากเต็มจอ');
    exit.dataset.name = name;
    const frame = el('iframe', { title: name, allowFullscreen: true, referrerPolicy: 'no-referrer' });
    frame.allow = 'autoplay; fullscreen; picture-in-picture';
    frame.dataset.on = '0';  // render() loads it
    const cell = el('div', { className: 'cell' },
      frame,
      el('div', { className: 'ov' }, el('span', { className: 'tag' }, ic('vol'), el('span', { textContent: name })), more),
      exit);
    cell.dataset.name = name;
    return cell;
  }

  // Picks the arrangement that shows the most 16:9 video.
  function layout() {
    const vis = visible();
    const n = vis.length, main = mainNow();
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
      const m = cells.get(main);
      m.style.gridColumn = `1 / span ${best.a}`;
      m.style.gridRow = `1 / span ${best.b}`;
    }
  }

  // ---------- rendering ----------
  // `force` lists channels whose player must be reloaded even if nothing else changed.
  function render(force = []) {
    // No main screen picked (or it was removed): the first channel in the list is the main screen.
    if (!state.channels.includes(state.main)) state.main = null;
    const vis = visible();
    if (!vis.includes(maxed)) maxed = null;

    // Sound: in the focus layout it always follows the main screen; in the grid it is picked by hand.
    const want = state.layout === 'focus'
      ? (userMuted ? null : mainNow())
      : (vis.includes(gridAudio) ? gridAudio : null);
    const reloadSet = new Set(force);
    if (want !== audio) { if (audio) reloadSet.add(audio); if (want) reloadSet.add(want); audio = want; }

    for (const [n, c] of cells) if (!state.channels.includes(n)) { c.remove(); cells.delete(n); }
    state.channels.forEach((n, i) => {
      let c = cells.get(n);
      if (!c) { c = makeCell(n); cells.set(n, c); grid.appendChild(c); }
      const on = vis.includes(n);
      const f = c.querySelector('iframe');
      // Offline channels are unloaded; when they go live they load fresh, so no page refresh is needed.
      if (on && (f.dataset.on !== '1' || reloadSet.has(n))) { f.src = src(n, n !== audio); f.dataset.on = '1'; }
      else if (!on && f.dataset.on === '1') { f.src = 'about:blank'; f.dataset.on = '0'; }
      c.style.order = i;
      c.classList.toggle('off', !on);
      c.classList.toggle('audio', n === audio);
      c.classList.toggle('max', n === maxed);
    });
    layout();

    const total = state.channels.length;
    const live = state.channels.filter(isLive).length;
    document.querySelectorAll('[data-layout]').forEach((b) => b.classList.toggle('on', b.dataset.layout === state.layout));
    document.body.classList.toggle('no-names', !state.showNames);
    $('#chip-status').hidden = !total;
    $('#count').textContent = statusOk ? `${live}/${total}` : String(total);
    $('#chip-status').title = statusOk ? `ไลฟ์อยู่ ${live} จาก ${total} ช่อง` : `${total} ช่อง`;
    $('#bar-dot').className = `dot${statusOk && live ? ' live' : ''}`;
    $('#empty').hidden = total > 0;
    $('#waiting').hidden = !(total && !vis.length);
    grid.hidden = !vis.length;
    $('#opt-hide-offline').checked = state.hideOffline;
    $('#opt-names').checked = state.showNames;
    $('#opt-awake').checked = state.keepAwake;
    renderStatus(live, total);
    renderList();
    renderFavs();
    renderSets();
    if (sheetFor) renderSheet();
    syncWakeLock();
    save();
  }

  function renderStatus(live, total) {
    const note = $('#status-note');
    const time = new Date(lastPoll).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    note.textContent = statusOk === false
      ? (state.statusUrl ? `ตรวจไม่ได้: ${statusErr}` : 'ยังไม่ได้ตั้งค่า · ระหว่างนี้จะแสดงทุกช่อง')
      : statusOk ? `เชื่อมต่อแล้ว · ไลฟ์ ${live}/${total} · ตรวจล่าสุด ${time} (ทุก 1 นาที)`
        : 'กำลังตรวจ…';
    note.classList.toggle('warn', statusOk === false);
    $('#status-warn').hidden = statusOk !== false;
  }

  const dot = (n) => el('span', { className: `dot ${status.get(n) || 'unknown'}` });

  let drag = null;  // channel-list drag in progress
  function renderList() {
    if (drag) return;  // never rebuild the list under the user's finger
    const list = $('#d-list'); list.textContent = '';
    const main = mainNow();
    for (const n of state.channels) {
      const marks = el('span', { className: 'marks' });
      if (state.layout === 'focus' && n === main) marks.append(ic('focus'));
      if (n === audio) marks.append(ic('vol'));
      const sub = describe(n);
      const open = el('button', { type: 'button', className: 'row-main' }, dot(n),
        el('span', { className: 'row-text' }, el('span', { className: 'nm', textContent: n }),
          ...(sub ? [el('span', { className: 'sub', textContent: sub })] : [])),
        marks);
      open.dataset.sheet = n;
      const li = el('li', { className: shown(n) ? '' : 'dim' },
        el('span', { className: 'grip', title: 'ลากเพื่อจัดลำดับ' }, ic('grip')), open);
      li.dataset.name = n;
      list.append(li);
    }
    if (!state.channels.length) list.append(el('li', { className: 'empty-note', textContent: 'ยังไม่มีช่อง · กด "เพิ่มช่อง" ด้านบน' }));
    $('#d-hint').hidden = state.channels.length < 2;
    $('#set-save').disabled = !state.channels.length;
    $('#clear').disabled = !state.channels.length;
  }

  // Live favorites first, so the ones worth opening are easy to find.
  const favsSorted = () => [...state.favorites].sort((a, b) => isLive(b) - isLive(a));
  function favChips(box, removable) {
    box.textContent = '';
    for (const n of favsSorted()) {
      const on = state.channels.includes(n);
      const t = el('button', { type: 'button', title: on ? 'เอาออกจากจอ' : 'เพิ่มขึ้นจอ' }, dot(n), n);
      t.dataset.favToggle = n;
      const chip = el('span', { className: `chip${on ? ' on' : ''}` }, t);
      if (removable) {
        const x = el('button', { type: 'button', className: 'x', title: 'เอาออกจากช่องโปรด' }, ic('close'));
        x.dataset.favDel = n;
        chip.append(x);
      }
      box.append(chip);
    }
    if (!state.favorites.length) box.append(el('span', { className: 'empty-note', textContent: 'ยังไม่มี · กดดาวในตัวเลือกของช่องเพื่อเพิ่ม' }));
  }
  function renderFavs() {
    favChips($('#fav-list'), true);
    favChips($('#add-favs'), false);
    favChips($('#empty-favs'), false);
    $('#add-favs-wrap').hidden = !state.favorites.length;
    $('#empty-favs-wrap').hidden = !state.favorites.length;
    const btn = $('#fav-open');
    btn.hidden = !state.favorites.length;
    if (statusOk) {
      const n = state.favorites.filter((f) => isLive(f) && !state.channels.includes(f)).length;
      btn.textContent = `เปิดช่องโปรดที่กำลังไลฟ์ (${n})`;
      btn.disabled = !n;
    } else {
      btn.textContent = 'เปิดช่องโปรดทั้งหมด';
      btn.disabled = false;
    }
  }

  function setRows(box, deletable) {
    box.textContent = '';
    state.sets.forEach((s, i) => {
      const load = el('button', { type: 'button' }, el('span', { textContent: s.name }),
        el('small', { textContent: `${s.channels.length} ช่อง · ${s.layout === 'focus' ? 'จอหลัก' : 'เท่ากัน'}` }));
      load.dataset.setLoad = i;
      const li = el('li', {}, load);
      if (deletable) {
        const del = el('button', { type: 'button', className: 'ib', title: 'ลบชุดนี้' }, ic('trash'));
        del.dataset.setDel = i;
        li.append(del);
      }
      box.append(li);
    });
    if (!state.sets.length && deletable) box.append(el('li', { className: 'empty-note', textContent: 'ยังไม่มี · กด "บันทึกเป็นชุด" ในแท็บ ช่อง' }));
  }
  function renderSets() {
    setRows($('#set-list'), true);
    setRows($('#add-sets'), false);
    setRows($('#empty-sets'), false);
    $('#add-sets-wrap').hidden = !state.sets.length;
    $('#empty-sets-wrap').hidden = !state.sets.length;
  }

  function renderSheet() {
    const n = sheetFor;
    if (!state.channels.includes(n)) return closePanels();
    $('#sheet-title').textContent = n;
    $('#sheet-dot').className = `dot ${status.get(n) || 'unknown'}`;
    $('#sheet-sub').textContent = describe(n) || 'ไม่ทราบสถานะ';
    $('#sheet').querySelectorAll('[data-act]').forEach((b) => { b.dataset.name = n; });
    const tile = (act) => $(`#sheet [data-act="${act}"]`);
    const focusMode = state.layout === 'focus';
    tile('sound').classList.toggle('on', n === audio);
    setIcon(tile('sound'), n === audio ? 'vol' : 'mute');
    tile('sound').querySelector('span').textContent = n === audio ? 'มีเสียง'
      : focusMode && n !== mainNow() ? 'ฟังช่องนี้' : 'เปิดเสียง';
    tile('main').classList.toggle('on', focusMode && n === mainNow());
    tile('max').classList.toggle('on', n === maxed);
    const fav = state.favorites.includes(n);
    tile('fav').classList.toggle('on', fav);
    setIcon(tile('fav'), fav ? 'star-on' : 'star');
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
    if (added) { render(); pollSoon(); }
    const notes = [];
    if (added) notes.push(`เพิ่ม ${added} ช่อง`);
    if (dup) notes.push(`มีอยู่แล้ว ${dup}`);
    if (bad) notes.push(`ลิงก์ไม่ถูกต้อง ${bad}`);
    if (full) notes.push(`เต็ม ${MAX} ช่องแล้ว`);
    if (before <= HEAVY && state.channels.length > HEAVY) notes.push('เปิดหลายช่องจะใช้เน็ตและแบตมาก');
    if (notes.length) toast(notes.join(' · '));
    return added;
  }

  function setMain(name) {
    state.main = name;
    state.layout = 'focus';
    userMuted = false;
    maxed = null;
    render();
  }

  function setAudio(name) {
    if (state.layout === 'focus') {
      if (name !== mainNow()) return setMain(name);  // only the main screen has sound in this layout
      userMuted = audio === name;
    } else {
      gridAudio = gridAudio === name ? null : name;
    }
    render();
  }

  function setLayout(l) {
    if (l === state.layout) return;
    if (l === 'focus') userMuted = false;
    else gridAudio = audio;  // keep the sound that was playing
    state.layout = l;
    maxed = null;
    render();
  }

  // Reloads every player muted: also silences channels unmuted from inside Kick's own player.
  function muteAll() {
    if (!state.channels.length) return;
    userMuted = true;
    gridAudio = null;
    render(visible());
    toast('ปิดเสียงทุกช่องแล้ว');
  }

  function remove(name) {
    state.channels = state.channels.filter((c) => c !== name);
    render();
  }

  function toggleFav(name) {
    const was = state.favorites.includes(name);
    state.favorites = was ? state.favorites.filter((f) => f !== name) : [...state.favorites, name];
    render();
    if (!was) pollSoon();
  }

  function act(action, name) {
    switch (action) {
      case 'sound': setAudio(name); break;
      case 'main': setMain(name); break;
      case 'max': maxed = maxed === name ? null : name; closePanels(); render(); break;
      case 'fav': toggleFav(name); break;
      case 'reload': render([name]); toast(`โหลด ${name} ใหม่`); break;
      case 'chat': window.open(`https://kick.com/popout/${name}/chat`, '_blank', 'noopener'); break;
      case 'open': window.open(`https://kick.com/${name}`, '_blank', 'noopener'); break;
      case 'rm': remove(name); break;
    }
  }

  function saveSet() {
    if (!state.channels.length) return;
    const name = (prompt('ตั้งชื่อชุดนี้', `ชุดที่ ${state.sets.length + 1}`) || '').trim().slice(0, 40);
    if (!name) return;
    const set = { name, channels: [...state.channels], layout: state.layout, main: state.main };
    const i = state.sets.findIndex((s) => s.name === name);
    if (i >= 0) state.sets[i] = set; else state.sets.push(set);
    render();
    toast(`บันทึกชุด "${name}" แล้ว`);
  }

  function loadSet(i) {
    const s = state.sets[i]; if (!s) return;
    Object.assign(state, { channels: [...s.channels], layout: s.layout, main: s.main });
    userMuted = false;
    maxed = null;
    closePanels();
    render();
    pollSoon();
    toast(`เปิดชุด "${s.name}"`);
  }

  async function setImmersive(on) {
    immersive = on;
    document.body.classList.toggle('immersive', on);
    closePanels();
    try {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch { /* fullscreen not available: hiding the bar still helps */ }
  }

  // ---------- panels ----------
  const PANELS = ['#drawer', '#sheet', '#addpop'];
  function openPanel(id) {
    closePanels();
    $('#backdrop').hidden = false;
    $(id).hidden = false;
    if (id === '#addpop') $('#add-input').focus();
  }
  function closePanels() {
    sheetFor = null;
    ['#backdrop', ...PANELS].forEach((id) => { $(id).hidden = true; });
  }
  function openSheet(name) {
    openPanel('#sheet');
    sheetFor = name;
    renderSheet();
  }
  function setTab(t) {
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === t);
      b.setAttribute('aria-selected', b.dataset.tab === t);
    });
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  }

  // ---------- events ----------
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('more')) openSheet(b.dataset.name);
    else if (b.classList.contains('exit-max')) { maxed = null; render(); }
  });

  // One handler for the bar, the menu, the action sheet and the shortcut lists.
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || grid.contains(b)) return;
    const d = b.dataset;
    if (d.open) openPanel(d.open);
    if (d.tab) setTab(d.tab);
    if ('close' in d) closePanels();
    else if (d.sheet) openSheet(d.sheet);
    else if (d.act) act(d.act, d.name);
    else if (d.favToggle) { state.channels.includes(d.favToggle) ? remove(d.favToggle) : add(d.favToggle); }
    else if (d.favDel) toggleFav(d.favDel);
    else if (d.setLoad) loadSet(+d.setLoad);
    else if (d.setDel) {
      const s = state.sets[+d.setDel];
      if (s && confirm(`ลบชุด "${s.name}"?`)) { state.sets.splice(+d.setDel, 1); render(); }
    } else if (d.layout) setLayout(d.layout);
  });
  $('#backdrop').addEventListener('click', closePanels);

  // Drag the grip to reorder channels in the menu.
  const list = $('#d-list');
  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip'); if (!grip) return;
    e.preventDefault();
    const li = grip.closest('li'), items = [...list.children];
    const from = items.indexOf(li);
    drag = { li, items, from, to: from, y0: e.clientY, rects: items.map((x) => x.getBoundingClientRect()), id: e.pointerId };
    grip.setPointerCapture(e.pointerId);
    li.classList.add('dragging');
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { li, items, from, rects } = drag;
    const dy = e.clientY - drag.y0;
    const center = rects[from].top + rects[from].height / 2 + dy;
    let to = from;
    rects.forEach((r, i) => {
      const mid = r.top + r.height / 2;
      if (i < from && center < mid) to = Math.min(to, i);
      if (i > from && center > mid) to = Math.max(to, i);
    });
    drag.to = to;
    const h = rects[from].height;
    li.style.transform = `translateY(${dy}px)`;
    items.forEach((x, i) => {
      if (x !== li) x.style.transform = i >= to && i < from ? `translateY(${h}px)` : i <= to && i > from ? `translateY(${-h}px)` : '';
    });
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { from, to, items } = drag;
    drag = null;
    items.forEach((x) => { x.style.transform = ''; x.classList.remove('dragging'); });
    if (to !== from) { const [n] = state.channels.splice(from, 1); state.channels.splice(to, 0, n); }
    render();
  };
  list.addEventListener('pointerup', endDrag);
  list.addEventListener('pointercancel', endDrag);

  const addFrom = (input) => (e) => {
    e.preventDefault();
    if (add(input.value)) { input.value = ''; closePanels(); }
  };
  for (const [form, input] of [['#add-form', '#add-input'], ['#empty-form', '#empty-input']]) {
    $(form).addEventListener('submit', addFrom($(input)));
    // Pasting several links adds them straight away.
    $(input).addEventListener('paste', () => setTimeout(() => {
      const i = $(input);
      if (/\s|,/.test(i.value.trim()) && add(i.value)) { i.value = ''; closePanels(); }
    }));
  }
  $('#fav-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const names = uniq($('#fav-input').value.split(/[\s,]+/)).filter((n) => !state.favorites.includes(n));
    if (!names.length) return toast('ลิงก์ไม่ถูกต้องหรือมีอยู่แล้ว');
    state.favorites.push(...names);
    $('#fav-input').value = '';
    render();
    pollSoon();
  });
  $('#fav-open').addEventListener('click', () => {
    const pick = statusOk ? state.favorites.filter((f) => isLive(f) && !state.channels.includes(f)) : state.favorites;
    if (add(pick.join(' '))) closePanels();
  });
  $('#set-save').addEventListener('click', saveSet);
  $('#mute-all').addEventListener('click', muteAll);
  $('#immersive').addEventListener('click', () => setImmersive(true));
  $('#exit-immersive').addEventListener('click', () => setImmersive(false));
  document.addEventListener('fullscreenchange', () => {
    // Leaving fullscreen with the back gesture also leaves immersive mode.
    if (!document.fullscreenElement && immersive) { immersive = false; document.body.classList.remove('immersive'); }
  });
  $('#opt-hide-offline').addEventListener('change', (e) => { state.hideOffline = e.target.checked; render(); });
  $('#opt-names').addEventListener('change', (e) => { state.showNames = e.target.checked; render(); });
  $('#opt-awake').addEventListener('change', (e) => { state.keepAwake = e.target.checked; render(); });
  $('#show-offline').addEventListener('click', () => { state.hideOffline = false; render(); });
  $('#clear').addEventListener('click', () => {
    if (state.channels.length && confirm('ลบทุกช่องบนจอ? (ช่องโปรดและชุดที่บันทึกยังอยู่)')) { state.channels = []; closePanels(); render(); }
  });
  $('#share').addEventListener('click', async () => {
    const p = new URLSearchParams({ c: state.channels.join(','), l: state.layout });
    if (state.main) p.set('m', state.main);
    const url = `${location.href.split(/[?#]/)[0]}?${p.toString().replace(/%2C/g, ',')}`;
    try { await navigator.clipboard.writeText(url); toast('คัดลอกลิงก์แล้ว'); } catch { prompt('คัดลอกลิงก์:', url); }
  });
  $('#status-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = $('#status-url').value.trim();
    const url = cleanUrl(raw);
    if (raw && !url) return toast('ลิงก์ต้องขึ้นต้นด้วย https://');
    state.statusUrl = url;
    $('#status-url').value = url;
    statusOk = null;
    render();
    await poll();
    toast(!url ? 'ลบตัวตรวจสถานะแล้ว' : statusOk ? 'ตัวตรวจสถานะใช้ได้' : `ใช้ไม่ได้: ${statusErr || 'ยังไม่มีช่องให้ตรวจ'}`);
    if (statusOk) $('#status-setup').open = false;
  });
  $('#copy-worker').addEventListener('click', async () => {
    for (const u of WORKER_CODE_URLS) {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) continue;
        await navigator.clipboard.writeText(await r.text());
        return toast('คัดลอกโค้ด Worker แล้ว');
      } catch { /* try the next source */ }
    }
    window.open(WORKER_CODE_URLS[1], '_blank', 'noopener');  // copy by hand from the raw file
  });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#backdrop').hidden) closePanels();
    else if (maxed) { maxed = null; render(); }
    else if (immersive) setImmersive(false);
  });
  // Coming back to the app (switching apps, waking the tablet) re-checks right away.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastPoll > 15000) poll();
    syncWakeLock();
  });
  new ResizeObserver(layout).observe(grid);

  load();
  $('#status-url').value = state.statusUrl;
  setTab('ch');
  render();
  poll();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
