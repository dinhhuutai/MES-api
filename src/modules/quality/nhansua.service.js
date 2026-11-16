'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// NHẬN SỬA (mig 132, 14/11/2026 — người dùng chốt). Luật sổ cái: `utils/choSua.js`.
//   Phân loại lỗi xong ⇒ phần sửa nằm ở *Hệ thống › Chờ nhận sửa*. Tổ sửa bấm "Nhận sửa" ở màn Sửa, tích tem + nhập SL nhận
//   ⇒ `tem.sl_nhan_sua += SL` + 1 dòng `nhan_sua` ⇒ đúng SL đó lên màn Sửa. 1 tem sửa nhiều ngày: cần sửa 8, hôm nay nhận 3
//   sửa 3, mai nhận 5 sửa 5 ⇒ không tồn ảo ở màn Sửa / Báo cáo sửa hàng.
//   · Nhận: SL ≤ chờ nhận, tem đã phân loại lỗi, chưa HỦY. Cả lô 1 transaction (lỗi 1 tem ⇒ không ghi tem nào).
//     `tg_nhan_sua` = mốc mở lô đang sửa: đặt lại khi tem đang không còn gì ở màn Sửa (đồng hồ SLA / dải Theo dõi).
//   · Hủy lượt nhận (lý do bắt buộc): chỉ khi phần ĐANG SỬA còn ≥ SL của lượt (chưa sửa tới phần đó) ⇒ trả về chờ nhận.
//     Hủy mềm (`da_huy`) — claude_agent_mes không có DELETE.
// ─────────────────────────────────────────────────────────────────────────────

const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const repo = require('./quality.repository');
const { coNhanSua } = require('../../utils/choSua');
const { timTem } = require('../../utils/temPrefix');
const { mauTim } = require('../../utils/timKiem');

const TOI_DA = 200;
const GHI_CHU_TOI_DA = 300;
const soNguyen = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

async function canMig() {
  if (!(await coNhanSua())) {
    throw new AppError('Chưa chạy migration 132 (Nhận sửa) — báo quản trị chạy database/migrations/132_nhan_sua.sql',
      { status: 409, errorCode: 'CHUA_MIGRATION' });
  }
}

// Danh sách CHỜ NHẬN SỬA (trang Hệ thống + hộp Nhận sửa ở màn Sửa). `co_cot=false` ⇒ chưa chạy mig 132.
async function listChoNhan({ search, filters }) {
  if (!(await coNhanSua())) return { co_cot: false, items: [] };
  const rows = await repo.listChoNhanSua({ search, filters });
  if (rows.length) {
    const so = new Map((await repo.soSuaCuaTem(rows.map((r) => r.tem_id))).map((x) => [x.tem_id, x]));
    rows.forEach((r) => {
      const x = so.get(r.tem_id) || {};
      r.con_sua_tong = r.con_sua;
      r.cho_nhan = Number(x.cho_nhan) || 0;
      r.da_nhan = Number(x.da_nhan) || 0;
      r.dang_sua = Number(x.dang_sua) || 0;
      r.da_xu_ly = Number(x.da_xu_ly) || 0;
      r.tg_phan_loai = x.tg_phan_loai || null;
    });
  }
  return { co_cot: true, items: rows };
}

