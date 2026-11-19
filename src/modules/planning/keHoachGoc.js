// ─────────────────────────────────────────────────────────────────────────────
// KẾ HOẠCH GỐC KHI SẢN XUẤT GỘP LỆNH — Danh sách release (+ In lệnh SX) theo ngày kế hoạch / ngày release.
//
// Sản xuất bấm chạy chung các lệnh cùng code phần + cùng chuyền (`production.gopLenhCungPhan`): lệnh nguồn HUY, SL dồn
//   vào lệnh đích ⇒ lệnh đích mang SL của nhiều NGÀY kế hoạch. Danh sách release đọc theo lệnh nên ngày của lệnh nguồn
//   mất kế hoạch, ngày của lệnh đích phình số. Luật (người dùng chốt): VẪN GỘP khi chạy, nhưng danh sách giữ KẾ HOẠCH
//   GỐC — mỗi lệnh nguồn hiện lại ở đúng ngày của nó với SL của nó, tiến độ (trạng thái, tem, test) lấy của lệnh đang
//   chạy; dòng lệnh đích chỉ còn phần của chính nó.
//
// Dữ liệu: lệnh nguồn giữ nguyên dòng `lenh_sx_dot_vai` + cột kế hoạch (gộp chỉ đổi `trang_thai`) ⇒ SL + ngày + giờ
//   của phần kế hoạch đọc thẳng từ lệnh nguồn. Quan hệ gộp ở audit `GOP_LENH_SX` (đích, `tu_lenh_ids`) / `GOP_VAO_LENH`
//   (nguồn, `vao_lenh_id`); gộp nối tiếp (đích bị gộp tiếp vào lệnh khác) đi đệ quy.
// ⚠ Kế hoạch đổi SL của lệnh đích SAU khi gộp (`REPLAN` / `QUAN_TRI_SUA_KE_HOACH` có `so_luong_release` cũ ≠ mới — người
//   lập kế hoạch đã nhìn thấy số gộp và đặt lại) ⇒ các lần gộp TRƯỚC đó coi như đã được kế hoạch chấp nhận, không tách
//   nữa. Sửa giờ / ngày / chuyền mà giữ SL thì vẫn tách. Giảm SL (Trả về Kế hoạch khi đang chạy, Cập nhật SL) trừ vào
//   phần của chính lệnh trước, thiếu mới trừ phần gộp vào sau cùng.
// Tách 1 lệnh ra khỏi lệnh gộp (`production.tachLenhGop`, audit `TACH_LENH_GOP` trên cả đích `tach_lenh_id` lẫn nguồn
//   `tu_lenh_id`) SAU lần gộp ⇒ cặp (đích, nguồn) đó không còn là phần chạy chung (gộp lại lần nữa sau đó thì tính lại).
// ─────────────────────────────────────────────────────────────────────────────
const repo = require('./planning.repository');

const HD_GOP = ['GOP_LENH_SX', 'GOP_VAO_LENH', 'TACH_LENH_GOP'];
const HD_DAT_LAI = ['REPLAN', 'QUAN_TRI_SUA_KE_HOACH'];
const TOI_DA_VONG = 6;

const soNguyen = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const tg = (v) => new Date(v).getTime();

// Kế hoạch đặt lại SL (cũ ≠ mới) ⇒ mốc; không có ⇒ 0.
function mocDatLai(auditDatLai) {
  let moc = 0;
  for (const a of auditDatLai) {
    const cu = soNguyen(a.gia_tri_cu && a.gia_tri_cu.so_luong_release);
    const moi = soNguyen(a.gia_tri_moi && a.gia_tri_moi.so_luong_release);
    if (cu != null && moi != null && cu !== moi) moc = Math.max(moc, tg(a.thoi_gian));
  }
  return moc;
}

// Mốc tách mới nhất của từng cặp `<đích>|<nguồn>` (đọc từ dòng của đích lẫn dòng của nguồn).
function mocTach(auditGop) {
  const m = new Map();
  auditGop.filter((a) => a.hanh_dong === 'TACH_LENH_GOP').forEach((a) => {
    const v = a.gia_tri_moi || {};
    let cap = null;
    if (v.tach_lenh_id) cap = `${a.lenh_id}|${v.tach_lenh_id}`;
    else if (v.tu_lenh_id) cap = `${v.tu_lenh_id}|${a.lenh_id}`;
    if (cap) m.set(cap, Math.max(m.get(cap) || 0, tg(a.thoi_gian)));
  });
  return m;
}

