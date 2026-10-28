// Smart Wastewater Monitor - Node.js server (zero required dependencies)
// Run: node server.js   ->  http://localhost:3000
// Needs Node 18+ (uses built-in fetch). Email alerts additionally need: npm install nodemailer
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SIMULATE = process.env.SIMULATE !== '0';
const MAX_HISTORY = 300;
const DATA_DIR = path.join(__dirname, 'data');
const READINGS_CSV = path.join(DATA_DIR, 'readings.csv');
const EVENTS_CSV = path.join(DATA_DIR, 'events.csv');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Settings ----------
const LIMITS = {
  ph:          { label: 'pH',          unit: '',    okMin: 6.5, okMax: 8.5, warnMin: 6.0, warnMax: 9.0 },
  turbidity:   { label: 'Turbidity',   unit: 'NTU', okMin: 0,   okMax: 50,  warnMin: 0,   warnMax: 100 },
  temperature: { label: 'Temperature', unit: '°C',  okMin: 10,  okMax: 35,  warnMin: 5,   warnMax: 40 }
};

// Dosing: which pump fixes which problem. Pulse dosing = run briefly, wait for mixing, re-measure.
const CHEMICALS = {
  base: { label: 'Base (raises pH)',        trigger: r => r.ph < LIMITS.ph.okMin },
  acid: { label: 'Acid (lowers pH)',        trigger: r => r.ph > LIMITS.ph.okMax },
  coag: { label: 'Coagulant (clears water)', trigger: r => r.turbidity > LIMITS.turbidity.okMax }
};
const DOSE_SECONDS = SIMULATE ? 4 : 5;        // pump ON time per pulse
const COOLDOWN_SECONDS = SIMULATE ? 12 : 60;   // minimum wait between pulses of the same chemical
const MAX_PULSES_PER_HOUR = 20;// safety cap: stop auto-dosing if something is wrong (sensor fault, empty tank)

// Notifications (set env vars to enable)
const TG_TOKEN = process.env.TELEGRAM_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MAIL_TO = process.env.ALERT_EMAIL_TO;                 // plus SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
const NOTIFY_COOLDOWN_MS = SIMULATE ? 20 * 1000 : 5 * 60 * 1000;                    // per parameter

// ---------- State ----------
const history = [];
const clients = new Set();
const pump = { mode: 'auto', chems: {} };                    // mode: auto | manual | off
for (const c of Object.keys(CHEMICALS)) pump.chems[c] = { on: false, until: 0, nextAllowed: 0, pulses: [] };
const lastNotified = {};
const notifications = [];                                    // shown on the dashboard (simulated delivery when no credentials)

// ---------- CSV storage ----------
function appendCsv(file, header, line) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, header + '\n');
  fs.appendFile(file, line + '\n', () => {});
}
const esc = s => `"${String(s).replace(/"/g, '""')}"`;
function logReading(r) {
  appendCsv(READINGS_CSV, 'timestamp,ph,turbidity_ntu,temperature_c,ph_status,turbidity_status,temperature_status',
    [new Date(r.time).toISOString(), r.ph, r.turbidity, r.temperature,
     r.alerts.ph.status, r.alerts.turbidity.status, r.alerts.temperature.status].join(','));
}
function logEvent(type, detail) {
  appendCsv(EVENTS_CSV, 'timestamp,type,detail', `${new Date().toISOString()},${type},${esc(detail)}`);
}
function readCsv(file, hours) {
  if (!fs.existsSync(file)) return [];
  const since = Date.now() - hours * 3600e3;
  return fs.readFileSync(file, 'utf8').trim().split('\n').slice(1)
    .map(l => l.split(',')).filter(c => new Date(c[0]).getTime() >= since);
}

// ---------- Evaluate + notify ----------
function evaluate(key, v) {
  const l = LIMITS[key];
  if (v >= l.okMin && v <= l.okMax) return { status: 'ok', direction: null };
  const direction = v > l.okMax ? 'high' : 'low';
  return { status: v >= l.warnMin && v <= l.warnMax ? 'warning' : 'danger', direction };
}

