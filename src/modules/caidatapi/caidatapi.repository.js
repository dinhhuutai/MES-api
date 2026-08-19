'use strict';

const { query } = require('../../config/db');
const { coCotCodePhan } = require('../../utils/caiDatApi');
const { mauTim } = require('../../utils/timKiem');

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

// ───────────────────────── LỊCH SỬ GỌI API (nguồn: `audit_log`) ─────────────────────────
// ⚠⚠ ĐỌC ĐƯỢC CẢ 2 HÌNH DẠNG JSON — bắt buộc, vì dòng ghi TRƯỚC 15/08/2026 có hình dạng cũ:
//   · thành công (cũ): { id_mes, ma_tem }                 ← KHÔNG có payload
//   · thất bại  (cũ): { loi, payload:{IDMES,...} }        ← IDMES nằm SÂU trong payload
//   · mọi dòng  (mới): { id_mes, ma_tem, url, gui, nhan, loi, so_lan_thu, thoi_gian_ms }
//   ⇒ `id_mes`/`ma_tem` phải COALESCE qua cả 3 đường, nếu không dòng lỗi cũ sẽ trống IDMES —
//     đúng cái cột quan trọng nhất để đối soát với ERP.
const ID_MES = `COALESCE(a.gia_tri_moi->>'id_mes', a.gia_tri_moi->'gui'->>'IDMES', a.gia_tri_moi->'payload'->>'IDMES')`;
const MA_TEM = `COALESCE(a.gia_tri_moi->>'ma_tem', a.gia_tri_moi->'gui'->>'BarcodeIn', a.gia_tri_moi->'payload'->>'BarcodeIn')`;

// ERP TRẢ VỀ GÌ — thêm 19/08/2026 theo yêu cầu "dù thành công hay thất bại cũng lưu message lại".
// ⚠⚠ `nhan` được `gonPhanHoi` lưu dưới dạng **CHUỖI JSON**, không phải jsonb lồng ⇒ muốn moi khóa
//   bên trong phải `->>'nhan'` rồi mới ép `::jsonb`. Dòng có phản hồi KHÔNG phải JSON (ERP trả HTML
//   khi sập chẳng hạn) sẽ làm phép ép kiểu ném lỗi và HỎNG CẢ TRANG lịch sử ⇒ chỉ ép khi chuỗi thật
//   sự bắt đầu bằng `{`. Đây là màn tra cứu — không được để một dòng rác làm chết cả màn.
const NHAN_JSON = `CASE WHEN left(btrim(COALESCE(a.gia_tri_moi->>'nhan','')), 1) = '{'
  THEN (a.gia_tri_moi->>'nhan')::jsonb END`;
// Ưu tiên khóa nâng sẵn ở mức trên cùng (dòng MỚI); dòng CŨ thì moi từ `nhan`.
const ERP_MESSAGE = `COALESCE(a.gia_tri_moi->>'erp_message', (${NHAN_JSON})->>'message')`;
const ERP_ERROR = `COALESCE(a.gia_tri_moi->>'erp_error', (${NHAN_JSON})->>'error')`;
const ERP_RETURN = `COALESCE(a.gia_tri_moi->>'erp_return_value', (${NHAN_JSON})->>'returnValue')`;

// `ma` = mã API (ERP_BARCODE_TEM | ERP_GHI_IN_TEM). Lấy cả dòng thành công (`ma`) lẫn lỗi (`ma_LOI`).
// ⚠ Lọc ngày theo GIỜ VN (khuôn chung của mọi màn lịch sử — §11.8 DATABASE.md).
// ⚠ Tìm kiếm: theo IDMES / mã tem — 2 khóa người dùng thực sự cầm trên tay khi đối soát 2 bên.
//   Dùng `~*` + `mauTim` theo luật tìm-kiếm-không-dấu toàn app (§8 CLAUDE.md).
async function lichSu({ ma, date = '', search = '', offset = 0, limit = 20 }) {
  const FROM = `
    FROM audit_log a
    LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
    WHERE a.hanh_dong IN ($1, $2)
      AND ($3 = '' OR (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $3::date)
      AND ($4 = '' OR ${ID_MES} ~* $4 OR ${MA_TEM} ~* $4)`;
  const args = [ma, `${ma}_LOI`, date || '', mauTim(search)];

  const dataSql = `
    SELECT a.id, a.thoi_gian, a.hanh_dong, a.id_ban_ghi,
           (a.hanh_dong = $1) AS thanh_cong,
           ${ID_MES} AS id_mes, ${MA_TEM} AS ma_tem,
           a.gia_tri_moi->>'url' AS url,
           a.gia_tri_moi->>'loi' AS loi,
           ${ERP_MESSAGE} AS erp_message,
           ${ERP_ERROR} AS erp_error,
           ${ERP_RETURN} AS erp_return_value,
           (a.gia_tri_moi->>'so_lan_thu')::int AS so_lan_thu,
           (a.gia_tri_moi->>'thoi_gian_ms')::int AS thoi_gian_ms,
           a.gia_tri_moi AS chi_tiet,
           nd.ho_ten AS nguoi
    ${FROM}
    ORDER BY a.thoi_gian DESC
    LIMIT $5 OFFSET $6`;
  const countSql = `SELECT count(*)::int AS total ${FROM}`;

  const [data, count] = await Promise.all([
    query(dataSql.replace(/\s+/g, ' '), [...args, limit, offset]),
    query(countSql.replace(/\s+/g, ' '), args),
  ]);
  return { rows: data.rows, total: count.rows[0].total };
}

module.exports = { luu, thongTinSua, lichSu };
