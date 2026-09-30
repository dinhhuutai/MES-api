'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// KÉO THÔNG TIN ĐÃ SỬA TỪ ERP cho trang *Đơn hàng › Phần in chờ sửa thông tin* (25/09/2026).
//
// Luồng: READY (KT/QC) trả phần in về GN → GN sửa BÊN ERP → job 5 phút/lần gọi
//   GET {ERP_DS_PHAN_IN_SUA_THONG_TIN_URL}?fromDate=<ngày vải về sớm nhất − 3>T00:00:00&dsPhan=<code1,code2,…>
//   (router ERP → proc `SX_spr_DSPhieuNhanvaiReady(@pTuNgay, @pDsPhan NVARCHAR(4000))`)
// → CẬP NHẬT lại phần in + đợt vải đang chờ → GN tích chọn rồi "Xác nhận lại" ⇒ phần in về READY.
//
// ⚠⚠ LUẬT LẤY (chốt 26/09, đổi 30/09/2026):
//   · THEO CODE PHẦN — MỌI phần in đang chờ GN, KHÔNG còn giới hạn "trả về trong ngày" (hôm nay trả, mai
//     GN mới sửa bên ERP vẫn tự cập nhật). `fromDate` chỉ để proc không cắt mất đợt cũ (`tuNgay`).
//   · ĐỢT VẢI ghép theo MÃ ĐỢT ERP (`IDDotReady` ↔ `dot_vai_ve.barcode`), dư đúng 1–1 thì ghép nốt.
//   · MỖI LƯỢT TỐI ĐA 100 code phần (`TOI_DA_MOI_LUOT`); còn dư thì lượt sau (5 phút sau) lấy tiếp —
//     xoay vòng theo "lần hỏi ERP gần nhất" (RAM, `lanHoi`): phần in CHƯA hỏi lần nào đi trước, rồi tới
//     phần in hỏi lâu nhất. 100 mã × ~26 ký tự ≈ 2.600 < 4.000 (`@pDsPhan NVARCHAR(4000)`).
//   ⚠ Router ERP phải đọc `req.query.dsPhan` và truyền vào `@pDsPhan` (bản ERP gửi 26/09 còn ghim NULL ⇒
//     proc trả MỌI phần in từ ngày đó — MES vẫn tự lọc theo code phần nên không sai, chỉ nặng hơn).
//
// ⚠⚠ Hình dạng dòng = CÙNG trường với `/phieu-nhan-vai-60` (`code_part`, `customer_name`, `order_name`,
//   `item_name`, `fabric_color`, `fabric_size`, `film_size`, `order_qty`, `tinhchatin`, `due_date`,
//   `ngaynhanvai`, `received_qty`, `loaikd`, `NGC`, `IDDotReady`, `BarcodePTHDH`…) — proc cùng họ
//   `SX_Spr_DSPhieuNhanvai…`. Đọc bằng CHÍNH các hàm `erp*` của `erpsync.service`. Khác thì sửa ở ĐÂY.
//
// ⚠⚠ CỐ Ý KHÔNG DÙNG `runSync` của đồng bộ chính: khóa đợt vải `ERP-<md5>` băm cả màu/kích/SL ⇒ ERP
//   sửa màu là ra khóa MỚI ⇒ `runSync` sẽ ĐẺ THÊM một đợt vải trùng. Ở đây chỉ CẬP NHẬT bản ghi có sẵn.
//
// PHẠM VI GHI (chỉ phần in đang chờ GN — `qc_tra_ve` TRA_VE_GN chưa xử lý):
//   · PHẦN IN — khách/đơn/mã hàng + màu/kích vải/kích phim/SLĐH/tính chất in/subID ⇒ `ganLaiTheoDong`
//     (đúng hàm của "Cập nhật theo code phần", có audit `ERP_CAP_NHAT_CODE_PHAN`); mã vạch phần in +
//     thời gian chờ khô ⇒ `phaninadmin.suaPhanIn` (whitelist + audit).
//   · ĐỢT VẢI (chưa release) — hạn giao · ngày vải về · SL vải về · loại · nhà gia công · barcode đợt ·
//     dự án · inset ⇒ `phaninadmin.suaDotVai` (guard hạ SL dưới SL đã in + tính lại phương án in).
//     Đợt không ghép được dòng ERP ⇒ ghi vào kết quả, GN sửa tay trên trang.
//   · Mức phần in lấy dòng ERP có mã đợt THUỘC phần in (ERP có thể trả dòng đơn khác trùng code phần).
//   · CHỈ GHI KHI KHÁC giá trị hiện tại ⇒ job chạy 5 phút/lần không đẻ audit rác.
//   · KHÔNG tự "Xác nhận lại" — GN vẫn phải bấm (người dùng chốt).
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const env = require('../../config/env');
const { apiBat } = require('../../utils/caiDatApi');
const { LOAI_GN } = require('../../utils/traVeGn');
const erpSvc = require('../erpsync/erpsync.service');
const erpRepo = require('../erpsync/erpsync.repository');
const phanInAdmin = require('../phaninadmin/phaninadmin.service');
const repo = require('./suathongtin.repository');
const sockets = require('../../sockets');
const { ghiLog } = require('../../utils/erpApiLog');
const { taoIdKetNoi } = require('../../utils/idKetNoi');