async function notify(text) {
  const real = (TG_TOKEN && TG_CHAT) || (MAIL_TO && process.env.SMTP_HOST);
  const note = { time: Date.now(), channel: real ? 'Telegram / email' : 'Telegram / email (simulated)', text };
  notifications.push(note); if (notifications.length > 20) notifications.shift();
  broadcast({ notification: note });
  if (TG_TOKEN && TG_CHAT) {
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text })
    }).catch(e => console.error('Telegram failed:', e.message));
  }
  if (MAIL_TO && process.env.SMTP_HOST) {
    try {
      const nodemailer = require('nodemailer');            // optional dependency
      const t = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      t.sendMail({ from: process.env.SMTP_USER, to: MAIL_TO, subject: 'Wastewater DANGER alert', text })
        .catch(e => console.error('Email failed:', e.message));
    } catch { console.error('Email needs: npm install nodemailer'); }
  }
}

function checkAlerts(r) {
  for (const key of Object.keys(LIMITS)) {
    const a = r.alerts[key];
    if (a.status !== 'danger') continue;
    if (Date.now() - (lastNotified[key] || 0) < NOTIFY_COOLDOWN_MS) continue;
    lastNotified[key] = Date.now();
    const msg = `DANGER: ${LIMITS[key].label} too ${a.direction} - ${r[key]} ${LIMITS[key].unit}`.trim();
    logEvent('alert', msg);
    notify(msg);
  }
}

// ---------- Dosing control ----------
function startPulse(chem, why) {
  const c = pump.chems[chem], now = Date.now();
  c.pulses = c.pulses.filter(t => now - t < 3600e3);
  if (c.on || now < c.nextAllowed) return false;
  if (c.pulses.length >= MAX_PULSES_PER_HOUR) {
    if (!c.capWarned) { c.capWarned = true; const m = `${CHEMICALS[chem].label} hit ${MAX_PULSES_PER_HOUR} pulses/hour - check sensor and tank`; logEvent('pump-lockout', m); notify(m); }
    return false;
  }
  c.capWarned = false;
  c.on = true; c.until = now + DOSE_SECONDS * 1000; c.nextAllowed = c.until + COOLDOWN_SECONDS * 1000; c.pulses.push(now);
  logEvent('pump-on', `${chem} (${why})`);
  const k = 'pump-' + chem;                                    // tell operators when automation acts on its own
  if (why === 'auto' && now - (lastNotified[k] || 0) >= NOTIFY_COOLDOWN_MS) {
    lastNotified[k] = now; notify(`Auto-dosing started: ${CHEMICALS[chem].label} pump (${DOSE_SECONDS} s pulse)`);
  }
  return true;
}
function tickPumps(r) {
  const now = Date.now();
  for (const [chem, c] of Object.entries(pump.chems)) {
    if (c.on && now >= c.until) { c.on = false; logEvent('pump-off', chem); }
  }
  if (pump.mode === 'off') for (const c of Object.values(pump.chems)) c.on = false;
  if (pump.mode === 'auto' && r) {
    for (const [chem, def] of Object.entries(CHEMICALS)) if (def.trigger(r)) startPulse(chem, 'auto');
  }
}
const pumpPublic = () => ({ mode: pump.mode, doseSeconds: DOSE_SECONDS, cooldownSeconds: COOLDOWN_SECONDS,
  chems: Object.fromEntries(Object.entries(pump.chems).map(([k, c]) => [k,
    { label: CHEMICALS[k].label, on: c.on, nextAllowed: c.nextAllowed }])) });
const pumpCommand = () => Object.fromEntries(Object.entries(pump.chems).map(([k, c]) => [k, c.on ? 1 : 0]));
const broadcast = obj => { const m = `data: ${JSON.stringify(obj)}\n\n`; for (const res of clients) res.write(m); };

// ---------- Ingest ----------
function ingest(raw) {
  const r = { time: Date.now(), alerts: {} };
  for (const key of Object.keys(LIMITS)) {
    const v = Number(raw[key]);
    if (!Number.isFinite(v)) return null;
    r[key] = Math.round(v * 100) / 100;
    r.alerts[key] = evaluate(key, v);
  }
  history.push(r); if (history.length > MAX_HISTORY) history.shift();
  logReading(r); checkAlerts(r); tickPumps(r);
  broadcast(r); broadcast({ pumpState: pumpPublic() });
  return r;
}
setInterval(() => { tickPumps(null); broadcast({ pumpState: pumpPublic() }); }, 1000); // expire pulses on time