async function nhanSua({ items = [], ghiChu = '' } = {}, actorId) {
  await canMig();
  const gom = new Map();
  (Array.isArray(items) ? items : []).forEach((i) => {
    const id = i && (i.temId || i.tem_id);
    const sl = soNguyen(i && (i.soLuong ?? i.so_luong));
    if (id && sl) gom.set(String(id), (gom.get(String(id)) || 0) + sl);
  });
  if (!gom.size) throw new AppError('Chọn tem và nhập số lượng nhận sửa', { status: 422, errorCode: 'EMPTY' });
  if (gom.size > TOI_DA) throw new AppError(`Mỗi lần nhận tối đa ${TOI_DA} tem`, { status: 422, errorCode: 'QUA_NHIEU' });
  const gc = String(ghiChu || '').trim() || null;
  if (gc && gc.length > GHI_CHU_TOI_DA) throw new AppError(`Ghi chú dài quá ${GHI_CHU_TOI_DA} ký tự`, { status: 422, errorCode: 'GHI_CHU_QUA_DAI' });

  const ids = [...gom.keys()].sort(); // khóa theo thứ tự cố định ⇒ 2 người nhận cùng lúc không deadlock
  const kq = [];
  await withTransaction(async (client) => {
    for (const id of ids) {
      const sl = gom.get(id);
      const tem = await repo.getTemLedger(id, { client, khoa: true });
      if (!tem) throw new AppError('Tem không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
      if (tem.trang_thai === 'HUY') throw new AppError(`Tem ${tem.ma_tem} đã bị HỦY`, { status: 409, errorCode: 'TEM_HUY' });
      const [so] = await repo.soSuaCuaTem([id], client);
      if (!so.vao_sua_duoc) {
        throw new AppError(`Tem ${tem.ma_tem} chưa phân loại lỗi — phân loại xong mới nhận sửa`, { status: 409, errorCode: 'CHUA_PHAN_LOAI_LOI' });
      }
      const choNhan = Number(so.cho_nhan) || 0;
      if (sl > choNhan) {
        throw new AppError(`Tem ${tem.ma_tem}: nhận ${sl} vượt số còn chờ nhận (${choNhan})`, { status: 422, errorCode: 'VUOT_CHO_NHAN' });
      }
      const daNhan = Number(so.da_nhan) || 0;
      const dangSua = Number(so.dang_sua) || 0;
      await client.query(
        `UPDATE tem SET sl_nhan_sua = $2,
           tg_nhan_sua = CASE WHEN $3::int <= 0 OR tg_nhan_sua IS NULL THEN CURRENT_TIMESTAMP ELSE tg_nhan_sua END,
           updated_by = $4, updated_date = CURRENT_TIMESTAMP WHERE id = $1`.replace(/\s+/g, ' '),
        [id, daNhan + sl, dangSua, actorId]);
      const { rows } = await client.query(
        `INSERT INTO nhan_sua (tem_id, so_luong, loai, ghi_chu, created_by) VALUES ($1, $2, 'NHAN', $3, $4) RETURNING id`,
        [id, sl, gc, actorId]);
      kq.push({ id: rows[0].id, tem_id: id, ma_tem: tem.ma_tem, so_luong: sl, dang_sua: dangSua + sl, cho_nhan: choNhan - sl });
    }
  });
  sockets.emit('quality:updated', { stage: 'SUA', action: 'NHAN_SUA' });
  sockets.emit('dashboard:refresh', {});
  return { so_tem: kq.length, tong_sl: kq.reduce((s, x) => s + x.so_luong, 0), items: kq };
}

async function huyNhanSua(id, lyDo, actorId) {
  await canMig();
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Phải nhập lý do hủy lượt nhận sửa', { status: 422, errorCode: 'NO_LY_DO' });
  if (ly.length > GHI_CHU_TOI_DA) throw new AppError(`Lý do dài quá ${GHI_CHU_TOI_DA} ký tự`, { status: 422, errorCode: 'LY_DO_QUA_DAI' });
  let out = null;
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM nhan_sua WHERE id = $1 FOR UPDATE', [id]);
    const n = rows[0];
    if (!n) throw new AppError('Không tìm thấy lượt nhận sửa', { status: 404, errorCode: 'NOT_FOUND' });
    if (n.da_huy) throw new AppError('Lượt nhận sửa này đã hủy rồi', { status: 409, errorCode: 'DA_HUY' });
    const tem = await repo.getTemLedger(n.tem_id, { client, khoa: true });
    const [so] = await repo.soSuaCuaTem([n.tem_id], client);
    const dangSua = Number(so.dang_sua) || 0;
    if (dangSua < n.so_luong) {
      throw new AppError(`Tem ${tem.ma_tem}: chỉ còn ${dangSua} pcs đang sửa (đã sửa phần còn lại) — không hủy được lượt nhận ${n.so_luong} pcs`,
        { status: 409, errorCode: 'DA_SUA' });
    }
    await client.query('UPDATE tem SET sl_nhan_sua = $2, updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
      [n.tem_id, Math.max(0, (Number(so.da_nhan) || 0) - n.so_luong), actorId]);
    await client.query(
      `UPDATE nhan_sua SET da_huy = true, ly_do_huy = $2, tg_huy = CURRENT_TIMESTAMP, nguoi_huy_id = $3,
         updated_by = $3, updated_date = CURRENT_TIMESTAMP WHERE id = $1`.replace(/\s+/g, ' '), [id, ly, actorId]);
    out = { id, tem_id: n.tem_id, ma_tem: tem.ma_tem, so_luong: n.so_luong };
  });
  sockets.emit('quality:updated', { stage: 'SUA', action: 'HUY_NHAN_SUA' });
  sockets.emit('dashboard:refresh', {});
  return out;
}

