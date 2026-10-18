import { html, render, Component } from 'https://unpkg.com/htm@3.1.1/preact/standalone.module.js';

// Settings come from the server (see server.js); these defaults apply until /api/config loads.
const DEFAULT_CONFIG = { votingOpen: true, allowChangeVote: true, hideResults: false, sampleData: false, adminEnabled: false };
const POLL_MS = 10000;

const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const CHART = {
  m: { chest: [34, 36, 38, 40, 42, 44, 46, 48], len: [24, 25, 26, 27, 28, 29, 30, 31] },
  f: { chest: [32, 34, 36, 38, 40, 42, 44, 46], len: [23, 24, 25, 26, 27, 28, 29, 30] }
};
const CUTS = [{ id: 'm', label: 'ทรงชาย' }, { id: 'f', label: 'ทรงหญิง' }];
const DESIGNS = [
  { id: '1', label: 'แบบที่ 1', tone: 'น้ำเงินเข้ม ชายเสื้อลายไทยสีทอง', front: 'assets/d2-front.png', back: 'assets/d2-back.png', board: 'assets/d2-board.jpg', chart: 'assets/d2-size.jpg' },
  { id: '2', label: 'แบบที่ 2', tone: 'ฟ้า–ขาว เส้นทองพลิ้ว', front: 'assets/d1-front.png', back: 'assets/d1-back.png', board: 'assets/d1-board.jpg', chart: 'assets/d1-size.jpg' }
];
const ORDER = ['ฝ่ายบริหาร', 'ผู้ช่วยศาสตราจารย์', 'แผนกวิชาสามัญสัมพันธ์', 'แผนกวิชาการบัญชี', 'แผนกวิชาการตลาด', 'แผนกวิชาโลจิสติกส์', 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', 'แผนกวิชาเทคโนโลยีสารสนเทศ', 'แผนกวิชาวิจิตรศิลป์', 'แผนกวิชาออกแบบ', 'แผนกวิชาคอมพิวเตอร์กราฟิก', 'แผนกวิชาแฟชั่นและสิ่งทอ', 'แผนกวิชาคหกรรมศาสตร์', 'แผนกวิชาอาหารและโภชนาการ', 'แผนกวิชาการโรงแรม', 'แผนกวิชาการท่องเที่ยว', 'ลูกจ้างชั่วคราว', 'นักการ', 'แม่บ้าน', 'พนักงานขับรถ', 'ยามรักษาการ'];
const GROUP_LABEL = { 'ลูกจ้างชั่วคราว': 'เจ้าหน้าที่ธุรการ (ลูกจ้างชั่วคราว)' };
// The size tape spans 16 inches: one inch either side of the cut's smallest and largest chest.
const TAPE_SPAN = 16;

const norm = s => (s || '').replace(/\s+/g, '').toLowerCase();
const fmtTime = t => new Date(t).toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const cutLabel = c => c === 'f' ? 'หญิง' : 'ชาย';
const dLabel = id => (DESIGNS.find(d => d.id === id) || {}).label || '—';
const MAX_EXTRAS = 9;
// Every shirt in a vote: the first (free) then the paid extras. Shirts have a cut and size only;
// the design is the vote. Older votes stored only a quantity, so their extras repeat the first shirt.
const extrasOf = v => v.extras || Array.from({ length: Math.max(0, (v.qty || 1) - 1) }, () => ({ cut: v.cut, size: v.size }));
const shirtsOf = v => [{ cut: v.cut, size: v.size }, ...extrasOf(v)];
const shirtText = x => `${cutLabel(x.cut)} ${x.size}`;
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
let xlsxLoading = null;
const loadXlsx = () => xlsxLoading || (xlsxLoading = new Promise((resolve, reject) => {
  const el = document.createElement('script');
  el.src = XLSX_URL;
  el.onload = () => resolve(window.XLSX);
  el.onerror = () => { xlsxLoading = null; reject(new Error('load failed')); };
  document.head.appendChild(el);
}));

class App extends Component {
  state = { tab: 'vote', staff: [], votes: [], query: '', open: false, hl: 0, person: null, phone: '', note: '', extra: false, design: null, side: 'front', cut: null, size: null, extras: [], done: null, confirm: false, lightbox: null, rq: '', mode: 'voted', cfg: DEFAULT_CONFIG, saving: false, error: '', names: [], prevVote: null, adminKey: '', askKey: false, keyInput: '', keyError: '' };

  componentDidMount() {
    fetch('data/staff.json').then(r => r.json()).then(rows => {
      const rank = g => { const i = ORDER.indexOf(g); return i < 0 ? 99 : i; };
      const staff = rows.map((r, i) => ({ name: r[0], g: r[1], i }))
        .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
        .map(p => ({ name: p.name, dept: GROUP_LABEL[p.g] || p.g }));
      this.setState({ staff });
    }).catch(() => {});
    this.loadConfig();
    this.refresh();
    // Poll so counts and results stay current while other people vote.
    this._poll = setInterval(() => { if (!document.hidden) this.refresh(); }, POLL_MS);
    this._onVisible = () => { if (!document.hidden) this.refresh(); };
    this._onKey = e => { if (e.key === 'Escape' && !this.state.saving) this.setState({ lightbox: null, askKey: false, confirm: false }); };
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('keydown', this._onKey);
  }
  componentWillUnmount() {
    clearInterval(this._poll);
    document.removeEventListener('visibilitychange', this._onVisible);
    window.removeEventListener('keydown', this._onKey);
  }
  componentDidUpdate(_, prev) {
    // Lock page scroll behind the lightbox, the done sheet and the password popup.
    const locked = !!(this.state.lightbox || this.state.done || this.state.askKey || this.state.confirm);
    if (locked !== !!(prev.lightbox || prev.done || prev.askKey || prev.confirm)) document.body.style.overflow = locked ? 'hidden' : '';
    if (this.state.askKey && !prev.askKey) { const el = document.getElementById('key'); if (el) el.focus(); }
  }

  canSeeResults() { return !!(this.state.adminKey || this.state.cfg.resultsPublic); }
  refresh() {
    fetch('api/summary', { cache: 'no-store' }).then(r => r.json()).then(b => this.setState({ names: b.names })).catch(() => {});
    // Config carries the "results open to everyone" switch, so re-read it as well.
    this.loadConfig();
    if (this.state.tab === 'results' && this.canSeeResults()) this.loadVotes(this.state.adminKey);
  }
  loadConfig() {
    // A reply that was already on its way when the admin flipped the switch would undo the flip on screen; drop it.
    const seq = this._cfgSeq = (this._cfgSeq || 0) + 1;
    fetch('api/config', { cache: 'no-store' }).then(r => r.json())
      .then(cfg => { if (seq === this._cfgSeq) this.setState({ cfg }); }).catch(() => {});
  }
  // Loads the results; resolves true when they were returned (password accepted, or results are open).
  async loadVotes(key) {
    try {
      const r = await fetch('api/votes', { headers: key ? { 'x-admin-key': key } : {}, cache: 'no-store' });
      if (r.status === 401) {
        // Password no longer works, or the results were locked again: leave the results.
        if (this.state.adminKey) this.setState({ adminKey: '', votes: [], tab: 'vote', askKey: true });
        else if (this.state.tab === 'results') this.setState({ votes: [], tab: 'vote' });
        return false;
      }
      if (!r.ok) return false;
      this.setState({ votes: await r.json() });
      return true;
    } catch (e) { return false; }
  }
  async unlock(e) {
    e.preventDefault();
    const key = this.state.keyInput.trim();
    if (!key) return;
    if (await this.loadVotes(key)) {
      this.setState({ adminKey: key, askKey: false, keyInput: '', keyError: '' });
      this.setTab('results');
    } else this.setState({ keyError: 'รหัสไม่ถูกต้อง ลองอีกครั้ง' });
  }
  // Results need the password; ask for it in a popup the first time.
  goResults() {
    if (this.canSeeResults()) this.setTab('results');
    else this.askForKey();
  }
  askForKey() { this.setState({ askKey: true, done: null, keyInput: '', keyError: '' }); }
  async setResultsPublic(on) {
    this._cfgSeq = (this._cfgSeq || 0) + 1;
    const r = await fetch('api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-admin-key': this.state.adminKey },
      body: JSON.stringify({ resultsPublic: on })
    });
    if (!r.ok) { window.alert('เปลี่ยนการตั้งค่าไม่สำเร็จ'); return; }
    this.setState(st => ({ cfg: { ...st.cfg, resultsPublic: on } }));
  }

  sample() {
    const st = this.state.staff;
    if (this._sample && this._sampleN === st.length) return this._sample;
    let seed = 88; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const out = [];
    st.forEach(p => {
      if (rnd() < 0.62) {
        const cut = rnd() < 0.6 ? 'f' : 'm';
        const si = Math.min(7, Math.max(0, Math.round(3 + (rnd() + rnd() - 1) * 3)));
        const design = rnd() < 0.57 ? '2' : '1';
        const extras = rnd() < 0.88 ? [] : [{ cut: rnd() < 0.5 ? 'm' : 'f', size: SIZES[Math.max(0, si - 1)] }];
        out.push({ name: p.name, dept: p.dept, design, cut, size: SIZES[si], extras, qty: 1 + extras.length, phone: '', note: '', time: Date.now() - Math.floor(rnd() * 5 * 864e5) });
      }
    });
    this._sample = out; this._sampleN = st.length; return out;
  }
  shownVotes() { return this.state.cfg.sampleData ? this.sample() : this.state.votes; }

  async pick(p) {
    this.setState({ person: p, query: '', open: false, prevVote: null, error: '' });
    try {
      const { vote } = await (await fetch('api/vote?name=' + encodeURIComponent(p.name), { cache: 'no-store' })).json();
      if (vote && this.state.person === p) this.setState({ prevVote: vote, design: vote.design, cut: vote.cut, size: vote.size, extras: extrasOf(vote) });
    } catch (e) {}
  }
  async submit() {
    const s = this.state;
    if (s.saving) return;
    this.setState({ saving: true, error: '' });
    try {
      const r = await fetch('api/votes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: s.person.name, design: s.design, cut: s.cut, size: s.size, extras: s.extras, phone: s.phone.trim(), note: s.note.trim() })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'บันทึกไม่สำเร็จ');
      this.setState(st => ({ saving: false, confirm: false, done: body, prevVote: body, names: st.names.includes(body.name) ? st.names : st.names.concat(body.name) }));
    } catch (e) {
      this.setState({ saving: false, error: e.message === 'Failed to fetch' ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองกดอีกครั้ง' : e.message });
    }
  }
  resetForm() {
    this.setState({ person: null, prevVote: null, query: '', phone: '', note: '', extra: false, design: null, cut: null, size: null, extras: [], done: null, side: 'front' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  setTab(tab) {
    // The password only lasts while the results page is open; leaving it locks the admin view again.
    const leaving = tab !== 'results' ? { adminKey: '', votes: [] } : {};
    this.setState({ tab, done: null, ...leaving }, () => this.refresh());
    window.scrollTo(0, 0);
  }

  sortedVotes() { return this.shownVotes().slice().sort((a, b) => a.time - b.time); }
  exportRows() {
    const head = ['ลำดับ', 'ชื่อ-สกุล', 'แผนก/ฝ่าย', 'แบบที่โหวต', 'ทรง', 'ไซซ์', 'จำนวนรวม (ตัว)', 'ชำระเอง (ตัว)', 'เสื้อตัวที่ชำระเอง', 'เบอร์โทร', 'หมายเหตุ', 'เวลาโหวต'];
    const rows = this.sortedVotes().map((v, i) => {
      const extras = extrasOf(v);
      return [i + 1, v.name, v.dept, dLabel(v.design), cutLabel(v.cut), v.size, 1 + extras.length, extras.length,
        extras.map((x, j) => `ตัวที่ ${j + 2}: ${shirtText(x)}`).join(', '), v.phone || '', v.note || '', fmtTime(v.time)];
    });
    return [head, ...rows];
  }
  async exportXlsx() {
    let XLSX;
    try { XLSX = await loadXlsx(); } catch (e) { window.alert('โหลดตัวสร้างไฟล์ Excel ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง หรือกดปุ่ม CSV แทน'); return; }
    const votes = this.shownVotes();
    const wb = XLSX.utils.book_new();
    const list = XLSX.utils.aoa_to_sheet(this.exportRows());
    list['!cols'] = [6, 28, 30, 10, 6, 6, 12, 12, 40, 14, 30, 18].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, list, 'รายชื่อผู้โหวต');
    // One row per shirt, for handing out shirts and collecting payment.
    const each = [['ลำดับ', 'ชื่อ-สกุล', 'แผนก/ฝ่าย', 'ตัวที่', 'ทรง', 'ไซซ์', 'ค่าใช้จ่าย']];
    this.sortedVotes().forEach(v => shirtsOf(v).forEach((x, j) => each.push([each.length, v.name, v.dept, j + 1, cutLabel(x.cut), x.size, j === 0 ? 'ฟรี' : 'ชำระเอง'])));
    const sheetEach = XLSX.utils.aoa_to_sheet(each);
    sheetEach['!cols'] = [6, 28, 30, 6, 6, 6, 10].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, sheetEach, 'เสื้อทุกตัว');
    // Order sheet: every shirt by cut and size.
    const all = votes.flatMap(shirtsOf);
    const count = (c, z) => all.filter(x => x.cut === c && x.size === z).length;
    const order = [['ทรง', ...SIZES, 'รวม']];
    CUTS.forEach(c => {
      const n = SIZES.map(z => count(c.id, z));
      order.push([c.label, ...n, n.reduce((a, b) => a + b, 0)]);
    });
    const sums = SIZES.map((_, k) => order.slice(1).reduce((a, r) => a + r[k + 1], 0));
    order.push(['รวม', ...sums, sums.reduce((a, b) => a + b, 0)]);
    const sheet2 = XLSX.utils.aoa_to_sheet(order);
    sheet2['!cols'] = [{ wch: 8 }, ...SIZES.map(() => ({ wch: 6 })), { wch: 6 }];
    XLSX.utils.book_append_sheet(wb, sheet2, 'สรุปจำนวนสั่งผลิต');
    XLSX.writeFile(wb, 'ผลโหวตแบบเสื้อ-88ปี.xlsx');
  }
  exportCsv() {
    const esc = x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    // Keep phone numbers as text so Excel does not drop the leading zero.
    const lines = this.exportRows().map((r, i) => r.map((x, j) => (i > 0 && j === 9 && x ? '="' + x + '"' : x)).map(esc).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ผลโหวตแบบเสื้อ-88ปี.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  async clearAll() {
    if (!window.confirm('ล้างข้อมูลการโหวตทั้งหมด? ข้อมูลจะไม่สามารถกู้คืนได้')) return;
    const r = await fetch('api/votes', { method: 'DELETE', headers: { 'x-admin-key': this.state.adminKey } });
    if (!r.ok) { window.alert('ล้างข้อมูลไม่สำเร็จ'); return; }
    this.refresh();
  }

  render(_, s) {
    const total = s.staff.length || 123;
    const onVote = s.tab === 'vote';

    return html`
<div class="app">
  <header class="top">
    <div class="wrap ${onVote ? '' : 'wide'} top-in">
      <div class="brand">
        <img src="assets/seal.webp" alt="ตราวิทยาลัยอาชีวศึกษาร้อยเอ็ด" />
        <div><b>วิทยาลัยอาชีวศึกษาร้อยเอ็ด</b><small>วันสถาปนาครบรอบ 88 ปี · สถานศึกษารางวัลพระราชทาน ปีการศึกษา 2568</small></div>
      </div>
      <button class="top-link" onClick=${() => (onVote ? this.goResults() : this.setTab('vote'))}>${onVote ? 'ดูผลโหวต' : 'กลับไปโหวต'}</button>
    </div>
  </header>

  ${onVote || !this.canSeeResults() ? this.renderVote(s.names.length, total) : this.renderResults(this.shownVotes(), total)}

  <footer class="foot"><div class="wrap ${onVote ? '' : 'wide'}">วิทยาลัยอาชีวศึกษาร้อยเอ็ด · สร้างคน สร้างอาชีพ สร้างอนาคต</div></footer>

  ${s.confirm && this.renderConfirm()}
  ${s.done && this.renderDone()}
  ${s.lightbox && this.renderLightbox()}
  ${s.askKey && this.renderKeyPopup()}
</div>`;
  }

  renderNamePicker(myVoted) {
    const s = this.state;
    if (s.person) return html`
      <div class="person">
        <div><b>${s.person.name}</b><small>${s.person.dept}</small></div>
        <button class="btn btn-ghost" style="height:40px;padding:0 14px;font-size:15px" onClick=${() => this.setState({ person: null, query: '', open: true })}>เปลี่ยนชื่อ</button>
      </div>`;

    const q = norm(s.query);
    const matches = s.staff.filter(p => !q || norm(p.name).includes(q) || norm(p.dept).includes(q));
    const hl = Math.min(s.hl, Math.max(0, matches.length - 1));
    let last = null;
    const onKey = e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.setState({ open: true, hl: Math.min(hl + 1, matches.length - 1) }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.setState({ hl: Math.max(hl - 1, 0) }); }
      else if (e.key === 'Enter' && s.open && matches[hl]) { e.preventDefault(); this.pick(matches[hl]); }
      else if (e.key === 'Escape') this.setState({ open: false });
    };
    return html`
      <div class="search">
        <label class="sr" for="name">ค้นหาชื่อ</label>
        <input id="name" class="field" value=${s.query} placeholder="พิมพ์ชื่อหรือนามสกุล" autocomplete="off" enterkeyhint="search"
          role="combobox" aria-expanded=${s.open} aria-controls="name-list"
          onInput=${e => this.setState({ query: e.target.value, open: true, hl: 0 })}
          onFocus=${() => this.setState({ open: true })}
          onBlur=${() => setTimeout(() => this.setState({ open: false }), 150)}
          onKeyDown=${onKey} />
        <span class="search-icon"></span>
        ${s.open && s.staff.length > 0 && html`
          <div class="list" id="name-list" role="listbox">
            ${matches.map((p, i) => {
              const head = p.dept !== last ? (last = p.dept, html`<div class="list-group">${p.dept}</div>`) : null;
              return html`${head}<div role="option" aria-selected=${i === hl} class="list-item ${i === hl && q ? 'active' : ''}" onMouseDown=${e => { e.preventDefault(); this.pick(p); }}>
                <span>${p.name}</span>${myVoted.has(p.name) && html`<span class="voted-tag">โหวตแล้ว</span>`}
              </div>`;
            })}
            ${q && matches.length === 0 && html`<div class="list-empty">ไม่พบชื่อนี้ ลองพิมพ์แค่ชื่อต้นหรือนามสกุล</div>`}
          </div>`}
      </div>`;
  }

  // Cut toggle plus the size tape for one shirt. Used for shirt 1 and every extra shirt.
  renderSizePicker(shirt, onChange, label) {
    const { cut, size } = shirt;
    const chart = CHART[cut || 'm'];
    const min = chart.chest[0] - 1;
    const pos = inch => ((inch - min) / TAPE_SPAN * 100) + '%';
    const idx = SIZES.indexOf(size);
    const readAt = cut && idx >= 0 ? chart.chest[idx] : null;
    const nums = [];
    for (let i = min + 1; i < min + TAPE_SPAN; i += 2) nums.push(i);
    return html`
      <div class="seg full" role="group" aria-label=${`ทรง${label}`}>
        ${CUTS.map(c => html`<button aria-pressed=${cut === c.id} onClick=${() => onChange({ cut: c.id })}>${c.label}</button>`)}
      </div>
      <div class="tape ${cut ? '' : 'off'}" role="group" aria-label=${`ไซซ์${label}`}>
        <div class="tape-marks">
          ${SIZES.map((code, i) => html`
            <button class="size-mark" style="left:${pos(chart.chest[i])}" aria-pressed=${size === code} disabled=${!cut}
              aria-label=${`${code} รอบอก ${chart.chest[i]} นิ้ว`} onClick=${() => onChange({ size: code })}>${code}</button>`)}
        </div>
        <div class="tape-strip" aria-hidden="true">
          ${nums.map(n => html`<span class="tape-num ${n === readAt ? 'on' : ''}" style="left:${pos(n)}">${n}</span>`)}
          ${readAt != null && html`<span class="tape-read" style="left:${pos(readAt)}"></span>`}
        </div>
      </div>
      <p class="reading">${!cut ? 'เลือกทรงก่อน ไซซ์จะแสดงตามรอบอกจริง'
        : idx < 0 ? 'แตะไซซ์บนสายวัด ตัวเลขคือรอบอก (นิ้ว)'
        : html`<b>${size}</b> · รอบอก <b class="mono">${chart.chest[idx]}"</b> · ยาว <b class="mono">${chart.len[idx]}"</b> <span class="hint">(±1 นิ้ว)</span>`}</p>`;
  }

  setExtra(i, patch) {
    this.setState(st => ({ extras: st.extras.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  }
  addExtra() {
    // Start from the first shirt's cut and size; most people order more of the same.
    this.setState(st => st.extras.length >= MAX_EXTRAS ? null
      : { extras: st.extras.concat({ cut: st.cut, size: st.size }) });
  }

  renderExtras() {
    const s = this.state;
    const n = s.extras.length;
    return html`
  <section class="block">
    <div class="block-head"><h2>สั่งเสื้อเพิ่ม</h2></div>
    <p class="hint">ในกรณีที่สั่งมากกว่า 1 ตัว ท่านจะต้องชำระเงินเองในตัวถัดไป เลือกทรงและไซซ์ของแต่ละตัว</p>
    ${s.extras.map((x, i) => html`
      <div class="extra" key=${i}>
        <div class="extra-head">
          <b>ตัวที่ ${i + 2}</b><span class="paid-tag">ชำระเอง</span>
          <button class="text-btn remove" onClick=${() => this.setState(st => ({ extras: st.extras.filter((_, j) => j !== i) }))} aria-label=${`ลบตัวที่ ${i + 2}`}>ลบ</button>
        </div>
        ${this.renderSizePicker(x, patch => this.setExtra(i, patch), ` ตัวที่ ${i + 2}`)}
      </div>`)}
    <button class="btn btn-ghost add-extra" disabled=${n >= MAX_EXTRAS} onClick=${() => this.addExtra()}>+ สั่งเพิ่มอีก 1 ตัว</button>
    ${n > 0 && html`<p class="paid-note">รวม <b class="mono">${n + 1}</b> ตัว · ฟรี 1 ตัว · ชำระเอง <b class="mono">${n}</b> ตัว</p>`}
  </section>`;
  }

  renderVote(voted, total) {
    const s = this.state;
    const allowChange = s.cfg.allowChangeVote, isOpen = s.cfg.votingOpen;
    const myVoted = new Set(s.names);
    const prev = s.person && s.prevVote && s.prevVote.name === s.person.name ? s.prevVote : null;

    const locked = !isOpen || (prev && !allowChange);
    const missing = [];
    if (!s.person) missing.push('ชื่อ');
    if (!s.design) missing.push('แบบเสื้อ');
    if (!s.cut) missing.push('ทรง');
    if (!s.size) missing.push('ไซซ์');
    s.extras.forEach((x, i) => { if (!x.cut || !x.size) missing.push(`ตัวที่ ${i + 2}`); });
    const canSubmit = !missing.length && !locked && !s.saving;
    const hint = s.error || (locked ? (!isOpen ? 'ปิดรับโหวตแล้ว' : 'ท่านโหวตแล้ว แก้ไขไม่ได้')
      : missing.length ? 'ยังขาด: ' + missing.join(', ')
      : prev ? 'จะบันทึกทับโหวตเดิม' : 'ครบแล้ว กดยืนยันได้');
    const hintClass = s.error || locked ? 'err' : missing.length ? '' : 'ok';
    const summary = ([s.design && dLabel(s.design), s.cut && s.size && `${cutLabel(s.cut)} ${s.size}`].filter(Boolean).join(' · ') || 'ยังไม่ได้เลือกเสื้อ')
      + (s.extras.length ? ` + เพิ่ม ${s.extras.length} ตัว` : '');
    const chartFor = s.design || '1';

    return html`
<section class="wrap intro">
  <img class="intro-logo" src="assets/logo-88.png" alt="ตราสัญลักษณ์ 88 ปี วิทยาลัยอาชีวศึกษาร้อยเอ็ด" />
  <h1>เลือกเสื้อที่ระลึก 88 ปี</h1>
  <p>เลือกแบบที่ชอบ แล้วระบุทรงและไซซ์ของท่าน ท่านละ 1 สิทธิ์</p>
  <p class="count">โหวตแล้ว <b class="mono">${voted}</b> จาก <span class="mono">${total}</span> คน</p>
</section>

<main class="wrap form">
  ${!isOpen && html`<div class="notice closed">ปิดรับโหวตแล้ว ขอบคุณทุกท่านที่ร่วมเลือก</div>`}

  <section class="block">
    <div class="block-head"><h2>ชื่อของท่าน <span class="req">*</span></h2></div>
    ${this.renderNamePicker(myVoted)}
    ${prev && html`<div class="notice info">ท่านโหวตไว้แล้วเมื่อ ${fmtTime(prev.time)}: ${dLabel(prev.design)} ทรง${cutLabel(prev.cut)} ${prev.size}${extrasOf(prev).length ? ` และสั่งเพิ่ม ${extrasOf(prev).length} ตัว` : ''}
      ${allowChange ? ' แก้ด้านล่างแล้วกดบันทึกได้' : ' ระบบไม่เปิดให้แก้ไข'}</div>`}
  </section>

  <section class="block">
    <div class="block-head">
      <h2>แบบที่ท่านโหวต <span class="req">*</span></h2>
      <div class="seg" role="group" aria-label="ด้านที่แสดง">
        <button aria-pressed=${s.side === 'front'} onClick=${() => this.setState({ side: 'front' })}>ด้านหน้า</button>
        <button aria-pressed=${s.side === 'back'} onClick=${() => this.setState({ side: 'back' })}>ด้านหลัง</button>
      </div>
    </div>
    <div class="shirts">
      ${DESIGNS.map(d => {
        const sel = s.design === d.id;
        return html`
        <div class="shirt" key=${d.id}>
          <button class="shirt-pick" aria-pressed=${sel} onClick=${() => this.setState({ design: d.id })}>
            <img src=${s.side === 'front' ? d.front : d.back} alt=${`${d.label} ${s.side === 'front' ? 'ด้านหน้า' : 'ด้านหลัง'}`} />
            ${sel && html`<span class="tick">เลือกแล้ว</span>`}
            <span class="shirt-name">${d.label}</span>
            <span class="shirt-tone">${d.tone}</span>
          </button>
          <button class="text-btn" onClick=${() => this.setState({ lightbox: { id: d.id, kind: 'board' } })}>ดูภาพละเอียด</button>
        </div>`;
      })}
    </div>
  </section>

  <section class="block">
    <div class="block-head">
      <h2>ทรงและไซซ์ ตัวที่ 1 <span class="req">*</span></h2>
      <button class="text-btn" onClick=${() => this.setState({ lightbox: { id: chartFor, kind: 'chart' } })}>ตารางไซซ์</button>
    </div>
    ${this.renderSizePicker(s, patch => this.setState(patch), ' ตัวที่ 1')}
  </section>

  ${this.renderExtras()}

  <section class="block">
    <div class="block-head"><h2>ติดต่อ <span class="hint" style="font-weight:400">(ไม่บังคับ)</span></h2></div>
    ${s.extra || s.phone || s.note ? html`
      <label class="field-label" for="phone">เบอร์โทร <span>(ไม่บังคับ)</span></label>
      <input id="phone" class="field" type="tel" inputmode="tel" maxlength="12" value=${s.phone} placeholder="08x-xxx-xxxx"
        onInput=${e => { const v = e.target.value.replace(/[^0-9-]/g, ''); e.target.value = v; this.setState({ phone: v }); }} />
      <label class="field-label" for="note">หมายเหตุถึงผู้จัดทำ <span>(ไม่บังคับ)</span></label>
      <textarea id="note" class="field" rows="2" value=${s.note} onInput=${e => this.setState({ note: e.target.value })}></textarea>`
    : html`<button class="text-btn" onClick=${() => this.setState({ extra: true })}>+ เพิ่มเบอร์โทรหรือหมายเหตุ</button>`}
  </section>
</main>

<div class="bar">
  <div class="wrap bar-in">
    <div class="bar-text">
      <b>${summary}</b>
      <small class=${hintClass} aria-live="polite">${hint}</small>
    </div>
    <button class="btn btn-primary" disabled=${!canSubmit} onClick=${() => { if (canSubmit) this.setState({ confirm: true, error: '' }); }}>
      ${prev && allowChange ? 'บันทึกการแก้ไข' : 'ยืนยันโหวต'}
    </button>
  </div>
</div>`;
  }

  renderKeyPopup() {
    const s = this.state;
    const close = () => this.setState({ askKey: false });
    return html`
<div class="backdrop" onClick=${e => { if (e.target === e.currentTarget) close(); }}>
  <form class="sheet lock" role="dialog" aria-modal="true" aria-labelledby="key-title" onSubmit=${e => this.unlock(e)}>
    <h2 id="key-title">ใส่รหัสเพื่อดูผลโหวต</h2>
    <label class="sr" for="key">รหัส</label>
    <input id="key" class="field" type="password" autocomplete="current-password" placeholder="รหัส" value=${s.keyInput}
      onInput=${e => this.setState({ keyInput: e.target.value, keyError: '' })} />
    ${s.keyError && html`<p class="lock-err" role="alert">${s.keyError}</p>`}
    <div class="sheet-actions">
      <button class="btn btn-ghost" type="button" onClick=${close}>ยกเลิก</button>
      <button class="btn btn-primary" type="submit">เข้าดูผล</button>
    </div>
  </form>
</div>`;
  }

  renderResults(votes, total) {
    const s = this.state;
    const voted = votes.length;
    const hide = s.cfg.hideResults, sampleOn = s.cfg.sampleData;

    const counts = DESIGNS.map(d => votes.filter(v => v.design === d.id).length);
    const maxC = Math.max(...counts), tie = counts.every(c => c === counts[0]);

    // Shirt counts include every shirt ordered, filtered by the design chosen above the table.
    const shirts = votes.flatMap(shirtsOf);
    const sumBy = (cut, z) => shirts.filter(x => (!cut || x.cut === cut) && x.size === z).length;
    const sizeRows = SIZES.map(z => ({ z, m: sumBy('m', z), f: sumBy('f', z), all: sumBy(null, z) }));
    const tot = k => sizeRows.reduce((a, r) => a + r[k], 0);
    const cell = n => html`<td class=${n ? 'mono' : 'mono zero'}>${n || '–'}</td>`;

    const votedNames = new Set(votes.map(v => v.name));
    const deptMap = new Map();
    s.staff.forEach(p => { if (!deptMap.has(p.dept)) deptMap.set(p.dept, { total: 0, voted: 0 }); const g = deptMap.get(p.dept); g.total++; if (votedNames.has(p.name)) g.voted++; });

    const rq = norm(s.rq); const match = (n, d) => !rq || norm(n).includes(rq) || norm(d).includes(rq);
    const pending = s.staff.filter(p => !votedNames.has(p.name));
    const list = s.mode === 'voted'
      ? votes.slice().sort((a, b) => b.time - a.time).filter(v => match(v.name, v.dept))
      : pending.filter(p => match(p.name, p.dept));
    const emptyText = s.rq ? 'ไม่พบชื่อหรือแผนกนี้' : (s.mode === 'voted' ? 'ยังไม่มีใครโหวต' : 'ทุกคนโหวตครบแล้ว');
    const canClear = s.mode === 'voted' && !sampleOn && s.votes.length > 0;

    return html`
<main class="wrap wide results">
  <h1 class="page-title">ผลโหวตแบบเสื้อ</h1>
  <p class="count">โหวตแล้ว <b class="mono">${voted}</b> จาก <span class="mono">${total}</span> คน (${(total ? voted / total * 100 : 0).toFixed(0)}%)</p>

  ${s.adminKey && html`
    <div class="panel switch-row">
      <div>
        <b id="pub-label">เปิดผลให้ทุกคนดู</b>
        <small>${s.cfg.resultsPublic ? 'เปิดผลไว้: ทุกคนกดดูผลได้โดยไม่ต้องใส่รหัส' : 'ล็อกดูผล: ต้องใส่รหัสถึงจะดูผลได้'}</small>
      </div>
      <button class="switch" role="switch" aria-checked=${!!s.cfg.resultsPublic} aria-labelledby="pub-label"
        onClick=${() => this.setResultsPublic(!s.cfg.resultsPublic)}><span></span></button>
    </div>`}

  ${sampleOn && html`<div class="notice sample">นี่คือข้อมูลตัวอย่าง ปิดได้ด้วย SAMPLE_DATA=false บนเซิร์ฟเวอร์</div>`}

  ${hide ? html`
    <div class="panel"><h2>ประกาศผลหลังปิดรับโหวต</h2><p class="hint">ระหว่างนี้ดูได้เฉพาะจำนวนคนที่โหวตแล้ว</p></div>` : html`
    <div class="tally">
      ${DESIGNS.map((d, i) => {
        const lead = voted > 0 && !tie && counts[i] === maxC;
        const pct = voted ? counts[i] / voted * 100 : 0;
        return html`
        <div class="tally-row ${lead ? 'lead' : ''}" key=${d.id}>
          <img src=${d.front} alt="" />
          <div>
            <div class="tally-name">${d.label}${lead && html`<span class="lead-tag">นำอยู่</span>`}</div>
            <div class="tally-num"><b>${counts[i]}</b> คะแนน · ${pct.toFixed(0)}%</div>
            <div class="meter"><i style="width:${pct}%"></i></div>
          </div>
        </div>`;
      })}
    </div>

    <section class="panel">
      <h2>จำนวนเสื้อที่ต้องสั่งผลิต</h2>
      <p class="hint">นับทุกตัว รวมตัวที่ชำระเอง</p>
      <table class="sizes">
        <thead><tr><th>ไซซ์</th><th>ชาย</th><th>หญิง</th><th>รวม</th></tr></thead>
        <tbody>${sizeRows.map(r => html`<tr><td>${r.z}</td>${cell(r.m)}${cell(r.f)}${cell(r.all)}</tr>`)}</tbody>
        <tfoot><tr><td>รวม</td><td class="mono">${tot('m')}</td><td class="mono">${tot('f')}</td><td class="mono">${tot('all')}</td></tr></tfoot>
      </table>
    </section>

    <section class="panel">
      <h2>โหวตแล้วแยกตามแผนก</h2>
      <ul class="depts">
        ${[...deptMap].map(([name, g]) => html`
          <li class=${g.voted === g.total ? 'full' : ''}>
            <div class="row"><span>${name}</span><b>${g.voted}/${g.total}</b></div>
            <div class="meter"><i style="width:${g.voted / g.total * 100}%"></i></div>
          </li>`)}
      </ul>
    </section>

    <section class="panel">
      <div class="tools">
        <div class="tools-row">
          <div class="seg" role="group" aria-label="รายชื่อ">
            <button aria-pressed=${s.mode === 'voted'} onClick=${() => this.setState({ mode: 'voted' })}>โหวตแล้ว ${voted}</button>
            <button aria-pressed=${s.mode === 'pending'} onClick=${() => this.setState({ mode: 'pending' })}>ยังไม่โหวต ${pending.length}</button>
          </div>
        </div>
        <input class="field" value=${s.rq} onInput=${e => this.setState({ rq: e.target.value })} placeholder="ค้นหาชื่อหรือแผนก" aria-label="ค้นหาชื่อหรือแผนก" />
        ${s.adminKey && html`<div class="tools-row">
          <button class="btn btn-primary" style="height:44px;flex:1" onClick=${() => this.exportXlsx()}>ดาวน์โหลด Excel</button>
          <button class="btn btn-ghost" style="height:44px" onClick=${() => this.exportCsv()}>CSV</button>
        </div>`}
      </div>
      <ul class="people">
        ${list.map(v => html`
          <li>
            <div class="who"><b>${v.name}</b><small>${v.dept}</small></div>
            ${s.mode === 'voted' && html`<div class="what">${dLabel(v.design)} · ${shirtText(v)}${extrasOf(v).length ? html`<small class="more" title=${extrasOf(v).map(shirtText).join(', ')}>+ เพิ่ม ${extrasOf(v).length} ตัว</small>` : ''}<small>${fmtTime(v.time)}</small></div>`}
          </li>`)}
      </ul>
      ${list.length === 0 && html`<p class="empty">${emptyText}</p>`}
      ${s.adminKey ? canClear && html`<button class="danger" onClick=${() => this.clearAll()}>ล้างข้อมูลการโหวตทั้งหมด</button>`
        : html`<button class="text-btn" style="align-self:flex-start" onClick=${() => this.askForKey()}>ผู้ดูแล: ใส่รหัสเพื่อดาวน์โหลด</button>`}
    </section>`}
</main>`;
  }

  // Last check before saving: everything the vote will record, with a way back to edit.
  renderConfirm() {
    const s = this.state;
    const shirts = [{ cut: s.cut, size: s.size }, ...s.extras];
    const editing = !!(s.prevVote && s.person && s.prevVote.name === s.person.name);
    const close = () => { if (!s.saving) this.setState({ confirm: false }); };
    return html`
<div class="backdrop" onClick=${e => { if (e.target === e.currentTarget) close(); }}>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <h2 id="confirm-title">ตรวจสอบก่อนยืนยัน</h2>
    <dl>
      <dt>ชื่อ</dt><dd>${s.person.name}</dd>
      <dt>โหวต</dt><dd>${dLabel(s.design)}</dd>
      ${shirts.map((x, j) => html`<dt>ตัวที่ ${j + 1}</dt><dd>${shirtText(x)} <span class="hint" style="font-weight:400">${j === 0 ? 'ฟรี' : 'ชำระเอง'}</span></dd>`)}
      ${s.phone.trim() && html`<dt>เบอร์โทร</dt><dd>${s.phone.trim()}</dd>`}
      ${s.note.trim() && html`<dt>หมายเหตุ</dt><dd>${s.note.trim()}</dd>`}
    </dl>
    ${s.extras.length > 0 && html`<p class="paid-note" style="margin:0">ฟรี 1 ตัว · ชำระเอง ${s.extras.length} ตัว</p>`}
    ${s.error && html`<p class="lock-err" style="margin:0" role="alert">${s.error}</p>`}
    <div class="sheet-actions">
      <button class="btn btn-ghost" disabled=${s.saving} onClick=${close}>แก้ไข</button>
      <button class="btn btn-primary" disabled=${s.saving} onClick=${() => this.submit()}>
        ${s.saving ? 'กำลังบันทึก…' : editing ? 'ยืนยันการแก้ไข' : 'ยืนยันโหวต'}
      </button>
    </div>
  </div>
</div>`;
  }

  renderDone() {
    const done = this.state.done;
    return html`
<div class="backdrop">
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="done-title">
    <h2 id="done-title">บันทึกโหวตแล้ว</h2>
    <p>ขอบคุณ ${done.name}</p>
    <dl>
      <dt>โหวต</dt><dd>${dLabel(done.design)}</dd>
      ${shirtsOf(done).map((x, j) => html`<dt>ตัวที่ ${j + 1}</dt><dd>${shirtText(x)} <span class="hint" style="font-weight:400">${j === 0 ? 'ฟรี' : 'ชำระเอง'}</span></dd>`)}
    </dl>
    ${extrasOf(done).length > 0 && html`<p class="paid-note" style="margin:0">ฟรี 1 ตัว · ชำระเอง ${extrasOf(done).length} ตัว</p>`}
    <div class="sheet-actions">
      <button class="btn btn-ghost" onClick=${() => this.resetForm()}>โหวตให้คนถัดไป</button>
      <button class="btn btn-primary" onClick=${() => this.resetForm()}>เสร็จสิ้น</button>
    </div>
  </div>
</div>`;
  }

  renderLightbox() {
    const lb = this.state.lightbox;
    const d = DESIGNS.find(x => x.id === lb.id), other = DESIGNS.find(x => x.id !== lb.id);
    const setKind = kind => this.setState(st => ({ lightbox: { ...st.lightbox, kind } }));
    return html`
<div class="lb" role="dialog" aria-modal="true" aria-label=${d.label}>
  <div class="lb-top">
    <b>${d.label}</b>
    <button class="lb-close" onClick=${() => this.setState({ lightbox: null })}>ปิด</button>
  </div>
  <div class="lb-img"><img src=${lb.kind === 'chart' ? d.chart : d.board} alt=${`${d.label} ${lb.kind === 'chart' ? 'ตารางไซซ์' : 'ภาพรายละเอียด'}`} /></div>
  <div class="lb-bottom">
    <div class="seg">
      <button aria-pressed=${lb.kind === 'board'} onClick=${() => setKind('board')}>ภาพรายละเอียด</button>
      <button aria-pressed=${lb.kind === 'chart'} onClick=${() => setKind('chart')}>ตารางไซซ์</button>
    </div>
    <button class="lb-other" onClick=${() => this.setState(st => ({ lightbox: { ...st.lightbox, id: other.id } }))}>ดู${other.label}</button>
  </div>
</div>`;
  }
}

render(html`<${App} />`, document.getElementById('app'));
