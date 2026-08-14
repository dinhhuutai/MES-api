'use strict';

const { query } = require('../../config/db');

// Lưu 1 dòng cấu hình. `ma_api` là PK nên upsert theo nó.
async function luu({ ma, bat, ghiChu, codePhan }, actorId) {
  await query(
    `INSERT INTO cai_dat_api (ma_api, bat, ghi_chu, code_phan, updated_by, updated_date)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (ma_api) DO UPDATE
        SET bat = EXCLUDED.bat, ghi_chu = EXCLUDED.ghi_chu, code_phan = EXCLUDED.code_phan,
            updated_by = EXCLUDED.updated_by, updated_date = CURRENT_TIMESTAMP`.replace(/\s+/g, ' '),
    [ma, !!bat, ghiChu || null, codePhan || null, actorId || null]
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
