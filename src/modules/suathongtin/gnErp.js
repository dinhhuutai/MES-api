'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TRẢ VỀ GN ⇄ ERP (07/10/2026, người dùng chốt) — bỏ nút "Hủy vải" · "Xác nhận lại" · "Lấy từ ERP".
//
// Luồng:
//   1. Màn bất kỳ bấm "Trả về GN" ⇒ phần in vào trang *Phần in chờ sửa thông tin* (như cũ) VÀ MES gửi NGAY
//      lệnh HỦY ĐỢT READY sang ERP (`huyBenErp` → `/gui-ds-huy-vai` → proc `SX_spr_DSPhieuNhanvaiReadyHuy`,
//      các cặp `code phần, IDDotReady`). Đợt gửi = đợt sống CHƯA vào sản xuất của phần in (`SQL_DOT_GUI`).
//   2. GN sửa thông tin + xác nhận lại TRÊN ERP ⇒ ERP đưa đợt lên lại danh sách ready ⇒ đồng bộ chính
//      `/phieu-nhan-vai-60` kéo về. `truocDongBo` (gọi trong `erpsync.runSync`) nhận ra dòng của cặp đã hủy
//      ⇒ áp thông tin đã sửa lên CHÍNH đợt cũ ⇒ đóng lượt trả về ⇒ phần in hiện lại ĐÚNG màn đã bấm trả về
//      (lệnh/đợt/xác nhận KT giữ nguyên lúc trả về — chỉ gỡ cờ, như "Xác nhận lại" cũ).
//
// ⚠⚠ NHẬN DIỆN "ERP GỬI LẠI" (đo prod 07/10/2026: `/phieu-nhan-vai-60` là CỬA SỔ ~7 GIỜ theo mốc ready của
//   ERP — cùng 1 dòng có mặt ở MỌI lượt đồng bộ trong 7 giờ đó). Dòng có mặt CHƯA chắc là đã xác nhận lại:
//   đợt vừa về < 7 giờ mà ERP chưa gỡ (proc hủy chưa viết xong, lỗi…) thì dòng CŨ vẫn nằm đó. Coi là gửi lại
//   khi (a) mốc ERP của dòng (`erp_datetime`/`created_date`, giờ VN) SAU lúc hủy thành công, HOẶC (b) đã có
//   ≥1 lượt đồng bộ sau khi hủy mà cặp đó VẮNG mặt (audit `GN_ERP_VANG`) rồi nay có lại. Chưa đủ ⇒ BỎ QUA
//   dòng (không cập nhật, không đẻ đợt mới), phần in nằm chờ tiếp.
//   ⇒ YÊU CẦU PHÍA ERP: xác nhận lại phải đưa đợt vào lại danh sách ready với mốc ready MỚI (đợt cũ hơn 7 giờ
//      mà giữ mốc cũ thì không bao giờ lọt cửa sổ `-60` nữa).
// ⚠⚠ ĐỔI KHÓA ĐỢT: khóa đợt MES `ERP-<md5>` băm cả `created_date` + màu/kích/SL của dòng ⇒ dòng xác nhận lại
//   gần như chắc chắn ra khóa MỚI ⇒ `runSync` sẽ ĐẺ THÊM đợt trùng. Nên trước vòng upsert, đợt cũ được đổi
//   `ma_dot_vai` sang khóa mới (cùng IDDotReady, ghép 1–1) ⇒ upsert tìm thấy, các lượt sau idempotent.
//
// Vết (audit_log, `ten_bang='qc_tra_ve'`, `id_ban_ghi` = id lượt — dùng index (ten_bang, id_ban_ghi)):
//   `GN_ERP_HUY` mỗi lần gửi { ok, trang_thai, cap:[{dot_vai_ve_id, ma_dot_vai, id_dot_ready}], loi, id_ket_noi }
//   · `GN_ERP_VANG` lượt đồng bộ đầu tiên sau hủy mà ERP không còn trả cặp nào · `GN_ERP_NHAN_LAI` cặp đã nhận
//   lại (+ đổi khóa) · đóng lượt = `GN_XAC_NHAN_LAI` { tu_dong: true } (người NULL = hệ thống).
// ⚠ KHÔNG NÉM LỖI ra đường ngầm (trả về GN / đồng bộ ERP) — hỏng ở đây không được chặn thao tác chính.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const erp = require('../../utils/erpApiChung');
const sockets = require('../../sockets');
const repo = require('./suathongtin.repository');

