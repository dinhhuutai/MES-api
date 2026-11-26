'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI LẠI Sh6 (kiểm phẩm) + SU6 (phân loại lỗi) THEO DANH SÁCH TEM (25/11/2026 — người dùng gửi danh sách 42 mã ERP báo,
//   phần lớn là tem kiểm giao trước ngày 20/11: Sh6 lúc đó gửi `BarcodeIn` = TEM 17, không có `Barcode17` (luật 19–25/11)
//   ⇒ ERP lấy 10 số sau của tem 17 làm nhãn 16, không khớp nhãn 16 của tem 15 mà SU6 gửi (`Maquet`).
//   Mỗi tem (nhận mã 9 / 10 / 12 số, nhãn 15 · 16 · 17 — tem 17 quy về tem gốc):
//     1. Sh6: MỌI lượt KCS còn hiệu lực của tem gốc — lượt đã gửi ⇒ CHÍNH nút "Gửi lại ERP" (`caidatapi/guiLai`, cùng IDMES +
//        Ngày CT / ngày ca cũ, thân dựng lại theo luật hiện hành: `BarcodeIn` = tem 15 + `Barcode17` = tem 17 sống của lượt);
//        lượt chưa từng gửi ⇒ gửi lần đầu (`kiemPhamErp.guiKiemPham`).
//     2. SU6 (SAU Sh6 của tem đó): tem có phiếu phân loại lỗi — đã gửi ⇒ `guiLai` (cùng IDMES + Ngày CT cũ); chưa từng gửi ⇒
//        gửi lần đầu (IDMES mới, Ngày CT = lúc lưu phiếu). Tem chưa phân loại lỗi ⇒ không có SU6.
//
// CÁCH CHẠY (MÁY CHỦ production, thư mục backend — SAU khi deploy BE có luật Sh6 `Barcode17` và ERP đã sửa router Sh6 nhận
//   `Barcode17`):
//     node src/scripts/guiLaiSh6Su6TheoTem.js                         ← XEM THỬ 42 mã mặc định (danh sách người dùng 25/11)
//     node src/scripts/guiLaiSh6Su6TheoTem.js --gui                   ← GỬI THẬT
//     node src/scripts/guiLaiSh6Su6TheoTem.js --tem=608085235,152608085151 [--gui]   ← danh sách khác
//     node src/scripts/guiLaiSh6Su6TheoTem.js --file=ds_tem.txt [--gui]              ← 1 mã / dòng (hoặc ngăn dấu phẩy)
//     thêm --chi-sh6 / --chi-su6 để gửi riêng 1 loại · --nguoi=<tên đăng nhập> (mặc định admin, ghi vào Lịch sử API)
// ⚠ Chạy lại vô hại: cùng IDMES ⇒ proc ERP xóa phiếu cũ cùng `Soctcu` rồi tạo lại.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../config/db');

const MAC_DINH = [
  608072733, 608085235, 608072726, 608085151, 608085232, 608085195, 608085260, 608085536, 608072739, 608085180,
  608085580, 608072734, 608072735, 608085334, 608085333, 608085388, 608085415, 608085387, 608085519, 608072793,
  608085493, 608085303, 608085425, 608072701, 608072784, 608072707, 608085250, 608085531, 608085307, 608085363,
  608072786, 608085336, 608072729, 608085318, 608085383, 608072785, 608072787, 608072788, 608085179, 608084896,
  608084895, 608084898,
].map(String);

const args = process.argv.slice(2);
const lay = (k, md) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : md; };
const GUI = args.includes('--gui');
const CHI_SH6 = args.includes('--chi-sh6');
const CHI_SU6 = args.includes('--chi-su6');
const NGUOI = lay('nguoi', 'admin');
const nghi = (ms) => new Promise((r) => setTimeout(r, ms));

function docDanhSach() {
  const f = lay('file', null);
  const raw = f ? fs.readFileSync(f, 'utf8') : lay('tem', null);
  const ds = raw ? raw.split(/[\s,;]+/) : MAC_DINH;
  return [...new Set(ds.map((x) => x.trim()).filter((x) => /^\d{9,12}$/.test(x)))];
}

