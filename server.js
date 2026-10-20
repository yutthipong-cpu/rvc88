// Shirt Vote server: serves the static site and stores votes in one shared JSON file.
// No dependencies — run with `node server.js` (Node 18+).
//
// Environment:
//   PORT               port to listen on (default 3000)
//   DATA_DIR           where votes.json is kept (default ./data)
//   ADMIN_KEY          password for the results page, downloads and clearing votes (no default: set it, or admin is off)
//   VOTING_OPEN        starting value of the open/close switch before the admin first sets it (default true)
//   ALLOW_CHANGE_VOTE  "false" blocks editing a vote (default true)
//   HIDE_RESULTS       "true" hides the per-design results (default false)
//   SAMPLE_DATA        "true" shows generated sample votes on the results page (default false)

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const flag = (name, def) => { const v = process.env[name]; return v == null || v === '' ? def : /^(1|true|yes)$/i.test(v); };
const CONFIG = {
  votingOpen: flag('VOTING_OPEN', true),
  allowChangeVote: flag('ALLOW_CHANGE_VOTE', true),
  hideResults: flag('HIDE_RESULTS', false),
  sampleData: flag('SAMPLE_DATA', false),
  adminEnabled: !!ADMIN_KEY
};

const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const DESIGN_IDS = ['1', '2', '3'];
const GROUP_LABEL = { 'ลูกจ้างชั่วคราว': 'เจ้าหน้าที่ธุรการ (ลูกจ้างชั่วคราว)' };
const OTHER_DEPT = 'อื่นๆ';

// Staff list is the source of truth for who may vote and their department.
const staffByName = new Map(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'staff.json'), 'utf8'))
    .map(([name, g]) => [name, GROUP_LABEL[g] || g])
);