const H = { HUY: 'GN_ERP_HUY', VANG: 'GN_ERP_VANG', NHAN_LAI: 'GN_ERP_NHAN_LAI' };
const GIU_NGAY = 60; // chỉ theo dõi lượt hủy trong 60 ngày gần nhất

const hoa = (v) => String(v == null ? '' : v).trim().toUpperCase();
const khoaCap = (codePhan, idDot) => `${hoa(codePhan)}|${hoa(idDot)}`;
const ghi = (luotId, hanhDong, moi, actorId = null) => repo.ghiAudit({ query: (sql, p) => query(sql, p) }, luotId, hanhDong, moi, actorId);
// Mốc ERP của dòng → 'YYYY-MM-DD HH:mm:ss' GIỜ VN (ERP gửi giờ VN dán nhãn Z — đo prod 07/10/2026).
const mocErp = (r) => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String((r && (r.erp_datetime || r.created_date || r.ngaynhanvai)) || ''));
  return m ? `${m[1]} ${m[2]}` : '';
};
const idDotErp = (r) => {
  const E = require('../erpsync/erpsync.service')._erp; // lazy — erpsync.service gọi ngược sang file này
  return E.erpBarcode(r);
};

// Đợt gửi hủy bên ERP: đợt SỐNG, có IDDotReady, CHƯA vào sản xuất (không thuộc lệnh ≠ HUY nào đã qua
// Release 2 hoặc đã có phiếu chạy) — cùng phạm vi các màn "tạm rời" khi trả về GN (`utils/traVeGn.js`).
const SQL_DOT_GUI = `SELECT dv.id, dv.ma_dot_vai, btrim(dv.barcode) AS id_dot_ready FROM dot_vai_ve dv
  WHERE dv.phan_in_id = $1 AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY') AND COALESCE(btrim(dv.barcode),'') <> ''
    AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
      WHERE l.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY'
        AND (ls.trang_thai NOT IN ('RELEASE_1','RELEASE_2')
             OR EXISTS (SELECT 1 FROM phieu_san_xuat ps WHERE ps.lenh_san_xuat_id = ls.id AND ps.trang_thai <> 'HUY')))
  ORDER BY dv.created_date`.replace(/\s+/g, ' ');

/**
 * Gửi lệnh hủy đợt READY bên ERP cho 1 lượt trả về GN rồi ghi `GN_ERP_HUY`. Không ném lỗi.
 * trang_thai: DA_HUY (ERP nhận) · LOI · API_TAT · KHONG_CO_DOT (không đợt nào có IDDotReady / chưa sản xuất).
 */
async function huyBenErp(luotId, { phanInId, maPhan }, actorId = null) {
  try {
    const { rows } = await query(SQL_DOT_GUI, [phanInId]);
    const cap = rows.map((d) => ({ dot_vai_ve_id: d.id, ma_dot_vai: d.ma_dot_vai, id_dot_ready: d.id_dot_ready }));
    const kq = cap.length
      ? await erp.guiDsHuyVai(cap.map((c) => ({ codePhan: maPhan, idDotReady: c.id_dot_ready })), { actorId, idBanGhi: luotId })
      : { ok: false, bo_qua: true, ly_do: 'KHONG_CO_DOT' };
    const trangThai = kq.ok ? 'DA_HUY' : kq.ly_do === 'KHONG_CO_DOT' ? 'KHONG_CO_DOT' : kq.bo_qua ? 'API_TAT' : 'LOI';
    await ghi(luotId, H.HUY, {
      ok: !!kq.ok, trang_thai: trangThai, phan_in_id: phanInId, ma_phan: maPhan, cap,
      id_ket_noi: kq.id_ket_noi || null, loi: kq.error || null,
    }, actorId);
    sockets.emit('gn:updated', { phanInId, erp: true });
    return { ok: !!kq.ok, trang_thai: trangThai, so_cap: cap.length, error: kq.error || null, id_ket_noi: kq.id_ket_noi || null };
  } catch (e) {
    console.error(`[gn-erp] ✗ Gửi hủy đợt READY bên ERP lỗi (${maPhan}): ${e.message}`);
    return { ok: false, trang_thai: 'LOI', error: e.message };
  }
}

