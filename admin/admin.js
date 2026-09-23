// Barbershop Razor — barber's schedule (Supabase)
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const CFG = window.RAZOR_CONFIG || {};
  const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && !/YOUR[-_]/i.test(CFG.supabaseUrl + CFG.supabaseAnonKey));
  const SCREENS = ['loading', 'setup', 'login', 'denied', 'schedule'];
  const show = id => SCREENS.forEach(s => { $('#' + s).hidden = s !== id; });

  if (!configured || !window.supabase) {
    if (configured) $('#setup-text').textContent = 'Библиотеката на Supabase не се зареди. Провери интернет връзката и презареди.';
    show('setup');
    return;
  }
  const db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

  // ---------- shop time (Europe/Sofia), independent of the phone's own time zone ----------
  const SHOP = { timeZone: 'Europe/Sofia', opens: 600, closes: 1080, slotMinutes: 30, closedDays: [2] };
  const pad = n => String(n).padStart(2, '0');
  const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const toMinutes = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const tzParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: SHOP.timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const shopNow = () => { const p = tzParts(Date.now()); return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute }; };
  const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekdayOf = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();
  const offsetAt = ms => { const p = tzParts(ms); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms; };
  const shopTimeToIso = (iso, minutes) => {
    const [y, mo, d] = iso.split('-').map(Number);
    const wall = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
    let ms = wall - offsetAt(wall);
    ms = wall - offsetAt(ms);
    return new Date(ms).toISOString();
  };
  const isoToShop = ts => { const p = tzParts(Date.parse(ts)); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
  const fmt = (iso, opts) => new Intl.DateTimeFormat('bg-BG', { ...opts, timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // ---------- UI helpers ----------
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let toastTimer;
  const toast = (text, error = false) => {
    const t = $('#toast');
    t.textContent = text; t.classList.toggle('error', error); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  };
  const ERRORS = {
    slot_taken: 'Този час току-що беше зает.',
    not_found: 'Този запис вече не съществува.',
    invalid_name: 'Въведи име.',
    invalid_phone: 'Телефонът е твърде дълъг.',
    invalid_notes: 'Бележката е твърде дълга (до 500 знака).',
    invalid_time: 'Невалиден час.',
    outside_hours: 'Часът е извън работното време.',
    forbidden: 'Нямаш права за това действие.'
  };
  const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>';

  // ---------- state ----------
  let day = shopNow().date;
  let slots = new Map();          // "HH:MM" → { status, name, phone, notes, source }
  let flash = new Set();          // slots just changed from another device
  let loadSeq = 0, channel = null;

  // ---------- auth ----------
  async function start() {
    let session = null;
    try { ({ data: { session } } = await db.auth.getSession()); } catch (e) { /* treat as signed out */ }
    if (!session) { show('login'); return; }
    await enter();
  }
  async function enter() {
    let res;
    try { res = await db.rpc('is_admin'); } catch (e) { res = { error: e }; }
    if (res.error) { show('login'); $('#login-form .form-msg').textContent = 'Връзката със сървъра не успя. Опитай пак.'; return; }
    if (!res.data) { show('denied'); return; }
    show('schedule');
    await loadSettings();
    renderHeader();
    await loadDay();
    subscribe();
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget, btn = f.querySelector('button'), msg = f.querySelector('.form-msg');
    msg.textContent = '';
    const email = f.email.value.trim(), password = f.password.value;
    if (!email || !password) { msg.textContent = 'Въведи имейл и парола.'; return; }
    btn.disabled = true;
    const { error } = await db.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (error) { msg.textContent = /invalid/i.test(error.message) ? 'Грешен имейл или парола.' : 'Входът не успя. Опитай пак.'; return; }
    f.password.value = '';
    await enter();
  });
  document.querySelectorAll('[data-logout]').forEach(b => b.addEventListener('click', async () => {
    if (channel) { db.removeChannel(channel); channel = null; }
    await db.auth.signOut();
    show('login');
  }));
  db.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') { if (channel) { db.removeChannel(channel); channel = null; } show('login'); }
  });

  // ---------- data ----------
  async function loadSettings() {
    const { data } = await db.from('business_settings').select('timezone,open_time,close_time,slot_minutes,closed_weekdays').limit(1).maybeSingle();
    if (!data) return;
    Object.assign(SHOP, { timeZone: data.timezone || SHOP.timeZone, opens: toMinutes(data.open_time), closes: toMinutes(data.close_time),
      slotMinutes: data.slot_minutes, closedDays: (data.closed_weekdays || []).map(Number) });
  }
  async function loadDay({ quiet = false } = {}) {
    const seq = ++loadSeq, from = shopTimeToIso(day, 0), to = shopTimeToIso(addDays(day, 1), 0);
    if (!quiet) renderSkeleton();
    const [st, bd] = await Promise.all([
      db.from('slot_status').select('starts_at,status').gte('starts_at', from).lt('starts_at', to),
      db.from('booking_details').select('starts_at,customer_name,customer_phone,notes,source').gte('starts_at', from).lt('starts_at', to)
    ]);
    if (seq !== loadSeq) return;                      // the barber already moved to another day
    $('#load-error').hidden = !(st.error || bd.error);
    if (st.error || bd.error) { if (!quiet) $('#slots').replaceChildren(); return; }
    const details = new Map(bd.data.map(r => [isoToShop(r.starts_at).time, r]));
    slots = new Map();
    st.data.forEach(r => {
      const time = isoToShop(r.starts_at).time, d = details.get(time) || {};
      slots.set(time, { status: r.status, name: d.customer_name, phone: d.customer_phone, notes: d.notes, source: d.source });
    });
    render();
  }

  // ---------- rendering ----------
  function renderHeader() {
    const now = shopNow().date;
    $('#day-name').textContent = day === now ? 'Днес' : day === addDays(now, 1) ? 'Утре' : day === addDays(now, -1) ? 'Вчера' : cap(fmt(day, { weekday: 'long' }));
    $('#day-date').textContent = (day === now || Math.abs(Date.parse(day) - Date.parse(now)) <= 864e5 ? cap(fmt(day, { weekday: 'long' })) + ', ' : '') + fmt(day, { day: 'numeric', month: 'long', year: 'numeric' });
    $('#today-btn').setAttribute('aria-pressed', String(day === now));
    $('#day-picker').value = day;
    $('#closed-note').hidden = !SHOP.closedDays.includes(weekdayOf(day));
  }
  function renderSkeleton() {
    $('#slots').innerHTML = '<li class="slot-skeleton"></li>'.repeat(4);
    $('#summary').textContent = '';
  }
  function render() {
    renderHeader();
    const now = shopNow(), list = $('#slots'), items = [];
    let booked = 0, free = 0, blocked = 0;
    for (let m = SHOP.opens; m + SHOP.slotMinutes <= SHOP.closes; m += SHOP.slotMinutes) {
      const time = hhmm(m), s = slots.get(time);
      const past = day < now.date || (day === now.date && m + SHOP.slotMinutes <= now.minutes);
      const current = day === now.date && now.minutes >= m && now.minutes < m + SHOP.slotMinutes;
      const cls = ['slot', s ? (s.status === 'booked' ? 'is-booked' : 'is-blocked') : 'is-free', past && 'is-past', current && 'is-now', flash.has(time) && 'is-flash'].filter(Boolean).join(' ');
      let body, actions;
      if (!s) {
        free++;
        body = '<span class="state">Свободен</span>';
        actions = '<button class="btn btn--primary" type="button" data-act="book">Запази</button><button class="btn" type="button" data-act="block">Блокирай</button>';
      } else if (s.status === 'booked') {
        booked++;
        const tel = (s.phone || '').replace(/[^\d+]/g, '');
        body = `<strong class="who">${esc(s.name || 'Без име')}</strong>` +
          (s.phone ? `<a class="phone" href="tel:${esc(tel)}">${PHONE_ICON}${esc(s.phone)}</a>` : '') +
          (s.notes ? `<p class="notes">${esc(s.notes)}</p>` : '') +
          `<span class="src">${s.source === 'website' ? 'Онлайн' : 'По телефона'}</span>`;
        actions = '<button class="btn" type="button" data-act="edit">Редактирай</button><button class="btn btn--line-danger" type="button" data-act="cancel">Отмени</button>';
      } else {
        blocked++;
        body = '<span class="state">Блокиран</span>';
        actions = '<button class="btn" type="button" data-act="unblock">Освободи</button>';
      }
      items.push(`<li class="${cls}" data-time="${time}"><div class="slot-time">${time}</div><div class="slot-body">${body}</div><div class="slot-actions">${actions}</div></li>`);
    }
    list.innerHTML = items.join('');
    flash.clear();
    const parts = [`${booked} ${booked === 1 ? 'записан' : 'записани'}`, `${free} ${free === 1 ? 'свободен' : 'свободни'}`];
    if (blocked) parts.push(`${blocked} ${blocked === 1 ? 'блокиран' : 'блокирани'}`);
    $('#summary').textContent = parts.join(' · ');
  }

  // ---------- day navigation ----------
  const goTo = iso => { day = iso; renderHeader(); loadDay(); };
  $('#prev').addEventListener('click', () => goTo(addDays(day, -1)));
  $('#next').addEventListener('click', () => goTo(addDays(day, 1)));
  $('#today-btn').addEventListener('click', () => goTo(shopNow().date));
  $('#retry').addEventListener('click', () => loadDay());
  const picker = $('#day-picker');
  $('#day-label').addEventListener('click', () => {
    try { picker.showPicker(); } catch (e) { picker.focus(); picker.click(); }
  });
  picker.addEventListener('change', () => { if (picker.value) goTo(picker.value); });
  // swipe left/right on the schedule to change day
  let touch = null;
  $('#slots').addEventListener('touchstart', e => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
  $('#slots').addEventListener('touchend', e => {
    if (!touch) return;
    const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) goTo(addDays(day, dx < 0 ? 1 : -1));
  }, { passive: true });
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]') || $('#schedule').hidden || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowLeft') goTo(addDays(day, -1));
    if (e.key === 'ArrowRight') goTo(addDays(day, 1));
  });

  // ---------- actions ----------
  const call = async (fn, args, btn) => {
    if (btn) btn.disabled = true;
    let res;
    try { res = await db.rpc(fn, args); } catch (err) { res = { error: err }; }
    if (btn) btn.disabled = false;
    if (res.error) return { ok: false, error: 'network' };
    return res.data || { ok: false };
  };
  const errorText = code => ERRORS[code] || 'Няма връзка със сървъра. Опитай пак.';

  $('#slots').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const time = btn.closest('.slot').dataset.time, startsAt = shopTimeToIso(day, toMinutes(time)), s = slots.get(time);
    const act = btn.dataset.act;
    if (act === 'book') openSheet('book', time);
    if (act === 'edit') openSheet('edit', time, s);
    if (act === 'cancel') confirmCancel(time, s);
    if (act === 'block' || act === 'unblock') {
      const r = await call(act === 'block' ? 'admin_block_slot' : 'admin_unblock_slot', { p_starts_at: startsAt }, btn);
      if (r.ok) toast(act === 'block' ? `${time} е блокиран` : `${time} е свободен`);
      else toast(errorText(r.error), true);
      loadDay({ quiet: true });
    }
  });

  // Book / edit sheet
  const sheet = $('#sheet'), sheetForm = $('#sheet-form');
  let sheetCtx = null;
  function openSheet(mode, time, s = {}) {
    sheetCtx = { mode, time };
    $('#sheet-title').textContent = mode === 'book' ? `Запази ${time}` : `Промени ${time}`;
    $('#sheet-save').textContent = mode === 'book' ? 'Запази' : 'Запази промените';
    sheetForm.name.value = s.name || '';
    sheetForm.phone.value = s.phone || '';
    sheetForm.notes.value = s.notes || '';
    sheetForm.querySelector('.form-msg').textContent = '';
    sheet.showModal();
    setTimeout(() => sheetForm.name.focus(), 50);
  }
  sheetForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = sheetForm.querySelector('.form-msg'), name = sheetForm.name.value.trim();
    msg.textContent = '';
    if (!name) { msg.textContent = 'Въведи име.'; sheetForm.name.focus(); return; }
    const { mode, time } = sheetCtx;
    const args = { p_starts_at: shopTimeToIso(day, toMinutes(time)), p_customer_name: name, p_customer_phone: sheetForm.phone.value.trim(), p_notes: sheetForm.notes.value.trim() };
    const r = await call(mode === 'book' ? 'admin_book_slot' : 'admin_update_booking', args, $('#sheet-save'));
    if (!r.ok) {
      msg.textContent = errorText(r.error);
      if (r.error === 'slot_taken' || r.error === 'not_found') loadDay({ quiet: true });
      return;
    }
    sheet.close();
    toast(mode === 'book' ? `Запазено: ${time} · ${name}` : 'Промените са запазени');
    loadDay({ quiet: true });
  });

  // Cancel confirmation
  const confirmDlg = $('#confirm');
  let cancelCtx = null;
  function confirmCancel(time, s = {}) {
    cancelCtx = { time };
    $('#confirm-title').textContent = `Да отменя ли ${time}?`;
    $('#confirm-text').textContent = `${s.name || 'Този час'}${s.phone ? ' · ' + s.phone : ''}. Часът ще стане свободен за записване.`;
    confirmDlg.showModal();
  }
  $('#confirm-ok').addEventListener('click', async e => {
    const { time } = cancelCtx;
    const r = await call('admin_cancel_booking', { p_starts_at: shopTimeToIso(day, toMinutes(time)) }, e.currentTarget);
    confirmDlg.close();
    if (r.ok) toast(`${time} е отменен`); else toast(errorText(r.error), true);
    loadDay({ quiet: true });
  });

  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  // ---------- live updates ----------
  let reloadTimer;
  function subscribe() {
    if (channel) return;
    const live = $('#live'), label = live.querySelector('span');
    const onChange = change => {
      const row = change.eventType === 'DELETE' ? change.old : change.new;
      if (row && row.starts_at) {
        const { date, time } = isoToShop(row.starts_at);
        if (date !== day) return;
        flash.add(time);
      }
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => loadDay({ quiet: true }), 250);
    };
    channel = db.channel('admin-schedule')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'slot_status' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_details' }, onChange)
      .subscribe(status => {
        const on = status === 'SUBSCRIBED';
        live.dataset.state = on ? 'on' : 'off';
        label.textContent = on ? 'На живо' : 'Без връзка';
        if (on) loadDay({ quiet: true });          // pick up anything missed while reconnecting
      });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('#schedule').hidden) loadDay({ quiet: true });
  });
  setInterval(() => { if (!$('#schedule').hidden && !document.querySelector('dialog[open]')) render(); }, 60000);   // keep "now" / past styling current

  start();
})();