async function main() {
  // Chặn chạy bằng bản BE cũ (Sh6 `BarcodeIn` = tem 17): gửi lại lúc đó chỉ ghi lại đúng thân sai.
  const nguon = fs.readFileSync(path.join(__dirname, '../modules/quality/kiemPhamErp.js'), 'utf8');
  if (!/payload\.Barcode17\s*=/.test(nguon)) throw new Error('Bản BE chưa có luật Sh6 Barcode17 — deploy BE trước rồi mới chạy');
  const { rows: [db] } = await query('SELECT current_database() AS db, inet_server_addr()::text AS may');
  const { rows: [nd] } = await query('SELECT id FROM nguoi_dung WHERE ten_dang_nhap = $1', [NGUOI]);
  if (!nd) throw new Error(`Không có tài khoản ${NGUOI}`);
  const actorId = nd.id;
  const ds = docDanhSach();
  console.log(`[sh6-su6] DB ${db.db}@${db.may || 'local'} · ${ds.length} mã · ${GUI ? 'GỬI THẬT' : 'XEM THỬ (thêm --gui để gửi)'}`
    + `${CHI_SH6 ? ' · chỉ Sh6' : ''}${CHI_SU6 ? ' · chỉ SU6' : ''}`);

  // Quy mọi mã về TEM GỐC (tem 17 ⇒ tem_goc_id). Ứng viên của mã nhập (dựng trong SQL — gói tin nhỏ): 12 số = nguyên mã
  //   (nhãn 16 ⇒ tem 15) · 10 số = thêm tiền tố 15 / 17 · 9 số = thêm 152 / 172.
  const { rows: tems } = await query(
    `SELECT u.nhap, t.id, t.ma_tem, COALESCE(g.id, t.id) AS goc_id, COALESCE(g.ma_tem, t.ma_tem) AS goc_ma
       FROM unnest($1::text[]) AS u(nhap)
       JOIN tem t ON t.ma_tem = ANY(CASE length(u.nhap)
              WHEN 12 THEN ARRAY[CASE WHEN left(u.nhap, 2) = '16' THEN '15' || substr(u.nhap, 3) ELSE u.nhap END]
              WHEN 10 THEN ARRAY['15' || u.nhap, '17' || u.nhap]
              ELSE ARRAY['152' || u.nhap, '172' || u.nhap] END)
       LEFT JOIN tem g ON g.id = t.tem_goc_id`.replace(/\s+/g, ' '), [ds]);
  const theoNhap = new Map();
  tems.forEach((t) => theoNhap.set(t.nhap, [...(theoNhap.get(t.nhap) || []), t]));
  const khong = ds.filter((m) => !theoNhap.has(m));
  if (khong.length) console.log(`  ⚠ Không tìm thấy tem trên MES: ${khong.join(', ')}`);
  const mapMo = [...theoNhap.entries()].filter(([, v]) => v.length > 1);
  if (mapMo.length) {
    console.log(`  ⚠ Mã khớp nhiều tem (bỏ qua — nhập đủ 12 số): ${mapMo.map(([k, v]) => `${k} → ${v.map((x) => x.ma_tem).join('/')}`).join('; ')}`);
  }
  const goc = new Map();
  [...theoNhap.values()].filter((v) => v.length === 1).flat().forEach((t) => {
    if (!goc.has(t.goc_id)) goc.set(t.goc_id, { id: t.goc_id, ma: t.goc_ma, nhap: [] });
    goc.get(t.goc_id).nhap.push(t.ma_tem);
  });
  console.log(`  → ${goc.size} tem gốc`);

  const { guiLai } = require('../modules/caidatapi/guiLai');
  const kiemPhamErp = require('../modules/quality/kiemPhamErp');
  const plRepo = require('../modules/quality/phanloailoi.repository');
  const erp = require('../utils/erpApiChung');
  const { capIdMes } = require('../utils/idMes');
  const { temCode } = require('../utils/temPrefix');
  const tk = { sh6_ok: 0, sh6_loi: 0, su6_ok: 0, su6_loi: 0, su6_khong: 0, khong_kcs: 0 };
  const loi = [];

  for (const t of [...goc.values()].sort((a, b) => a.ma.localeCompare(b.ma))) {
    console.log(`\n■ ${t.ma}${t.nhap.some((m) => m !== t.ma) ? `  (từ ${t.nhap.join(', ')})` : ''}`);
    // ── Sh6: mọi lượt KCS còn hiệu lực + lần gửi Sh6 mới nhất của lượt ──
    if (!CHI_SU6) {
      const { rows: luot } = await query(
        `SELECT k.id, to_char(k.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM HH24:MI') AS luc, k.so_luong_dat, k.so_luong_loi,
                k.so_luong_chenh_lech, tc.ma_tem AS tem_17, s.id AS audit_id, s.hanh_dong, s.gia_tri_moi->>'id_mes' AS id_mes,
                s.gia_tri_moi->'gui'->>'BarcodeIn' AS bin, s.gia_tri_moi->'gui'->>'Barcode17' AS b17
           FROM kcs k
           LEFT JOIN tem tc ON tc.kcs_tach_id = k.id AND tc.trang_thai <> 'HUY'
           LEFT JOIN LATERAL (SELECT a.id, a.hanh_dong, a.gia_tri_moi FROM audit_log a WHERE a.ten_bang = 'kcs' AND a.id_ban_ghi = k.id::text
                                AND a.hanh_dong IN ('ERP_GUI_KIEM_PHAM', 'ERP_GUI_KIEM_PHAM_LOI') ORDER BY a.thoi_gian DESC LIMIT 1) s ON true
          WHERE k.tem_id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log c WHERE c.ten_bang = 'kcs' AND c.hanh_dong = 'HUY_XAC_NHAN' AND c.id_ban_ghi = k.id::text)
          ORDER BY k.created_date`.replace(/\s+/g, ' '), [t.id]);
      if (!luot.length) { tk.khong_kcs += 1; console.log('  Sh6: chưa có lượt KCS còn hiệu lực — bỏ qua'); }
      for (const l of luot) {
        const cu = l.audit_id ? `IDMES ${l.id_mes} · cũ BarcodeIn ${l.bin || '—'} / Barcode17 ${l.b17 || '—'}${l.hanh_dong === 'ERP_GUI_KIEM_PHAM_LOI' ? ' (LỖI)' : ''}` : 'chưa từng gửi';
        const moi = `mới BarcodeIn ${t.ma} / Barcode17 ${l.tem_17 || '—'}`;
        const dong = `  Sh6 lượt ${l.luc} đạt ${l.so_luong_dat} hư ${l.so_luong_loi}: ${cu} → ${moi}`;
        if (!GUI) { console.log(dong); continue; }
        try {
          if (l.audit_id) await guiLai('ERP_GUI_KIEM_PHAM', l.audit_id, actorId);
          else {
            const kq = await kiemPhamErp.guiKiemPham(l.id, t.id, {
              dat: l.so_luong_dat, hu: l.so_luong_loi, thieu: Math.max(0, -(Number(l.so_luong_chenh_lech) || 0)),
            }, actorId);
            if (!kq.ok) throw new Error(kq.error || kq.ly_do || 'không gửi được');
          }
          tk.sh6_ok += 1; console.log(`${dong}  ✓`);
        } catch (e) {
          tk.sh6_loi += 1; loi.push(`${t.ma} Sh6 ${l.luc}: ${e.message}`); console.log(`${dong}  ✗ ${e.message}`);
        }
        await nghi(300);
      }
    }
    // ── SU6: phiếu phân loại lỗi của tem (sau Sh6) ──
    if (!CHI_SH6) {
      const phieu = await plRepo.getPhieuTheoTem(t.id);
      if (!phieu) { tk.su6_khong += 1; console.log('  SU6: chưa phân loại lỗi — không có SU6'); continue; }
      const { rows: [s] } = await query(
        `SELECT a.id, a.hanh_dong, a.gia_tri_moi->>'id_mes' AS id_mes, a.gia_tri_moi->'gui'->>'Maquet' AS maquet FROM audit_log a
          WHERE a.ten_bang = 'tem' AND a.id_ban_ghi = $1 AND a.hanh_dong IN ('ERP_GUI_PHAN_LOAI_LOI', 'ERP_GUI_PHAN_LOAI_LOI_LOI')
          ORDER BY a.thoi_gian DESC LIMIT 1`.replace(/\s+/g, ' '), [String(t.id)]);
      const dsLoi = (phieu.dong || []).map((d) => `${d.ma_loi} sửa ${d.so_luong_sua}/hủy ${d.so_luong_huy}`).join(', ');
      const dong = `  SU6 Maquet ${temCode(t.ma, 16)} [${dsLoi}]: ${s ? `IDMES ${s.id_mes}${s.hanh_dong === 'ERP_GUI_PHAN_LOAI_LOI_LOI' ? ' (lần trước LỖI)' : ' (lần trước thành công)'}` : 'chưa từng gửi ⇒ gửi lần đầu'}`;
      if (!GUI) { console.log(dong); continue; }
      try {
        if (s) await guiLai('ERP_GUI_PHAN_LOAI_LOI', s.id, actorId);
        else {
          // Như nhánh SU6 của `guiLai` khi chưa có dòng lịch sử: IDMES mới, Ngày CT = lúc lưu phiếu.
          const { rows: [tm] } = await query('SELECT COALESCE(sl_kcs_dat, 0)::int AS sl_kcs_dat FROM tem WHERE id = $1', [t.id]);
          const dsMa = erp.dsMaLoi(phieu.dong, tm.sl_kcs_dat);
          if (!dsMa) throw new Error('phiếu không có mã lỗi');
          const idMes = await capIdMes('gui-erp-phan-loai-loi');
          const kq = await erp.guiPhanLoaiLoi({
            IDMes: String(idMes), Ngayct: phieu.updated_date || phieu.created_date, nhanvien: await erp.tenDangNhap(actorId),
            Maquet: temCode(t.ma, 16), DsMaloi: dsMa,
          }, { temId: t.id, actorId });
          if (!kq || !kq.ok) throw new Error((kq && (kq.error || kq.ly_do)) || 'không gửi được');
        }
        tk.su6_ok += 1; console.log(`${dong}  ✓`);
      } catch (e) {
        tk.su6_loi += 1; loi.push(`${t.ma} SU6: ${e.message}`); console.log(`${dong}  ✗ ${e.message}`);
      }
      await nghi(300);
    }
  }

  console.log(`\n[sh6-su6] ${GUI ? 'Xong' : 'Xem thử xong'} — ${JSON.stringify(tk)}`);
  if (loi.length) console.log(`Lỗi:\n  ${loi.join('\n  ')}`);
}

main()
  .catch((e) => { console.error('[sh6-su6] ✗', e.message); process.exitCode = 1; })
  .finally(() => pool.end().catch(() => {}));
