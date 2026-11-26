'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PHÂN CÔNG THEO PHIẾU IN TEM SF0 (19/11/2026, người dùng chốt: "tem gửi câu Sh6 và câu sửa phải lấy lại ca trưởng,
//   chuyền trưởng, thợ in của tem in SF0 thì mới đúng").
// Vì sao: `duLieuGhiInTem` đọc phân công HIỆN TẠI của PHIẾU sản xuất — 1 phiếu chạy qua nhiều ca và phân công đầu ca
//   ghi đè phiếu trước mỗi lần in ⇒ lúc KCS / Sửa gửi Sh6 / SK6 (giờ sau, ca sau) đọc ra người của CA KHÁC. SF0 chụp
//   đúng người lúc IN TEM (và được gửi lại khi Sửa tem đổi phân công) ⇒ là nguồn đúng.
// Nguồn = lần gửi SF0 (`audit_log` `ten_bang='tem'`, `ERP_GHI_IN_TEM`) LÚC IN = lần thành công ĐẦU TIÊN của tem — tem 17 /
//   tem con ⇒ của TEM GỐC; chưa có lần nào thành công ⇒ lần lỗi đầu tiên (`ERP_GHI_IN_TEM_LOI`, thân MES định gửi). Không
//   có SF0 (tem 13 gia công đi JQ6, tem chưa gửi) ⇒ trả không có gì ⇒ bên gọi giữ cách cũ.
// ⚠ 19/11/2026 (ca thật 152608084040…43, 152608083125/83159/83299/83410): KHÔNG lấy lần MỚI NHẤT — "Gửi lại" / Sửa tem dựng
//   lại thân SF0 từ phân công HIỆN TẠI của phiếu (người ca sau) ⇒ lần mới nhất mang người sai, chép sang Sh6 là sai theo.
//   Ngoại lệ: tem có PHÂN CÔNG RIÊNG (`tem_phan_cong` · `SUA_PHAN_CONG_TEM` — người dùng sửa người của tem) ⇒ lần MỚI NHẤT
//   (thân SF0 dựng từ phân công riêng), trả `rieng: true`.
// 3 giá trị đã là MÃ SỐ NHÂN VIÊN (đã chuẩn hóa lúc gửi SF0); SF0 gửi `-` khi trống ⇒ đổi lại thành rỗng (Sh6/SK6 không
//   dùng `-`). Đi qua `chuanHoa` lần nữa vô hại: mã số không tra ra họ tên ⇒ giữ nguyên.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

const sach = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '-' ? '' : s;
};

// Map tem_id → { Catruong, Chuyentruong, dsthoin, id_mes_sf0, rieng } (chỉ tem có SF0).
async function phanCongSf0(temIds = []) {
  const ids = [...new Set(temIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const { rows } = await query(`SELECT t.id AS tem_id, x.gui, r.rieng FROM tem t
      CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM audit_log p WHERE p.ten_bang = 'tem_phan_cong'
          AND p.id_ban_ghi = COALESCE(t.tem_goc_id, t.id)::text AND p.hanh_dong = 'SUA_PHAN_CONG_TEM') AS rieng) r
      CROSS JOIN LATERAL (SELECT COALESCE(a.gia_tri_moi->'gui', a.gia_tri_moi->'payload') AS gui FROM audit_log a
        WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = COALESCE(t.tem_goc_id, t.id)::text
          AND a.hanh_dong IN ('ERP_GHI_IN_TEM', 'ERP_GHI_IN_TEM_LOI')
          AND COALESCE(a.gia_tri_moi->'gui', a.gia_tri_moi->'payload') IS NOT NULL
        ORDER BY (a.hanh_dong = 'ERP_GHI_IN_TEM') DESC, CASE WHEN r.rieng THEN a.thoi_gian END DESC NULLS LAST,
                 a.thoi_gian ASC LIMIT 1) x
     WHERE t.id = ANY($1::uuid[])`.replace(/\s+/g, ' '), [ids]);
  return new Map(rows.map((r) => {
    const g = r.gui || {};
    return [String(r.tem_id), {
      Catruong: sach(g.Catruong), Chuyentruong: sach(g.Chuyentruong), dsthoin: sach(g.dsthoin), id_mes_sf0: g.IDMES ?? null,
      // Thiết bị (chuyền = `banin`) + tổ in của lượt SF0 — chỉ `thietBi` mới dùng (Nhận sửa JH0, 26/11/2026).
      banin: sach(g.banin), Toin: sach(g.Toin),
      rieng: !!r.rieng,
    }];
  }));
}

// Đè 3 trường người của payload Sh6 / SK6 / SF0 gửi lại (`taoPayload`) bằng giá trị SF0 lúc in. Trả true nếu đã đè.
// `CatruongMsnv` phải xóa: `chuanHoa` ưu tiên nó hơn `Catruong`.
// `giuKhiRieng` (SF0 gửi lại): tem có phân công riêng ⇒ KHÔNG đè — payload đã dựng từ phân công riêng (`duLieuGhiInTem`).
// `thietBi` (Nhận sửa JH0): đè thêm chuyền (`banin`) + tổ in (`Toin`) bằng giá trị SF0 khi SF0 có (trống ⇒ giữ của tem).
async function apPhanCongSf0(payload, temId, { giuKhiRieng = false, thietBi = false } = {}) {
  const pc = (await phanCongSf0([temId])).get(String(temId));
  if (!pc || (giuKhiRieng && pc.rieng)) return false;
  payload.Catruong = pc.Catruong;
  payload.Chuyentruong = pc.Chuyentruong;
  payload.dsthoin = pc.dsthoin;
  payload.CatruongMsnv = null;
  if (thietBi) {
    if (pc.banin) payload.banin = pc.banin;
    if (pc.Toin) payload.Toin = pc.Toin;
  }
  return true;
}

module.exports = { phanCongSf0, apPhanCongSf0 };
