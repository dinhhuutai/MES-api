'use strict';

const { query } = require('../../config/db');

// Lưu 1 dòng cấu hình. `ma_tinh_nang` là PK nên upsert theo nó.
async function luu({ ma, bat, ghiChu }, actorId) {
  await query(
    `INSERT INTO cai_dat_tinh_nang (ma_tinh_nang, bat, ghi_chu, updated_by, updated_date)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (ma_tinh_nang) DO UPDATE
        SET bat = EXCLUDED.bat, ghi_chu = EXCLUDED.ghi_chu,
            updated_by = EXCLUDED.updated_by, updated_date = CURRENT_TIMESTAMP`.replace(/\s+/g, ' '),
    [ma, !!bat, ghiChu || null, actorId || null]
  );
}

// Người + giờ sửa gần nhất của từng tính năng (để trang hiện "ai tắt, lúc nào").
async function thongTinSua() {
  const { rows } = await query(
    `SELECT c.ma_tinh_nang, c.ghi_chu, c.updated_date, nd.ho_ten AS nguoi
       FROM cai_dat_tinh_nang c LEFT JOIN nguoi_dung nd ON nd.id = c.updated_by`.replace(/\s+/g, ' ')
  );
  return rows;
}

module.exports = { luu, thongTinSua };
