'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// LÝ DO NGHẼN (mig 106, 26/09/2026) — xác nhận mục đã quá SLA thì phải nhập lý do.
// Repository + service gộp 1 file (module nhỏ, cùng khuôn `phongban`).
// ⚠ Dò bảng trước (`coBang`) — thiếu mig 106 thì ĐỌC trả rỗng, GHI trả `{ luu: 0, thieu_migration }`
//   và KHÔNG ném lỗi: hỏi lý do là phần thêm, không được chặn việc xác nhận của xưởng.
// ⚠ Chú thích để NGOÀI chuỗi SQL (câu gửi gộp 1 dòng — bẫy IPS §9).
// ─────────────────────────────────────────────────────────────────────────────

const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');

let coBangCache = false;
async function coBang() {
  if (coBangCache) return true;
  const { rows } = await query("SELECT 1 FROM information_schema.tables WHERE table_name = 'ly_do_nghen' LIMIT 1");
  coBangCache = rows.length > 0;
  return coBangCache;
}

const uuidOrNull = (v) => (/^[0-9a-f-]{36}$/i.test(String(v || '')) ? String(v) : null);
const soOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const ngayOrNull = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

// Ghi lý do cho NHIỀU đối tượng cùng lúc (1 lý do chung). `items[i]` mang khóa đối tượng + số đo.
async function ghi({ maTrang, lyDo, hanhDong, items } = {}, actorId) {
  const ma = String(maTrang || '').trim().slice(0, 40);
  const ly = String(lyDo || '').trim().slice(0, 2000);
  if (!ma) throw new AppError('Thiếu mã màn', { status: 422, errorCode: 'NO_MA_TRANG' });
  if (!ly) throw new AppError('Nhập lý do nghẽn', { status: 422, errorCode: 'NO_LY_DO' });
  const ds = (Array.isArray(items) ? items : []).slice(0, 500);
  if (!ds.length) throw new AppError('Chưa có mục nào', { status: 422, errorCode: 'NO_ITEMS' });
  if (!(await coBang())) return { luu: 0, thieu_migration: true };
  const hd = ['XAC_NHAN', 'GHI_TAY'].includes(hanhDong) ? hanhDong : 'XAC_NHAN';
  await withTransaction(async (client) => {
    for (const it of ds) {
      // ⚠ Màn theo LỆNH / TEM thường không gửi `phan_in_id` ⇒ SUY RA (đợt vải → phần in; lệnh → đợt vải
      //   đầu tiên → phần in; tem → phiếu → lệnh → …) để Dashboard tra lý do THEO PHẦN IN được.
      await client.query(
        `INSERT INTO ly_do_nghen (ma_trang, phan_in_id, dot_vai_ve_id, lenh_san_xuat_id, tem_id, ma_doi_tuong, ly_do, tg_bat_dau_nghen, so_phut_nghen, sla_phut, hanh_dong, created_by) VALUES ($1, COALESCE($2::uuid, (SELECT phan_in_id FROM dot_vai_ve WHERE id = $3::uuid), (SELECT dv.phan_in_id FROM lenh_sx_dot_vai l JOIN dot_vai_ve dv ON dv.id = l.dot_vai_ve_id WHERE l.lenh_san_xuat_id = $4::uuid LIMIT 1), (SELECT dv.phan_in_id FROM tem t JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id JOIN lenh_sx_dot_vai l ON l.lenh_san_xuat_id = ps.lenh_san_xuat_id JOIN dot_vai_ve dv ON dv.id = l.dot_vai_ve_id WHERE t.id = $5::uuid LIMIT 1)), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [ma, uuidOrNull(it.phan_in_id), uuidOrNull(it.dot_vai_ve_id), uuidOrNull(it.lenh_san_xuat_id), uuidOrNull(it.tem_id),
          it.ma ? String(it.ma).slice(0, 120) : null, ly, ngayOrNull(it.tg_bat_dau_nghen),
          soOrNull(it.so_phut_nghen), soOrNull(it.sla_phut), hd, actorId]);
    }
  });
  return { luu: ds.length };
}

// Lý do gần đây (mới nhất trước). `maTrang` rỗng = mọi màn (dùng cho Dashboard). FE tự dựng map theo
// khóa đối tượng và lấy dòng ĐẦU TIÊN gặp (= mới nhất).
async function danhSach({ maTrang = '', soNgay = 60 } = {}) {
  if (!(await coBang())) return { items: [], co_bang: false };
  const n = Math.min(Math.max(Number(soNgay) || 60, 1), 365);
  const { rows } = await query(
    `SELECT l.id, l.ma_trang, l.phan_in_id, l.dot_vai_ve_id, l.lenh_san_xuat_id, l.tem_id, l.ma_doi_tuong, l.ly_do, l.tg_bat_dau_nghen, l.so_phut_nghen, l.sla_phut, l.hanh_dong, l.created_date, nd.ho_ten AS nguoi FROM ly_do_nghen l LEFT JOIN nguoi_dung nd ON nd.id = l.created_by WHERE l.dang_hoat_dong AND ($1 = '' OR l.ma_trang = $1) AND l.created_date >= now() - ($2::int * interval '1 day') ORDER BY l.created_date DESC LIMIT 5000`,
    [String(maTrang || ''), n]);
  return { items: rows, co_bang: true };
}

// LỊCH SỬ NGHẼN ĐÃ XÁC NHẬN của 1 màn, lọc theo NGÀY BẮT ĐẦU NGHẼN (giờ VN) — modal "Danh sách nghẽn"
// chế độ "Đã xác nhận" (30/09/2026). Chỉ dòng `XAC_NHAN` (mục đã được xác nhận qua trạm lúc đang nghẽn);
// `GHI_TAY` là ghi lý do khi mục CÒN nghẽn nên không tính. Kèm thông tin phần in để hiện đủ cột.
// ⚠ Câu SQL giữ ngắn (IPS ~1400 ký tự, §9): chuyền chỉ suy từ lệnh; màn theo tem để trống.
const ngayOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
async function lichSu({ maTrang = '', tuNgay, denNgay } = {}) {
  const ma = String(maTrang || '').trim();
  if (!ma) throw new AppError('Thiếu mã màn', { status: 422, errorCode: 'NO_MA_TRANG' });
  if (!(await coBang())) return { items: [], co_bang: false };
  const tu = ngayOk(tuNgay); const den = ngayOk(denNgay) || tu;
  if (!tu) throw new AppError('Chọn ngày bắt đầu nghẽn', { status: 422, errorCode: 'NO_NGAY' });
  const { rows } = await query(
    "SELECT l.id, l.phan_in_id, l.dot_vai_ve_id, l.lenh_san_xuat_id, l.tem_id, l.ma_doi_tuong, l.ly_do, l.tg_bat_dau_nghen, l.so_phut_nghen, l.sla_phut, l.created_date, u.ho_ten AS nguoi, p.ma_phan, p.mau_vai, p.kich_vai, p.kich_phim, m.ma_hang, d.ma_don_hang, k.ten_khach_hang, v.han_giao_hang, c.ten_chuyen FROM ly_do_nghen l LEFT JOIN nguoi_dung u ON u.id = l.created_by LEFT JOIN phan_in p ON p.id = l.phan_in_id LEFT JOIN ma_hang m ON m.id = p.ma_hang_id LEFT JOIN don_hang d ON d.id = m.don_hang_id LEFT JOIN khach_hang k ON k.id = d.khach_hang_id LEFT JOIN dot_vai_ve v ON v.id = l.dot_vai_ve_id LEFT JOIN lenh_san_xuat s ON s.id = l.lenh_san_xuat_id LEFT JOIN chuyen_san_xuat c ON c.id = s.chuyen_id WHERE l.dang_hoat_dong AND l.hanh_dong = 'XAC_NHAN' AND l.ma_trang = $1 AND (l.tg_bat_dau_nghen AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date ORDER BY l.tg_bat_dau_nghen DESC, l.created_date DESC LIMIT 2000",
    [ma, tu, den]);
  // Cùng 1 đối tượng + cùng mốc bắt đầu nghẽn bị ghi 2 lần (bấm lại / xác nhận theo đợt) ⇒ giữ lần MỚI NHẤT.
  const seen = new Set();
  const items = [...rows].sort((a, b) => new Date(b.created_date) - new Date(a.created_date)).filter((r) => {
    const k = [r.phan_in_id, r.dot_vai_ve_id, r.lenh_san_xuat_id, r.tem_id, new Date(r.tg_bat_dau_nghen).getTime()].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => new Date(b.tg_bat_dau_nghen) - new Date(a.tg_bat_dau_nghen));
  return { items, co_bang: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// GỢI Ý / LẤY LẠI LÝ DO NGHẼN THEO NHÓM CODE PHẦN (07/10/2026, người dùng chốt): trong CÙNG 1 NGÀY (giờ VN),
// cùng màn (`maTrang`), code phần chung 3 đoạn đầu (vd `DK-2610-004` của `DK-2610-004-A01-F01-C01`) đã có lý do
// ⇒ code phần sau dùng lại lý do đó, khỏi nhập lại. Trả lý do MỚI NHẤT của mỗi nhóm.
// · Khớp qua `phan_in.ma_phan` (`phan_in_id` luôn được suy khi ghi — `ghi`), KHÔNG qua `ma_doi_tuong` (màn theo
//   tem/lệnh lưu mã tem/mã lệnh ở đó).
// · Tiền tố tính Ở CẢ 2 ĐẦU bằng cùng luật: tách dấu '-', lấy tối đa 3 đoạn đầu (FE `utils/nghen.js tienToCodePhan`).
// ─────────────────────────────────────────────────────────────────────────────
const tienToCodePhan = (ma) => String(ma || '').trim().split('-').slice(0, 3).join('-');
async function goiY({ maTrang = '', tien = '' } = {}) {
  const ma = String(maTrang || '').trim();
  const ds = [...new Set(String(tien || '').split(',').map((x) => tienToCodePhan(x)).filter(Boolean))].slice(0, 200);
  if (!ma || !ds.length) return { items: [] };
  if (!(await coBang())) return { items: [], co_bang: false };
  const { rows } = await query(
    "SELECT DISTINCT ON (x.tien) x.tien, x.ly_do, x.ma_phan, x.created_date, x.nguoi FROM (SELECT array_to_string((string_to_array(p.ma_phan, '-'))[1:3], '-') AS tien, l.ly_do, p.ma_phan, l.created_date, u.ho_ten AS nguoi FROM ly_do_nghen l JOIN phan_in p ON p.id = l.phan_in_id LEFT JOIN nguoi_dung u ON u.id = l.created_by WHERE l.dang_hoat_dong AND l.ma_trang = $1 AND (l.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) x WHERE x.tien = ANY($2::text[]) ORDER BY x.tien, x.created_date DESC",
    [ma, ds]);
  return { items: rows };
}

module.exports = { ghi, danhSach, lichSu, goiY, coBang, tienToCodePhan };
