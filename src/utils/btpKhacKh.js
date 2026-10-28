'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BTP KHÁC KẾ HOẠCH (mig 120, 28/10/2026, người dùng yêu cầu) — in bán thành phẩm = in 2 ĐẦU của tấm vải; đầu này có
// thể lên kế hoạch ở máy A ngày X, đầu kia ở máy B ngày Y ⇒ 1 đợt vải phải được Release 1 HAI LẦN, mỗi lần đủ SL vải.
//
// Luật (NGUỒN DUY NHẤT — đừng chép ra chỗ khác):
//   · Đợt có cờ `dot_vai_ve.btp_khac_kh` ⇒ SỨC CHỨA release = 2 × SL vải (đợt thường = 1 × SL vải).
//   · "Còn release" = phần còn của ĐẦU ĐANG LẬP: min(sức chứa − đã release, SL − (đã release mod SL)) ⇒ đầu 1 chia
//     300 + 200 thì sau 300 còn 200 (chưa sang đầu 2); release đủ đầu 1 thì còn = SL cho đầu 2. Đợt thường: công thức
//     ra đúng SL − đã release như cũ.
//   · 1 lệnh giữ tối đa SL vải của 1 đợt (1 đầu) — trần Lập lại kế hoạch = min(SL, sức chứa − lệnh khác giữ).
//
// ⚠ Câu ĐỌC dùng `to_jsonb(dv)->>'btp_khac_kh'` ⇒ chạy được cả khi CHƯA chạy mig 120 (thiếu khóa ⇒ NULL ⇒ đợt thường)
//   — các hằng SQL dựng lúc nạp module (siSoTram) không dò cột được. Câu GHI phải dò cột trước (`coCotBtp`, khuôn
//   `coCotThoInKh`: có ⇒ nhớ mãi, chưa ⇒ nhớ 60 s).
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../config/db');

// Biểu thức boolean: đợt `dv` có cờ BTP khác KH.
const coBtpSql = (dv = 'dv') => `COALESCE((to_jsonb(${dv})->>'btp_khac_kh')::boolean, false)`;
// Số lần release đủ SL vải được phép (1 hoặc 2).
const soDauSql = (dv = 'dv') => `(CASE WHEN ${coBtpSql(dv)} THEN 2 ELSE 1 END)`;
// Sức chứa release của đợt = SL vải × số đầu.
const sucChuaSql = (dv = 'dv') => `(COALESCE(${dv}.so_luong_vai_ve,0) * ${soDauSql(dv)})`;
// "Còn release" của đầu đang lập (`daSql` = biểu thức SL đã release của đợt). Gương JS `conRelease`.
const conReleaseSql = (dv, daSql) => `(CASE WHEN ${sucChuaSql(dv)} - (${daSql}) <= 0 THEN 0
  ELSE LEAST(${sucChuaSql(dv)} - (${daSql}), COALESCE(${dv}.so_luong_vai_ve,0) - MOD((${daSql})::int, GREATEST(COALESCE(${dv}.so_luong_vai_ve,0),1)::int)) END)`;

function conRelease(soLuong, daRelease, btp) {
  const sl = Math.max(0, Number(soLuong) || 0);
  const da = Math.max(0, Number(daRelease) || 0);
  const tong = sl * (btp ? 2 : 1) - da;
  if (tong <= 0) return 0;
  return Math.min(tong, sl - (da % Math.max(sl, 1)));
}

// Đầu BTP đang lập (1 / 2) — chỉ có nghĩa khi đợt có cờ; đã release đủ cả 2 đầu ⇒ 2.
function dauDangLap(soLuong, daRelease) {
  const sl = Math.max(1, Number(soLuong) || 0);
  return Math.min(2, Math.floor((Number(daRelease) || 0) / sl) + 1);
}

const NHO_CHUA_CO_MS = 60 * 1000;
let coCot = false;
let doLuc = 0;
async function coCotBtp() {
  if (coCot) return true;
  if (Date.now() - doLuc < NHO_CHUA_CO_MS) return false;
  try {
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='dot_vai_ve' AND column_name IN ('btp_khac_kh','btp_khac_kh_tg','btp_khac_kh_boi')"
    );
    coCot = Number(rows[0] && rows[0].n) === 3;
  } catch (e) {
    coCot = false;
  }
  doLuc = Date.now();
  return coCot;
}

// Bật cờ cho các đợt CHƯA có cờ (trong transaction `client` hoặc query thường) + audit. Trả danh sách id đã bật.
async function batCoTx(client, dotVaiIds, actorId, { nguon, lyDo } = {}) {
  const run = client || { query };
  const ids = [...new Set((dotVaiIds || []).map(String))];
  if (!ids.length) return [];
  const { rows } = await run.query(
    `UPDATE dot_vai_ve SET btp_khac_kh = true, btp_khac_kh_tg = now(), btp_khac_kh_boi = $2,
            updated_by = $2, updated_date = now()
      WHERE id = ANY($1::uuid[]) AND NOT btp_khac_kh RETURNING id::text AS id`.replace(/\s+/g, ' '),
    [ids, actorId]
  );
  for (const r of rows) {
    await run.query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
       VALUES ('dot_vai_ve', $1, 'BAT_BTP_KHAC_KH', '{"btp_khac_kh":false}'::jsonb, $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
      [r.id, JSON.stringify({ btp_khac_kh: true, nguon: nguon || null, ly_do: lyDo || null }), actorId]
    );
  }
  return rows.map((r) => r.id);
}

module.exports = { coBtpSql, soDauSql, sucChuaSql, conReleaseSql, conRelease, dauDangLap, coCotBtp, batCoTx };
