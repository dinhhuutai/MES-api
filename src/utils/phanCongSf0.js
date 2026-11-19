'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PHÂN CÔNG THEO PHIẾU IN TEM SF0 (19/11/2026, người dùng chốt: "tem gửi câu Sh6 và câu sửa phải lấy lại ca trưởng,
//   chuyền trưởng, thợ in của tem in SF0 thì mới đúng").
// Vì sao: `duLieuGhiInTem` đọc phân công HIỆN TẠI của PHIẾU sản xuất — 1 phiếu chạy qua nhiều ca và phân công đầu ca
//   ghi đè phiếu trước mỗi lần in ⇒ lúc KCS / Sửa gửi Sh6 / SK6 (giờ sau, ca sau) đọc ra người của CA KHÁC. SF0 chụp
//   đúng người lúc IN TEM (và được gửi lại khi Sửa tem đổi phân công) ⇒ là nguồn đúng.
// Nguồn = lần gửi SF0 (`audit_log` `ten_bang='tem'`, `ERP_GHI_IN_TEM`) MỚI NHẤT của tem — tem 17 / tem con ⇒ của TEM GỐC;
//   chưa có lần nào thành công ⇒ lần lỗi mới nhất (`ERP_GHI_IN_TEM_LOI`, thân MES định gửi). Không có SF0 (tem 13 gia
//   công đi JQ6, tem chưa gửi) ⇒ trả không có gì ⇒ bên gọi giữ cách cũ.
// 3 giá trị đã là MÃ SỐ NHÂN VIÊN (đã chuẩn hóa lúc gửi SF0); SF0 gửi `-` khi trống ⇒ đổi lại thành rỗng (Sh6/SK6 không
//   dùng `-`). Đi qua `chuanHoa` lần nữa vô hại: mã số không tra ra họ tên ⇒ giữ nguyên.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

const sach = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '-' ? '' : s;
};

// Map tem_id → { Catruong, Chuyentruong, dsthoin, id_mes_sf0 } (chỉ tem có SF0).
async function phanCongSf0(temIds = []) {
  const ids = [...new Set(temIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const { rows } = await query(`SELECT t.id AS tem_id, x.gui FROM tem t
      CROSS JOIN LATERAL (SELECT COALESCE(a.gia_tri_moi->'gui', a.gia_tri_moi->'payload') AS gui FROM audit_log a
        WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = COALESCE(t.tem_goc_id, t.id)::text
          AND a.hanh_dong IN ('ERP_GHI_IN_TEM', 'ERP_GHI_IN_TEM_LOI')
          AND COALESCE(a.gia_tri_moi->'gui', a.gia_tri_moi->'payload') IS NOT NULL
        ORDER BY (a.hanh_dong = 'ERP_GHI_IN_TEM') DESC, a.thoi_gian DESC LIMIT 1) x
     WHERE t.id = ANY($1::uuid[])`.replace(/\s+/g, ' '), [ids]);
  return new Map(rows.map((r) => {
    const g = r.gui || {};
    return [String(r.tem_id), {
      Catruong: sach(g.Catruong), Chuyentruong: sach(g.Chuyentruong), dsthoin: sach(g.dsthoin), id_mes_sf0: g.IDMES ?? null,
    }];
  }));
}

// Đè 3 trường người của payload Sh6 / SK6 (`taoPayload`) bằng giá trị SF0. Trả true nếu đã đè.
// `CatruongMsnv` phải xóa: `chuanHoa` ưu tiên nó hơn `Catruong`.
async function apPhanCongSf0(payload, temId) {
  const pc = (await phanCongSf0([temId])).get(String(temId));
  if (!pc) return false;
  payload.Catruong = pc.Catruong;
  payload.Chuyentruong = pc.Chuyentruong;
  payload.dsthoin = pc.dsthoin;
  payload.CatruongMsnv = null;
  return true;
}

module.exports = { phanCongSf0, apPhanCongSf0 };
