'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI LẠI PHÂN LOẠI LỖI (ERP SU6) THEO ĐỊNH DẠNG MỚI của `@pDsMaloi`: bộ bốn `mã lỗi, SL HỦY, SL SỬA, SL ĐẠT`
// (proc `MES_spr_MES2SU6` ALTER 14/11/2026; SL đạt = `tem.sl_kcs_dat`, lặp lại ở mọi bộ — `erpApiChung.dsMaLoi`).
//
// PHẠM VI: phiếu phân loại lỗi ĐANG CÒN (chưa hủy) có lần lưu cuối trong khoảng ngày (giờ VN, mặc định cả tháng 11/2026),
//   tem không HỦY, phiếu có ≥ 1 dòng mang mã lỗi, mã tem là mã ERP 12 số.
//   · GIỮ IDMES + Ngày CT + nhân viên của lần gửi SU6 gần nhất SAU lần hủy phân loại gần nhất ⇒ proc ghi đè đúng phiếu cũ.
//   · Phiếu chưa từng gửi (hoặc lần gửi đó đã bị báo hủy vì hủy phân loại) ⇒ chỉ LIỆT KÊ; thêm `--ca-chua-gui` để gửi với
//     IDMES MỚI (Ngày CT = lúc lưu phiếu, nhân viên = người lưu phiếu).
//
// CÁCH CHẠY (trên MÁY CHỦ production, thư mục backend — SAU KHI deploy BE bản SU6 bộ bốn VÀ ERP đã ALTER proc/router):
//     node src/scripts/guiLaiSu6PhanLoaiLoi.js                          ← XEM THỬ (mặc định 2026-11-01 → 2026-11-30)
//     node src/scripts/guiLaiSu6PhanLoaiLoi.js 2026-11-01 2026-11-14    ← xem thử khoảng ngày khác
//     node src/scripts/guiLaiSu6PhanLoaiLoi.js --gui                    ← GỬI THẬT (tuần tự, từng tem 1)
//     node src/scripts/guiLaiSu6PhanLoaiLoi.js --gui --ca-chua-gui      ← gửi cả phiếu chưa từng gửi
//
// ⚠ Người ghi vào lịch sử API = tài khoản `admin` (đổi bằng `--nguoi=<tên đăng nhập>`); thân gửi vẫn giữ `nhanvien` cũ.
// ⚠ Chạy lại lần 2 vô hại: cùng IDMES ⇒ ERP ghi đè phiếu.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { query, pool } = require('../config/db');
const plRepo = require('../modules/quality/phanloailoi.repository');
const erp = require('../utils/erpApiChung');
const { temCode } = require('../utils/temPrefix');
const { capIdMes } = require('../utils/idMes');
const { laMaTemErp } = require('../utils/erpGhiInTem');

const args = process.argv.slice(2);
const ngays = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const TU = ngays[0] || '2026-11-01';
const DEN = ngays[1] || ngays[0] || '2026-11-30';
const GUI = args.includes('--gui');
const CA_CHUA_GUI = args.includes('--ca-chua-gui');
const NGUOI = (args.find((a) => a.startsWith('--nguoi=')) || '--nguoi=admin').slice('--nguoi='.length);

// Phiếu còn sống, lưu lần cuối trong khoảng + lần gửi SU6 gần nhất sau lần hủy phân loại gần nhất của tem.
const SQL = `
  WITH p AS (
    SELECT pl.id AS phieu_id, pl.tem_id, t.ma_tem, COALESCE(t.sl_kcs_dat, 0)::int AS sl_kcs_dat,
           COALESCE(pl.updated_date, pl.created_date) AS tg_luu, COALESCE(pl.updated_by, pl.created_by) AS nguoi_luu,
           (SELECT max(a.thoi_gian) FROM audit_log a
             WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = pl.tem_id::text AND a.hanh_dong = 'HUY_PHAN_LOAI_LOI') AS moc_huy
      FROM phan_loai_loi pl
      JOIN tem t ON t.id = pl.tem_id
     WHERE t.trang_thai <> 'HUY'
       AND (COALESCE(pl.updated_date, pl.created_date) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1::date AND $2::date
  )
  SELECT p.*, to_char(p.tg_luu AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') AS tg_luu_vn,
         g.id AS audit_id, g.gia_tri_moi AS gtm
    FROM p
    LEFT JOIN LATERAL (
      SELECT a.id, a.gia_tri_moi FROM audit_log a
       WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = p.tem_id::text
         AND a.hanh_dong IN ('ERP_GUI_PHAN_LOAI_LOI', 'ERP_GUI_PHAN_LOAI_LOI_LOI')
         AND (p.moc_huy IS NULL OR a.thoi_gian > p.moc_huy)
         AND COALESCE(a.gia_tri_moi->'gui'->>'IDMes', a.gia_tri_moi->>'id_mes', '') ~ '^[0-9]+$'
       ORDER BY a.thoi_gian DESC LIMIT 1
    ) g ON TRUE
   ORDER BY p.tg_luu`;

