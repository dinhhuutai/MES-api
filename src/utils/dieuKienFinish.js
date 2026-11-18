'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ĐIỀU KIỆN FINISH CỦA 1 PHẦN IN (18/11/2026, người dùng chốt — THAY luật 29/10 "SL đã in + vải hư/thiếu ≥ SLNV").
// Hàm thuần: nhận số đã đọc (`modules/quality/finishPhanIn.js`) ⇒ trạng thái từng điều kiện. Gương nhãn FE:
// `frontend/src/features/quality/utils/danhSachFinish.js DK_FINISH` (sửa luật thì sửa cả hai).
//   1. CHAY      — mọi lệnh sống (≠ HUY) của phần in đã XÁC NHẬN CHẠY HOÀN TẤT: lệnh `SAN_XUAT`/`HOAN_TAT` có phiếu
//                  `HOAN_TAT` và không còn phiếu `DANG_CHAY` (lệnh gia công nhận hàng về cũng thành HOAN_TAT). Lệnh còn ở
//                  Release 1 / Test Run / Chờ chạy / Gia công (chưa nhận) ⇒ chưa đạt. Phần in chưa có lệnh ⇒ chưa đạt.
//   2. KIEM      — mọi tem kiểm xong: Σ còn KCS = 0 (tem công đoạn đầu / tem con không vào KCS — `conKcsSql`).
//   3. PHAN_LOAI — mọi tem gốc có hư ở KCS đã phân loại lỗi (có phiếu Phân loại lỗi hoặc đã có lượt Sửa — `vaoSuaDuocSql`).
//   4. SUA       — sửa xong (nếu có): Σ (hư chờ sửa − sửa đạt − sửa hủy) = 0, gồm cả phần chưa Nhận sửa.
//   5. OQC       — đã qua OQC: Σ còn OQC = 0.
//   6. TICH      — mọi tem có SL qua OQC đã được tích ở modal Tích tem của Giao hàng (`tem.da_tich_giao`).
//   7. SL        — SL đạt (giao khách) = Σ SL qua OQC (`sl_oqc_dat`) của tem ĐÃ TÍCH ≥ SLĐH (`phan_in.so_luong_don_hang`;
//                  SLĐH trống / 0 ⇒ không đạt — phải Chuyển finish).
// Đủ 7 ⇒ FINISH TỰ ĐỘNG, ngày finish = ngày (giờ VN) của lần tích tem giao MUỘN NHẤT.
// "CHUYỂN FINISH" (bấm tay, lý do bắt buộc) — chỉ khi CHƯA finish và: đủ 1–6 mà SL đạt < SLĐH, HOẶC admin đã "Mở điều kiện"
//   cho phần in (khi đó chỉ cần điều kiện 1). Ngày finish = ngày bấm. Admin chỉ mở được phần in đã đạt điều kiện 1.
// Trạng thái tay lưu ở `audit_log` `ten_bang='phan_in_finish'`, `id_ban_ghi` = phần in (DATABASE.md §8) — dòng MỚI NHẤT thắng:
//   `CHUYEN_FINISH` / `HUY_CHUYEN_FINISH` · `MO_DIEU_KIEN` / `DONG_DIEU_KIEN`.
// ⚠ Finish TỰ ĐỘNG tính LẠI mỗi lần đọc (không đóng băng): phần in có đợt vải mới ⇒ lệnh mới chưa chạy ⇒ rời danh sách
//   finish tới khi đủ điều kiện lại. Chuyển finish tay thì giữ nguyên.
// ─────────────────────────────────────────────────────────────────────────────

const AUDIT_FINISH = 'phan_in_finish';

const DK_FINISH = [
  { ma: 'CHAY', ten: 'Chạy hoàn tất' },
  { ma: 'KIEM', ten: 'Kiểm xong' },
  { ma: 'PHAN_LOAI', ten: 'Phân loại lỗi xong' },
  { ma: 'SUA', ten: 'Sửa xong' },
  { ma: 'OQC', ten: 'Qua OQC' },
  { ma: 'TICH', ten: 'Đã tích giao' },
  { ma: 'SL', ten: 'SL đạt ≥ SLĐH' },
];

const so = (v) => (v == null || v === '' ? 0 : Number(v) || 0);

// `r` = 1 dòng đọc từ `finishPhanIn.docFinish` (số + `chuyen_finish` / `mo_dieu_kien` dạng object hoặc null).
function danhGiaFinish(r) {
  const sldh = so(r.so_luong_don_hang);
  const dk = {
    CHAY: so(r.so_lenh) > 0 && so(r.so_lenh_chua_xong) === 0,
    KIEM: so(r.con_kcs) === 0,
    PHAN_LOAI: so(r.chua_phan_loai) === 0,
    SUA: so(r.con_sua) === 0,
    OQC: so(r.con_oqc) === 0,
    TICH: so(r.chua_tich) === 0,
    SL: sldh > 0 && so(r.sl_dat) >= sldh,
  };
  const thieu = DK_FINISH.filter((d) => !dk[d.ma]).map((d) => d.ma);
  const tuDong = thieu.length === 0;
  const tay = r.chuyen_finish || null;
  const finish = tuDong || !!tay;
  const moDk = !!r.mo_dieu_kien;
  return {
    dk,
    thieu,
    finish,
    // Chuyển tay thắng (đã chốt ngày bấm) — kể cả khi sau đó đủ điều kiện tự động.
    loai_finish: tay ? 'CHUYEN_TAY' : (tuDong ? 'TU_DONG' : null),
    ngay_finish: tay ? (tay.ngay || null) : (tuDong ? (r.ngay_tich || null) : null),
    mo_dieu_kien: moDk,
    // Nút "Chuyển finish": chưa finish + đã chạy hoàn tất + (admin đã mở HOẶC chỉ còn thiếu SL đạt ≥ SLĐH).
    duoc_chuyen: !finish && dk.CHAY && (moDk || (thieu.length === 1 && thieu[0] === 'SL')),
    // Admin chỉ mở điều kiện cho phần in đã chạy hoàn tất mà chưa finish.
    duoc_mo: !finish && dk.CHAY,
  };
}

// Ghi chú dòng: điều kiện còn thiếu kèm số (chưa finish) — đọc nhanh "kẹt ở đâu".
function ghiChuThieu(r, kq) {
  const f = (n) => so(n).toLocaleString('vi-VN');
  const p = [];
  for (const ma of kq.thieu) {
    if (ma === 'CHAY') p.push(so(r.so_lenh) ? `Còn ${f(r.so_lenh_chua_xong)}/${f(r.so_lenh)} lệnh chưa chạy hoàn tất` : 'Chưa có lệnh sản xuất');
    else if (ma === 'KIEM') p.push(`Chờ kiểm ${f(r.con_kcs)}`);
    else if (ma === 'PHAN_LOAI') p.push(`${f(r.chua_phan_loai)} tem chưa phân loại lỗi`);
    else if (ma === 'SUA') p.push(`Chờ sửa ${f(r.con_sua)}`);
    else if (ma === 'OQC') p.push(`Chờ OQC ${f(r.con_oqc)}`);
    else if (ma === 'TICH') p.push(`${f(r.chua_tich)} tem chưa tích giao`);
    else if (ma === 'SL') p.push(so(r.so_luong_don_hang) > 0 ? `SL đạt ${f(r.sl_dat)} < SLĐH ${f(r.so_luong_don_hang)}` : 'Chưa có SLĐH');
  }
  return p.join(' · ');
}

module.exports = { AUDIT_FINISH, DK_FINISH, danhGiaFinish, ghiChuThieu };