// "Gửi lại" ở *Cài đặt API › Lịch sử* thành công ⇒ lượt đó coi như ERP đã hủy (chép `cap` của lần thử trước).
async function danhDauGuiLaiThanhCong(luotId, idKetNoi, actorId = null) {
  try {
    const { rows } = await query(
      "SELECT a.gia_tri_moi FROM audit_log a WHERE a.ten_bang = 'qc_tra_ve' AND a.id_ban_ghi = $1 AND a.hanh_dong = $2 ORDER BY a.thoi_gian DESC LIMIT 1",
      [String(luotId), H.HUY]);
    if (!rows.length) return false;
    const cu = rows[0].gia_tri_moi || {};
    await ghi(luotId, H.HUY, { ...cu, ok: true, trang_thai: 'DA_HUY', id_ket_noi: idKetNoi || cu.id_ket_noi || null, loi: null, gui_lai: true }, actorId);
    sockets.emit('gn:updated', { phanInId: cu.phan_in_id || null, erp: true });
    return true;
  } catch (e) {
    console.error(`[gn-erp] ✗ Đánh dấu gửi lại thành công lỗi: ${e.message}`);
    return false;
  }
}

// Trạng thái ERP của các lượt ĐANG CHỜ của 1 phần in — guard cho "Xác nhận lại" tay / "Gửi hủy sang ERP".
async function trangThaiDangCho(phanInId) {
  const cho = await repo.dangCho(phanInId);
  const daHuy = cho.some((q) => q.erp_huy && q.erp_huy.ok === true);
  return { cho, daHuy };
}

// ─── ĐỒNG BỘ ERP: NHẬN LẠI ĐỢT ĐÃ HỦY ───────────────────────────────────────
// Các lượt đang theo dõi: có lần hủy thành công trong `GIU_NGAY` ngày, còn cặp CHƯA nhận lại mà đợt còn sống.
// (Lượt đã đóng vẫn theo dõi cặp còn lại — GN xác nhận lại trên ERP từng đợt — để không đẻ đợt trùng.)
async function napDangTheoDoi() {
  const { rows: au } = await query(
    `SELECT a.id_ban_ghi AS luot_id, a.hanh_dong, a.gia_tri_moi, a.thoi_gian,
            to_char(a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') AS tg_vn
       FROM audit_log a
      WHERE a.ten_bang = 'qc_tra_ve' AND a.hanh_dong IN ($1, $2, $3)
        AND a.thoi_gian > now() - make_interval(days => $4)
      ORDER BY a.thoi_gian`.replace(/\s+/g, ' '),
    [H.HUY, H.VANG, H.NHAN_LAI, GIU_NGAY]);
  const theoLuot = new Map();
  for (const a of au) {
    if (!theoLuot.has(a.luot_id)) theoLuot.set(a.luot_id, []);
    theoLuot.get(a.luot_id).push(a);
  }
  const luot = [];
  for (const [luotId, ds] of theoLuot) {
    const huy = [...ds].reverse().find((a) => a.hanh_dong === H.HUY && a.gia_tri_moi && a.gia_tri_moi.ok === true);
    if (!huy) continue;
    const sau = ds.filter((a) => a.thoi_gian > huy.thoi_gian);
    const daNhan = new Set(sau.filter((a) => a.hanh_dong === H.NHAN_LAI)
      .flatMap((a) => ((a.gia_tri_moi && a.gia_tri_moi.cap) || []).map((c) => String(c.dot_vai_ve_id))));
    const cap = ((huy.gia_tri_moi && huy.gia_tri_moi.cap) || []).filter((c) => !daNhan.has(String(c.dot_vai_ve_id)));
    if (!cap.length) continue;
    luot.push({
      luot_id: luotId, tg_huy_vn: huy.tg_vn, vang: sau.some((a) => a.hanh_dong === H.VANG), cap,
    });
  }
  if (!luot.length) return [];
  const [{ rows: qs }, { rows: dots }] = await Promise.all([
    query(`SELECT q.id::text AS luot_id, q.da_xu_ly, q.phan_in_id, pin.ma_phan FROM qc_tra_ve q
             JOIN phan_in pin ON pin.id = q.phan_in_id WHERE q.id = ANY($1::uuid[])`.replace(/\s+/g, ' '),
    [luot.map((l) => l.luot_id)]),
    query("SELECT id::text AS id, ma_dot_vai FROM dot_vai_ve WHERE id = ANY($1::uuid[]) AND trang_thai NOT IN ('DA_GOP','DA_HUY')",
      [[...new Set(luot.flatMap((l) => l.cap.map((c) => String(c.dot_vai_ve_id))))]]),
  ]);
  const qMap = new Map(qs.map((q) => [q.luot_id, q]));
  const dMap = new Map(dots.map((d) => [d.id, d]));
  return luot.map((l) => {
    const q = qMap.get(l.luot_id);
    if (!q) return null;
    // Đợt đã hủy/gộp trong MES thì thôi theo dõi (ERP gửi lại ⇒ đi đường "đợt mới" bình thường).
    const cap = l.cap.map((c) => ({ ...c, dot: dMap.get(String(c.dot_vai_ve_id)) })).filter((c) => c.dot);
    return cap.length ? { ...l, ...q, cap } : null;
  }).filter(Boolean);
}