fs.mkdirSync(DATA_DIR, { recursive: true });
let votes = [];
try { votes = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

// Writes go to a temp file then rename, so a crash never leaves a half-written file.
let writing = Promise.resolve();
function persist() {
  const data = JSON.stringify(votes, null, 1);
  writing = writing.then(() => fs.promises.writeFile(VOTES_FILE + '.tmp', data))
    .then(() => fs.promises.rename(VOTES_FILE + '.tmp', VOTES_FILE));
  return writing;
}

// Settings the admin changes from the results page.
//   resultsPublic: anyone can view results without the password
//   votingOpen:    voting accepts new votes and edits
//   round:         the voting round in progress; earlier rounds are kept read-only in votes-round<N>.json
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = { resultsPublic: false, votingOpen: CONFIG.votingOpen, round: 1 };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
function saveSettings() {
  return fs.promises.writeFile(SETTINGS_FILE + '.tmp', JSON.stringify(settings))
    .then(() => fs.promises.rename(SETTINGS_FILE + '.tmp', SETTINGS_FILE));
}

const archiveFile = n => path.join(DATA_DIR, `votes-round${n}.json`);
const archivedRounds = () => fs.readdirSync(DATA_DIR)
  .map(f => /^votes-round(\d+)\.json$/.exec(f)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);

const publicVote = ({ phone, note, ...v }) => v;

// The phone number given with a vote is that person's code for changing it later.
const digits = s => String(s || '').replace(/\D/g, '');
const validPhone = s => /^\d{9,10}$/.test(digits(s));
// Wrong guesses are limited per name and address so nobody can try numbers until one fits.
const MAX_TRIES = 5, TRY_WINDOW = 15 * 60 * 1000;
const tries = new Map();
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function checkPhone(req, vote, phone) {
  if (!digits(vote.phone)) return null; // voted before phone numbers were required: the first number given becomes the code
  const key = vote.name + '|' + clientIp(req);
  const now = Date.now();
  const t = tries.get(key);
  if (t && now - t.first < TRY_WINDOW && t.count >= MAX_TRIES) return { status: 429, error: 'ใส่เบอร์ผิดหลายครั้ง รอ 15 นาทีแล้วลองใหม่' };
  if (digits(phone) === digits(vote.phone)) { tries.delete(key); return null; }
  tries.set(key, t && now - t.first < TRY_WINDOW ? { first: t.first, count: t.count + 1 } : { first: now, count: 1 });
  return { status: 403, error: 'เบอร์โทรไม่ตรงกับที่ใช้ตอนโหวต' };
}
const isAdmin = req => !!ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 16384) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return send(res, 200, { ...CONFIG, votingOpen: settings.votingOpen, resultsPublic: settings.resultsPublic, round: settings.round, pastRounds: archivedRounds() });
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    if (!isAdmin(req)) return send(res, 401, { error: 'รหัสไม่ถูกต้อง' });
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' }); }
    if (typeof b.resultsPublic === 'boolean') settings.resultsPublic = b.resultsPublic;
    if (typeof b.votingOpen === 'boolean') settings.votingOpen = b.votingOpen;
    await saveSettings();
    return send(res, 200, settings);
  }

  // Start a new round: the current votes are kept read-only, voting starts empty and closed.
  if (url.pathname === '/api/rounds/new' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: 'รหัสไม่ถูกต้อง' });
    // The caller names the round being closed, so a repeated request cannot skip a round.
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' }); }
    if (Number(b.from) !== settings.round) return send(res, 409, { error: `รอบปัจจุบันคือรอบที่ ${settings.round}` });
    const file = archiveFile(settings.round);
    if (fs.existsSync(file)) return send(res, 409, { error: `มีข้อมูลรอบที่ ${settings.round} เก็บไว้แล้ว` });
    await writing;
    await fs.promises.writeFile(file, JSON.stringify(votes, null, 1));
    votes = [];
    await persist();
    settings = { ...settings, round: settings.round + 1, votingOpen: false, resultsPublic: false };
    await saveSettings();
    return send(res, 200, { round: settings.round, archived: archivedRounds() });
  }

  // Who has voted (names only), for the turnout count and the "โหวตแล้ว" tags.
  if (url.pathname === '/api/summary' && req.method === 'GET') return send(res, 200, { names: votes.map(v => v.name) });

  // One person's own vote, shown only when they give the phone number they voted with.
  if (url.pathname === '/api/vote/check' && req.method === 'POST') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' }); }
    const v = votes.find(x => x.name === String(b.name || ''));
    if (!v) return send(res, 404, { error: 'ยังไม่มีโหวตของชื่อนี้' });
    const bad = checkPhone(req, v, b.phone);
    if (bad) return send(res, bad.status, { error: bad.error });
    return send(res, 200, { vote: { ...publicVote(v), note: v.note } });
  }

  // Results need the admin password unless the admin has opened them to everyone.
  // Phone numbers and notes only ever go to the admin.
  if (url.pathname === '/api/votes' && req.method === 'GET') {
    // An earlier round's votes are admin-only.
    const round = Number(url.searchParams.get('round')) || settings.round;
    if (round !== settings.round) {
      if (!isAdmin(req)) return send(res, 401, { error: 'รหัสไม่ถูกต้อง' });
      try { return send(res, 200, JSON.parse(fs.readFileSync(archiveFile(round), 'utf8'))); }
      catch (e) { return send(res, 404, { error: 'ไม่พบข้อมูลรอบนี้' }); }
    }
    if (isAdmin(req)) return send(res, 200, votes);
    if (settings.resultsPublic) return send(res, 200, votes.map(publicVote));
    return send(res, 401, { error: 'รหัสไม่ถูกต้อง' });
  }

  if (url.pathname === '/api/votes' && req.method === 'POST') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' }); }
    if (!settings.votingOpen) return send(res, 403, { error: 'ระบบโหวตยังไม่เปิด' });
    // Names not on the staff list are allowed and grouped under "อื่นๆ".
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    const known = staffByName.has(name);
    // A first name and a surname, letters only.
    if (!known && !(/^[\p{L}\p{M}][\p{L}\p{M} .()-]{3,79}$/u.test(name) && /\S\s+\S/.test(name))) return send(res, 400, { error: 'กรอกชื่อและนามสกุลให้ถูกต้อง' });
    if (!DESIGN_IDS.includes(b.design)) return send(res, 400, { error: 'กรุณาเลือกแบบเสื้อ' });
    if (!SIZES.includes(b.size)) return send(res, 400, { error: 'กรุณาเลือกไซซ์' });
    // Shirts after the first are paid by the voter; each has its own size (one cut for everyone).
    // The design is the vote, so it is chosen once and does not apply per shirt.
    const extras = Array.isArray(b.extras) ? b.extras : [];
    if (extras.length > 9) return send(res, 400, { error: 'สั่งได้สูงสุด 10 ตัว' });
    for (const [i, x] of extras.entries()) {
      if (!x || !SIZES.includes(x.size)) return send(res, 400, { error: `เลือกไซซ์ของตัวที่ ${i + 2}` });
    }
    if (!validPhone(b.phone)) return send(res, 400, { error: 'กรอกเบอร์โทร 9–10 หลัก' });
    const prev = votes.find(v => v.name === name);
    if (prev && !CONFIG.allowChangeVote) return send(res, 409, { error: 'ท่านโหวตแล้ว ไม่สามารถโหวตซ้ำได้' });
    if (prev) {
      const bad = checkPhone(req, prev, b.phone);
      if (bad) return send(res, bad.status, { error: bad.error });
    }
    const vote = {
      name, dept: known ? staffByName.get(name) : OTHER_DEPT, ...(known ? {} : { other: true }), design: b.design, size: b.size,
      extras: extras.map(x => ({ size: x.size })),
      qty: 1 + extras.length,
      phone: digits(b.phone),
      note: String(b.note || '').trim().slice(0, 500),
      time: Date.now()
    };
    votes = votes.filter(v => v.name !== name).concat(vote);
    await persist();
    return send(res, 200, publicVote(vote));
  }

  if (url.pathname === '/api/votes' && req.method === 'DELETE') {
    if (!isAdmin(req)) return send(res, 401, { error: 'รหัสผู้ดูแลไม่ถูกต้อง' });
    votes = [];
    await persist();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not found' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
// Only these paths are served, so votes.json and server files stay private.
const PUBLIC = /^\/(index\.html|app\.js|styles\.css|assets\/[\w.-]+|data\/staff\.json)$/;

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (!PUBLIC.test(p)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // Content-Length lets the page show how far a large picture has loaded.
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => { console.error(e); send(res, 500, { error: 'เกิดข้อผิดพลาดในระบบ' }); });
  } else {
    serveStatic(req, res, url);
  }
}).listen(PORT, () => {
  console.log(`Shirt Vote running at http://localhost:${PORT}`);
  if (!ADMIN_KEY) console.log('ADMIN_KEY is not set: the results page, downloads and clearing votes are turned off.');
});