// Nguồn còn hiệu lực của từng lệnh: Map lenhId → [{ id, tg }] (gộp sau mốc đặt lại kế hoạch, chưa tách sau lần gộp, theo thời gian).
function nguonHieuLuc(auditGop, auditDatLai, vaoLenh) {
  const tach = mocTach(auditGop);
  const datLaiTheoLenh = new Map();
  auditDatLai.forEach((a) => {
    if (!datLaiTheoLenh.has(a.lenh_id)) datLaiTheoLenh.set(a.lenh_id, []);
    datLaiTheoLenh.get(a.lenh_id).push(a);
  });
  const out = new Map();
  auditGop.filter((a) => a.hanh_dong === 'GOP_LENH_SX').forEach((a) => {
    const moc = mocDatLai(datLaiTheoLenh.get(a.lenh_id) || []);
    if (tg(a.thoi_gian) <= moc) return;
    const ids = (a.gia_tri_moi && a.gia_tri_moi.tu_lenh_ids) || [];
    ids.map(String).forEach((s) => {
      if (vaoLenh.get(s) !== a.lenh_id) return; // nguồn phải trỏ đúng về đích này
      // Đã tách ra sau lần gộp này (`>=`: tách chỉ có thể xảy ra SAU gộp, JS chỉ tới mili-giây).
      if ((tach.get(`${a.lenh_id}|${s}`) || 0) >= tg(a.thoi_gian)) return;
      if (!out.has(a.lenh_id)) out.set(a.lenh_id, []);
      out.get(a.lenh_id).push({ id: s, tg: tg(a.thoi_gian) });
    });
  });
  return out;
}

// Các phần kế hoạch của lệnh `id`: [{ id, sl }] — phần đầu là của chính lệnh, sau đó là các nguồn (đệ quy).
function cacPhan(id, nguon, slTheoId, daQua = new Set()) {
  if (daQua.has(id)) return [];
  daQua.add(id);
  const ds = (nguon.get(id) || []).slice().sort((a, b) => a.tg - b.tg);
  const con = ds.map((s) => cacPhan(s.id, nguon, slTheoId, daQua)).filter((p) => p.length);
  const tong = slTheoId.get(id) || 0;
  const slCon = con.reduce((s, p) => s + p.reduce((x, y) => x + y.sl, 0), 0);
  let rieng = tong - slCon;
  const phanCon = con.flat().map((p) => ({ ...p }));
  if (rieng < 0) { // giảm SL nhiều hơn phần riêng ⇒ trừ tiếp vào phần gộp sau cùng
    let thieu = -rieng; rieng = 0;
    for (let i = phanCon.length - 1; i >= 0 && thieu > 0; i -= 1) {
      const bot = Math.min(phanCon[i].sl, thieu);
      phanCon[i].sl -= bot; thieu -= bot;
    }
  }
  return [{ id, sl: rieng }, ...phanCon];
}

