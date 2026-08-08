'use strict';

const { query, withTransaction } = require('../../config/db');
const { MAU_GOC } = require('../../utils/mauTemSeed');

// Bảng `mau_tem`/`gan_mau_tem` là mig 073 — chưa chạy migration thì module này tắt êm (trả rỗng)
// thay vì làm sập trang. Dò 1 lần rồi CACHE KHI ĐÃ CÓ (chạy migration xong nhận ngay, khỏi restart BE).
let coBang = false;
async function kiemBang() {
  if (coBang) return true;
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('mau_tem','gan_mau_tem')`.replace(/\s+/g, ' ')
  );
  coBang = rows[0].n === 2;
  return coBang;
}

const COT = 'id, ma_mau, ten_mau, mo_ta, bo_cuc_json, la_mac_dinh, dang_hoat_dong, created_date, updated_date';

async function listMau() {
  if (!await kiemBang()) return [];
  const { rows } = await query(
    `SELECT ${COT},
            (SELECT string_agg(g.ma_vi_tri, ',' ORDER BY g.ma_vi_tri) FROM gan_mau_tem g WHERE g.mau_tem_id = m.id) AS vi_tri_list
       FROM mau_tem m WHERE m.dang_hoat_dong ORDER BY m.la_mac_dinh DESC, m.ten_mau`.replace(/\s+/g, ' ')
  );
  return rows;
}

async function getMau(id) {
  if (!await kiemBang()) return null;
  const { rows } = await query(`SELECT ${COT} FROM mau_tem WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getMauByMa(maMau) {
  if (!await kiemBang()) return null;
  const { rows } = await query(`SELECT ${COT} FROM mau_tem WHERE ma_mau = $1`, [maMau]);
  return rows[0] || null;
}

// Mẫu đang GẮN vào 1 vị trí in — nguồn cho lúc IN THẬT. Chưa gắn → null ⇒ nút in lùi về bố cục cứng.
async function getMauTheoViTri(maViTri) {
  if (!await kiemBang()) return null;
  const { rows } = await query(
    `SELECT m.${COT.split(', ').join(', m.')} FROM gan_mau_tem g JOIN mau_tem m ON m.id = g.mau_tem_id
      WHERE g.ma_vi_tri = $1 AND m.dang_hoat_dong LIMIT 1`.replace(/\s+/g, ' '),
    [maViTri]
  );
  return rows[0] || null;
}

async function listGan() {
  if (!await kiemBang()) return [];
  const { rows } = await query('SELECT ma_vi_tri, mau_tem_id FROM gan_mau_tem');
  return rows;
}

async function taoMau({ maMau, tenMau, moTa, boCuc, laMacDinh = false }, actorId) {
  const { rows } = await query(
    `INSERT INTO mau_tem (ma_mau, ten_mau, mo_ta, bo_cuc_json, la_mac_dinh, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING ${COT}`,
    [maMau, tenMau, moTa || null, JSON.stringify(boCuc || {}), !!laMacDinh, actorId]
  );
  return rows[0];
}

async function suaMau(id, { tenMau, moTa, boCuc }, actorId) {
  const { rows } = await query(
    `UPDATE mau_tem SET ten_mau = COALESCE($2, ten_mau), mo_ta = $3,
            bo_cuc_json = COALESCE($4::jsonb, bo_cuc_json), updated_by = $5, updated_date = now()
      WHERE id = $1 RETURNING ${COT}`,
    [id, tenMau || null, moTa || null, boCuc ? JSON.stringify(boCuc) : null, actorId]
  );
  return rows[0] || null;
}

// Xóa MỀM (giữ lịch sử + phòng khi lỡ tay). Gỡ luôn khỏi mọi vị trí in để nút in không trỏ vào mẫu chết.
async function xoaMau(id, actorId) {
  return withTransaction(async (client) => {
    await client.query('DELETE FROM gan_mau_tem WHERE mau_tem_id = $1', [id]);
    const { rows } = await client.query(
      'UPDATE mau_tem SET dang_hoat_dong = false, updated_by = $2, updated_date = now() WHERE id = $1 RETURNING ma_mau',
      [id, actorId]
    );
    return rows[0] || null;
  });
}

// Gắn mẫu vào vị trí in (1 vị trí ↔ 1 mẫu). `mauTemId = null` ⇒ GỠ gắn → nút in lùi về bố cục cứng.
async function ganMau(maViTri, mauTemId, actorId) {
  if (!mauTemId) {
    await query('DELETE FROM gan_mau_tem WHERE ma_vi_tri = $1', [maViTri]);
    return null;
  }
  const { rows } = await query(
    `INSERT INTO gan_mau_tem (ma_vi_tri, mau_tem_id, created_by) VALUES ($1,$2,$3)
     ON CONFLICT (ma_vi_tri) DO UPDATE SET mau_tem_id = EXCLUDED.mau_tem_id,
       updated_by = EXCLUDED.created_by, updated_date = now()
     RETURNING ma_vi_tri, mau_tem_id`,
    [maViTri, mauTemId, actorId]
  );
  return rows[0];
}

// Tạo 4 MẪU GỐC nếu chưa có (idempotent theo `ma_mau`). Gọi mỗi lần mở danh sách — rẻ, và giúp
// người dùng luôn có bản dựng lại đúng tem hiện hành để bắt đầu sửa.
// ⚠ KHÔNG tự gắn vào vị trí in: gắn là đổi bản in thật, phải do người dùng bấm.
async function seedMauGoc(actorId) {
  if (!await kiemBang()) return 0;
  let them = 0;
  for (const m of MAU_GOC) {
    const { rowCount } = await query(
      `INSERT INTO mau_tem (ma_mau, ten_mau, mo_ta, bo_cuc_json, la_mac_dinh, created_by)
       VALUES ($1,$2,$3,$4::jsonb,true,$5) ON CONFLICT (ma_mau) DO NOTHING`,
      [m.ma_mau, m.ten_mau, m.mo_ta, JSON.stringify(m.bo_cuc), actorId]
    );
    them += rowCount;
  }
  return them;
}

module.exports = {
  kiemBang, listMau, getMau, getMauByMa, getMauTheoViTri, listGan,
  taoMau, suaMau, xoaMau, ganMau, seedMauGoc,
};