const E = erpSvc._erp;
const MA_API = 'ERP_DS_SUA_THONG_TIN';

// Kết quả lượt chạy gần nhất (RAM) — trang hiện "ERP cập nhật lúc …". Mất khi restart BE, chấp nhận.
let lanCuoi = null;
let dangChay = false;
const TOI_DA_MOI_LUOT = 100;
// ma_phan → mốc (ms) lần gần nhất đã gửi lên ERP. Mất khi restart BE ⇒ lượt đầu hỏi lại từ đầu, vô hại.
const lanHoi = new Map();

const hoa = (v) => E.clean(v).toUpperCase();
const soHoacNull = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
const khacNhau = (a, b) => String(a ?? '').trim() !== String(b ?? '').trim();
// Ngày (DATE từ node-pg là Date lúc 00:00 giờ máy chủ) → 'YYYY-MM-DD' theo giờ LOCAL.
const ngayStr = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};
// Dòng ERP mới nhất (theo mốc ERP tạo) — dùng cho thông tin mức PHẦN IN khi ERP trả nhiều dòng.
const mocDong = (r) => String(r.erp_datetime || r.created_date || r.ngaynhanvai || '');

// MỌI phần in đang chờ GN (lượt trả về chưa xử lý) — KHÔNG còn lọc "trả về trong ngày" (30/09/2026:
// hôm nay trả mà mai GN mới sửa bên ERP thì vẫn phải tự cập nhật). `ngay_som` = ngày vải về sớm nhất
// của các đợt sống ⇒ dùng tính `fromDate` (proc ERP lọc `Dotnhanvai > @pTuNgay`).
async function phanInDangCho() {
  const { rows } = await query(
    `SELECT pin.id, pin.ma_phan, pin.barcode, pin.thoi_gian_cho_kho_phut, min(q.created_date) AS tg_tra_ve,
            (SELECT min(COALESCE(dv.ngay_vai_ve, (dv.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date))
               FROM dot_vai_ve dv WHERE dv.phan_in_id = pin.id AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')) AS ngay_som
       FROM qc_tra_ve q JOIN phan_in pin ON pin.id = q.phan_in_id AND pin.dang_hoat_dong
      WHERE q.loai = $1 AND q.da_xu_ly = false
      GROUP BY pin.id`.replace(/\s+/g, ' '),
    [LOAI_GN]
  );
  return rows;
}

// Chọn tối đa 100 phần in cho lượt này: chưa hỏi lần nào trước, rồi tới phần hỏi lâu nhất.
function chonLuot(pins) {
  return [...pins]
    .sort((a, b) => (lanHoi.get(hoa(a.ma_phan)) || 0) - (lanHoi.get(hoa(b.ma_phan)) || 0)
      || String(a.tg_tra_ve).localeCompare(String(b.tg_tra_ve)))
    .slice(0, TOI_DA_MOI_LUOT);
}

