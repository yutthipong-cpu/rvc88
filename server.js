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
  hideResults: flag('HIDE_RESULTS', false),
  sampleData: flag('SAMPLE_DATA', false),
  adminEnabled: !!ADMIN_KEY
};

const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
// Designs offered in each round (same as ROUND_DESIGNS in app.js); a later round offers the last listed set.
const ROUND_DESIGN_IDS = { 1: ['1', '2'], 2: ['6', '7', '4', '5'] };
const designIds = round => ROUND_DESIGN_IDS[round] || ROUND_DESIGN_IDS[Math.max(...Object.keys(ROUND_DESIGN_IDS).map(Number))];
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

// The phone number given with a vote lets the admin reach the voter.
const digits = s => String(s || '').replace(/\D/g, '');
const validPhone = s => /^\d{9,10}$/.test(digits(s));
// Design and shirts of a vote, checked the same way when voting and when the admin corrects a vote.
// Shirts after the first are paid by the voter; each has its own size (one cut for everyone).
// The design is the vote, so it is chosen once and does not apply per shirt.
function shirtsError(b) {
  if (!designIds(settings.round).includes(b.design)) return 'กรุณาเลือกแบบเสื้อ';
  if (!SIZES.includes(b.size)) return 'กรุณาเลือกไซซ์';
  const extras = Array.isArray(b.extras) ? b.extras : [];
  if (extras.length > 9) return 'สั่งได้สูงสุด 10 ตัว';
  for (const [i, x] of extras.entries()) if (!x || !SIZES.includes(x.size)) return `เลือกไซซ์ของตัวที่ ${i + 2}`;
  return null;
}
const shirtsOf = b => {
  const extras = (Array.isArray(b.extras) ? b.extras : []).map(x => ({ size: x.size }));
  return { design: b.design, size: b.size, extras, qty: 1 + extras.length };
};
// Spam guards: at most MAX_VOTES votes a round (127 staff plus room for names not on the list),
// a limit on new votes per address and per phone number, and on wrong admin passwords.
const MAX_VOTES = Number(process.env.MAX_VOTES) || 150;
const VOTES_PER_IP = 40, IP_WINDOW = 10 * 60 * 1000; // a whole office can share one address
const VOTES_PER_PHONE = 5; // someone may vote for a colleague with their own number
const KEY_FAILS = 20, KEY_WINDOW = 15 * 60 * 1000;
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const hits = new Map();
const recent = (k, win) => { const now = Date.now(); const t = (hits.get(k) || []).filter(x => now - x < win); if (t.length) hits.set(k, t); else hits.delete(k); return t; };
const tooMany = (k, max, win) => recent(k, win).length >= max;
const note = k => hits.set(k, (hits.get(k) || []).concat(Date.now()));
setInterval(() => { for (const k of [...hits.keys()]) recent(k, Math.max(IP_WINDOW, KEY_WINDOW)); }, IP_WINDOW).unref();

// After too many wrong passwords from one address, even the right one is refused for a while.
function isAdmin(req) {
  const given = req.headers['x-admin-key'];
  if (!ADMIN_KEY || !given) return false;
  const k = 'key|' + clientIp(req);
  if (tooMany(k, KEY_FAILS, KEY_WINDOW)) return false;
  if (given === ADMIN_KEY) return true;
  note(k);
  return false;
}

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
    return send(res, 200, { ...CONFIG, votingOpen: settings.votingOpen, resultsPublic: settings.resultsPublic, round: settings.round, pastRounds: archivedRounds(), full: votes.length >= MAX_VOTES });
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
    // Open results show only how many votes each design has: no names, sizes or order of voting.
    if (settings.resultsPublic) {
      const tally = {};
      votes.forEach(v => { tally[v.design] = (tally[v.design] || 0) + 1; });
      return send(res, 200, { tally });
    }
    return send(res, 401, { error: 'รหัสไม่ถูกต้อง' });
  }

  if (url.pathname === '/api/votes' && req.method === 'POST') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' }); }
    if (!settings.votingOpen) return send(res, 403, { error: 'ระบบโหวตยังไม่เปิด' });
    // "website" is a hidden field people never see; only form-filling bots put something in it.
    if (b.website) return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' });
    const ipKey = 'vote|' + clientIp(req);
    if (tooMany(ipKey, VOTES_PER_IP, IP_WINDOW)) return send(res, 429, { error: 'ส่งโหวตถี่เกินไป รอสักครู่แล้วลองใหม่' });
    note(ipKey);
    if (votes.length >= MAX_VOTES) return send(res, 403, { error: `รับโหวตครบ ${MAX_VOTES} รายการแล้ว โปรดติดต่อผู้ดูแล` });
    // Names not on the staff list are allowed and grouped under "อื่นๆ".
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    const known = staffByName.has(name);
    // A first name and a surname, letters only.
    if (!known && !(/^[\p{L}\p{M}][\p{L}\p{M} .()-]{3,79}$/u.test(name) && /\S\s+\S/.test(name))) return send(res, 400, { error: 'กรอกชื่อและนามสกุลให้ถูกต้อง' });
    const bad = shirtsError(b);
    if (bad) return send(res, 400, { error: bad });
    if (!validPhone(b.phone)) return send(res, 400, { error: 'กรอกเบอร์โทร 9–10 หลัก' });
    // One vote per person; only the admin can change it afterwards (PUT below).
    if (votes.some(v => v.name === name)) return send(res, 409, { error: 'ชื่อนี้โหวตแล้ว หากต้องการแก้ไข โปรดติดต่อผู้ดูแล' });
    if (votes.filter(v => v.phone === digits(b.phone)).length >= VOTES_PER_PHONE) return send(res, 409, { error: `เบอร์นี้ใช้โหวตครบ ${VOTES_PER_PHONE} ชื่อแล้ว` });
    const vote = {
      name, dept: known ? staffByName.get(name) : OTHER_DEPT, ...(known ? {} : { other: true }), ...shirtsOf(b),
      phone: digits(b.phone),
      note: String(b.note || '').trim().slice(0, 500),
      time: Date.now()
    };
    votes = votes.concat(vote);
    await persist();
    return send(res, 200, publicVote(vote));
  }

  // The admin corrects someone's vote in the current round; name, department and phone stay as voted.
  if (url.pathname === '/api/votes' && req.method === 'PUT') {
    if (!isAdmin(req)) return send(res, 401, { error: 'รหัสผู้ดูแลไม่ถูกต้อง' });
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'ข้อมูลไม่ถูกต้อง' }); }
    const prev = votes.find(v => v.name === String(b.name || ''));
    if (!prev) return send(res, 404, { error: 'ไม่พบโหวตของชื่อนี้' });
    const bad = shirtsError(b);
    if (bad) return send(res, 400, { error: bad });
    const vote = { ...prev, ...shirtsOf(b), note: String(b.note || '').trim().slice(0, 500), edited: Date.now() };
    votes = votes.map(v => v === prev ? vote : v);
    await persist();
    return send(res, 200, vote);
  }

  if (url.pathname === '/api/votes' && req.method === 'DELETE') {
    if (!isAdmin(req)) return send(res, 401, { error: 'รหัสผู้ดูแลไม่ถูกต้อง' });
    // ?name= removes one person's vote; without it every vote of the current round is cleared.
    const name = url.searchParams.get('name');
    if (name != null) {
      if (!votes.some(v => v.name === name)) return send(res, 404, { error: 'ไม่พบโหวตของชื่อนี้' });
      votes = votes.filter(v => v.name !== name);
    } else votes = [];
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
