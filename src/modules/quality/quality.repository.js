'use strict';

const { query } = require('../../config/db');

const TEM_CTX = `
  SELECT t.id AS tem_id, t.ma_tem, t.so_luong, t.trang_thai,
         ls.ma_lenh_san_xuat, cs.ma_chuyen,
         (SELECT string_agg(DISTINCT pin.ma_phan, ', ')
            FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
            JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id) AS phan_list
  FROM tem t
  JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
  JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
  LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id`;

async function listByTemStatus(status, { search = '' }) {
  const { rows } = await query(
    `${TEM_CTX}
     WHERE t.trang_thai = $1 AND ($2 = '' OR t.ma_tem ILIKE '%'||$2||'%' OR ls.ma_lenh_san_xuat ILIKE '%'||$2||'%')
     ORDER BY t.created_date`,
    [status, search]
  );
  return rows;
}

async function getTemBasic(temId) {
  const { rows } = await query('SELECT id, ma_tem, so_luong, trang_thai FROM tem WHERE id = $1', [temId]);
  return rows[0] || null;
}

async function setTemTrangThai(client, temId, trangThai, actorId) {
  await client.query(
    'UPDATE tem SET trang_thai = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [temId, trangThai, actorId]
  );
}

async function insertKcs(client, temId, d, actorId) {
  await client.query(
    `INSERT INTO kcs (tem_id, so_luong_kiem, so_luong_mau, so_luong_dat, so_luong_loi, so_luong_huy,
                      so_luong_chenh_lech, ket_qua, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [temId, d.soLuongKiem, d.soLuongMau, d.soLuongDat, d.soLuongLoi, d.soLuongHuy,
     d.soLuongChenhLech, d.ketQua, d.ghiChu || null, actorId]
  );
}

async function insertSua(client, temId, d, actorId) {
  await client.query(
    `INSERT INTO sua (tem_id, so_luong_sua, so_luong_sua_dat, so_luong_sua_huy, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [temId, d.soLuongSua, d.soLuongSuaDat, d.soLuongSuaHuy, d.ghiChu || null, actorId]
  );
}

async function nextOqcRound(temId) {
  const { rows } = await query(
    'SELECT COALESCE(MAX(lan_kiem_cua_phan),0)+1 AS lan FROM oqc WHERE tem_id = $1',
    [temId]
  );
  return rows[0].lan;
}

async function insertOqc(client, temId, d, actorId) {
  await client.query(
    `INSERT INTO oqc (tem_id, lan_kiem_cua_phan, so_luong_kiem, so_luong_dat, so_luong_loi, ket_qua, ghi_chu, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [temId, d.lanKiem, d.soLuongKiem, d.soLuongDat, d.soLuongLoi, d.ketQua, d.ghiChu || null, actorId]
  );
}

module.exports = {
  listByTemStatus, getTemBasic, setTemTrangThai, insertKcs, insertSua, nextOqcRound, insertOqc,
};
