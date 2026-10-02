'use strict';

// ─── BÁO CÁO BẤT THƯỜNG DỪNG CHUYỀN — đọc dữ liệu thô (02/10/2026) ────────────────────────────────
// Luật + cách gom: `utils/baoCaoDungChuyen.js` (hàm thuần). Ở đây chỉ ĐỌC:
//   · 1 câu lấy các lần dừng có lúc BẮT ĐẦU trong khoảng ngày SX [tuNgay 06:00 → denNgay+1 06:00) giờ VN,
//     kèm chuyền · tổ in · lệnh · phần in (gộp chuỗi) · người ghi / người bấm hoạt động lại.
//   · Loại ca từng ngày: `cai_dat_ca_tuan`; tuần chưa cài ⇒ suy từ mã ca trên tem của ngày (cùng luật
//     `utils/baoCaoSanXuat.suyLoaiCaTuTem` — để 2 báo cáo cùng ngày gọi ca giống nhau).
//   · Mọi câu gửi 1 dòng (IPS), không `--` trong chuỗi SQL. Dò cột trước khi dùng (`coCot`).
//   · Cache trong RAM 15s theo khoảng ngày (FE nghe socket `production:updated` tự tải lại).

const { query } = require('../../config/db');
const { coCot } = require('./baoCaoSanXuat');
const { khoaTuanIso, suyLoaiCaTuTem } = require('../../utils/baoCaoSanXuat');
const { dungBaoCaoDungChuyen } = require('../../utils/baoCaoDungChuyen');

// Bản ghi test kỹ thuật 06/08/2026 được đánh dấu bằng tiền tố này trong `ly_do` ("không tính vào downtime").
const TIEN_TO_BO_QUA = '[BỎ QUA]%';

const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
const W0 = `(($1::date + time '06:00') ${VN})`;
const W1 = `(($2::date + 1 + time '06:00') ${VN})`;

// Phần in của lệnh (lệnh ép ủi in kiếng đọc đợt vải của lệnh liên kết — cùng luật `baoCaoSanXuat.docPhanIn`).
const PHAN_IN_LENH = `LEFT JOIN LATERAL (SELECT string_agg(DISTINCT pin.ma_phan, ', ') AS ma_phan,
    string_agg(DISTINCT kh.ten_khach_hang, ', ') AS khach, string_agg(DISTINCT dh.ma_don_hang, ', ') AS po,
    string_agg(DISTINCT mh.ma_hang, ', ') AS ma_hang, string_agg(DISTINCT pin.mau_vai, ', ') AS mau_vai
  FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id JOIN phan_in pin ON pin.id = dv.phan_in_id
  LEFT JOIN ma_hang mh ON mh.id = pin.ma_hang_id LEFT JOIN don_hang dh ON dh.id = mh.don_hang_id
  LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
  WHERE lsd.lenh_san_xuat_id = COALESCE(ls.lenh_lien_ket_id, ls.id)) pi ON true`;

async function docLanDung(tuNgay, denNgay, { coLyDoId, coTo }) {
  const sql = `SELECT n.id, n.ly_do, n.tg_bd_ngung, n.tg_kt_ngung, n.so_phut, n.trang_thai,
      to_char(((n.tg_bd_ngung ${VN}) - interval '6 hours')::date, 'YYYY-MM-DD') AS ngay_sx,
      EXTRACT(HOUR FROM n.tg_bd_ngung ${VN})::int AS gio, EXTRACT(MINUTE FROM n.tg_bd_ngung ${VN})::int AS phut,
      ${coLyDoId ? 'n.ly_do_id, ldn.ma_ly_do, ldn.ten_ly_do' : 'NULL::uuid AS ly_do_id, NULL AS ma_ly_do, NULL AS ten_ly_do'},
      ps.trang_thai AS phieu_trang_thai, ps.tg_kt AS phieu_tg_kt, ls.ma_lenh_san_xuat,
      cs.ma_chuyen, cs.ten_chuyen, lc.ma_loai AS ma_loai_chuyen, lc.ten_loai AS ten_loai_chuyen,
      ${coTo ? 'ti.ma_to, ti.ten_to' : 'NULL AS ma_to, NULL AS ten_to'},
      ndc.ho_ten AS nguoi_ghi, ndu.ho_ten AS nguoi_cap_nhat,
      pi.ma_phan, pi.khach, pi.po, pi.ma_hang, pi.mau_vai
    FROM ngung_chuyen n
    LEFT JOIN phieu_san_xuat ps ON ps.id = n.phieu_san_xuat_id
    LEFT JOIN lenh_san_xuat ls ON ls.id = COALESCE(n.lenh_san_xuat_id, ps.lenh_san_xuat_id)
    LEFT JOIN chuyen_san_xuat cs ON cs.id = COALESCE(n.chuyen_id, ps.chuyen_id, ls.chuyen_id)
    LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
    ${coLyDoId ? 'LEFT JOIN ly_do_ngung_chuyen ldn ON ldn.id = n.ly_do_id' : ''}
    ${coTo ? 'LEFT JOIN to_in ti ON ti.id = ps.to_in_id' : ''}
    LEFT JOIN nguoi_dung ndc ON ndc.id = n.created_by
    LEFT JOIN nguoi_dung ndu ON ndu.id = n.updated_by
    ${PHAN_IN_LENH}
    WHERE n.tg_bd_ngung >= ${W0} AND n.tg_bd_ngung < ${W1}
      AND COALESCE(n.ly_do, '') NOT LIKE $3`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tuNgay, denNgay, TIEN_TO_BO_QUA]);
  return rows;
}