// rows = dòng `releaseListByDate` (lệnh sống của ngày) · trả mảng dòng đã tách theo kế hoạch gốc.
async function tachKeHoachGoc(rows, date, mode) {
  if (mode !== 'KE_HOACH' && mode !== 'RELEASE') return rows;
  const songIds = [...new Set(rows.map((r) => String(r.lenh_id)))];
  const nguonNgay = await repo.lenhGopTheoNgay(date, mode);

  // Bao đóng họ gộp: đi lên (nguồn → đích) và đi xuống (đích → nguồn) tới khi không thêm lệnh mới.
  const ho = new Set([...songIds, ...nguonNgay]);
  const daDoc = new Set();
  const auditGop = [];
  for (let vong = 0; vong < TOI_DA_VONG; vong += 1) {
    const moi = [...ho].filter((x) => !daDoc.has(x));
    if (!moi.length) break;
    moi.forEach((x) => daDoc.add(x));
    // eslint-disable-next-line no-await-in-loop
    const ds = await repo.auditGopLenh(moi, HD_GOP);
    auditGop.push(...ds);
    ds.forEach((a) => {
      const v = a.gia_tri_moi || {};
      if (a.hanh_dong === 'GOP_VAO_LENH' && v.vao_lenh_id) ho.add(String(v.vao_lenh_id));
      if (a.hanh_dong === 'GOP_LENH_SX') (v.tu_lenh_ids || []).forEach((s) => ho.add(String(s)));
    });
  }
  if (!auditGop.length) return rows; // ngày này không có lệnh nào dính gộp — đường nhanh

  const hoIds = [...ho];
  const [auditDatLai, slRows] = await Promise.all([repo.auditGopLenh(hoIds, HD_DAT_LAI), repo.slLenhTheoId(hoIds)]);
  const lenhTheoId = new Map(slRows.map((l) => [l.id, l]));
  const slTheoId = new Map(slRows.map((l) => [l.id, l.sl]));
  // Nguồn → đích (lần gộp mới nhất của nguồn).
  const vaoLenh = new Map();
  auditGop.filter((a) => a.hanh_dong === 'GOP_VAO_LENH').forEach((a) => {
    const v = a.gia_tri_moi || {};
    if (v.vao_lenh_id) vaoLenh.set(a.lenh_id, String(v.vao_lenh_id));
  });
  const nguon = nguonHieuLuc(auditGop, auditDatLai, vaoLenh);

  // Gốc đang sống của 1 lệnh (đi theo chuỗi gộp).
  const gocSong = (id) => {
    let x = id;
    for (let i = 0; i < 20; i += 1) {
      const l = lenhTheoId.get(x);
      if (l && l.trang_thai !== 'HUY') return x;
      const v = vaoLenh.get(x);
      if (!v) return null;
      x = v;
    }
    return null;
  };
  // Phần kế hoạch theo gốc: Map gốc → Map lệnh → sl.
  const phanTheoGoc = new Map();
  const phanCua = (goc) => {
    if (!phanTheoGoc.has(goc)) phanTheoGoc.set(goc, new Map(cacPhan(goc, nguon, slTheoId).map((p) => [p.id, p.sl])));
    return phanTheoGoc.get(goc);
  };
  const tomTat = (goc, boId) => [...phanCua(goc).entries()]
    .filter(([id, sl]) => id !== boId && sl > 0)
    .map(([id, sl]) => ({ lenh_id: id, ma_lenh: lenhTheoId.get(id)?.ma_lenh_san_xuat || '', sl, ngay_ke_hoach: lenhTheoId.get(id)?.ngay_ke_hoach || null }));

  // 1) Dòng lệnh sống của ngày: chỉ còn phần RIÊNG của lệnh.
  const out = [];
  for (const r of rows) {
    const id = String(r.lenh_id);
    const p = phanCua(id);
    if (p.size <= 1) { out.push(r); continue; }
    const rieng = p.get(id) || 0;
    if (rieng <= 0) continue; // cả SL của lệnh là phần gộp từ ngày khác
    out.push({ ...r, so_luong_release: rieng, sl_release_phan: rieng, chay_chung: tomTat(id, id) });
  }

  // 2) Lệnh nguồn của ngày: dòng mới = kế hoạch của nguồn + tiến độ của lệnh đang chạy.
  const can = [];
  nguonNgay.forEach((s) => {
    const goc = gocSong(s);
    if (!goc) return;
    const sl = phanCua(goc).get(s) || 0;
    if (sl > 0) can.push({ s, goc, sl });
  });
  if (!can.length) return out;
  const dongCan = await repo.dongReleaseTheoLenh([...new Set(can.flatMap((x) => [x.s, x.goc]))]);
  const dongTheoLenh = new Map();
  dongCan.forEach((d) => { if (!dongTheoLenh.has(String(d.lenh_id))) dongTheoLenh.set(String(d.lenh_id), d); });
  const COT_KE_HOACH = ['lenh_id', 'ma_lenh_san_xuat', 'ngay_ke_hoach', 'created_date', 'tg_bd_kh', 'tg_kt_kh', 'giai_doan',
    'tho_in_kh', 'dinh_muc_kh', 'ma_chuyen', 'ten_chuyen', 'dinh_muc_gio', 'ma_loai_chuyen', 'ten_loai_chuyen', 'owner',
    'slnv', 'han_giao', 'khuon_ok', 'muc_ok'];
  for (const { s, goc, sl } of can) {
    const ds = dongTheoLenh.get(s); const dg = dongTheoLenh.get(goc);
    if (!ds || !dg) continue;
    const keHoach = Object.fromEntries(COT_KE_HOACH.map((k) => [k, ds[k]]));
    out.push({
      ...dg, ...keHoach,
      so_luong_release: sl, sl_release_phan: sl, so_phan_in: 1,
      lenh_chay_id: goc, ma_lenh_chay: dg.ma_lenh_san_xuat,
      chay_chung: tomTat(goc, s),
    });
  }
  // Giữ thứ tự của câu SQL: chuyền → khách → đơn → giờ tạo lệnh → lệnh → code phần.
  const so = (a, b) => String(a || '').localeCompare(String(b || ''), 'vi');
  return out.sort((a, b) => {
    if (!a.ten_chuyen !== !b.ten_chuyen) return a.ten_chuyen ? -1 : 1;
    return so(a.ten_chuyen, b.ten_chuyen) || so(a.ten_khach_hang, b.ten_khach_hang) || so(a.ma_don_hang, b.ma_don_hang)
      || (tg(a.created_date) - tg(b.created_date)) || so(a.lenh_id, b.lenh_id) || so(a.ma_phan, b.ma_phan);
  });
}

module.exports = { tachKeHoachGoc, cacPhan, nguonHieuLuc, mocDatLai };