// `fromDate` gửi ERP, dạng 'YYYY-MM-DDT00:00:00' (không hậu tố Z) — đúng định dạng router ERP nhận.
// ⚠ Proc lọc `Dotnhanvai > @pTuNgay` (lớn hơn HẲN) ⇒ lấy ngày vải về sớm nhất của các phần in trong lượt
//   rồi LÙI THÊM `LUI_NGAY` ngày (lệch múi giờ + ngày vải về MES ≠ mốc ERP). Thiếu ngày ⇒ lùi từ hôm nay.
//   Không dùng một mốc thật xa: router ERP đang ghim `@pDsPhan = NULL` thì proc trả MỌI dòng từ mốc đó.
const LUI_NGAY = 3;
const LUI_MAC_DINH = 60;
function tuNgay(pins) {
  const ngay = pins.map((p) => ngayStr(p.ngay_som)).filter(Boolean).sort()[0];
  const d = ngay ? new Date(`${ngay}T00:00:00`) : new Date();
  d.setDate(d.getDate() - (ngay ? LUI_NGAY : LUI_MAC_DINH));
  return `${ngayStr(d)}T00:00:00`;
}

// Đợt vải CHƯA release (đang chờ READY) của 1 phần in.
async function dotChoCuaPhanIn(pinId) {
  const { rows } = await query(
    `SELECT dv.id, dv.ma_dot_vai, dv.han_giao_hang, dv.ngay_vai_ve, dv.so_luong_vai_ve, dv.nha_gia_cong,
            dv.barcode, dv.loai_dot_vai_id, dv.du_an, dv.inset
       FROM dot_vai_ve dv
      WHERE dv.phan_in_id = $1 AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
        AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
                         WHERE l.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY')`.replace(/\s+/g, ' '),
    [pinId]
  );
  return rows;
}

// Mã đợt ERP (`IDDotReady` ↔ `dot_vai_ve.barcode`) của MỌI đợt sống — để chọn dòng ERP THUỘC phần in này
// khi ERP trả dòng của đơn khác trùng code phần (ca DK-2609-008-A01-F03-C01, 29/09/2026).
async function maDotSongCuaPhanIn(pinId) {
  const { rows } = await query(
    "SELECT upper(btrim(barcode)) AS bc FROM dot_vai_ve WHERE phan_in_id = $1 AND trang_thai NOT IN ('DA_GOP','DA_HUY') AND COALESCE(btrim(barcode),'') <> ''",
    [pinId]
  );
  return new Set(rows.map((r) => r.bc));
}

// Ghép dòng ERP ↔ đợt vải chờ: (1) theo mã đợt ERP; (2) phần còn lại đúng 1–1 thì ghép (đợt cũ thiếu mã).
function ghepDot(dots, dong) {
  const cap = []; const conDot = [...dots]; const conDong = [];
  for (const r of dong) {
    const bc = hoa(E.erpBarcode(r));
    const i = bc ? conDot.findIndex((d) => hoa(d.barcode) === bc) : -1;
    if (i >= 0) cap.push([conDot.splice(i, 1)[0], r]); else conDong.push(r);
  }
  if (conDot.length === 1 && conDong.length === 1) { cap.push([conDot[0], conDong[0]]); conDot.length = 0; conDong.length = 0; }
  return { cap, conDot, conDong };
}

// So 1 đợt vải với 1 dòng ERP ⇒ patch các trường KHÁC (rỗng từ ERP thì giữ nguyên).
async function patchDot(d, r) {
  const patch = {};
  const han = E.toDate(r.due_date);
  if (han && khacNhau(han, ngayStr(d.han_giao_hang))) patch.han_giao_hang = han;
  const nv = E.erpNgayVaiVe(r);
  if (nv && khacNhau(nv, ngayStr(d.ngay_vai_ve))) patch.ngay_vai_ve = nv;
  const sl = soHoacNull(r.received_qty);
  if (sl != null && sl >= 0 && sl !== Number(d.so_luong_vai_ve)) patch.so_luong_vai_ve = sl;
  const ngc = E.erpNhaGiaCong(r);
  if (ngc && khacNhau(ngc, d.nha_gia_cong)) patch.nha_gia_cong = ngc;
  const bcd = E.erpBarcode(r);
  if (bcd && khacNhau(bcd, d.barcode)) patch.barcode = bcd;
  const duAn = E.erpDuAn(r);
  if (duAn && khacNhau(duAn, d.du_an)) patch.du_an = duAn;
  const inset = E.erpInset(r);
  if (inset != null && inset !== Number(d.inset)) patch.inset = inset;
  const loaiId = await loaiIdTheoLoaikd(r.loaikd);
  if (loaiId && loaiId !== d.loai_dot_vai_id) patch.loai_dot_vai_id = loaiId;
  return patch;
}

