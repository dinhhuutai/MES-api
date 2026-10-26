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
// ⚠ + `IDPhieuGiao` (30/09/2026): ID kết nối của phiếu giao nay là IDMES ⇒ mã phiếu hiện ở cột này để
//   vẫn tìm được theo mã phiếu ERP.
// ⚠ + `Maquet` (phân loại lỗi — nhãn 16…) · `BarcodeSua17`/`BarcodeSua` (sửa đạt, OQC) — 18/10/2026: trước đó dòng
//   phân loại lỗi không có mã tem nào ở cột này ⇒ ô tìm theo mã tem không ra (người dùng báo).
const MA_TEM = `COALESCE(a.gia_tri_moi->>'ma_tem', a.gia_tri_moi->'gui'->>'BarcodeIn', a.gia_tri_moi->'payload'->>'BarcodeIn',
  a.gia_tri_moi->'gui'->>'Maquet', a.gia_tri_moi->'gui'->>'BarcodeSua17', a.gia_tri_moi->'gui'->>'BarcodeSua',
  a.gia_tri_moi->'gui'->>'IDPhieuGiao')`;
// Mã tem ERP 12 số: 2 số đầu là tiền tố công đoạn (15 in · 16 nhãn lỗi · 17 sửa) — người tra hay cầm nhãn khác với
// mã đã gửi (gửi `16…`, quét tem `15…`) ⇒ gõ đủ 12 số thì so thêm 10 số sau, bất kể tiền tố.
const duoiMaTem = (s) => (/^\d{12}$/.test(String(s || '').trim()) ? String(s).trim().slice(2) : '');
// ⚠⚠ "ID KẾT NỐI" (27/09/2026) — dòng MỚI luôn có `id_mes`. Dòng CŨ của 3 API qua `goiErp` (phiếu giao ·
//   phân loại lỗi · lấy ID phiếu giao) và 3 API mã tem KHÔNG ghi `id_mes` ⇒ moi lại từ payload/phản hồi:
//   `IDMes` (phân loại lỗi, viết thường) · `IDPhieuGiao` (phiếu giao) · `ma_tem` (mã tem ERP cấp — chỉ
//   dòng xin mã tem, nhận biết bằng `hanh_dong`) · `barcode` trong phản hồi (lấy ID phiếu giao).
//   Khai SAU `NHAN_JSON` vì dùng nó.


// ERP TRẢ VỀ GÌ — thêm 19/08/2026 theo yêu cầu "dù thành công hay thất bại cũng lưu message lại".
// ⚠⚠ `nhan` được `gonPhanHoi` lưu dưới dạng **CHUỖI JSON**, không phải jsonb lồng ⇒ muốn moi khóa
//   bên trong phải `->>'nhan'` rồi mới ép `::jsonb`. Dòng có phản hồi KHÔNG phải JSON (ERP trả HTML
//   khi sập chẳng hạn) sẽ làm phép ép kiểu ném lỗi và HỎNG CẢ TRANG lịch sử ⇒ chỉ ép khi chuỗi thật
//   sự bắt đầu bằng `{`. Đây là màn tra cứu — không được để một dòng rác làm chết cả màn.
// ⚠ 26/10/2026: phản hồi dài bị `gonPhanHoi` CẮT ("…(cắt bớt)") vẫn mở đầu `{` mà không còn là JSON ⇒ ép kiểu ném
//   "invalid input syntax for type json" (gặp ở Release 1 khi lịch sử gộp theo lượt đọc nhiều dòng hơn) ⇒ đòi cả `}` cuối.
const NHAN_JSON = `CASE WHEN left(btrim(COALESCE(a.gia_tri_moi->>'nhan','')), 1) = '{'
  AND right(btrim(a.gia_tri_moi->>'nhan'), 1) = '}'
  THEN (a.gia_tri_moi->>'nhan')::jsonb END`;
// Ưu tiên khóa nâng sẵn ở mức trên cùng (dòng MỚI); dòng CŨ thì moi từ `nhan`.
const ERP_MESSAGE = `COALESCE(a.gia_tri_moi->>'erp_message', (${NHAN_JSON})->>'message')`;
const ERP_ERROR = `COALESCE(a.gia_tri_moi->>'erp_error', (${NHAN_JSON})->>'error')`;
const ERP_RETURN = `COALESCE(a.gia_tri_moi->>'erp_return_value', (${NHAN_JSON})->>'returnValue')`;
const ID_MES = `COALESCE(a.gia_tri_moi->>'id_mes', a.gia_tri_moi->'gui'->>'IDMES', a.gia_tri_moi->'payload'->>'IDMES',
  a.gia_tri_moi->'gui'->>'IDMes', a.gia_tri_moi->'gui'->>'IDPhieuGiao', a.gia_tri_moi->'gui'->>'MaPhieuGiao',
  CASE WHEN a.hanh_dong LIKE 'ERP_BARCODE_TEM%' THEN a.gia_tri_moi->>'ma_tem' END,
  CASE WHEN a.hanh_dong LIKE 'ERP_LAY_ID_PHIEU_GIAO%' THEN (${NHAN_JSON})->>'barcode' END,
  'LOG-' || a.id::text)`;
// ⚠ Lối lùi cuối `LOG-<audit id>`: lượt lỗi CŨ (trước 27/09/2026) chưa từng có mã nào (vd xin mã tem ăn
//   HTTP 404 trước khi ERP cấp số) — vẫn phải có một ID để nêu tên đúng dòng khi trao đổi.