// ---------- Simulator (the demo data source) ----------
const SCENARIOS = {
  acid:   { label: 'Acid spill',          target: { ph: 5.2 } },
  alkali: { label: 'Alkaline discharge',  target: { ph: 9.8 } },
  mud:    { label: 'Muddy storm inflow',  target: { turbidity: 160 } },
  heat:   { label: 'Hot industrial discharge', target: { temperature: 42 } }
};
const SCENARIO_SECONDS = 45;
let sim = { ph: 7.3, turbidity: 30, temperature: 25, scenario: null, until: 0, paused: false, random: false };
function simPublic() {
  return { scenario: sim.scenario, label: sim.scenario ? SCENARIOS[sim.scenario].label : null, until: sim.until, paused: sim.paused, random: sim.random, seconds: SCENARIO_SECONDS };
}
function simulateStep() {
  if (sim.paused) return;
  if (sim.scenario && Date.now() > sim.until) { sim.scenario = null; broadcast({ simState: simPublic() }); }
  if (sim.random && !sim.scenario && Math.random() < 0.04) {
    const keys = Object.keys(SCENARIOS); sim.scenario = keys[Math.floor(Math.random() * keys.length)];
    sim.until = Date.now() + SCENARIO_SECONDS * 1000; broadcast({ simState: simPublic() });
  }
  const target = Object.assign({ ph: 7.3, turbidity: 30, temperature: 25 }, sim.scenario ? SCENARIOS[sim.scenario].target : {});
  const pull = sim.scenario ? 0.12 : 0.2;
  sim.ph          += (target.ph - sim.ph) * pull + (Math.random() - .5) * 0.1;
  sim.turbidity   += (target.turbidity - sim.turbidity) * pull + (Math.random() - .5) * 4;
  sim.temperature += (target.temperature - sim.temperature) * pull + (Math.random() - .5) * 0.2;
  // dosing pumps act on the simulated water, so the control loop is visible in the graphs
  if (pump.chems.base.on) sim.ph += 0.8;
  if (pump.chems.acid.on) sim.ph -= 0.8;
  if (pump.chems.coag.on) sim.turbidity -= 25;
  sim.ph = Math.min(14, Math.max(0, sim.ph)); sim.turbidity = Math.max(0, sim.turbidity);
  ingest(sim);
}
// Pre-fill 1 hour of history (with two incidents) so reports have data on the first run.
function seedHistory() {
  if (fs.existsSync(READINGS_CSV)) return;
  const now = Date.now(), n = 360, rows = [], ev = [];
  for (let i = 0; i < n; i++) {
    const t = now - (n - i) * 10000;
    let ph = 7.3 + (Math.random() - .5) * .3, tu = 30 + (Math.random() - .5) * 8, te = 25 + (Math.random() - .5) * .6;
    if (i > 100 && i < 125) ph = 5.9 + (Math.random() - .5) * .3;     // acid incident
    if (i > 250 && i < 268) tu = 85 + (Math.random() - .5) * 20;      // muddy inflow
    const a = { ph: evaluate('ph', ph), turbidity: evaluate('turbidity', tu), temperature: evaluate('temperature', te) };
    rows.push([new Date(t).toISOString(), ph.toFixed(2), tu.toFixed(1), te.toFixed(1), a.ph.status, a.turbidity.status, a.temperature.status].join(','));
  }
  const at = i => new Date(now - (n - i) * 10000).toISOString();
  ev.push(`${at(102)},alert,"DANGER: pH too low - 5.9"`, `${at(102)},pump-on,"base (auto)"`, `${at(112)},pump-on,"base (auto)"`, `${at(255)},pump-on,"coag (auto)"`);
  fs.writeFileSync(READINGS_CSV, 'timestamp,ph,turbidity_ntu,temperature_c,ph_status,turbidity_status,temperature_status\n' + rows.join('\n') + '\n');
  fs.writeFileSync(EVENTS_CSV, 'timestamp,type,detail\n' + ev.join('\n') + '\n');
}
if (SIMULATE) { seedHistory(); setInterval(simulateStep, 2000); }