// Lịch sử lượt nhận theo NGÀY NHẬN (giờ VN, khoảng ngày) — kèm số hiện tại của tem (đang sửa / chờ nhận) để biết hủy được không.
async function lichSuNhan({ tuNgay, denNgay, search = '' } = {}) {
  if (!(await coNhanSua())) return { co_cot: false, items: [] };
  const params = [tuNgay, denNgay];
  const conds = ["(n.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1::date AND $2::date"];
  if (search) {
    params.push(mauTim(timTem(search)));
    conds.push(`(t.ma_tem ~* $3 OR info.ma_phan ~* $3 OR info.ma_hang ~* $3 OR info.ten_khach_hang ~* $3)`);
  }
  const { rows } = await query(`SELECT n.id, n.tem_id, n.so_luong, n.loai, n.ghi_chu, n.da_huy, n.ly_do_huy, n.tg_huy,
      n.created_date AS tg_nhan, nd.ho_ten AS nguoi_nhan, nh.ho_ten AS nguoi_huy,
      t.ma_tem, t.sl_kcs_sua, ls.ma_lenh_san_xuat, cs.ma_chuyen,
      info.ten_khach_hang, info.ma_don_hang, info.ma_hang, info.ma_phan, info.mau_vai, info.kich_vai, info.kich_phim
    FROM nhan_sua n
    JOIN tem t ON t.id = n.tem_id
    LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
    LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = COALESCE(t.chuyen_id, ps.chuyen_id, ls.chuyen_id)
    LEFT JOIN nguoi_dung nd ON nd.id = n.created_by
    LEFT JOIN nguoi_dung nh ON nh.id = n.nguoi_huy_id
    LEFT JOIN LATERAL (SELECT kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim
      FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id JOIN phan_in pin ON pin.id = dv.phan_in_id
      JOIN ma_hang mh ON mh.id = pin.ma_hang_id JOIN don_hang dh ON dh.id = mh.don_hang_id
      JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY pin.ma_phan, dv.ma_dot_vai LIMIT 1) info ON true
    WHERE ${conds.join(' AND ')}
    ORDER BY n.created_date DESC LIMIT 2000`.replace(/\s+/g, ' '), params);
  if (rows.length) {
    const so = new Map((await repo.soSuaCuaTem([...new Set(rows.map((r) => r.tem_id))])).map((x) => [x.tem_id, x]));
    rows.forEach((r) => {
      const x = so.get(r.tem_id) || {};
      r.dang_sua = Number(x.dang_sua) || 0;
      r.cho_nhan = Number(x.cho_nhan) || 0;
      r.huy_duoc = !r.da_huy && r.dang_sua >= r.so_luong;
    });
  }
  return { co_cot: true, items: rows };
}

module.exports = { listChoNhan, nhanSua, huyNhanSua, lichSuNhan };