// Ghép dòng ERP ↔ đợt cũ CÙNG IDDotReady (1–1): trùng khóa trước, còn lại theo thứ tự. Đổi `ma_dot_vai` của
// đợt sang khóa mới (khóa mới đã thuộc đợt khác ⇒ không đổi, ghi lại). Trả danh sách cặp đã nhận.
async function ghepVaDoiKhoa(L, dong) {
  const nhan = [];
  const theoId = new Map();
  for (const c of L.cap) {
    const k = hoa(c.id_dot_ready);
    if (!theoId.has(k)) theoId.set(k, { dots: [], rows: [] });
    theoId.get(k).dots.push(c);
  }
  for (const p of dong) {
    const g = theoId.get(hoa(idDotErp(p.r)));
    if (g && !g.rows.includes(p)) g.rows.push(p);
  }
  for (const { dots, rows } of theoId.values()) {
    const conDot = [...dots]; const conDong = [];
    for (const p of rows) {
      const i = conDot.findIndex((c) => c.dot.ma_dot_vai === p.maDotVai);
      if (i >= 0) nhan.push({ c: conDot.splice(i, 1)[0], p }); else conDong.push(p);
    }
    while (conDot.length && conDong.length) nhan.push({ c: conDot.shift(), p: conDong.shift() });
  }
  const out = [];
  for (const { c, p } of nhan) {
    const cu = c.dot.ma_dot_vai;
    let moi = cu;
    let ghiChu = null;
    if (p.maDotVai && p.maDotVai !== cu) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: trung } = await query('SELECT id::text AS id FROM dot_vai_ve WHERE ma_dot_vai = $1 LIMIT 1', [p.maDotVai]);
      if (trung.length && trung[0].id === String(c.dot_vai_ve_id)) moi = p.maDotVai; // lượt khác vừa đổi rồi
      else if (trung.length) ghiChu = `Khóa mới ${p.maDotVai} đã thuộc đợt khác — giữ khóa cũ`;
      else {
        // eslint-disable-next-line no-await-in-loop
        const { rowCount } = await query(
          'UPDATE dot_vai_ve SET ma_dot_vai = $2, updated_date = CURRENT_TIMESTAMP WHERE id = $1 AND ma_dot_vai = $3',
          [c.dot_vai_ve_id, p.maDotVai, cu]);
        if (rowCount) moi = p.maDotVai;
      }
    }
    out.push({ dot_vai_ve_id: c.dot_vai_ve_id, id_dot_ready: c.id_dot_ready, ma_dot_vai_cu: cu, ma_dot_vai_moi: moi, ghi_chu: ghiChu });
  }
  return out;
}

/**
 * Gọi trong `erpsync.runSync` SAU khi dựng `prepared`, TRƯỚC vòng upsert. Không ném lỗi.
 * @param {object} o
 * @param {object[]} o.rows      mọi dòng ERP của lượt (kể cả dòng bị bỏ qua) — để biết cặp có mặt hay vắng
 * @param {object[]} o.prepared  dòng đã dựng khóa `{ r, maDotVai, skip }`
 * @param {boolean} o.theoDoiVang chỉ lượt đồng bộ CHÍNH (gọi ERP thật, đủ cửa sổ) mới được ghi "vắng"
 * @returns {{ boQua: Set, so_bo_qua: number, sau: () => Promise<object[]> }}
 *   `boQua` = các phần tử `prepared` vòng upsert phải BỎ (dòng cũ của đợt đã hủy, ERP chưa xác nhận lại);
 *   `sau()` chạy SAU vòng upsert: áp thông tin đã sửa + đóng lượt + báo các màn.
 */
