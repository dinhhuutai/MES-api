'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BTP KHÁC KẾ HOẠCH (mig 120, 28/10/2026, người dùng yêu cầu) — in bán thành phẩm = in NHIỀU ĐẦU của tấm vải; mỗi đầu có
// thể lên kế hoạch ở máy / ngày khác nhau ⇒ 1 đợt vải được Release 1 NHIỀU LẦN, mỗi lần đủ SL vải.
// ⚠⚠ 29/10/2026 (người dùng: "tích BTP coi như thêm 1 đợt vải mới, có thể tích cho lần 3, lần 4 — in 3, 4 đầu"): bản
//   28/10 chỉ có cờ 2 đầu. Nay `dot_vai_ve.so_dau_btp` = SỐ ĐẦU (1 = đợt thường); `btp_khac_kh` giữ đồng bộ = (số đầu > 1).
//
// Luật (NGUỒN DUY NHẤT — đừng chép ra chỗ khác):
//   · SỨC CHỨA release = số đầu × SL vải.
//   · "Còn release" = phần còn của ĐẦU ĐANG LẬP: min(sức chứa − đã release, SL − (đã release mod SL)) ⇒ đầu 1 chia
//     300 + 200 thì sau 300 còn 200 (chưa sang đầu kế); release đủ 1 đầu thì còn = SL cho đầu kế. Đợt thường: công thức
//     ra đúng SL − đã release như cũ.
//   · 1 lệnh giữ tối đa SL vải của 1 đợt (1 đầu) — trần Lập lại kế hoạch = min(SL, sức chứa − lệnh khác giữ).
//   · TÍCH "BTP" (Release 1 · KH tạm · Lập lại kế hoạch · Sửa kế hoạch ở Danh sách release · Hệ thống) = THÊM 1 ĐẦU sau
//     phần đã lập: số đầu = max(hiện tại, max(1, ⌈(đã release + KH tạm chờ) ÷ SL⌉) + 1) ⇒ đợt (lại) hiện ở Release 1 với
//     còn = SL. Tích lại khi đầu kế đang chờ ⇒ không đổi (bấm 2 lần không thêm 2 đầu).
//   · BỎ TÍCH (Lập lại kế hoạch · Sửa kế hoạch · Hệ thống) = BỎ ĐẦU CHỜ: số đầu = max(1, ⌈(đã release + KH tạm chờ) ÷ SL⌉)
//     ⇒ đợt rời Release 1 (đầu đang dở thì vẫn còn phần dở). Không bao giờ hạ dưới phần đã lập.
//
// ⚠ Câu ĐỌC dùng `to_jsonb(dv)->>'…'` ⇒ chạy được cả khi CHƯA chạy mig 120 (thiếu khóa ⇒ đợt thường) — các hằng SQL
//   dựng lúc nạp module (siSoTram) không dò cột được. Câu GHI phải dò cột trước (`coCotBtp`, khuôn `coCotThoInKh`).
// ─────────────────────────────────────────────────────────────────────────────
const { query, withTransaction } = require('../config/db');

// Biểu thức boolean: đợt `dv` có hơn 1 đầu.
const coBtpSql = (dv = 'dv') => `(${soDauSql(dv)} > 1)`;
// Số đầu của đợt (≥ 1). Dòng có cờ 28/10 mà chưa có cột số đầu ⇒ 2.
function soDauSql(dv = 'dv') {
  return `GREATEST(1, COALESCE((to_jsonb(${dv})->>'so_dau_btp')::int,
    CASE WHEN COALESCE((to_jsonb(${dv})->>'btp_khac_kh')::boolean, false) THEN 2 ELSE 1 END))`;
}
// Sức chứa release của đợt = SL vải × số đầu.
const sucChuaSql = (dv = 'dv') => `(COALESCE(${dv}.so_luong_vai_ve,0) * ${soDauSql(dv)})`;
// "Còn release" của đầu đang lập (`daSql` = biểu thức SL đã release của đợt). Gương JS `conRelease`.
const conReleaseSql = (dv, daSql) => `(CASE WHEN ${sucChuaSql(dv)} - (${daSql}) <= 0 THEN 0
  ELSE LEAST(${sucChuaSql(dv)} - (${daSql}), COALESCE(${dv}.so_luong_vai_ve,0) - MOD((${daSql})::int, GREATEST(COALESCE(${dv}.so_luong_vai_ve,0),1)::int)) END)`;

// `soDau`: số đầu (số) — nhận cả boolean kiểu cũ (true = 2 đầu).
const soDauCua = (soDau) => (typeof soDau === 'boolean' ? (soDau ? 2 : 1) : Math.max(1, Math.floor(Number(soDau) || 1)));

function conRelease(soLuong, daRelease, soDau) {
  const sl = Math.max(0, Number(soLuong) || 0);
  const da = Math.max(0, Number(daRelease) || 0);
  const tong = sl * soDauCua(soDau) - da;
  if (tong <= 0) return 0;
  return Math.min(tong, sl - (da % Math.max(sl, 1)));
}

