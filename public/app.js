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
    } else {
      $('onboarding').hidden = true; $('chat').hidden = false; $('balance').hidden = false;
      const signText = m.profile.cuspSign
        ? `${m.profile.sign} (cusp with ${m.profile.cuspSign})` : m.profile.sign;
      $('chartLine').textContent =
        `☉ ${signText} · ${m.profile.element} · Life path ${m.profile.lifePath}`;
      $('chartLine').appendChild(resetBtn);
    }
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
    if (state.me.profile) {
      state.me.history.forEach((h) => addMessage(h.role, h.content));
      if (state.me.history.length === 0) startReading();
    }
    if (new URLSearchParams(location.search).get('paid')) history.replaceState({}, '', '/');
  })();
})();
