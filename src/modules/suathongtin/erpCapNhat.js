'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// KÉO THÔNG TIN ĐÃ SỬA TỪ ERP cho trang *Đơn hàng › Phần in chờ sửa thông tin* (25/09/2026).
//
// Luồng: READY (KT/QC) trả phần in về GN → GN sửa BÊN ERP → job 5 phút/lần gọi
//   GET {ERP_DS_PHAN_IN_SUA_THONG_TIN_URL}?fromDate=<hôm nay>T00:00:00&dsPhan=<code1,code2,…>
//   (router ERP → proc `SX_spr_DSPhieuNhanvaiReady(@pTuNgay, @pDsPhan NVARCHAR(4000))`)
// → CẬP NHẬT lại phần in + đợt vải đang chờ → GN tích chọn rồi "Xác nhận lại" ⇒ phần in về READY.
//
// ⚠⚠ LUẬT LẤY (người dùng chốt 26/09/2026):
//   · CHỈ phần in bị trả về GN TRONG NGÀY HÔM NAY (giờ VN) — `fromDate` = 00:00 hôm nay.
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
//   · ĐỢT VẢI — hạn giao · ngày vải về · SL vải về · loại · nhà gia công · barcode đợt ⇒
//     `phaninadmin.suaDotVai` (guard hạ SL dưới SL đã in + tính lại phương án in). CHỈ khi khớp được
//     KHÔNG mập mờ: phần in còn ĐÚNG 1 đợt chưa release và ERP trả ĐÚNG 1 dòng cho code phần đó.
//     Nhiều đợt / nhiều dòng ⇒ bỏ qua phần đợt vải (ghi vào kết quả), GN sửa tay trên trang.
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

// Phần in đang chờ GN mà lượt trả về còn chờ được tạo TRONG NGÀY HÔM NAY (giờ VN).
async function phanInDangCho() {
  const { rows } = await query(
    `SELECT pin.id, pin.ma_phan, pin.barcode, pin.thoi_gian_cho_kho_phut, min(q.created_date) AS tg_tra_ve
       FROM qc_tra_ve q JOIN phan_in pin ON pin.id = q.phan_in_id AND pin.dang_hoat_dong
      WHERE q.loai = $1 AND q.da_xu_ly = false
        AND (q.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
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

// 00:00 hôm nay theo giờ VN, dạng 'YYYY-MM-DDT00:00:00' (không hậu tố Z) — đúng định dạng router ERP nhận.
function homNayVN() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const g = (t) => parts.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T00:00:00`;
}

// Đợt vải CHƯA release (đang chờ READY) của 1 phần in.
async function dotChoCuaPhanIn(pinId) {
  const { rows } = await query(
    `SELECT dv.id, dv.ma_dot_vai, dv.han_giao_hang, dv.ngay_vai_ve, dv.so_luong_vai_ve, dv.nha_gia_cong,
            dv.barcode, dv.loai_dot_vai_id
       FROM dot_vai_ve dv
      WHERE dv.phan_in_id = $1 AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
        AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
                         WHERE l.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY')`.replace(/\s+/g, ' '),
    [pinId]
  );
  return rows;
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
  const moiNhat = [...dong].sort((a, b) => mocDong(b).localeCompare(mocDong(a)))[0];

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

  // 2) Mức đợt vải — chỉ khi khớp 1–1 không mập mờ.
  const dots = await dotChoCuaPhanIn(pin.id);
  if (dots.length === 1 && dong.length === 1) {
    const d = dots[0]; const r = dong[0];
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
    const loaiId = await loaiIdTheoLoaikd(r.loaikd);
    if (loaiId && loaiId !== d.loai_dot_vai_id) patch.loai_dot_vai_id = loaiId;
    if (Object.keys(patch).length) {
      try {
        await phanInAdmin.suaDotVai(d.id, patch, actorId);
        out.dot_vai.push(...Object.keys(patch));
      } catch (e) { out.ghi_chu = `Đợt vải: ${e.message}`; }
    }
  } else if (dots.length || dong.length) {
    out.ghi_chu = out.ghi_chu || `Không khớp 1–1 đợt vải (MES ${dots.length} đợt chờ · ERP ${dong.length} dòng) — thông tin đợt vải GN sửa tay`;
  }

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
  try {
    const tatCa = await phanInDangCho();
    if (!tatCa.length) {
      lanCuoi = { tg: new Date().toISOString(), tu_dong: tuDong, so_cho: 0, bo_qua: 'Không có phần in trả về hôm nay đang chờ sửa — không gọi ERP' };
      return lanCuoi;
    }
    // Dọn mốc của phần in không còn chờ (đã xác nhận lại / sang ngày) cho Map khỏi phình.
    const conCho = new Set(tatCa.map((p) => hoa(p.ma_phan)));
    for (const k of [...lanHoi.keys()]) if (!conCho.has(k)) lanHoi.delete(k);
    const pins = chonLuot(tatCa);
    const fromDate = homNayVN();
    const dsPhan = pins.map((p) => p.ma_phan).join(',');
    const { data } = await E.fetchErp(env.erp.dsSuaThongTinUrl, fromDate, { dsPhan });
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
      tg: new Date().toISOString(), tu_dong: tuDong, so_cho: tatCa.length, so_hoi: pins.length,
      con_lai_luot_sau: Math.max(0, tatCa.length - pins.length), from_date: fromDate, tong_erp: data.length,
      co_tren_erp: pins.filter((p) => theoMa.has(hoa(p.ma_phan))).length,
      so_cap_nhat: soDoi, chi_tiet: ketQua.slice(0, 50), loi: loi.slice(0, 20),
      thoi_gian_ms: Date.now() - t0,
    };
    if (soDoi || loi.length) console.log(`[gn-erp] cập nhật ${soDoi} phần in · ${loi.length} lỗi`);
    return lanCuoi;
  } catch (e) {
    lanCuoi = { tg: new Date().toISOString(), tu_dong: tuDong, loi_chung: e.message };
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
