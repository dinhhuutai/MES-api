'use strict';

// =====================================================================
// Theo dõi dòng chảy CHỦ ĐỘNG (migration 029).
// Đơn vị theo dõi = ĐỢT VẢI VỀ. Mỗi bước chuyển trạm:
//   1) ghi lich_su_luan_chuyen (tu_tram → den_tram, tg_bd = tg_vao trạm cũ, tg_kt = now)
//   2) upsert ton_tram (đợt vải đang ở trạm hiện tại) ON CONFLICT(dot_vai_ve_id)
// GỌI BEST-EFFORT: mọi lỗi ghi vết đều nuốt (log) để KHÔNG làm hỏng nghiệp vụ chính.
// Trạm lấy theo ma_tram của workflow_version HIỆN HÀNH (không hardcode).
// =====================================================================

const { query, withTransaction } = require('../../config/db');

// ---- Resolver: từ đối tượng nghiệp vụ → danh sách dot_vai_ve_id ----

async function dotVaiFromLenh(lenhId) {
  const { rows } = await query(
    'SELECT dot_vai_ve_id FROM lenh_sx_dot_vai WHERE lenh_san_xuat_id = $1',
    [lenhId]
  );
  return rows.map((r) => r.dot_vai_ve_id);
}

async function dotVaiFromTem(temId) {
  const { rows } = await query(
    `SELECT DISTINCT lsdv.dot_vai_ve_id
     FROM tem t
     JOIN phieu_san_xuat p ON p.id = t.phieu_san_xuat_id
     JOIN lenh_sx_dot_vai lsdv ON lsdv.lenh_san_xuat_id = p.lenh_san_xuat_id
     WHERE t.id = $1`,
    [temId]
  );
  return rows.map((r) => r.dot_vai_ve_id);
}

async function dotVaiFromPhanIn(phanInId) {
  const { rows } = await query('SELECT id FROM dot_vai_ve WHERE phan_in_id = $1', [phanInId]);
  return rows.map((r) => r.id);
}

async function dotVaiFromDonHang(donHangId) {
  const { rows } = await query(
    `SELECT dv.id
     FROM dot_vai_ve dv
     JOIN phan_in pi ON pi.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pi.ma_hang_id
     WHERE mh.don_hang_id = $1`,
    [donHangId]
  );
  return rows.map((r) => r.id);
}

// Owner "xử lý" mặc định của trạm (ưu tiên owner dạng user) — gán vào ton_tram.owner_id.
async function defaultProcessingOwner(tramId) {
  try {
    const { rows } = await query(
      `SELECT user_id FROM tram_owner
       WHERE tram_id = $1 AND user_id IS NOT NULL AND loai = 'XU_LY'
       ORDER BY created_date LIMIT 1`,
      [tramId]
    );
    return rows[0]?.user_id || null;
  } catch {
    return null;
  }
}

