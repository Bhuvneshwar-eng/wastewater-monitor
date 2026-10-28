const COLORS = { ok: '#1b8a5a', warning: '#d9921a', danger: '#c62d2d', low: '#1f62c4' };
const LINE = { ph: '#1f9e9e', turbidity: '#a0722a', temperature: '#7b4fb3' };
const MAX_POINTS = 60;
let limits = {};
const charts = {};
const lastStatus = {};

const fmt = t => new Date(t).toLocaleTimeString();

function makeChart(key, canvas) {
  const l = limits[key];
  // Draw the safe band as dashed lines so people see where limits sit.
  const band = (v, name) => ({ data: [], borderColor: 'rgba(120,120,120,.6)', borderDash: [5, 4], borderWidth: 1, pointRadius: 0, label: name });
  charts[key] = new Chart(canvas, {
    type: 'line',
    data: { labels: [], datasets: [
      { label: l.label, data: [], borderColor: LINE[key], borderWidth: 2, pointRadius: 3, tension: .25, pointBackgroundColor: [] },
      band(l.okMin, 'safe min'), band(l.okMax, 'safe max')
    ] },
    options: {
      animation: false, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxTicksLimit: 5 } } }
    }
  });
}

function pushPoint(key, r) {
  const c = charts[key], l = limits[key], a = r.alerts[key];
  c.data.labels.push(fmt(r.time));
  c.data.datasets[0].data.push(r[key]);
  c.data.datasets[0].pointBackgroundColor.push(a.status === 'ok' ? LINE[key] : COLORS[a.status]);
  c.data.datasets[1].data.push(l.okMin);
  c.data.datasets[2].data.push(l.okMax);
  if (c.data.labels.length > MAX_POINTS) {
    c.data.labels.shift();
    c.data.datasets.forEach(d => d.data.shift());
    c.data.datasets[0].pointBackgroundColor.shift();
  }
}

function render(r) {
  let worst = 'ok';
  const problems = [];
  for (const key of Object.keys(limits)) {
    const l = limits[key], a = r.alerts[key];
    const card = document.querySelector(`.card[data-key="${key}"]`);
    // Colour by status; "too low" gets blue so low and high are distinguishable.
    const cls = a.status === 'ok' ? 'ok' : (a.direction === 'low' ? 'low' : a.status);
    card.className = 'card ' + cls;
    card.querySelector('.num').textContent = r[key].toFixed(key === 'turbidity' ? 0 : 1);
    card.querySelector('.unit').textContent = l.unit;
    card.querySelector('.range').textContent = `Safe range: ${l.okMin}–${l.okMax} ${l.unit}`.trim();
    card.querySelector('.badge').textContent =
      a.status === 'ok' ? 'Normal' : `${a.status === 'danger' ? 'Danger' : 'Warning'} · too ${a.direction}`;
    if (a.status !== 'ok') problems.push(`${l.label} too ${a.direction} (${r[key]} ${l.unit})`.trim());
    if (a.status === 'danger') worst = 'danger'; else if (a.status === 'warning' && worst !== 'danger') worst = 'warning';

    // log only when the status changes
    const sig = a.status + (a.direction || '');
    if (a.status !== 'ok' && lastStatus[key] !== sig) addLog(`${fmt(r.time)} · ${l.label} too ${a.direction}: ${r[key]} ${l.unit} (${a.status})`, a.status === 'danger' ? 'danger' : (a.direction === 'low' ? 'low' : ''));
    lastStatus[key] = sig;
  }
  const b = document.getElementById('banner');
  b.className = 'banner ' + worst;
  b.textContent = worst === 'ok' ? 'All parameters within safe range'
    : (worst === 'danger' ? 'DANGER: ' : 'Warning: ') + problems.join('; ');
}

function addLog(text, cls) {
  const ul = document.getElementById('log');
  ul.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  li.textContent = text; if (cls) li.className = cls;
  ul.prepend(li);
}