// `ma` = mã API (ERP_BARCODE_TEM | ERP_GHI_IN_TEM). Lấy cả dòng thành công (`ma`) lẫn lỗi (`ma_LOI`).
// ⚠ Lọc ngày theo GIỜ VN (khuôn chung của mọi màn lịch sử — §11.8 DATABASE.md).
// ⚠ Tìm kiếm: theo IDMES / mã tem — 2 khóa người dùng thực sự cầm trên tay khi đối soát 2 bên.
//   Dùng `~*` + `mauTim` theo luật tìm-kiếm-không-dấu toàn app (§8 CLAUDE.md).
// ⚠⚠ 1 DÒNG = 1 LƯỢT (26/10/2026, người dùng: "lần 1 lỗi mà chạy lại các lần sau thành công thì phải báo thành công,
//   có ghi lại các lần lỗi và lần thứ mấy thành công"). Trước đó mỗi lần gửi 1 dòng ⇒ lượt timeout rồi "Gửi lại" thành
//   công vẫn để lại dòng "Lỗi" đỏ (prod 21–24/10: 8 lượt ghi in tem như vậy). Nay GỘP mọi lần gửi CÙNG ID KẾT NỐI
//   (Gửi lại / Sửa & gửi giữ IDMES cũ) thành 1 dòng: số liệu + kết quả = lần gửi MỚI NHẤT (nút Gửi lại dùng đúng dòng
//   đó), `cac_lan_gui` = mọi lần gửi cũ → mới (mỗi lần kèm `so_lan_thu` + `cac_lan_loi` của lần thử tự động bên
//   trong), `so_lan_gui`, `co_thanh_cong`. Lọc ngày / tìm chọn LƯỢT có ít nhất 1 lần gửi khớp; lượt hiện đủ mọi lần
//   gửi kể cả ngày khác. Phân trang + tổng theo LƯỢT.
// Hiệu năng: quét các dòng của API ĐÚNG 1 lần (`b`, tính ID kết nối + cờ khớp lọc), chỉ đọc chi tiết JSON cho các lượt
//   của TRANG đang xem (Release 1 ~4.400 dòng: bản quét 2 lần + gộp mọi lượt mất ~3,5 s).
async function lichSu({ ma, date = '', search = '', offset = 0, limit = 20 }) {
  const args = [ma, `${ma}_LOI`, date || '', mauTim(search), duoiMaTem(search)];
  const sql = `
    WITH b AS MATERIALIZED (
      SELECT a.id, a.thoi_gian, a.hanh_dong, a.nguoi_thuc_hien_id, ${ID_MES} AS idm,
             (($3 = '' OR (a.thoi_gian AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $3::date)
              AND ($4 = '' OR ${ID_MES} ~* $4 OR ${MA_TEM} ~* $4 OR ($5 <> '' AND substr(${MA_TEM}, 3) = $5))) AS khop
        FROM audit_log a WHERE a.hanh_dong IN ($1, $2)),
    k AS (SELECT b.idm FROM b GROUP BY b.idm HAVING bool_or(b.khop)),
    d AS (SELECT DISTINCT ON (b.idm) b.id, b.idm, b.thoi_gian FROM b JOIN k ON k.idm = b.idm
           ORDER BY b.idm, b.thoi_gian DESC, b.id DESC),
    p AS (SELECT d.*, count(*) OVER () AS total FROM d ORDER BY d.thoi_gian DESC, d.id DESC LIMIT $6 OFFSET $7),
    g AS (
      SELECT b.idm, count(*)::int AS so_lan_gui, bool_or(b.hanh_dong = $1) AS co_thanh_cong,
             json_agg(json_build_object('id', x.id, 'thoi_gian', x.thoi_gian, 'thanh_cong', x.hanh_dong = $1,
               'loi', x.gia_tri_moi->>'loi', 'so_lan_thu', (x.gia_tri_moi->>'so_lan_thu')::int,
               'thoi_gian_ms', (x.gia_tri_moi->>'thoi_gian_ms')::int, 'cac_lan_loi', x.gia_tri_moi->'cac_lan_loi',
               'sua_tay', x.gia_tri_moi ? 'sua_tay', 'nguoi', ng.ho_ten) ORDER BY x.thoi_gian, x.id) AS cac_lan_gui
        FROM b JOIN p ON p.idm = b.idm JOIN audit_log x ON x.id = b.id
        LEFT JOIN nguoi_dung ng ON ng.id = x.nguoi_thuc_hien_id
       GROUP BY b.idm)
    SELECT p.total::int AS _total, a.id, a.thoi_gian, a.hanh_dong, a.id_ban_ghi,
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
           nd.ho_ten AS nguoi,
           g.so_lan_gui, g.co_thanh_cong, g.cac_lan_gui
      FROM p
      JOIN audit_log a ON a.id = p.id
      JOIN g ON g.idm = p.idm
      LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
     ORDER BY p.thoi_gian DESC, p.id DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [...args, limit, offset]);
  let total = rows.length ? rows[0]._total : 0;
  // Trang vượt cuối (không có dòng) mà không phải trang 1 ⇒ đếm riêng cho đúng tổng.
  if (!rows.length && offset > 0) {
    const c = await query(sql.replace(/\s+/g, ' '), [...args, 1, 0]);
    total = c.rows.length ? c.rows[0]._total : 0;
  }
  return { rows: rows.map(({ _total, ...r }) => r), total };
}

module.exports = { luu, thongTinSua, lichSu };