// Loại ca theo NGÀY: tuần đã cài thì theo cài đặt; chưa cài ⇒ suy từ mã ca tem của ngày; không có ⇒ NGAN.
async function hamLoaiCaNgay(cacNgay, tuNgay, denNgay) {
  const tuan = new Map();
  try {
    const { rows } = await query('SELECT nam, tuan, loai_ca FROM cai_dat_ca_tuan');
    rows.forEach((r) => tuan.set(`${r.nam}-${r.tuan}`, r.loai_ca));
  } catch { /* bảng chưa có (mig 046) ⇒ suy từ tem / mặc định */ }
  const thieu = cacNgay.filter((d) => !tuan.has(khoaTuanIso(d)));
  const theoTem = new Map();
  if (thieu.length && await coCot('tem', 'ngay_ca')) {
    const { rows } = await query(
      `SELECT to_char(t.ngay_ca, 'YYYY-MM-DD') AS ngay, upper(right(t.ma_ngay_ca, 2)) AS ca_hint, count(*)::int AS n
         FROM tem t WHERE t.ngay_ca BETWEEN $1::date AND $2::date AND t.trang_thai <> 'HUY' AND t.ma_ngay_ca IS NOT NULL
        GROUP BY 1, 2`.replace(/\s+/g, ' '),
      [tuNgay, denNgay]
    );
    const gom = new Map();
    rows.forEach((r) => {
      if (!gom.has(r.ngay)) gom.set(r.ngay, []);
      gom.get(r.ngay).push(r); // { ca_hint, n } — `n` = số tem, `suyLoaiCaTuTem` nhận làm trọng số
    });
    gom.forEach((ds, ngay) => { const lc = suyLoaiCaTuTem(ds); if (lc) theoTem.set(ngay, lc); });
  }
  return (ngay) => tuan.get(khoaTuanIso(ngay)) || theoTem.get(ngay) || 'NGAN';
}

async function dungMoi(tuNgay, denNgay) {
  const [coLyDoId, coTo] = await Promise.all([coCot('ngung_chuyen', 'ly_do_id'), coCot('phieu_san_xuat', 'to_in_id')]);
  const rows = await docLanDung(tuNgay, denNgay, { coLyDoId, coTo });
  const loaiCaNgay = rows.length
    ? await hamLoaiCaNgay([...new Set(rows.map((r) => r.ngay_sx))], tuNgay, denNgay)
    : () => 'NGAN';
  return dungBaoCaoDungChuyen({ tuNgay, denNgay, rows, loaiCaNgay, bayGio: Date.now() });
}

const CACHE_MS = 15000;
const cache = new Map(); // `tu|den` → { het, hua }

// Lưu PROMISE ⇒ nhiều người mở cùng lúc chỉ chạy 1 lượt; lỗi thì bỏ cache ngay.
async function baoCaoDungChuyen(tuNgay, denNgay) {
  const k = `${tuNgay}|${denNgay}`;
  const now = Date.now();
  const c = cache.get(k);
  if (c && c.het > now) return c.hua;
  const hua = dungMoi(tuNgay, denNgay);
  cache.set(k, { het: now + CACHE_MS, hua });
  hua.catch(() => cache.delete(k));
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return hua;
}

module.exports = { baoCaoDungChuyen };
