'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GHI VẾT MỌI LƯỢT GỌI API ERP — nguồn cho trang *Hệ thống > Cài đặt API* (nút "Lịch sử").
//
// Vì sao cần: trước đây 2 API đẩy/kéo chỉ để lại `console.log` trên máy chủ ⇒ muốn biết
// "hôm qua gửi cái gì lên ERP, IDMES bao nhiêu" thì phải SSH đọc log. Mà **IDMES là khóa đối
// soát 2 bên** (MES ↔ ERP) nên bắt buộc phải tra được từ giao diện.
//
// ⚠ KHÔNG thêm bảng — dùng `audit_log` (forward-only, đã có sẵn). Khối lượng rất nhẹ:
//   ~2 dòng / 1 tem in ra, mà prod hiện chỉ ~26 tem / 7 ngày.
//
// ⚠⚠ HÌNH DẠNG `gia_tri_moi` THỐNG NHẤT cho MỌI dòng mới (cả thành công lẫn lỗi):
//     { id_mes, ma_tem, url, thanh_cong, so_lan_thu, thoi_gian_ms, gui, nhan, loi }
//   Nhờ vậy màn lịch sử chỉ cần 1 cách đọc. Dòng CŨ (trước 15/08/2026) có hình dạng khác
//   ({id_mes, ma_tem} khi thành công · {loi, payload} khi lỗi) ⇒ hàm đọc phải COALESCE,
//   xem `caidatapi.repository.lichSu`.
//
// ⚠ MỌI LỖI ĐỀU BỊ NUỐT: đây là bước ghi vết, hỏng nó KHÔNG được kéo theo lỗi cho luồng in tem.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

// `ten_bang` của từng API. `ERP_GHI_IN_TEM` cố ý giữ 'tem' + `id_ban_ghi = tem.id` để dòng lịch sử
// còn LIÊN KẾT được với tem (và tương thích với các dòng đã ghi từ 14/08/2026).
const TEN_BANG = { ERP_BARCODE_TEM: 'erp_api', ERP_GHI_IN_TEM: 'tem' };

// Cắt bớt phản hồi ERP trước khi lưu — tránh 1 lần lỗi bất thường nhồi cả trang HTML vào audit_log.
const DAI_TOI_DA_PHAN_HOI = 2000;
function gonPhanHoi(v) {
  if (v == null) return null;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > DAI_TOI_DA_PHAN_HOI ? `${s.slice(0, DAI_TOI_DA_PHAN_HOI)}…(cắt bớt)` : s;
  } catch { return String(v).slice(0, DAI_TOI_DA_PHAN_HOI); }
}

/**
 * Ghi 1 lượt gọi API ERP.
 * @param {string} maApi      'ERP_BARCODE_TEM' | 'ERP_GHI_IN_TEM'
 * @param {object} o
 *  - thanhCong {boolean}
 *  - idBanGhi  {string}  id gắn vào audit (tem.id với ghi-in-tem; barcode/'-' với lấy mã tem)
 *  - idMes     {number}  ⚠ khóa đối soát MES ↔ ERP — luôn cố gắng điền
 *  - maTem     {string}
 *  - url       {string}  gọi ĐI ĐÂU (bài học 11/08: lỗi chỉ ghi "timeout" nên rất khó tìm)
 *  - soLanThu  {number}  đã thử mấy lần mới xong/mới bỏ
 *  - thoiGianMs{number}
 *  - gui       {object}  payload gửi lên (null với API chỉ GET)
 *  - nhan      {any}     phản hồi nhận về — LƯU CẢ KHI LỖI (xem `erpGhiInTem.goiMotLan`)
 *  - erpMessage     {string} `message` ERP trả về (cả 2 nhánh)
 *  - erpError       {string} `error` ERP trả về ở nhánh lỗi — câu của SQL Server
 *  - erpReturnValue {number} mã RETURN của stored procedure (0 = OK). ⚠ Router ERP vẫn trả
 *                            `success: true` khi proc trả mã khác 0 ⇒ phải lưu riêng để rà.
 *  - loi       {string}
 *  - actorId   {string}
 */
async function ghiLog(maApi, o = {}) {
  try {
    await query(
      `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, CURRENT_TIMESTAMP, $5)`.replace(/\s+/g, ' '),
      [
        TEN_BANG[maApi] || 'erp_api',
        String(o.idBanGhi || '-'),
        o.thanhCong ? maApi : `${maApi}_LOI`,
        JSON.stringify({
          id_mes: o.idMes ?? null,
          ma_tem: o.maTem ?? null,
          url: o.url ?? null,
          thanh_cong: !!o.thanhCong,
          so_lan_thu: o.soLanThu ?? null,
          thoi_gian_ms: o.thoiGianMs ?? null,
          gui: o.gui ?? null,
          nhan: gonPhanHoi(o.nhan),
          // ⚠ 3 khóa dưới nâng từ trong `nhan` ra mức trên cùng để màn Lịch sử đọc thẳng — cùng lý
          //   do đã làm với `id_mes`. Khóa vắng mặt ở dòng CŨ ⇒ bên đọc phải chịu được `null`.
          erp_message: o.erpMessage ?? null,
          erp_error: o.erpError ?? null,
          erp_return_value: o.erpReturnValue ?? null,
          loi: o.loi ?? null,
        }),
        o.actorId || null,
      ]
    );
  } catch (e) {
    console.error(`[erp-api-log] ✗ Không ghi được lịch sử ${maApi}: ${e.message}`);
  }
}

module.exports = { ghiLog, TEN_BANG };