async function loaiIdTheoLoaikd(loaikd) {
  const ma = E.LOAIKD_MAP[hoa(loaikd)];
  if (!ma) return null;
  const { rows } = await query('SELECT id FROM loai_dot_vai WHERE ma_loai = $1 LIMIT 1', [ma]);
  return rows[0]?.id || null;
}

// So 1 phần in với các dòng ERP của nó rồi ghi phần KHÁC. Trả tóm tắt để hiện trên trang.
async function capNhatMotPhanIn(pin, dong, actorId) {
  const out = { ma_phan: pin.ma_phan, phan_in: [], dot_vai: [], ghi_chu: null };
  // Thông tin mức phần in: ưu tiên dòng ERP mà mã đợt (`IDDotReady`) là đợt CỦA phần in này — ERP có thể
  // trả thêm dòng đơn khác trùng code phần; không có dòng nào khớp mã đợt thì lùi về dòng mới nhất.
  const maDot = await maDotSongCuaPhanIn(pin.id);
  const cuaMinh = dong.filter((r) => maDot.has(hoa(E.erpBarcode(r))));
  const moiNhat = [...(cuaMinh.length ? cuaMinh : dong)].sort((a, b) => mocDong(b).localeCompare(mocDong(a)))[0];

  // 1) Mức phần in qua `ganLaiTheoDong` — chỉ gọi khi có trường thật sự khác.
  const [cu] = await erpRepo.anhChupPhanInTheoMa([pin.ma_phan]);
  if (cu) {
    const moi = {
      khach: E.clean(moiNhat.customer_name), don_hang: E.clean(moiNhat.order_name), ma_hang: E.clean(moiNhat.item_name),
      mau_vai: E.clean(moiNhat.fabric_color), kich_vai: E.clean(moiNhat.fabric_size), kich_phim: E.clean(moiNhat.film_size),
      so_luong_don_hang: soHoacNull(moiNhat.order_qty), tinh_chat_in: E.erpTinhChatIn(moiNhat),
    };
    const cuMap = {
      khach: cu.ma_khach_hang, don_hang: cu.ma_don_hang, ma_hang: cu.ma_hang, mau_vai: cu.mau_vai,
      kich_vai: cu.kich_vai, kich_phim: cu.kich_phim, so_luong_don_hang: cu.so_luong_don_hang, tinh_chat_in: cu.tinh_chat_in,
    };
    // Trường ERP gửi RỖNG thì KHÔNG coi là "sửa thành rỗng" (khỏi xóa mất dữ liệu đang đúng).
    const doi = Object.keys(moi).filter((k) => moi[k] != null && moi[k] !== '' && khacNhau(moi[k], cuMap[k]));
    const thieuMa = !moi.khach || !moi.don_hang || !moi.ma_hang;
    if (doi.length && !thieuMa) {
      await E.ganLaiTheoDong(cu.ma_phan, moiNhat, actorId);
      out.phan_in.push(...doi);
    } else if (doi.length && thieuMa) {
      out.ghi_chu = 'ERP thiếu khách/đơn/mã hàng — bỏ qua phần cập nhật phần in';
    }
  }
  // Mã vạch phần in + thời gian chờ khô: whitelist của Quản trị phần in.
  const patchPin = {};
  const bc = E.erpBarcodePhanIn(moiNhat);
  if (bc && khacNhau(bc, pin.barcode)) patchPin.barcode = bc;
  const tgPhoi = soHoacNull(moiNhat.tgphoi);
  if (tgPhoi && tgPhoi > 0 && Math.round(tgPhoi) !== Number(pin.thoi_gian_cho_kho_phut)) patchPin.thoi_gian_cho_kho_phut = Math.round(tgPhoi);
  if (Object.keys(patchPin).length) {
    await phanInAdmin.suaPhanIn(pin.id, patchPin, actorId);
    out.phan_in.push(...Object.keys(patchPin));
  }

  // 2) Mức đợt vải — ghép từng đợt chờ với dòng ERP theo MÃ ĐỢT ERP (`IDDotReady`), còn dư đúng 1–1 thì
  //    ghép nốt. Đợt không ghép được ⇒ báo trong kết quả, GN sửa tay.
  const dots = await dotChoCuaPhanIn(pin.id);
  const { cap, conDot } = ghepDot(dots, dong);
  const loiDot = [];
  for (const [d, r] of cap) {
    const patch = await patchDot(d, r);
    if (!Object.keys(patch).length) continue;
    try {
      await phanInAdmin.suaDotVai(d.id, patch, actorId);
      out.dot_vai.push(...Object.keys(patch).map((k) => `${d.barcode || d.ma_dot_vai}: ${k}`));
    } catch (e) { loiDot.push(`${d.barcode || d.ma_dot_vai}: ${e.message}`); }
  }
  if (conDot.length) loiDot.push(`${conDot.length} đợt chờ không tìm thấy dòng ERP cùng mã đợt — GN sửa tay`);
  if (loiDot.length) out.ghi_chu = [out.ghi_chu, `Đợt vải: ${loiDot.join(' · ')}`].filter(Boolean).join(' | ');

  // Vết trên chính lượt trả về ⇒ hiện ở lịch sử của phần in (SidePanel).
  if (out.phan_in.length || out.dot_vai.length) {
    const cho = await repo.dangCho(pin.id);
    for (const q of cho) {
      await repo.ghiAudit({ query: (sql, p) => query(sql, p) }, q.id, 'GN_ERP_CAP_NHAT',
        { phan_in_id: pin.id, ma_phan: pin.ma_phan, phan_in: out.phan_in, dot_vai: out.dot_vai }, actorId);
    }
  }
  return out;
}

