'use strict';

const { query } = require('../../config/db');
const { MA_TCIN_SQL } = require('../../utils/tinhChatIn');

// Áp luồng sản xuất mới cho phần in mang tính chất `ma` (mig 126) — bỏ qua phần in đã sửa tay hoặc đã có lệnh sống
//   (đã chạy theo luồng cũ; đổi thì dùng Quản trị phần in). Trả số phần in đổi.
async function apLuongChoPhanInTx(client, ma, luong) {
  const { rowCount } = await client.query(
    `UPDATE phan_in pin SET luong_sx = $2::varchar, la_in_kieng = ($2::varchar IN ('IN_KIENG','KIENG_KHONG_EP')), luong_sx_tg = CURRENT_TIMESTAMP
      WHERE ${MA_TCIN_SQL('pin.tinh_chat_in')} = $1 AND NOT pin.luong_sx_sua_tay
        AND pin.luong_sx IS DISTINCT FROM $2::varchar
        AND NOT EXISTS (SELECT 1 FROM dot_vai_ve dv JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = dv.id
                          JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                         WHERE dv.phan_in_id = pin.id AND ls.trang_thai <> 'HUY')`.replace(/\s+/g, ' '),
    [ma, luong]
  );
  return rowCount;
}

// Cột `ready_che_do` (mig 131 — READY theo công đoạn). Cache khi CÓ.
let _coCheDo = false;
async function coCotCheDo() {
  if (_coCheDo) return true;
  const { rows } = await query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tinh_chat_in' AND column_name = 'ready_che_do' LIMIT 1");
  _coCheDo = rows.length > 0;
  return _coCheDo;
}

// Cột `kt_yeu_cau` (mig 133 — yêu cầu KT của công đoạn Ép/Logo). Cache khi CÓ.
let _coKtYc = false;
async function coCotKtYc() {
  if (_coKtYc) return true;
  const { rows } = await query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tinh_chat_in' AND column_name = 'kt_yeu_cau' LIMIT 1");
  _coKtYc = rows.length > 0;
  return _coKtYc;
}
// Cột `kt_hskt` (mig 134 — công đoạn Ép/Logo phải xác nhận HSKT). Cache khi CÓ.
let _coKtHskt = false;
async function coCotKtHskt() {
  if (_coKtHskt) return true;
  const { rows } = await query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tinh_chat_in' AND column_name = 'kt_hskt' LIMIT 1");
  _coKtHskt = rows.length > 0;
  return _coKtHskt;
}
// Cột `dsp_logo` (mig 137 — dòng sản phẩm logo: Ép ⇒ Logo, In + Logo được phép). Cache khi CÓ.
let _coDsp = false;
async function coCotDspLogo() {
  if (_coDsp) return true;
  const { rows } = await query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tinh_chat_in' AND column_name = 'dsp_logo' LIMIT 1");
  _coDsp = rows.length > 0;
  return _coDsp;
}
// Cột `mot_tdthdh` (mig 139 — tính chất nhiều công đoạn chỉ có 1 tờ TDTHĐH ⇒ đợt mới từ ERP mang cả 2 công đoạn). Cache khi CÓ.
let _coMot = false;
async function coCotMotTdthdh() {
  if (_coMot) return true;
  const { rows } = await query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tinh_chat_in' AND column_name = 'mot_tdthdh' LIMIT 1");
  _coMot = rows.length > 0;
  return _coMot;
}
// Thiếu cột (chưa mig 134) ⇒ false (không cần HSKT) — khớp `utils/tech.js ktHsktSql`. Thiếu `dsp_logo` (mig 137) / `mot_tdthdh`
//   (mig 139) ⇒ false.
const COT_KT_YC = "COALESCE(to_jsonb(t)->>'kt_yeu_cau', 'KHUON_MUC') AS kt_yeu_cau, COALESCE((to_jsonb(t)->>'kt_hskt')::boolean, false) AS kt_hskt, "
  + "COALESCE((to_jsonb(t)->>'dsp_logo')::boolean, false) AS dsp_logo, COALESCE((to_jsonb(t)->>'mot_tdthdh')::boolean, false) AS mot_tdthdh";

async function coBang() {
  const { rows } = await query("SELECT to_regclass('public.tinh_chat_in') AS bang");
  return !!rows[0].bang;
}

