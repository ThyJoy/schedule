(function () {
  'use strict';

  const DATA_KEY = 'sched.data.v1';
  const SETTINGS_KEY = 'sched.settings.v1';
  const DEFAULT_COURSE_NUM = 5;

  const WD_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  const WD_LONG = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------------------
  // Хранилище
  // ---------------------------------------------------------------------------

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  const state = {
    data: null,
    builtin: null,
    settings: Object.assign({ courseNum: DEFAULT_COURSE_NUM, parityFlip: false, showAll: false, view: 'day' }, load(SETTINGS_KEY) || {}),
    sel: startOfDay(new Date()),
  };
  const saveSettings = () => save(SETTINGS_KEY, state.settings);

  // ---------------------------------------------------------------------------
  // Даты
  // ---------------------------------------------------------------------------

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  const isoWeekday = (d) => ((d.getDay() + 6) % 7) + 1; // пн = 1 … вс = 7
  const mondayOf = (d) => addDays(startOfDay(d), 1 - isoWeekday(d));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const sameDay = (a, b) => ymd(a) === ymd(b);
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 864e5);
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const fmtLong = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const fmtShort = (iso) => { const [, m, d] = iso.split('-'); return `${d}.${m}`; };

  const parseYmd = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

  // Начало занятий: из настроек, иначе самая ранняя дата «с …» в файле, иначе 1 сентября
  function semesterStart() {
    if (state.settings.startDate) return parseYmd(state.settings.startDate);
    let min = null;
    if (state.data) state.data.courses.forEach((c) => c.entries.forEach((e) => e.lessons.forEach((l) => {
      if (l.from && (!min || l.from < min)) min = l.from;
    })));
    if (min) return parseYmd(min);
    const t = new Date();
    return new Date(t.getMonth() >= 7 ? t.getFullYear() : t.getFullYear() - 1, 8, 1);
  }
  const beforeStart = (d) => ymd(d) < ymd(semesterStart());

  // Неделя, в которую попадает начало занятий, — первая (нечётная)
  function weekInfo(d) {
    const num = Math.floor(daysBetween(mondayOf(semesterStart()), mondayOf(d)) / 7) + 1;
    let odd = Math.abs(num) % 2 === 1;
    if (state.settings.parityFlip) odd = !odd;
    return { num, parity: odd ? 'odd' : 'even' };
  }

  // ---------------------------------------------------------------------------
  // Данные расписания
  // ---------------------------------------------------------------------------

  function course() {
    const cs = state.data ? state.data.courses : [];
    return cs.find((c) => c.num === state.settings.courseNum) || cs[0] || null;
  }

  // Номера пар: по всем уникальным временам начала в файле
  let pairNumbers = {};
  function computePairNumbers() {
    const starts = new Set();
    state.data.courses.forEach((c) => c.entries.forEach((e) => starts.add(e.start)));
    pairNumbers = {};
    [...starts].sort((a, b) => toMin(a) - toMin(b)).forEach((s, i) => { pairNumbers[s] = i + 1; });
  }

  function lessonStatus(l, d) {
    const iso = ymd(d);
    if (beforeStart(d)) return { ok: false, why: `занятия с ${fmtShort(ymd(semesterStart()))}` };
    if (l.week && l.week !== weekInfo(d).parity) return { ok: false, why: l.week === 'even' ? 'только по чётным' : 'только по нечётным' };
    if (l.from && iso < l.from) return { ok: false, why: `начнётся ${fmtShort(l.from)}` };
    if (l.to && iso > l.to) return { ok: false, why: `закончилось ${fmtShort(l.to)}` };
    return { ok: true };
  }

  // Слоты дня: [{entry, lessons:[{l, st}]}]
  function slotsFor(d, includeInactive) {
    const c = course();
    if (!c) return [];
    const wd = isoWeekday(d);
    return c.entries
      .filter((e) => e.day === wd)
      .sort((a, b) => toMin(a.start) - toMin(b.start))
      .map((e) => ({
        entry: e,
        lessons: e.lessons.map((l) => ({ l, st: lessonStatus(l, d) })).filter((x) => x.st.ok || includeInactive),
      }))
      .filter((s) => s.lessons.length);
  }
  const activeCount = (d) => slotsFor(d, false).length;

  // ---------------------------------------------------------------------------
  // Отрисовка
  // ---------------------------------------------------------------------------

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function lessonHtml(x) {
    const { l, st } = x;
    const tags = [];
    if (l.room) tags.push(`<span class="tag room">ауд. ${esc(l.room)}</span>`);
    if (l.week) tags.push(`<span class="tag">${l.week === 'even' ? 'чётная неделя' : 'нечётная неделя'}</span>`);
    if (l.from || l.to) tags.push(`<span class="tag">${l.from ? 'с ' + fmtShort(l.from) : ''}${l.to ? ' по ' + fmtShort(l.to) : ''}</span>`);
    if (!st.ok) tags.push(`<span class="tag">${esc(st.why)}</span>`);
    l.notes.forEach((n) => tags.push(`<span class="tag note">${esc(n)}</span>`));
    return `<div class="lesson${st.ok ? '' : ' inactive'}">
      <div class="subj">${esc(l.subject)}</div>
      ${l.teachers.length ? `<div class="meta">${esc(l.teachers.join(', '))}</div>` : ''}
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
    </div>`;
  }

  function slotHtml(s, cls, statusHtml) {
    const e = s.entry;
    const n = pairNumbers[e.start];
    return `<article class="slot ${cls || ''}">
      <div class="time"><div class="s">${e.start}</div><div class="e">${e.end}</div>${n ? `<div class="n">${n} пара</div>` : ''}</div>
      <div>${statusHtml || ''}${s.lessons.map(lessonHtml).join('')}</div>
    </article>`;
  }

  function renderHeader() {
    const c = course();
    $('courseTitle').textContent = c ? `${c.label}${c.kind ? ' · ' + c.kind : ''}` : 'Расписание';
    const wi = weekInfo(state.sel);
    $('weekLabel').textContent = wi.num > 0
      ? `${wi.num}-я неделя · ${wi.parity === 'odd' ? 'нечётная' : 'чётная'}`
      : `занятия с ${fmtLong(semesterStart())}`;

    const mon = mondayOf(state.sel);
    const today = startOfDay(new Date());
    const c7 = c && c.entries.some((e) => e.day === 7);
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const has = activeCount(d) > 0;
      const cls = ['day', has ? 'has' : '', sameDay(d, today) ? 'today' : '', sameDay(d, state.sel) ? 'sel' : '', i === 6 && !c7 ? 'off' : ''].join(' ');
      html += `<button class="${cls}" data-date="${ymd(d)}" aria-label="${WD_LONG[i]}, ${d.getDate()} ${MONTHS[d.getMonth()]}"><span class="dw">${WD_SHORT[i]}</span><span class="dn">${d.getDate()}</span><span class="dot"></span></button>`;
    }
    $('days').innerHTML = html;
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.settings.view));
  }

  function renderDay() {
    const d = state.sel;
    const slots = slotsFor(d, state.settings.showAll);
    const now = new Date();
    const isToday = sameDay(d, now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const activeSlots = slots.filter((s) => s.lessons.some((x) => x.st.ok));
    const nextSlot = isToday ? activeSlots.find((s) => toMin(s.entry.start) > nowMin) : null;

    const title = `${WD_LONG[isoWeekday(d) - 1]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
    const cnt = activeSlots.length;
    let html = `<div class="date-head"><h2>${isToday ? 'Сегодня, ' : ''}${title}</h2><span class="count">${cnt ? `${cnt} ${plural(cnt, 'пара', 'пары', 'пар')}` : ''}</span></div>`;

    if (beforeStart(d) && !state.settings.showAll) {
      html += `<div class="empty"><div class="big">Занятия начнутся ${fmtLong(semesterStart())}</div><button class="btn small" id="toStart" style="margin-top:12px">Показать первый день</button></div>`;
    } else if (!slots.length) {
      html += `<div class="empty"><div class="big">Занятий нет</div>${isoWeekday(d) === 7 ? 'Воскресенье' : 'Можно отдохнуть'}</div>`;
    } else {
      html += slots.map((s) => {
        let cls = '', status = '';
        const active = s.lessons.some((x) => x.st.ok);
        if (isToday && active) {
          const st = toMin(s.entry.start), en = toMin(s.entry.end);
          if (nowMin >= st && nowMin < en) {
            cls = 'now';
            status = `<div class="status">Идёт сейчас · до конца ${en - nowMin} мин</div>`;
          } else if (nowMin >= en) cls = 'past';
          else if (s === nextSlot) {
            const left = st - nowMin;
            status = `<div class="status next">Следующая · через ${left >= 60 ? Math.floor(left / 60) + ' ч ' : ''}${left % 60} мин</div>`;
          }
        }
        return slotHtml(s, cls, status);
      }).join('');
    }
    html += footHtml();
    $('main').innerHTML = html;
    const b = $('toStart');
    if (b) b.onclick = () => go(semesterStart());
  }

  function renderWeek() {
    const mon = mondayOf(state.sel);
    const today = startOfDay(new Date());
    const c = course();
    const lastDay = c && c.entries.some((e) => e.day === 7) ? 7 : 6;
    let html = '';
    for (let i = 0; i < lastDay; i++) {
      const d = addDays(mon, i);
      const slots = slotsFor(d, state.settings.showAll);
      const isToday = sameDay(d, today);
      html += `<section class="week-day"><h3 class="${isToday ? 'today' : ''}">${WD_LONG[i]}, ${d.getDate()} ${MONTHS[d.getMonth()]}${isToday ? ' · сегодня' : ''}</h3>`;
      html += slots.length ? slots.map((s) => slotHtml(s)).join('') : '<div class="none">Занятий нет</div>';
      html += '</section>';
    }
    html += footHtml();
    $('main').innerHTML = html;
  }

  function footHtml() {
    const d = state.data;
    if (!d) return '';
    return `<div class="foot">${esc(d.title)}${d.subtitle ? '<br>' + esc(d.subtitle.toLowerCase()) : ''}</div>`;
  }

  function render() {
    if (!state.data) return;
    renderHeader();
    if (state.settings.view === 'week') renderWeek();
    else renderDay();
  }

  // ---------------------------------------------------------------------------
  // Настройки
  // ---------------------------------------------------------------------------

  function fillSettings() {
    const sel = $('courseSelect');
    sel.innerHTML = state.data.courses
      .map((c) => `<option value="${c.num}"${c === course() ? ' selected' : ''}>${esc(c.label)}${c.kind ? ' · ' + esc(c.kind) : ''} — ${c.entries.length} ${plural(c.entries.length, 'пара', 'пары', 'пар')} в неделю</option>`)
      .join('');
    const today = startOfDay(new Date());
    const ref = beforeStart(today) ? semesterStart() : today;
    const wi = weekInfo(ref);
    $('parityText').innerHTML = `${beforeStart(today) ? 'Первая неделя' : 'Сейчас'} — <b>${wi.parity === 'odd' ? 'нечётная' : 'чётная'}</b>`;
    $('startDate').value = ymd(semesterStart());
    $('showAll').checked = !!state.settings.showAll;
    const d = state.data;
    const when = d.importedAt ? new Date(d.importedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
    $('fileInfo').innerHTML = `<b>${esc(d.fileName || 'встроенное расписание')}</b><br><span class="hint">${d.builtin ? 'Встроено в приложение' : 'Загружено ' + esc(when)}</span>`;
    $('resetBtn').hidden = !!d.builtin || !state.builtin;
  }

  function openSheet() {
    fillSettings();
    $('sheetBackdrop').hidden = false;
    requestAnimationFrame(() => $('sheet').classList.add('open'));
    $('sheet').setAttribute('aria-hidden', 'false');
  }
  function closeSheet() {
    $('sheet').classList.remove('open');
    $('sheet').setAttribute('aria-hidden', 'true');
    setTimeout(() => { $('sheetBackdrop').hidden = true; }, 250);
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 6000 : 3500);
  }

  async function importFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const data = await window.ScheduleParser.parseFile(buf, file.name);
      const total = data.courses.reduce((n, c) => n + c.entries.length, 0);
      if (!total) throw new Error('В файле не нашлось ни одной пары');
      state.data = data;
      computePairNumbers();
      if (!save(DATA_KEY, data)) toast('Не удалось сохранить расписание в памяти браузера', true);
      if (!data.courses.some((c) => c.num === state.settings.courseNum)) {
        state.settings.courseNum = data.courses[0].num;
        saveSettings();
      }
      const c = course();
      fillSettings();
      render();
      toast(`Расписание обновлено: ${c.label}, ${c.entries.length} ${plural(c.entries.length, 'пара', 'пары', 'пар')} в неделю`);
    } catch (e) {
      console.error(e);
      toast('Не получилось прочитать файл: ' + (e.message || e), true);
    }
  }

  // ---------------------------------------------------------------------------
  // События
  // ---------------------------------------------------------------------------

  function go(d) { state.sel = startOfDay(d); render(); }

  function bind() {
    $('days').addEventListener('click', (e) => {
      const b = e.target.closest('.day');
      if (!b) return;
      const [y, m, d] = b.dataset.date.split('-').map(Number);
      state.sel = new Date(y, m - 1, d);
      if (state.settings.view === 'week') state.settings.view = 'day';
      saveSettings();
      render();
      window.scrollTo({ top: 0 });
    });
    $('prevWeek').onclick = () => go(addDays(state.sel, -7));
    $('nextWeek').onclick = () => go(addDays(state.sel, 7));
    $('todayBtn').onclick = () => { go(new Date()); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    document.querySelectorAll('.seg button').forEach((b) => {
      b.onclick = () => { state.settings.view = b.dataset.view; saveSettings(); render(); };
    });

    // Свайпы влево/вправо: день (или неделя в режиме «Неделя»)
    let sx = 0, sy = 0, st = 0;
    const main = $('main');
    main.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
    main.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6 || Date.now() - st > 700) return;
      const step = state.settings.view === 'week' ? 7 : 1;
      let next = addDays(state.sel, dx < 0 ? step : -step);
      if (step === 1 && isoWeekday(next) === 7 && !(course() && course().entries.some((x) => x.day === 7))) {
        next = addDays(next, dx < 0 ? 1 : -1); // воскресенье пропускаем
      }
      go(next);
    }, { passive: true });

    $('settingsBtn').onclick = openSheet;
    $('closeSheet').onclick = closeSheet;
    $('sheetBackdrop').onclick = closeSheet;
    $('courseSelect').onchange = (e) => { state.settings.courseNum = +e.target.value; saveSettings(); render(); };
    $('startDate').onchange = (e) => {
      state.settings.startDate = e.target.value || null;
      saveSettings(); fillSettings(); render();
    };
    $('parityFlip').onclick = () => { state.settings.parityFlip = !state.settings.parityFlip; saveSettings(); fillSettings(); render(); };
    $('showAll').onchange = (e) => { state.settings.showAll = e.target.checked; saveSettings(); render(); };
    $('fileInput').onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) importFile(f);
    };
    $('resetBtn').onclick = () => {
      if (!state.builtin) return;
      try { localStorage.removeItem(DATA_KEY); } catch (e) { /* ignore */ }
      state.data = state.builtin;
      computePairNumbers();
      fillSettings();
      render();
      toast('Вернул встроенное расписание');
    };

    document.addEventListener('keydown', (e) => {
      if (e.target.closest('select, input')) return;
      if (e.key === 'ArrowLeft') go(addDays(state.sel, state.settings.view === 'week' ? -7 : -1));
      if (e.key === 'ArrowRight') go(addDays(state.sel, state.settings.view === 'week' ? 7 : 1));
      if (e.key === 'Escape') closeSheet();
    });

    // Обновляем «идёт сейчас» раз в 30 секунд и при возвращении в приложение
    setInterval(() => { if (state.settings.view === 'day' && sameDay(state.sel, new Date())) render(); }, 30000);
    let lastDay = ymd(new Date());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const t = ymd(new Date());
      if (t !== lastDay) { lastDay = t; state.sel = startOfDay(new Date()); }
      render();
    });
  }

  function setupInstallHint() {
    const el = $('installHint');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone) { el.textContent = ''; return; }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    el.textContent = ios
      ? 'Чтобы установить: Safari → «Поделиться» → «На экран „Домой“».'
      : 'Чтобы установить: меню браузера (⋮) → «Установить приложение» или «Добавить на главный экран».';
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      el.innerHTML = '';
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = 'Установить на телефон';
      b.onclick = async () => { e.prompt(); await e.userChoice; el.innerHTML = ''; };
      el.appendChild(b);
    });
  }

  // Файл, присланный через «Поделиться → Расписание» (Android)
  async function takeSharedFile() {
    if (!/[?&]shared=1/.test(location.search) || !('caches' in window)) return;
    history.replaceState(null, '', location.pathname);
    try {
      const cache = await caches.open('shared-file');
      const res = await cache.match('shared-file');
      if (!res) return;
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'расписание');
      await cache.delete('shared-file');
      await importFile(new File([blob], name));
    } catch (e) {
      toast('Не удалось открыть присланный файл', true);
    }
  }

  // ---------------------------------------------------------------------------
  // Старт
  // ---------------------------------------------------------------------------

  async function init() {
    bind();
    setupInstallHint();
    try {
      const r = await fetch('schedule.json', { cache: 'no-cache' });
      if (r.ok) { state.builtin = await r.json(); state.builtin.builtin = true; }
    } catch (e) { /* офлайн без кэша — ниже возьмём сохранённое */ }
    state.data = load(DATA_KEY) || state.builtin;
    if (!state.data) {
      $('main').innerHTML = '<div class="empty"><div class="big">Расписание не загружено</div>Откройте настройки и выберите файл .doc или .docx</div>';
      return;
    }
    computePairNumbers();
    // В выходной показываем ближайший учебный день
    if (activeCount(state.sel) === 0 && isoWeekday(state.sel) === 7) state.sel = addDays(state.sel, 1);
    render();
    takeSharedFile();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