// Chạy 1 lượt. `tuDong` = job; bấm tay thì `actorId` = người bấm.
async function dongBo({ tuDong = false, actorId = null } = {}) {
  if (dangChay) return { bo_qua: 'Đang có lượt khác chạy' };
  if (!(await apiBat(MA_API))) {
    lanCuoi = { tg: new Date().toISOString(), tu_dong: tuDong, bo_qua: 'API đang TẮT (Hệ thống › Cài đặt API)' };
    return lanCuoi;
  }
  dangChay = true;
  const t0 = Date.now();
  let idKn = null;
  try {
    const tatCa = await phanInDangCho();
    if (!tatCa.length) {
      lanCuoi = { tg: new Date().toISOString(), tu_dong: tuDong, so_cho: 0, bo_qua: 'Không có phần in nào đang chờ sửa thông tin — không gọi ERP' };
      return lanCuoi;
    }
    // Dọn mốc của phần in không còn chờ (đã xác nhận lại) cho Map khỏi phình.
    const conCho = new Set(tatCa.map((p) => hoa(p.ma_phan)));
    for (const k of [...lanHoi.keys()]) if (!conCho.has(k)) lanHoi.delete(k);
    const pins = chonLuot(tatCa);
    const fromDate = tuNgay(pins);
    const dsPhan = pins.map((p) => p.ma_phan).join(',');
    // ⚠⚠ ID KẾT NỐI (27/09/2026): mỗi lượt kéo 1 ID, gửi kèm query `IDKetNoi` (router ERP bỏ qua khóa
    //   lạ, nhưng log truy cập bên ERP có) + ghi lịch sử ở *Cài đặt API* — trước đây lượt kéo này
    //   KHÔNG để lại vết nào ngoài console.
    idKn = taoIdKetNoi('GN');
    let data;
    try {
      ({ data } = await E.fetchErp(env.erp.dsSuaThongTinUrl, fromDate, { dsPhan, IDKetNoi: idKn }));
    } catch (e) {
      await ghiLog(MA_API, {
        thanhCong: false, idMes: idKn, url: env.erp.dsSuaThongTinUrl, thoiGianMs: Date.now() - t0,
        gui: { fromDate, dsPhan, IDKetNoi: idKn }, loi: e.message, actorId,
      });
      throw e;
    }
    await ghiLog(MA_API, {
      thanhCong: true, idMes: idKn, url: env.erp.dsSuaThongTinUrl, thoiGianMs: Date.now() - t0,
      gui: { fromDate, dsPhan, IDKetNoi: idKn },
      nhan: { so_dong: data.length, code_phan: [...new Set(data.map((r) => r.code_part).filter(Boolean))] },
      actorId,
    });
    const moc = Date.now();
    for (const p of pins) lanHoi.set(hoa(p.ma_phan), moc);

    const theoMa = new Map();
    for (const r of data) {
      const ma = hoa(r.code_part);
      if (!ma) continue;
      if (!theoMa.has(ma)) theoMa.set(ma, []);
      theoMa.get(ma).push(r);
    }
    const ketQua = []; const loi = [];
    for (const pin of pins) {
      const dong = theoMa.get(hoa(pin.ma_phan));
      if (!dong) continue;
      try {
        const kq = await capNhatMotPhanIn(pin, dong, actorId);
        if (kq.phan_in.length || kq.dot_vai.length || kq.ghi_chu) ketQua.push(kq);
      } catch (e) { loi.push(`${pin.ma_phan}: ${e.message}`); }
    }
    const soDoi = ketQua.filter((k) => k.phan_in.length || k.dot_vai.length).length;
    if (soDoi) {
      sockets.emit('gn:updated', { erp: true });
      sockets.emit('dashboard:refresh', {});
    }
    lanCuoi = {
      tg: new Date().toISOString(), tu_dong: tuDong, id_ket_noi: idKn, so_cho: tatCa.length, so_hoi: pins.length,
      con_lai_luot_sau: Math.max(0, tatCa.length - pins.length), from_date: fromDate, tong_erp: data.length,
      co_tren_erp: pins.filter((p) => theoMa.has(hoa(p.ma_phan))).length,
      so_cap_nhat: soDoi, chi_tiet: ketQua.slice(0, 50), loi: loi.slice(0, 20),
      thoi_gian_ms: Date.now() - t0,
    };
    if (soDoi || loi.length) console.log(`[gn-erp] cập nhật ${soDoi} phần in · ${loi.length} lỗi`);
    return lanCuoi;
  } catch (e) {
    lanCuoi = { tg: new Date().toISOString(), tu_dong: tuDong, id_ket_noi: idKn, loi_chung: e.message };
    console.error('[gn-erp] Lỗi:', e.message);
    if (!tuDong) throw e;
    return lanCuoi;
  } finally { dangChay = false; }
}

const trangThai = () => ({ lan_cuoi: lanCuoi, url: env.erp.dsSuaThongTinUrl, dang_chay: dangChay, toi_da_moi_luot: TOI_DA_MOI_LUOT });

// Job cùng nhịp với đồng bộ đợt vải (ERP_SYNC_INTERVAL_MIN, sàn 5 phút). Lệch 90s so với job chính để
// 2 proc ERP không chạy cùng lúc.
function startJob() {
  const ms = Math.max(5, env.erp.syncIntervalMin) * 60 * 1000;
  const run = () => dongBo({ tuDong: true }).catch((e) => console.error('[gn-erp] Lỗi:', e.message));
  setTimeout(run, 90000);
  setInterval(run, ms);
  console.log(`[gn-erp] Job lấy phần in đã sửa thông tin từ ERP mỗi ${Math.max(5, env.erp.syncIntervalMin)} phút: ${env.erp.dsSuaThongTinUrl}`);
}

module.exports = { dongBo, trangThai, startJob, _capNhatMotPhanIn: capNhatMotPhanIn };