// Danh mục đang dùng + người / giờ sửa gần nhất.
async function danhMuc() {
  const { rows } = await query(
    `SELECT t.id, t.ma_chuan, t.ten, t.luong, t.bo_qua, t.ghi_chu, t.updated_date, nd.ho_ten AS nguoi_sua, COALESCE(to_jsonb(t)->>'ready_che_do', 'RIENG') AS ready_che_do,
            ${COT_KT_YC}
       FROM tinh_chat_in t LEFT JOIN nguoi_dung nd ON nd.id = t.updated_by
      WHERE t.dang_hoat_dong`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Số phần in còn sống theo tính chất (kèm tên để nhận ra tính chất chưa có trong danh mục).
async function demPhanIn() {
  const { rows } = await query(
    `SELECT ${MA_TCIN_SQL('pi.tinh_chat_in')} AS ma, min(btrim(pi.tinh_chat_in)) AS ten, count(*)::int AS so_phan_in
       FROM phan_in pi
      WHERE pi.dang_hoat_dong AND btrim(COALESCE(pi.tinh_chat_in, '')) <> ''
      GROUP BY 1`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Số đợt ERP gửi trong dữ liệu thô còn giữ (job dọn xóa sau khoảng 10 ngày) — gồm cả dòng đang bị bỏ qua.
async function demDotErp() {
  const cot = "COALESCE(r.payload->>'tinhchatin', r.payload->>'Tinhchatin')";
  const { rows } = await query(
    `SELECT ${MA_TCIN_SQL(cot)} AS ma, min(btrim(${cot})) AS ten, count(*)::int AS so_dot
       FROM erp_phieu_nhan_vai_raw r
      WHERE r.payload IS NOT NULL AND btrim(COALESCE(${cot}, '')) <> ''
      GROUP BY 1`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Số phần in còn sống của 1 tính chất (chặn xóa khỏi danh mục).
async function demPhanInCua(client, ma) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM phan_in pi WHERE pi.dang_hoat_dong AND ${MA_TCIN_SQL('pi.tinh_chat_in')} = $1`, [ma]
  );
  return rows[0].n;
}

// Đọc + khóa các dòng (kể cả dòng đã ẩn — thêm lại thì bật lại, không đẻ dòng trùng).
async function docTheoMaTx(client, dsMa) {
  const { rows } = await client.query(
    `SELECT t.id, t.ma_chuan, t.ten, t.luong, t.bo_qua, t.ghi_chu, t.dang_hoat_dong, COALESCE(to_jsonb(t)->>'ready_che_do', 'RIENG') AS ready_che_do, ${COT_KT_YC} FROM tinh_chat_in t WHERE t.ma_chuan = ANY($1::text[]) FOR UPDATE`, [dsMa]
  );
  return rows;
}

async function docTheoIdTx(client, id) {
  const { rows } = await client.query(
    `SELECT t.id, t.ma_chuan, t.ten, t.luong, t.bo_qua, t.ghi_chu, t.dang_hoat_dong, COALESCE(to_jsonb(t)->>'ready_che_do', 'RIENG') AS ready_che_do, ${COT_KT_YC} FROM tinh_chat_in t WHERE t.id = $1 FOR UPDATE`, [id]
  );
  return rows[0] || null;
}

// Cột tùy chọn theo migration đã chạy: `ready_che_do` (mig 131) · `kt_yeu_cau` (mig 133) · `kt_hskt` (mig 134).
async function cotTuyChon(d) {
  const cot = [];
  if (await coCotCheDo()) cot.push(['ready_che_do', d.ready_che_do || 'RIENG']);
  if (await coCotKtYc()) cot.push(['kt_yeu_cau', d.kt_yeu_cau || 'KHUON_MUC']);
  if (await coCotKtHskt()) cot.push(['kt_hskt', d.kt_hskt !== false]);
  if (await coCotDspLogo()) cot.push(['dsp_logo', d.dsp_logo === true]);
  if (await coCotMotTdthdh()) cot.push(['mot_tdthdh', d.mot_tdthdh === true]);
  return cot;
}

async function themTx(client, d, actorId) {
  const them = await cotTuyChon(d);
  const vals = [d.ma_chuan, d.ten, d.luong, d.bo_qua, d.ghi_chu, actorId || null, ...them.map(([, v]) => v)];
  const { rows } = await client.query(
    `INSERT INTO tinh_chat_in (ma_chuan, ten, luong, bo_qua, ghi_chu, created_by, updated_by${them.map(([c]) => `, ${c}`).join('')})
     VALUES ($1, $2, $3, $4, $5, $6, $6${them.map((_, i) => `, $${7 + i}`).join('')}) RETURNING id`.replace(/\s+/g, ' '),
    vals
  );
  return rows[0].id;
}

async function suaTx(client, id, d, actorId) {
  const them = await cotTuyChon(d);
  await client.query(
    `UPDATE tinh_chat_in SET luong = $2, bo_qua = $3, ghi_chu = $4, dang_hoat_dong = true${them.map(([c], i) => `, ${c} = $${6 + i}`).join('')},
            updated_by = $5, updated_date = CURRENT_TIMESTAMP WHERE id = $1`.replace(/\s+/g, ' '),
    [id, d.luong, d.bo_qua, d.ghi_chu, actorId || null, ...them.map(([, v]) => v)]
  );
}

async function anTx(client, id, actorId) {
  await client.query(
    'UPDATE tinh_chat_in SET dang_hoat_dong = false, updated_by = $2, updated_date = CURRENT_TIMESTAMP WHERE id = $1',
    [id, actorId || null]
  );
}

async function logTx(client, id, hanhDong, cu, moi, actorId) {
  await client.query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_cu, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('tinh_chat_in', $1, $2, $3::jsonb, $4::jsonb, $5, clock_timestamp(), $5)`.replace(/\s+/g, ' '),
    [String(id), hanhDong, cu ? JSON.stringify(cu) : null, moi ? JSON.stringify(moi) : null, actorId || null]
  );
}

module.exports = { coCotCheDo, coCotKtYc, coCotKtHskt, coCotDspLogo, coCotMotTdthdh, coBang, danhMuc, demPhanIn, demDotErp, demPhanInCua, docTheoMaTx, docTheoIdTx, themTx, suaTx, anTx, logTx, apLuongChoPhanInTx };
