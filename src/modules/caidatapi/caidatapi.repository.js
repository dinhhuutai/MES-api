'use strict';

const { query } = require('../../config/db');
const { coCotCodePhan } = require('../../utils/caiDatApi');

// Lưu 1 dòng cấu hình. `ma_api` là PK nên upsert theo nó.
// ⚠⚠ DÒ CỘT `code_phan` TRƯỚC rồi mới dựng câu INSERT (khuôn `temCoCot` mig 066) — cột này thêm SAU
//   khi bảng đã lên production. Lỗi thật 14/08/2026: prod chạy mig 083 bản cũ nên thiếu cột ⇒
//   **không lưu được gì cả, kể cả bật/tắt** (42703 `column "code_phan" ... does not exist`).
//   Thiếu cột thì vẫn lưu bật/tắt + ghi chú bình thường, chỉ bỏ qua danh sách code phần.
async function luu({ ma, bat, ghiChu, codePhan }, actorId) {
  const co = await coCotCodePhan();
  // Dựng cột + tham số SONG SONG để số thứ tự `$n` không bao giờ lệch giữa 2 nhánh.
  const cot = ['ma_api', 'bat', 'ghi_chu', ...(co ? ['code_phan'] : []), 'updated_by'];
  const val = [ma, !!bat, ghiChu || null, ...(co ? [codePhan || null] : []), actorId || null];
  const holder = cot.map((_, i) => `$${i + 1}`).join(', ');
  const set = ['bat', 'ghi_chu', ...(co ? ['code_phan'] : []), 'updated_by']
    .map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await query(
    `INSERT INTO cai_dat_api (${cot.join(', ')}, updated_date)
     VALUES (${holder}, CURRENT_TIMESTAMP)
     ON CONFLICT (ma_api) DO UPDATE
        SET ${set}, updated_date = CURRENT_TIMESTAMP`.replace(/\s+/g, ' '),
    val
  );
}

// Người + giờ sửa gần nhất của từng API (để trang hiện "ai tắt, lúc nào").
async function thongTinSua() {
  const { rows } = await query(
    `SELECT c.ma_api, c.ghi_chu, c.updated_date, nd.ho_ten AS nguoi
       FROM cai_dat_api c LEFT JOIN nguoi_dung nd ON nd.id = c.updated_by`.replace(/\s+/g, ' ')
  );
  return rows;
}

module.exports = { luu, thongTinSua };
