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

module.exports = { ghi, danhSach, coBang };
