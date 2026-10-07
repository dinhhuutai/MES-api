'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ÁP THÔNG TIN ERP ĐÃ SỬA LÊN PHẦN IN ĐANG CHỜ GN (25/09/2026; đổi vai 07/10/2026).
//
// ⚠⚠ 07/10/2026 BỎ job kéo `/ds-phan-in-sua-thong-tin` + nút "Lấy từ ERP" (người dùng chốt): trả về GN nay
//   HỦY đợt READY bên ERP ngay (`gnErp.huyBenErp`), GN sửa + xác nhận lại TRÊN ERP ⇒ dòng quay về qua đồng bộ
//   chính `/phieu-nhan-vai-60` ⇒ `gnErp.truocDongBo` gọi `capNhatMotPhanIn` dưới đây rồi tự trả phần in về đúng
//   màn. File chỉ còn phần "so ERP ↔ MES rồi ghi chỗ khác" (tách khỏi `runSync` vì `upsertPhanIn` giữ nguyên
//   đơn/mã hàng và `upsertDotVai` không đổi SL đợt đã có).
//
// ⚠⚠ Hình dạng dòng = CÙNG trường với `/phieu-nhan-vai-60` (`code_part`, `customer_name`, `order_name`,
//   `item_name`, `fabric_color`, `fabric_size`, `film_size`, `order_qty`, `tinhchatin`, `due_date`,
//   `ngaynhanvai`, `received_qty`, `loaikd`, `NGC`, `IDDotReady`, `BarcodePTHDH`…). Đọc bằng CHÍNH các hàm
//   `erp*` của `erpsync.service`. Khác thì sửa ở ĐÂY.
//
// PHẠM VI GHI (chỉ phần in đang chờ GN — `qc_tra_ve` TRA_VE_GN chưa xử lý):
//   · PHẦN IN — khách/đơn/mã hàng + màu/kích vải/kích phim/SLĐH/tính chất in/subID ⇒ `ganLaiTheoDong`
//     (đúng hàm của "Cập nhật theo code phần", có audit `ERP_CAP_NHAT_CODE_PHAN`); mã vạch phần in +
//     thời gian chờ khô ⇒ `phaninadmin.suaPhanIn` (whitelist + audit).
//   · ĐỢT VẢI (chưa release) — hạn giao · ngày vải về · SL vải về · loại · nhà gia công · barcode đợt ·
//     dự án · inset ⇒ `phaninadmin.suaDotVai` (guard hạ SL dưới SL đã in + tính lại phương án in).
//     Đợt không ghép được dòng ERP ⇒ ghi vào kết quả, GN sửa tay trên trang.
//   · Mức phần in lấy dòng ERP có mã đợt THUỘC phần in (ERP có thể trả dòng đơn khác trùng code phần).
//   · CHỈ GHI KHI KHÁC giá trị hiện tại ⇒ không đẻ audit rác.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const erpSvc = require('../erpsync/erpsync.service');
const erpRepo = require('../erpsync/erpsync.repository');
const phanInAdmin = require('../phaninadmin/phaninadmin.service');
const repo = require('./suathongtin.repository');

const E = erpSvc._erp;

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

module.exports = { capNhatMotPhanIn };