// ---- Core: move nhiều đợt vải sang 1 trạm (theo mã trạm) ----
// opts: { soLuong?, ownerId? }  — soLuong áp cho tất cả, ownerId ghi đè owner xử lý.
async function moveDotVaiTo(dotVaiIds, tramCode, actorId, opts = {}) {
  try {
    const ids = [...new Set((dotVaiIds || []).filter(Boolean))];
    if (ids.length === 0) return;

    // Trạm đích theo workflow hiện hành.
    const { rows: tramRows } = await query(
      `SELECT t.id, t.thu_tu
       FROM tram t
       JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh = true
       WHERE t.ma_tram = $1
       LIMIT 1`,
      [tramCode]
    );
    const den = tramRows[0];
    if (!den) { console.warn(`[tracking] Không tìm thấy trạm ${tramCode} ở workflow hiện hành`); return; }

    const ownerId = opts.ownerId || (await defaultProcessingOwner(den.id));

    // Thông tin đợt vải (phan_in + số lượng) + trạm hiện tại.
    const { rows: info } = await query(
      `SELECT dv.id AS dot_vai_ve_id, dv.phan_in_id, dv.so_luong_vai_ve,
              tt.tram_id AS cur_tram_id, tt.tg_vao AS cur_tg_vao,
              ct.thu_tu AS cur_thu_tu
       FROM dot_vai_ve dv
       LEFT JOIN ton_tram tt ON tt.dot_vai_ve_id = dv.id
       LEFT JOIN tram ct ON ct.id = tt.tram_id
       WHERE dv.id = ANY($1::uuid[])`,
      [ids]
    );

    await withTransaction(async (client) => {
      for (const row of info) {
        // Forward-only: không kéo đợt vải lùi về trạm trước (chống re-fire / gọi sai thứ tự).
        if (row.cur_thu_tu != null && den.thu_tu != null && den.thu_tu < row.cur_thu_tu) continue;
        // Đã ở đúng trạm → bỏ qua (không tạo dòng luân chuyển rỗng).
        if (row.cur_tram_id === den.id) continue;

        const soLuong = opts.soLuong != null ? opts.soLuong : row.so_luong_vai_ve;

        await client.query(
          `INSERT INTO lich_su_luan_chuyen
             (phan_in_id, dot_vai_ve_id, tu_tram_id, den_tram_id, so_luong, tg_bd, tg_kt, created_by)
           VALUES ($1,$2,$3,$4,$5,$6, CURRENT_TIMESTAMP, $7)`,
          [row.phan_in_id, row.dot_vai_ve_id, row.cur_tram_id || null, den.id, soLuong, row.cur_tg_vao || null, actorId]
        );

        await client.query(
          `INSERT INTO ton_tram
             (phan_in_id, dot_vai_ve_id, tram_id, so_luong, owner_id, tg_vao, created_by)
           VALUES ($1,$2,$3,$4,$5, CURRENT_TIMESTAMP, $6)
           ON CONFLICT (dot_vai_ve_id) WHERE dot_vai_ve_id IS NOT NULL
           DO UPDATE SET tram_id = EXCLUDED.tram_id, so_luong = EXCLUDED.so_luong,
                         owner_id = EXCLUDED.owner_id, tg_vao = EXCLUDED.tg_vao,
                         updated_by = EXCLUDED.created_by, updated_date = CURRENT_TIMESTAMP`,
          [row.phan_in_id, row.dot_vai_ve_id, den.id, soLuong, ownerId, actorId]
        );
      }
    });
  } catch (e) {
    // Best-effort: không ném lỗi ra ngoài.
    console.error(`[tracking] moveDotVaiTo(${tramCode}) lỗi: ${e.message}`);
  }
}

// Hoàn tác chuyển trạm: đưa đợt vải VỀ LẠI 1 trạm (bỏ qua forward-guard) — dùng khi HỦY/hoàn tác.
// Best-effort: chỉ cập nhật ton_tram (dashboard/orders tính deterministic nên không phụ thuộc).
async function revertToTram(dotVaiIds, tramCode, actorId) {
  try {
    const ids = [...new Set((dotVaiIds || []).filter(Boolean))];
    if (ids.length === 0) return;
    const { rows } = await query(
      `SELECT t.id FROM tram t JOIN workflow_version wv ON wv.id = t.workflow_version_id AND wv.la_hien_hanh = true
       WHERE t.ma_tram = $1 LIMIT 1`,
      [tramCode]
    );
    const tramId = rows[0]?.id;
    if (!tramId) return;
    await query(
      `UPDATE ton_tram SET tram_id = $1, tg_vao = CURRENT_TIMESTAMP, updated_by = $2, updated_date = CURRENT_TIMESTAMP
       WHERE dot_vai_ve_id = ANY($3::uuid[])`,
      [tramId, actorId, ids]
    );
  } catch (e) {
    console.error(`[tracking] revertToTram(${tramCode}) lỗi: ${e.message}`);
  }
}
const revertToReady = (dotVaiIds, actorId) => revertToTram(dotVaiIds, 'READY', actorId);

// Tiện ích: move theo đối tượng (tự resolve đợt vải).
const moveByLenh = async (lenhId, tramCode, actorId, opts) =>
  moveDotVaiTo(await dotVaiFromLenh(lenhId), tramCode, actorId, opts);
const moveByTem = async (temId, tramCode, actorId, opts) =>
  moveDotVaiTo(await dotVaiFromTem(temId), tramCode, actorId, opts);
const moveByPhanIn = async (phanInId, tramCode, actorId, opts) =>
  moveDotVaiTo(await dotVaiFromPhanIn(phanInId), tramCode, actorId, opts);
const moveByDonHang = async (donHangId, tramCode, actorId, opts) =>
  moveDotVaiTo(await dotVaiFromDonHang(donHangId), tramCode, actorId, opts);

module.exports = {
  moveDotVaiTo, revertToReady, revertToTram,
  moveByLenh, moveByTem, moveByPhanIn, moveByDonHang,
  dotVaiFromLenh, dotVaiFromTem, dotVaiFromPhanIn, dotVaiFromDonHang,
};
