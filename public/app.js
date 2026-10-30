(() => {
  const $ = (id) => document.getElementById(id);
  const state = { me: null, seconds: 0, busy: false };

  // Starfield
  const stars = $('stars');
  for (let i = 0; i < 70; i++) {
    const s = document.createElement('i');
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.animationDelay = Math.random() * 4 + 's';
    s.style.transform = `scale(${0.6 + Math.random() * 1.2})`;
    stars.appendChild(s);
  }

  const money = (cents) => '$' + (cents / 100).toFixed(2).replace(/\.00$/, '');
  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  async function api(path, body) {
    const res = await fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function setBalance(sec) {
    state.seconds = Math.max(0, sec);
    $('balanceText').textContent = clock(state.seconds);
    $('balance').classList.toggle('low', state.seconds > 0 && state.seconds <= 60);
  }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'you' : 'luna');
    String(text).split(/\n{2,}/).forEach((para) => {
      const p = document.createElement('p');
      p.textContent = para;
      div.appendChild(p);
    });
    $('messages').appendChild(div);
    $('messages').scrollTop = $('messages').scrollHeight;
    return div;
  }

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = 'Start over';
  resetBtn.style.cssText = 'background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font:inherit;font-size:.85rem;margin-left:12px;padding:0';

  function render() {
    const m = state.me;
    const p = m.pricing;
    $('trialLine').textContent = m.balanceSeconds > 0 && !m.profile
      ? `✦ Your first ${p.trialMinutes} minutes are free.` : '';
    $('badge').hidden = !m.subscribed;
    $('accountBtn').textContent = m.email ? 'Account' : 'Sign in';
    setBalance(m.balanceSeconds);

    // pricing copy
    $('subTitle').textContent = `Membership · ${money(p.subscriptionCents)}/month`;
    $('subDetail').textContent = `${p.subscriptionMinutes} minutes included each month`;
    $('packs').innerHTML = '';
    p.packs.forEach((n) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pack';
      b.innerHTML = '<b></b><span class="muted"></span>';
      b.firstChild.textContent = `${n} min`;
      b.lastChild.textContent = money(n * p.perMinuteCents);
      b.addEventListener('click', () => checkout('minutes', n));
      $('packs').appendChild(b);
    });
    $('modeNote').textContent = m.modes.devBilling
      ? 'Test mode: no real charges. Buttons add time instantly.' : '';

    if (!m.profile) {
      $('onboarding').hidden = false; $('chat').hidden = true; $('balance').hidden = true;
      $('chartToggle').hidden = true; $('chartPanel').hidden = true;
      $('menuSky').hidden = true;
      $('tarotToggle').hidden = true; $('tarotPanel').hidden = true;
      $('compatToggle').hidden = true; $('compatPanel').hidden = true;
      $('quickChips').hidden = true;
    } else {
      $('onboarding').hidden = true; $('chat').hidden = false; $('balance').hidden = false;
      const signText = m.profile.cuspSign
        ? `${m.profile.sign} (cusp with ${m.profile.cuspSign})` : m.profile.sign;
      let line = `☉ ${signText} · ${m.profile.element} · Life path ${m.profile.lifePath}`;
      const ch = m.chart;
      if (ch && Array.isArray(ch.planets)) {
        const moon = ch.planets.find((p) => p.key === 'moon');
        if (moon) line += ` · ☽ ${moon.sign}`;
        if (ch.ascendant) line += ` · ↑ ${ch.ascendant.sign}`;
      }
      $('chartLine').textContent = line;
      $('chartLine').appendChild(resetBtn);
      $('chartToggle').hidden = !ch;
      $('menuSky').hidden = !ch;
      if (!ch) $('chartPanel').hidden = true;
      else if (state.chartFor !== ch) { state.chartFor = ch; buildChartPanel(ch); loadSky(); }
      $('quickChips').hidden = false;
      $('tarotToggle').hidden = false;
      if (m.tarot && state.tarotFor !== m.tarot) { state.tarotFor = m.tarot; renderDraw(m.tarot); }
      $('compatToggle').hidden = false;
      const compat = m.profile && m.profile.compat;
      if (compat && state.compatFor !== compat) { state.compatFor = compat; renderCompat(compat); }
    }
  }

  // ---- Tarot ----
  const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
    'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];
  function renderDraw(draw) {
    const wrap = $('tarotCards');
    wrap.innerHTML = '';
    draw.cards.forEach((c, i) => {
      const div = document.createElement('div');
      div.className = 'tarot-card';
      div.style.animationDelay = (i * 0.12) + 's';
      const pos = document.createElement('div');
      pos.className = 'tc-pos'; pos.textContent = c.position;
      const face = document.createElement('div');
      face.className = 'tc-face' + (c.reversed ? ' tc-rev-glyph' : '');
      face.textContent = c.arcana === 'major' ? ROMAN[c.numeral] : (c.glyph || '');
      const name = document.createElement('div');
      name.className = 'tc-name'; name.textContent = c.name;
      const orient = document.createElement('div');
      orient.className = 'tc-orient'; orient.textContent = c.reversed ? 'Reversed' : 'Upright';
      const meaning = document.createElement('div');
      meaning.className = 'tc-meaning'; meaning.textContent = c.meaning;
      div.append(pos, face, name, orient, meaning);
      wrap.appendChild(div);
    });
    $('tarotAsk').hidden = false;
  }

  async function doDraw(spread) {
    const r = await api('tarot', { spread });
    if (!r.ok) { addMessage('luna', r.data.error || 'The cards would not shuffle. Try again?'); return; }
    state.me.tarot = r.data.tarot;
    state.tarotFor = r.data.tarot;
    renderDraw(r.data.tarot);
  }

  // ---- Birth chart panel ----
  const SIGN_GLYPHS = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];
  // The wheel is drawn with the ascendant at the left horizon and signs
  // running counter-clockwise, the way printed charts look. All values in
  // the SVG come from the server's own tables (sign and planet names), so
  // building it as a string is safe.
  const pt = (lon, r) => {
    const t = (180 - lon) * Math.PI / 180;
    return [140 + r * Math.cos(t), 140 - r * Math.sin(t)];
  };
  function wheelSvg(ch) {
    let s = '<svg viewBox="0 0 280 280" width="280" height="280" role="img" aria-label="Your birth chart wheel">';
    s += '<circle cx="140" cy="140" r="132" fill="none" stroke="rgba(255,255,255,.25)"/>';
    s += '<circle cx="140" cy="140" r="100" fill="none" stroke="rgba(255,255,255,.14)"/>';
    s += '<circle cx="140" cy="140" r="58" fill="none" stroke="rgba(255,255,255,.14)"/>';
    for (let i = 0; i < 12; i++) {
      const [x1, y1] = pt(i * 30, 100); const [x2, y2] = pt(i * 30, 132);
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,.14)"/>`;
      const [gx, gy] = pt(i * 30 + 15, 116);
      s += `<text x="${gx.toFixed(1)}" y="${(gy + 5).toFixed(1)}" text-anchor="middle" font-size="15" fill="#a9a3d6">${SIGN_GLYPHS[i]}</text>`;
    }
    if (ch.ascendant) {
      const [ax, ay] = pt(ch.ascendant.longitude, 132);
      const [bx, by] = pt(ch.ascendant.longitude, 58);
      s += `<line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="#f4c76a" stroke-width="1.6"/>`;
      const [tx, ty] = pt(ch.ascendant.longitude, 46);
      s += `<g class="hit" data-kind="rising"><circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="11" fill="transparent"/><text x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="#f4c76a">ASC</text></g>`;
      for (let h = 1; h <= 12; h++) {
        const [hx, hy] = pt(ch.ascendant.longitude + (h - 1) * 30 + 15, 47);
        s += `<g class="hit" data-kind="house" data-house="${h}"><circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="10" fill="transparent"/><text x="${hx.toFixed(1)}" y="${(hy + 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="#8A8A93">${h}</text></g>`;
      }
    }
    const sorted = [...ch.planets].sort((a, b) => a.longitude - b.longitude);
    let prevLon = -99; let prevR = 76;
    sorted.forEach((p) => {
      let r = 76;
      if (p.longitude - prevLon < 10 && prevR === 76) r = 64;
      prevLon = p.longitude; prevR = r;
      const [x, y] = pt(p.longitude, r);
      s += `<g class="hit" data-kind="planet" data-name="${p.name}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="transparent"/><text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="middle" font-size="15" fill="#f4c76a">${p.glyph}</text></g>`;
    });
    return s + '</svg>';
  }

  function buildChartPanel(ch) {
    state.chart = ch;
    $('chartWheel').innerHTML = wheelSvg(ch);
    const list = $('chartList');
    list.innerHTML = '';
    const addRow = (glyph, text, onTap) => {
      const li = document.createElement('li');
      const g = document.createElement('span');
      g.className = 'pl-glyph'; g.textContent = glyph;
      li.appendChild(g);
      li.appendChild(document.createTextNode(text));
      if (onTap) { li.className = 'tappable'; li.addEventListener('click', onTap); }
      list.appendChild(li);
    };
    if (ch.ascendant) {
      addRow('↑', `Rising in ${ch.ascendant.sign} · ${ch.ascendant.degreeInSign}°`
        + (ch.ascendant.cusp ? ' · near a sign cusp' : ''),
        () => showPop(`Rising in ${ch.ascendant.sign}`, state.describe && state.describe.rising));
    }
    ch.planets.forEach((p) => {
      addRow(p.glyph, `${p.name} in ${p.sign} · ${p.degreeInSign}°`
        + (p.house ? ` · House ${p.house}` : '')
        + (p.retrograde ? ' · Retrograde' : '')
        + (p.cusp ? ' · near a sign cusp' : ''),
        () => showPop(`${p.name} in ${p.sign}`, state.describe && state.describe.planets[p.name]));
    });
    $('chartAspects').textContent = ch.aspects && ch.aspects.length
      ? 'Aspects: ' + ch.aspects.map((a) => `${a.a} ${a.type.toLowerCase()} ${a.b}`).join(' · ')
      : '';
    $('chartNote').textContent = ch.hasTime && ch.hasPlace
      ? 'Computed from your birth date, time and place. Asking Luna about it uses reading time, like any message.'
      : 'Add your birth time and birth place (tap Start over) to unlock your rising sign and houses. Asking Luna about your chart uses reading time, like any message.';
  }

  // ---- Sky: placement pop-ups + the transit feed ----
  function showPop(title, text) {
    if (!text) return;
    $('chartPopTitle').textContent = title;
    $('chartPopText').textContent = text;
    $('chartPop').hidden = false;
    $('chartPop').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  const ASPECT_VERB = {
    conjunction: 'merges with', sextile: 'gives a friendly lift to',
    square: 'pushes against', trine: 'flows easily with', opposition: 'pulls opposite',
  };
  const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];

  async function loadSky() {
    const [chartRes, transitRes] = await Promise.all([api('chart'), api('transits')]);
    if (chartRes.ok) state.describe = chartRes.data.describe || null;
    if (transitRes.ok && Array.isArray(transitRes.data.transits)) {
      state.transits = transitRes.data.transits;
      $('feedSection').hidden = state.transits.length === 0;
      renderFeed();
    }
  }

  function renderFeed() {
    const list = $('feedList');
    list.innerHTML = '';
    const range = state.feedRange || 'today';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const within = (t, days) => {
      const exact = new Date(t.exact + 'T12:00:00');
      return exact >= new Date(today.getTime() - 86400000) && exact <= new Date(today.getTime() + days * 86400000);
    };
    const items = (state.transits || []).filter((t) =>
      range === 'today' ? true : range === 'week' ? within(t, 7) : within(t, 30));
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent = range === 'today'
        ? 'A quiet sky today — nothing is pressing on your chart.'
        : `Nothing peaks ${range === 'week' ? 'this week' : 'this month'} — your active transits are the slower, longer kind. See Today for what is live now.`;
      list.appendChild(p);
      return;
    }
    items.forEach((t) => {
      const div = document.createElement('div');
      div.className = 'feed-item';
      const tag = document.createElement('span');
      tag.className = 'tag'; tag.textContent = t.tag;
      const title = document.createElement('div');
      title.className = 'feed-title';
      title.textContent = `${t.transit} ${ASPECT_VERB[t.aspect] || t.aspect} your ${t.natal}`;
      const meta = document.createElement('div');
      meta.className = 'muted small';
      meta.textContent = `${t.applying ? 'Building' : 'Fading'} · peaks ${t.exact}`;
      div.append(tag, title, meta);
      div.addEventListener('click', () =>
        showPop(`${t.transit} & your ${t.natal}`, `${t.line} It peaks on ${t.exact}.`));
      list.appendChild(div);
    });
  }

  function openPaywall(outOfTime) {
    $('pwLead').textContent = outOfTime
      ? 'Your reading time has run out. Pick up right where you left off.'
      : 'Add reading time or become a member.';
    $('pwError').textContent = '';
    $('paywall').hidden = false;
  }

  async function checkout(plan, minutes) {
    $('pwError').textContent = '';
    const r = await api('checkout', { plan, minutes });
    if (!r.ok) { $('pwError').textContent = r.data.error || 'Something went wrong.'; return; }
    if (r.data.url) { window.location = r.data.url; return; }
    state.me = r.data; render();
    $('paywall').hidden = true;
    if (state.me.history.length === 0 && state.me.profile) startReading();
  }

  async function send(text, showUser = true) {
    if (state.busy) return;
    state.busy = true; $('sendBtn').disabled = true;
    if (showUser) addMessage('user', text);
    const typing = addMessage('luna', 'Luna is reading the sky...');
    typing.classList.add('typing');
    const r = await api('chat', { message: text });
    typing.remove();
    state.busy = false; $('sendBtn').disabled = false;
    if (r.status === 402) { setBalance(0); openPaywall(true); return; }
    if (!r.ok) { addMessage('luna', r.data.error || 'Something went wrong.'); return; }
    addMessage('luna', r.data.reply);
    setBalance(r.data.balanceSeconds);
    if (r.data.balanceSeconds <= 0) openPaywall(true);
  }

  const startReading = () => send('Please begin my reading.', false);

  // Events
  $('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('formError').textContent = '';
    const f = Object.fromEntries(new FormData(e.target));
    const r = await api('profile', f);
    if (!r.ok) { $('formError').textContent = r.data.error; return; }
    state.me = r.data; render();
    $('messages').innerHTML = '';
    startReading();
  });
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    if (state.seconds <= 0) { openPaywall(true); return; }
    $('chatInput').value = '';
    send(text);
  });
  $('chartToggle').addEventListener('click', () => {
    $('chartPanel').hidden = !$('chartPanel').hidden;
  });
  $('menuChat').addEventListener('click', () => {
    $('chatInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('chatInput').focus({ preventScroll: true });
  });
  $('menuSky').addEventListener('click', () => {
    $('chartPanel').hidden = false;
    const feed = $('feedSection');
    const target = feed && !feed.hidden ? feed : $('chartPanel');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('chartAsk').addEventListener('click', () => {
    if (state.seconds <= 0) { openPaywall(true); return; }
    $('chartPanel').hidden = true;
    send('Tell me about my birth chart — what stands out to you?');
  });
  $('chartWheel').addEventListener('click', (e) => {
    const g = e.target.closest('[data-kind]');
    if (!g || !state.describe) return;
    const ch = state.chart;
    if (g.dataset.kind === 'planet') {
      const p = ch && ch.planets.find((pl) => pl.name === g.dataset.name);
      if (p) showPop(`${p.name} in ${p.sign}`, state.describe.planets[p.name]);
    } else if (g.dataset.kind === 'house') {
      const h = Number(g.dataset.house);
      showPop(`Your ${ORDINAL[h - 1]} house`, state.describe.houses[h]);
    } else if (g.dataset.kind === 'rising' && ch && ch.ascendant) {
      showPop(`Rising in ${ch.ascendant.sign}`, state.describe.rising);
    }
  });
  $('chartPopClose').addEventListener('click', () => { $('chartPop').hidden = true; });
  document.querySelectorAll('.range-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.range-chip').forEach((c) => c.classList.toggle('active', c === chip));
      state.feedRange = chip.dataset.range;
      renderFeed();
    });
  });
  $('feedAsk').addEventListener('click', () => {
    if (state.seconds <= 0) { openPaywall(true); return; }
    $('chartPanel').hidden = true;
    send("What do today's transits mean for me?");
  });
  $('quickChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-q]');
    if (!btn) return;
    if (state.seconds <= 0) { openPaywall(true); return; }
    send(btn.dataset.q);
  });
  // ---- Compatibility ----
  const CAT_LABELS = { communication: 'Communication', chemistry: 'Romantic Chemistry', growth: 'Long-Term Growth' };
  function renderCompat(c) {
    $('compatForm').hidden = true;
    $('compatResult').hidden = false;
    const cats = $('compatCats');
    cats.innerHTML = '';
    for (const [key, v] of Object.entries(c.categories)) {
      const row = document.createElement('div');
      row.className = 'cat-row';
      const head = document.createElement('div');
      head.className = 'cat-head';
      const label = document.createElement('span'); label.textContent = CAT_LABELS[key] || key;
      const score = document.createElement('strong'); score.textContent = `${v.score}/100`;
      head.append(label, score);
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('div');
      fill.className = 'fill'; fill.style.width = v.score + '%';
      bar.appendChild(fill);
      const line = document.createElement('p');
      line.className = 'muted small'; line.textContent = v.line;
      row.append(head, bar, line);
      cats.appendChild(row);
    }
    const t = $('compatTable');
    const bt = c.bigThree;
    t.innerHTML = '';
    const mkRow = (cells, header) => {
      const tr = document.createElement('tr');
      cells.forEach((txt) => {
        const cell = document.createElement(header ? 'th' : 'td');
        cell.textContent = txt || '—';
        tr.appendChild(cell);
      });
      t.appendChild(tr);
    };
    mkRow(['', 'You', c.name], true);
    mkRow(['Sun', bt.you.sun, bt.them.sun]);
    mkRow(['Moon', bt.you.moon, bt.them.moon]);
    mkRow(['Rising', bt.you.rising, bt.them.rising]);
    const highs = $('compatHighs');
    highs.innerHTML = '';
    (c.highlights || []).forEach((h) => {
      const li = document.createElement('li');
      li.textContent = `Your ${h.a} ${h.type} their ${h.b} — ${h.line}`;
      highs.appendChild(li);
    });
    $('compatAsk').textContent = `Ask Luna about you and ${c.name}`;
  }

  $('compatToggle').addEventListener('click', () => {
    $('compatPanel').hidden = !$('compatPanel').hidden;
  });
  $('compatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('compatError').textContent = '';
    const fd = new FormData(e.target);
    const r = await api('compatibility', {
      name: fd.get('name'), dob: fd.get('dob'),
      birthTime: fd.get('birthTime'), birthPlace: fd.get('birthPlace'),
    });
    if (!r.ok) { $('compatError').textContent = r.data.error || 'Something went wrong.'; return; }
    if (state.me && state.me.profile) state.me.profile.compat = r.data.compat;
    state.compatFor = r.data.compat;
    renderCompat(r.data.compat);
  });
  $('compatAsk').addEventListener('click', () => {
    if (state.seconds <= 0) { openPaywall(true); return; }
    const c = state.compatFor;
    if (!c) return;
    $('compatPanel').hidden = true;
    send(`What does my compatibility with ${c.name} look like?`);
  });
  $('compatReset').addEventListener('click', () => {
    $('compatResult').hidden = true;
    $('compatForm').hidden = false;
  });
  $('tarotToggle').addEventListener('click', () => {
    $('tarotPanel').hidden = !$('tarotPanel').hidden;
  });
  $('spreadOne').addEventListener('click', () => doDraw('one'));
  $('spreadThree').addEventListener('click', () => doDraw('three'));
  $('tarotAsk').addEventListener('click', () => {
    if (state.seconds <= 0) { openPaywall(true); return; }
    const t = state.me.tarot;
    if (!t) return;
    $('tarotPanel').hidden = true;
    const names = t.cards.map((c) => `${c.name}${c.reversed ? ' (reversed)' : ''}`).join(', ');
    send(`I drew these cards: ${names}. What do they mean for me?`);
  });
  $('balance').addEventListener('click', () => openPaywall(false));
  $('pwClose').addEventListener('click', () => { $('paywall').hidden = true; });
  $('subBtn').addEventListener('click', () => checkout('subscription'));
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Start over with new birth details? Your remaining time is kept.')) return;
    const r = await api('reset', {});
    if (!r.ok) return;
    state.me = r.data;
    $('messages').innerHTML = '';
    $('profileForm').reset();
    render();
  });

  // Account: sign in / create account / forgot password / reset.
  // After a successful sign-in, registration, or logout the page reloads so
  // the session, balance, and chat history are rebuilt from the new session.
  const resetToken = new URLSearchParams(location.search).get('reset') || '';
  function openAccount(mode) {
    const signedIn = !!(state.me && state.me.email);
    $('acctLoggedOut').hidden = signedIn || mode === 'resetConfirm';
    $('acctLoggedIn').hidden = !signedIn || mode === 'resetConfirm';
    $('acctForm').hidden = mode !== 'login';
    $('acctResetRequestForm').hidden = mode !== 'resetRequest';
    $('acctResetConfirmForm').hidden = mode !== 'resetConfirm';
    $('acctError').textContent = '';
    $('acctResetRequestMsg').textContent = '';
    $('acctResetConfirmMsg').textContent = '';
    if (signedIn) $('acctEmail').textContent = state.me.email;
    $('accountModal').hidden = false;
  }
  $('accountBtn').addEventListener('click', () => openAccount('login'));
  $('acctClose').addEventListener('click', () => { $('accountModal').hidden = true; });
  $('acctForgotBtn').addEventListener('click', () => openAccount('resetRequest'));
  $('acctBackBtn').addEventListener('click', () => openAccount('login'));
  $('acctForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('acctError').textContent = '';
    const r = await api('login', Object.fromEntries(new FormData(e.target)));
    if (!r.ok) { $('acctError').textContent = r.data.error || 'Something went wrong.'; return; }
    location.reload();
  });
  $('acctRegisterBtn').addEventListener('click', async () => {
    $('acctError').textContent = '';
    const r = await api('register', Object.fromEntries(new FormData($('acctForm'))));
    if (!r.ok) { $('acctError').textContent = r.data.error || 'Something went wrong.'; return; }
    location.reload();
  });
  $('acctResetRequestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('reset-request', Object.fromEntries(new FormData(e.target)));
    $('acctResetRequestMsg').textContent = r.data.message
      || 'If an account exists for that email, a password reset link has been sent.';
  });
  $('acctResetConfirmForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('acctResetConfirmMsg').textContent = '';
    const f = Object.fromEntries(new FormData(e.target));
    const r = await api('reset-confirm', { token: resetToken, password: f.password });
    if (!r.ok) { $('acctResetConfirmMsg').textContent = r.data.error || 'Something went wrong.'; return; }
    history.replaceState({}, '', '/');
    openAccount('login');
    $('acctError').textContent = 'Password updated. You can sign in now.';
  });
  $('acctLogoutBtn').addEventListener('click', async () => {
    await api('logout', {});
    location.reload();
  });

  // Local countdown for display + server heartbeat for actual billing
  setInterval(() => {
    if (!state.me || !state.me.profile || document.hidden || state.seconds <= 0) return;
    setBalance(state.seconds - 1);
    if (state.seconds === 0) openPaywall(true);
  }, 1000);
  setInterval(async () => {
    if (!state.me || !state.me.profile || document.hidden || state.seconds <= 0) return;
    const r = await api('tick', {});
    if (r.ok) setBalance(r.data.balanceSeconds);
  }, 10000);

  // Boot
  (async () => {
    const r = await api('me');
    state.me = r.data; render();
    if (state.me.profile && !state.me.chart) {
      // Profiles from before the chart feature get theirs on first load.
      const cr = await api('chart');
      if (cr.ok && cr.data.chart) { state.me.chart = cr.data.chart; render(); }
    }
    if (state.me.profile) {
      state.me.history.forEach((h) => addMessage(h.role, h.content));
      if (state.me.history.length === 0) startReading();
    }
    if (new URLSearchParams(location.search).get('paid')) history.replaceState({}, '', '/');
    if (resetToken) openAccount('resetConfirm');
  })();
})();