// ---------- Reports ----------
function report(hours) {
  const rows = readCsv(READINGS_CSV, hours);
  const out = { hours, samples: rows.length, parameters: {}, doses: {}, alerts: 0 };
  const cols = { ph: [1, 4], turbidity: [2, 5], temperature: [3, 6] };
  for (const [k, [vi, si]] of Object.entries(cols)) {
    const vals = rows.map(c => +c[vi]);
    out.parameters[k] = rows.length ? {
      min: Math.min(...vals), max: Math.max(...vals),
      avg: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
      pctOutOfRange: +(100 * rows.filter(c => c[si] !== 'ok').length / rows.length).toFixed(1)
    } : null;
  }
  for (const e of readCsv(EVENTS_CSV, hours)) {
    if (e[1] === 'alert') out.alerts++;
    if (e[1] === 'pump-on') { const chem = e[2].replace(/"/g, '').split(' ')[0]; out.doses[chem] = (out.doses[chem] || 0) + 1; }
  }
  return out;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req, cb) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { cb(JSON.parse(b)); } catch { cb(null); } }); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), url = u.pathname;

  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ init: true, limits: LIMITS, history, pumpState: pumpPublic(), notifications, simulate: SIMULATE, sim: simPublic() })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }

  if (url === '/api/data' && req.method === 'POST') {          // ESP32 posts readings, gets pump commands back
    return readBody(req, b => {
      const r = b && ingest(b);
      r ? json(res, 200, { ok: true, pumps: pumpCommand() }) : json(res, 400, { error: 'need numeric ph, turbidity, temperature' });
    });
  }

  if (url === '/api/pump' && req.method === 'POST') {          // dashboard controls
    return readBody(req, b => {
      if (!b) return json(res, 400, { error: 'bad json' });
      if (b.mode) {
        if (!['auto', 'manual', 'off'].includes(b.mode)) return json(res, 400, { error: 'bad mode' });
        pump.mode = b.mode; logEvent('mode', b.mode);
        if (b.mode === 'off') tickPumps(null);
      }
      if (b.dose) {
        if (pump.mode !== 'manual') return json(res, 409, { error: 'switch to manual mode first' });
        if (!pump.chems[b.dose] || !startPulse(b.dose, 'manual')) return json(res, 409, { error: 'pump busy or cooling down' });
      }
      broadcast({ pumpState: pumpPublic() }); json(res, 200, { ok: true });
    });
  }

  if (url === '/api/sim' && req.method === 'POST') {          // demo controls
    return readBody(req, b => {
      if (!SIMULATE) return json(res, 409, { error: 'simulator is off' });
      if (!b) return json(res, 400, { error: 'bad json' });
      if (b.scenario === 'clear') sim.scenario = null;
      else if (b.scenario) {
        if (!SCENARIOS[b.scenario]) return json(res, 400, { error: 'unknown scenario' });
        sim.scenario = b.scenario; sim.until = Date.now() + SCENARIO_SECONDS * 1000;
        logEvent('scenario', SCENARIOS[b.scenario].label);
      }
      if (typeof b.paused === 'boolean') sim.paused = b.paused;
      if (typeof b.random === 'boolean') sim.random = b.random;
      broadcast({ simState: simPublic() }); json(res, 200, { ok: true });
    });
  }

  if (url === '/api/history.csv') {                            // download for reports
    const hours = +u.searchParams.get('hours') || 24;
    const body = 'timestamp,ph,turbidity_ntu,temperature_c,ph_status,turbidity_status,temperature_status\n' +
      readCsv(READINGS_CSV, hours).map(c => c.join(',')).join('\n') + '\n';
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="wastewater_report.csv"' });
    return res.end(body);
  }
  if (url === '/api/report') return json(res, 200, report(+u.searchParams.get('hours') || 24));

 const file = path.join(__dirname, url === '/' ? 'index.html' : url);
 if (!file.startsWith(__dirname + path.sep)) {
    res.writeHead(403);
    return res.end();
}
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}  (simulator ${SIMULATE ? 'ON' : 'OFF'}, Telegram ${TG_TOKEN ? 'ON' : 'off'}, email ${MAIL_TO ? 'ON' : 'off'})`));