// Đầu đang lập (1…số đầu); đã release đủ mọi đầu ⇒ = số đầu.
function dauDangLap(soLuong, daRelease, soDau = 2) {
  const sl = Math.max(1, Number(soLuong) || 0);
  return Math.min(soDauCua(soDau), Math.floor((Number(daRelease) || 0) / sl) + 1);
}

// Số đầu MỚI sau khi tích (`them`) / bỏ tích. `daTong` = đã release (lệnh ≠ HUY) + SL kế hoạch tạm đang chờ.
function soDauSau(soLuong, daTong, cu, them) {
  const sl = Math.max(1, Number(soLuong) || 0);
  const daLap = Math.max(1, Math.ceil((Math.max(0, Number(daTong) || 0)) / sl));
  const hien = soDauCua(cu);
  return them ? Math.max(hien, daLap + 1) : Math.max(1, Math.min(hien, daLap));
}
// Đợt đang có ĐẦU BTP CHỜ lập kế hoạch (số đầu > phần đã lập) — trạng thái ô tích ở Lập lại / Sửa kế hoạch.
const coDauCho = (soLuong, daTong, soDau) => soDauSau(soLuong, daTong, soDau, false) < soDauCua(soDau);

const NHO_CHUA_CO_MS = 60 * 1000;
let coCot = false;
let doLuc = 0;
async function coCotBtp() {
  if (coCot) return true;
  if (Date.now() - doLuc < NHO_CHUA_CO_MS) return false;
  try {
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='dot_vai_ve' AND column_name IN ('btp_khac_kh','btp_khac_kh_tg','btp_khac_kh_boi','so_dau_btp')"
    );
    coCot = Number(rows[0] && rows[0].n) === 4;
  } catch (e) {
    coCot = false;
  }
  doLuc = Date.now();
  return coCot;
}

// TÍCH (`them: true`) / BỎ TÍCH BTP cho các đợt — khóa đợt (FOR UPDATE, thứ tự id), đọc lại số trong transaction, ghi
// số đầu mới + audit `THEM_DAU_BTP` / `BO_DAU_BTP`. `client` = transaction của bên gọi (không có ⇒ tự mở 1 transaction).
// Trả [{ id, ma_dot_vai, cu, moi }] của các đợt ĐÃ ĐỔI. ⚠ Bên gọi phải `coCotBtp()` trước.
async function datSoDauTx(client, dotVaiIds, actorId, { them, nguon, lyDo } = {}) {
  const ids = [...new Set((dotVaiIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  if (!client) return withTransaction((c) => datSoDauTx(c, ids, actorId, { them, nguon, lyDo }));
  await client.query('SELECT id FROM dot_vai_ve WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
  const { rows } = await client.query(
    `SELECT dv.id::text AS id, dv.ma_dot_vai, COALESCE(dv.so_luong_vai_ve,0)::int AS so_luong, dv.so_dau_btp::int AS cu,
            COALESCE((SELECT SUM(COALESCE(lsd.so_luong,0)) FROM lenh_sx_dot_vai lsd
                      JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                      WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY'),0)::int
          + COALESCE((SELECT SUM(COALESCE(k.so_luong,0)) FROM ke_hoach_tam k
                      WHERE k.dot_vai_ve_id = dv.id AND k.trang_thai = 'CHO'),0)::int AS da_tong
       FROM dot_vai_ve dv WHERE dv.id = ANY($1::uuid[])`.replace(/\s+/g, ' '),
    [ids]
  );
  const doi = [];
  for (const r of rows) {
    const moi = soDauSau(r.so_luong, r.da_tong, r.cu, !!them);
    if (moi === soDauCua(r.cu)) continue;
    await client.query(
      `UPDATE dot_vai_ve SET so_dau_btp = $2::smallint, btp_khac_kh = ($2::smallint > 1), btp_khac_kh_tg = now(), btp_khac_kh_boi = $3,
              updated_by = $3, updated_date = now() WHERE id = $1`.replace(/\s+/g, ' '),
      [r.id, moi, actorId]
    );
    await client.query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
       VALUES ('dot_vai_ve', $1, $2, $3::jsonb, $4::jsonb, $5, CURRENT_TIMESTAMP, $5)`,
      [r.id, them ? 'THEM_DAU_BTP' : 'BO_DAU_BTP', JSON.stringify({ so_dau_btp: soDauCua(r.cu) }),
        JSON.stringify({ so_dau_btp: moi, da_lap: r.da_tong, nguon: nguon || null, ly_do: lyDo || null }), actorId]
    );
    doi.push({ id: r.id, ma_dot_vai: r.ma_dot_vai, cu: soDauCua(r.cu), moi });
  }
  return doi;
}

module.exports = {
  coBtpSql, soDauSql, sucChuaSql, conReleaseSql, conRelease, dauDangLap, soDauSau, coDauCho, coCotBtp, datSoDauTx,
};