async function truocDongBo({ rows = [], prepared = [], theoDoiVang = false } = {}) {
  const rong = { boQua: new Set(), so_bo_qua: 0, sau: async () => [] };
  let ds;
  try { ds = await napDangTheoDoi(); } catch (e) {
    console.error(`[gn-erp] ✗ Đọc lượt trả về GN đang chờ ERP lỗi: ${e.message}`);
    return rong;
  }
  if (!ds.length) return rong;
  const theoCap = new Map();
  for (const p of prepared) {
    if (p.skip) continue;
    const k = khoaCap(p.r.code_part, idDotErp(p.r));
    if (!theoCap.has(k)) theoCap.set(k, []);
    theoCap.get(k).push(p);
  }
  const coMat = new Set(rows.map((r) => khoaCap(r.code_part, idDotErp(r))));
  const boQua = new Set();
  const traLai = [];
  for (const L of ds) {
    try {
      const keys = [...new Set(L.cap.map((c) => khoaCap(L.ma_phan, c.id_dot_ready)))];
      if (!keys.some((k) => coMat.has(k))) {
        // Vắng cả lượt ⇒ ERP đã gỡ các đợt khỏi danh sách ready (hoặc chúng đã rơi khỏi cửa sổ).
        if (theoDoiVang && rows.length && !L.vang) {
          await ghi(L.luot_id, H.VANG, { ma_phan: L.ma_phan, so_cap: L.cap.length });
        }
        continue;
      }
      const dong = [...new Set(keys.flatMap((k) => theoCap.get(k) || []))];
      if (!dong.length) continue; // chỉ có dòng bị bỏ qua (loaikd / tính chất in ngoài phạm vi)
      const guiLai = L.vang || dong.some((p) => mocErp(p.r) > L.tg_huy_vn);
      if (!guiLai) { dong.forEach((p) => boQua.add(p)); continue; }
      const nhan = await ghepVaDoiKhoa(L, dong);
      if (!nhan.length) continue;
      await ghi(L.luot_id, H.NHAN_LAI, { ma_phan: L.ma_phan, cap: nhan });
      traLai.push({ L, dongR: rows.filter((r) => hoa(r.code_part) === hoa(L.ma_phan)) });
    } catch (e) {
      console.error(`[gn-erp] ✗ Nhận lại đợt từ ERP lỗi (${L.ma_phan}): ${e.message}`);
    }
  }
  return { boQua, so_bo_qua: boQua.size, sau: () => sauDongBo(traLai) };
}

// Sau vòng upsert: áp phần `upsert` không làm (đơn/mã hàng, SL đợt, mã vạch, chờ khô — `capNhatMotPhanIn`)
// rồi ĐÓNG lượt đang chờ ⇒ phần in về đúng màn đã trả về. Lượt đã đóng (cặp về sau) thì chỉ đổi khóa ở trên.
async function sauDongBo(traLai) {
  const ketQua = [];
  const daDong = new Set();
  for (const { L, dongR } of traLai) {
    if (L.da_xu_ly || daDong.has(L.phan_in_id)) continue;
    try {
      const { rows: [pin] } = await query(
        'SELECT id, ma_phan, barcode, thoi_gian_cho_kho_phut FROM phan_in WHERE id = $1', [L.phan_in_id]);
      let capNhat = null;
      if (pin && dongR.length) {
        try { capNhat = await require('./erpCapNhat').capNhatMotPhanIn(pin, dongR, null); }
        catch (e) { capNhat = { ghi_chu: `Áp thông tin ERP lỗi: ${e.message}` }; }
      }
      const kq = await require('./suathongtin.service').xacNhanTuDong(L.phan_in_id, capNhat);
      daDong.add(L.phan_in_id);
      if (kq) ketQua.push({ ma_phan: L.ma_phan, ve_man: kq.ve_man });
    } catch (e) {
      console.error(`[gn-erp] ✗ Tự trả phần in về màn cũ lỗi (${L.ma_phan}): ${e.message}`);
    }
  }
  if (ketQua.length) console.log(`[gn-erp] ERP gửi lại ${ketQua.length} phần in — đã trả về màn cũ: ${ketQua.map((x) => x.ma_phan).join(', ')}`);
  return ketQua;
}

module.exports = {
  huyBenErp, danhDauGuiLaiThanhCong, trangThaiDangCho, truocDongBo, H,
  // export để kiểm thực
  _mocErp: mocErp, _napDangTheoDoi: napDangTheoDoi,
};