const conn = document.getElementById('conn');
const es = new EventSource('/events');
es.onopen = () => { conn.textContent = 'Live'; conn.className = 'conn'; };
es.onerror = () => { conn.textContent = 'Disconnected – retrying'; conn.className = 'conn off'; };
es.onmessage = e => {
  const d = JSON.parse(e.data);
  if (d.notification) { addNote(d.notification); return; }
  if (d.simState) { renderSim(d.simState); return; }
  if (d.pumpState && !d.init) { renderPumps(d.pumpState); return; }
  if (d.init) {
    limits = d.limits; renderPumps(d.pumpState);
    document.getElementById('simPanel').hidden = !d.simulate; if (d.simulate) renderSim(d.sim);
    d.notifications.forEach(addNote);
    document.querySelectorAll('.card').forEach(c => makeChart(c.dataset.key, c.querySelector('canvas')));
    d.history.slice(-MAX_POINTS).forEach(r => { Object.keys(limits).forEach(k => pushPoint(k, r)); });
    Object.values(charts).forEach(c => c.update());
    if (d.history.length) render(d.history[d.history.length - 1]);
    return;
  }
  Object.keys(limits).forEach(k => pushPoint(k, d));
  Object.values(charts).forEach(c => c.update());
  render(d);
};

// ---------- Pumps ----------
let pumpMode = 'auto';
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
}
function renderPumps(s) {
  pumpMode = s.mode;
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === s.mode));
  document.querySelectorAll('.pump').forEach(el => {
    const c = s.chems[el.dataset.chem];
    el.classList.toggle('on', c.on);
    el.querySelector('.dose').disabled = s.mode !== 'manual' || c.on || Date.now() < c.nextAllowed;
  });
  document.getElementById('pumpHint').textContent =
    s.mode === 'auto' ? `Auto: pumps run ${s.doseSeconds} s pulses when a reading is out of range, then wait ${s.cooldownSeconds} s before the next pulse.`
    : s.mode === 'manual' ? 'Manual: use the Dose buttons. Automatic dosing is paused.' : 'Off: all pumps stopped.';
}
document.getElementById('modes').addEventListener('click', e => { if (e.target.dataset.mode) post('/api/pump', { mode: e.target.dataset.mode }); });
document.querySelectorAll('.pump .dose').forEach(b => b.addEventListener('click', () =>
  post('/api/pump', { dose: b.closest('.pump').dataset.chem }).then(r => { if (r.error) alert(r.error); })));

// ---------- Report ----------
document.getElementById('repBtn').addEventListener('click', async () => {
  const r = await (await fetch('/api/report?hours=24')).json();
  const el = document.getElementById('report');
  if (!r.samples) { el.textContent = 'No readings saved in the last 24 hours.'; return; }
  const rows = Object.entries(r.parameters).map(([k, p]) =>
    `<tr><td>${limits[k].label}</td><td>${p.min}</td><td>${p.avg}</td><td>${p.max}</td><td>${p.pctOutOfRange}%</td></tr>`).join('');
  const doses = Object.entries(r.doses).map(([k, n]) => `${k}: ${n}`).join(', ') || 'none';
  el.innerHTML = `<table><tr><th>Parameter</th><th>Min</th><th>Average</th><th>Max</th><th>Time out of range</th></tr>${rows}</table>
    <p>${r.samples} samples · ${r.alerts} danger alerts · pump pulses: ${doses}</p>`;
});

// ---------- Notifications (simulated delivery) ----------
function addNote(n) {
  const ul = document.getElementById('notes');
  ul.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  li.innerHTML = `<small>${n.channel} · ${fmt(n.time)}</small>`;
  li.append(n.text);
  ul.prepend(li);
}

// ---------- Simulation controls ----------
let simState = {}, simTimer;
function renderSim(s) {
  simState = s;
  const tag = document.getElementById('simTag');
  clearInterval(simTimer);
  const draw = () => {
    if (s.scenario) {
      const left = Math.max(0, Math.round((s.until - Date.now()) / 1000));
      tag.textContent = `${s.label} · ${left}s left`; tag.className = 'badge simtag active';
    } else { tag.textContent = s.paused ? 'Paused' : 'Normal inflow'; tag.className = 'badge simtag'; }
  };
  draw(); if (s.scenario) simTimer = setInterval(draw, 1000);
  document.getElementById('simPause').textContent = s.paused ? 'Resume simulation' : 'Pause simulation';
  document.getElementById('simRandom').textContent = 'Random incidents: ' + (s.random ? 'on' : 'off');
}
document.getElementById('scenarios').addEventListener('click', e => { const k = e.target.dataset.scn; if (k) post('/api/sim', { scenario: k }); });
document.getElementById('simPause').addEventListener('click', () => post('/api/sim', { paused: !simState.paused }));
document.getElementById('simRandom').addEventListener('click', () => post('/api/sim', { random: !simState.random }));
