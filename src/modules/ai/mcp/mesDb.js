'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// MCP `mes-db` — AI ĐỌC PostgreSQL (19/11/2026). Chỉ mở cho người có quyền AI_AGENT_PHAN_TICH.
// 3 lớp chặn ghi: (1) chỉ nhận 1 câu SELECT/WITH, chặn từ khóa ghi · (2) chạy trong BEGIN READ ONLY rồi ROLLBACK ·
// (3) user DB riêng `AI_DB_USER` (mig 138: mes_ai_doc) chỉ có SELECT, mặc định read-only, timeout 15 giây.
// ⚠ Câu SQL GOM VỀ 1 DÒNG trước khi gửi: IPS giữa máy chủ và DB từng cắt kết nối với câu nhiều dòng.
// ⚠ Pool riêng tối đa 2 kết nối: máy chủ chỉ chịu khoảng 4 câu nặng song song, đừng để AI chiếm hết.
// ═════════════════════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const env = require('../../../config/env');
const { cauHinhAi } = require('../ai.config');
const kienThuc = require('../kienThuc');
const { jsonGon } = require('./rutGon');

let pool = null;
let khoaPool = '';
function layPool() {
  const { db } = cauHinhAi();
  if (!db.user || !db.password) return null;
  const khoa = `${db.user}|${db.password}`;
  if (pool && khoaPool === khoa) return pool;
  if (pool) pool.end().catch(() => {});
  pool = new Pool({
    host: env.db.host,
    port: env.db.port,
    database: env.db.database,
    user: db.user,
    password: db.password,
    ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
    max: 2,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    application_name: 'thla-mes-ai',
  });
  pool.on('error', (e) => console.error('[ai-db] Lỗi pool:', e.message));
  khoaPool = khoa;
  return pool;
}

const TU_CAM = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|cluster|reindex|lock|set|reset|refresh|listen|notify|unlisten|prepare|execute|deallocate|discard|comment|security|into|pg_sleep|pg_terminate_backend|pg_cancel_backend|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|set_config)\b/i;

/** Chuẩn hóa + kiểm 1 câu chỉ đọc. Trả câu 1 dòng hoặc ném lỗi có lời giải thích. */
function chuanSql(sql) {
  let s = String(sql || '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim().replace(/;+\s*$/, '');
  if (!s) throw new Error('Câu SQL trống');
  if (s.length > 6000) throw new Error('Câu SQL quá dài (> 6000 ký tự)');
  const boChuoi = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (boChuoi.includes(';')) throw new Error('Chỉ được 1 câu lệnh (không dùng dấu ;)');
  if (!/^(select|with)\b/i.test(boChuoi)) throw new Error('Chỉ được câu SELECT hoặc WITH … SELECT');
  const cam = TU_CAM.exec(boChuoi);
  if (cam) throw new Error(`Câu có từ khóa không được phép: ${cam[1].toUpperCase()} (AI chỉ đọc)`);
  return s;
}

async function chayDoc(sql, thamSo = []) {
  const p = layPool();
  if (!p) throw new Error('Chưa cấu hình user DB chỉ đọc (AI_DB_USER / AI_DB_PASSWORD trong backend/.env)');
  const client = await p.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '15s'");
    const r = await client.query(sql, thamSo);
    await client.query('ROLLBACK');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* bỏ qua */ }
    throw e;
  } finally {
    client.release();
  }
}

const CONG_CU = [
  {
    name: 'mes_db_danh_sach_bang',
    description: 'Liệt kê các bảng PostgreSQL của MES mà AI đọc được, kèm mô tả và số dòng ước tính.',
    inputSchema: { type: 'object', properties: {} },
    chay: async () => {
      const r = await chayDoc("SELECT c.relname AS bang, obj_description(c.oid, 'pg_class') AS mo_ta, GREATEST(c.reltuples, 0)::bigint AS so_dong_uoc_tinh FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'p') AND has_table_privilege(c.oid, 'SELECT') ORDER BY c.relname");
      return jsonGon({ so_bang: r.rowCount, bang: r.rows.map((x) => ({ ...x, mo_ta: x.mo_ta ? String(x.mo_ta).slice(0, 160) : null })) });
    },
  },
  {
    name: 'mes_db_mo_ta_bang',
    description: 'Xem cột (tên, kiểu, mô tả) của 1 bảng + ghi chú nghiệp vụ về bảng đó trong tài liệu DATABASE. Gọi TRƯỚC khi viết SQL.',
    inputSchema: {
      type: 'object',
      properties: { ten_bang: { type: 'string', description: 'Tên bảng, vd tem, lenh_san_xuat, dot_vai_ve' } },
      required: ['ten_bang'],
    },
    chay: async (a) => {
      const ten = String(a.ten_bang || '').trim().toLowerCase();
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ten)) return jsonGon({ loi: 'Tên bảng không hợp lệ' });
      const r = await chayDoc("SELECT a.attname AS cot, format_type(a.atttypid, a.atttypmod) AS kieu, col_description(a.attrelid, a.attnum) AS mo_ta FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(c.oid, a.attnum, 'SELECT') ORDER BY a.attnum", [ten]);
      if (!r.rowCount) return jsonGon({ loi: `Không có bảng "${ten}" hoặc AI không được đọc bảng này` });
      const ghiChu = kienThuc.tim(ten.replace(/_/g, ' '), { k: 3, nguon: 'DU_LIEU' }).ket_qua
        .filter((d) => d.noi_dung.includes(ten)).map((d) => ({ tieu_de: d.tieu_de, noi_dung: d.noi_dung.slice(0, 1500) }));
      return jsonGon({ bang: ten, cot: r.rows, ghi_chu_tai_lieu: ghiChu });
    },
  },
  {
    name: 'mes_db_truy_van',
    description: 'Chạy 1 câu SELECT chỉ đọc trên PostgreSQL của MES (tối đa 15 giây, trả tối đa 200 dòng). Chỉ dùng khi API website không có số cần. Luôn lọc tem trang_thai <> \'HUY\' và đợt vải không DA_HUY/DA_GOP như MES.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Đúng 1 câu SELECT hoặc WITH … SELECT, không dấu ;' },
        muc_dich: { type: 'string', description: 'Câu này để trả lời ý gì (ghi nhật ký)' },
      },
      required: ['sql'],
    },
    chay: async (a) => {
      let s;
      try { s = chuanSql(a.sql); } catch (e) { return jsonGon({ loi: e.message }); }
      try {
        const r = await chayDoc(`SELECT * FROM (${s}) _ai LIMIT 201`);
        return jsonGon({
          so_dong: Math.min(r.rowCount, 200),
          con_nua: r.rowCount > 200,
          cot: r.fields.map((f) => f.name),
          dong: r.rows.slice(0, 200),
        });
      } catch (e) {
        return jsonGon({ loi: `PostgreSQL báo lỗi: ${e.message}`, goi_y: 'Kiểm lại tên bảng / cột bằng mes_db_mo_ta_bang' });
      }
    },
  },
];

function coCauHinh() { const { db } = cauHinhAi(); return !!(db.user && db.password); }

module.exports = { CONG_CU, chuanSql, coCauHinh };