async function main() {
  console.log(`[su6] Phân loại lỗi lưu ${TU} → ${DEN} · ${GUI ? 'GỬI THẬT' : 'XEM THỬ (thêm --gui để gửi)'}`);
  const { rows } = await query(SQL.replace(/\s+/g, ' '), [TU, DEN]);
  if (!rows.length) { console.log('Không có phiếu phân loại lỗi nào trong khoảng.'); return; }

  const coGui = []; const chuaGui = []; const boQua = [];
  for (const r of rows) {
    if (!laMaTemErp(r.ma_tem)) { boQua.push(`${r.ma_tem} (chưa có mã ERP)`); continue; }
    // eslint-disable-next-line no-await-in-loop
    const phieu = await plRepo.getPhieuTheoTem(r.tem_id);
    const ds = phieu ? erp.dsMaLoi(phieu.dong, r.sl_kcs_dat) : '';
    if (!ds) { boQua.push(`${r.ma_tem} (không dòng nào có mã lỗi)`); continue; }
    const cu = (r.gtm && r.gtm.gui) || {};
    const idMes = r.audit_id ? String(cu.IDMes || r.gtm.id_mes) : null;
    const d = { ...r, ds, idMes, ngayCt: cu.Ngayct || null, nhanvien: cu.nhanvien || null };
    (idMes ? coGui : chuaGui).push(d);
  }

  console.log('\nMã nhãn 16     Lưu lúc           IDMES       DsMaloi mới');
  for (const d of [...coGui, ...chuaGui]) {
    console.log(`${temCode(d.ma_tem, 16)}  ${d.tg_luu_vn}  ${String(d.idMes || '(mới)').padEnd(10)}  ${d.ds}`);
  }
  console.log(`\nTổng ${coGui.length} phiếu gửi lại cùng IDMES · ${chuaGui.length} phiếu chưa từng gửi`
    + `${CA_CHUA_GUI ? ' (SẼ gửi IDMES mới)' : ' (bỏ qua — thêm --ca-chua-gui để gửi)'}`);
  if (boQua.length) console.log(`Bỏ qua ${boQua.length}: ${boQua.join(', ')}`);
  if (!GUI) { console.log('\nXEM THỬ — chưa gửi gì. Chạy lại với --gui để gửi.'); return; }

  const { rows: nd } = await query('SELECT id FROM nguoi_dung WHERE ten_dang_nhap = $1', [NGUOI]);
  if (!nd.length) throw new Error(`Không tìm thấy tài khoản ${NGUOI}`);
  const actorId = nd[0].id;
  const ds = CA_CHUA_GUI ? [...coGui, ...chuaGui] : coGui;
  let ok = 0; const loi = [];
  for (const d of ds) {
    try {
      /* eslint-disable no-await-in-loop */
      const idMes = d.idMes || await capIdMes('gui-erp-phan-loai-loi');
      if (idMes == null) throw new Error('không cấp được IDMES');
      const kq = await erp.guiPhanLoaiLoi({
        IDMes: String(idMes),
        Ngayct: d.ngayCt || d.tg_luu,
        nhanvien: d.nhanvien || await erp.tenDangNhap(d.nguoi_luu || actorId),
        Maquet: temCode(d.ma_tem, 16),
        DsMaloi: d.ds,
      }, { temId: d.tem_id, actorId });
      /* eslint-enable no-await-in-loop */
      if (!kq || !kq.ok) throw new Error((kq && (kq.error || kq.ly_do)) || 'ERP báo lỗi');
      ok += 1;
      console.log(`  ✓ ${temCode(d.ma_tem, 16)} (IDMES ${idMes})`);
    } catch (e) {
      loi.push(d.ma_tem);
      console.log(`  ✗ ${temCode(d.ma_tem, 16)}: ${e.message}`);
    }
  }
  console.log(`\nXong: gửi được ${ok}/${ds.length}${loi.length ? ` · lỗi ${loi.length} (hàng đợi tự gửi lại sẽ thử tiếp; hoặc gửi tay ở Cài đặt API › Lịch sử)` : ''}`);
}

main()
  .catch((e) => { console.error(`[su6] ✗ ${e.message}`); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
