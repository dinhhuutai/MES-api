'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// HELPER GỌI ERP DÙNG CHUNG cho 3 API thêm ngày 04/09/2026:
//   · `ERP_LAY_ID_PHIEU_GIAO`  (GET)  — xin số phiếu giao do ERP cấp
//   · `ERP_GUI_PHIEU_GIAO`     (POST) — đẩy nội dung phiếu giao sang ERP
//   · `ERP_GUI_PHAN_LOAI_LOI`  (POST) — đẩy phiếu phân loại lỗi sang ERP
//
// VÌ SAO GOM 1 FILE: 3 API cùng một khuôn (đọc cờ bật/tắt ở *Cài đặt API* → gọi có retry+backoff →
// ghi vết vào `audit_log` để trang Lịch sử đọc được). Chép 3 bản như `erpTemBarcode`/`erpGhiInTem`
// là 3 chỗ phải sửa mỗi khi đổi luật.
//
// ⚠⚠ HAI KIỂU HÀNH XỬ KHI LỖI — ĐỪNG DÙNG NHẦM (bài học từ 2 API cũ):
//   · **CHIỀU XIN SỐ** (`layIdPhieuGiao`): mỗi lần gọi TIÊU MỘT SỐ của ERP. Lỗi ⇒ **trả `null`** để
//     bên gọi tự quyết (ở đây: lùi về mã phiếu MES tự sinh). CỐ Ý KHÔNG ném lỗi chặn việc giao hàng —
//     khác `erpTemBarcode` (chặn in tem) vì tem là thứ ERP BẮT BUỘC quét, còn số phiếu giao thì không.
//   · **CHIỀU ĐẨY** (`guiPhieuGiao` / `guiPhanLoaiLoi`): **KHÔNG BAO GIỜ ném lỗi ra ngoài** và bên gọi
//     KHÔNG `await` — nghiệp vụ đã ghi xong vào MES rồi, ERP chỉ là bên nhận tin. Timeout 10s × 3 lần
//     ⇒ xấu nhất ~33s, chặn response từng ấy là hỏng thao tác của người dùng.
//
// ⚠ URL mặc định SUY TỪ HOST của API đồng bộ (`config/env.js`) — đừng hardcode host (sự cố 11/08/2026).
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const env = require('../config/env');
const { query } = require('../config/db');
const { apiBat } = require('./caiDatApi');
const { ghiLog } = require('./erpApiLog');
const { maTemNhan } = require('./temPrefix');

// ─── CHUẨN HÓA GIÁ TRỊ GỬI ERP ───────────────────────────────────────────────
// ⚠ Cắt đúng độ dài tham số của proc (`NVARCHAR(20)` / `NVARCHAR(4000)`): tedious KHÔNG tự cắt,
//   chuỗi dài hơn làm proc ăn lỗi khó đọc ("String or binary data would be truncated" — đã gặp thật
//   với `ghi-in-tem` ngày 14/08/2026).
// ⚠ Chuỗi thiếu → `''` (KHÔNG `null`) để proc khỏi phải `ISNULL` từng chỗ — cùng quy ước `erpGhiInTem`.
//   RIÊNG trường ngày giờ (`sql.DateTime`) thì thiếu phải để `null`: chuỗi rỗng làm tedious ném lỗi
//   chuyển kiểu và HỎNG CẢ LƯỢT GỌI.
const catChuoi = (v, max) => {
  if (v == null) return '';
  const s = String(v).trim();
  return max && s.length > max ? s.slice(0, max) : s;
};
const ngayGio = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};

// `nhanvien` / `user` bên ERP là MÃ NHÂN VIÊN — trùng với `ten_dang_nhap` của MES (ERP tạo tài khoản
// theo mã nhân viên, vd `011600486`). ⚠ KHÔNG gửi `ho_ten`: cột ERP chỉ `NVARCHAR(20)` và họ tên
// tiếng Việt vừa dài vừa trùng nhau.
// ⚠ Lỗi đọc DB ⇒ trả `''`, TUYỆT ĐỐI không ném: đây là chiều đẩy chạy ngầm.
async function tenDangNhap(actorId) {
  if (!actorId) return '';
  try {
    const { rows } = await query('SELECT ten_dang_nhap FROM nguoi_dung WHERE id = $1', [actorId]);
    return catChuoi(rows[0] && rows[0].ten_dang_nhap, 20);
  } catch (e) {
    console.error(`[erp] ✗ Không đọc được tên đăng nhập của người thao tác: ${e.message}`);
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Proxy giống hệt `erpTemBarcode`/`erpGhiInTem` — undefined thì axios tự đọc HTTP_PROXY env.
function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

// 1 lượt gọi. Ném lỗi CÓ ĐÍNH phản hồi ERP (`e.phanHoi`) để bên trên lưu được "gửi gì → nhận gì"
// kể cả ở nhánh lỗi — đúng bài học 19/08/2026 với `ghi-in-tem`.
async function goiMotLan({ nhan, url, method, body, timeoutMs }) {
  console.log(`[${nhan}] → ${method} ${url}`);
  const res = await axios({
    method,
    url,
    data: method === 'POST' ? body : undefined,
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(env.erp.apiHeaders || {}) },
    proxy: erpProxy(),
    validateStatus: () => true,
  });
  const data = typeof res.data === 'string' ? safeJson(res.data) : res.data;
  const kem = (msg) => {
    const e = new Error(msg);
    e.phanHoi = data ?? res.data ?? null;
    e.httpStatus = res.status;
    return e;
  };
  if (res.status < 200 || res.status >= 300) {
    const chiTiet = data && (data.error || data.message)
      ? `${data.message || ''}${data.error ? ` — ${data.error}` : ''}`.trim()
      : String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {})).slice(0, 300);
    throw kem(`ERP trả về HTTP ${res.status}${chiTiet ? ` — ${chiTiet}` : ''}`);
  }
  if (data && data.success === false) {
    throw kem(`${data.message || 'ERP trả về success=false'}${data.error ? ` — ${data.error}` : ''}`);
  }
  // ⚠ `returnValue` = mã RETURN của stored procedure, KHÔNG phải HTTP status: proc chạy xong mà trả
  //   mã ≠ 0 (lỗi nghiệp vụ) thì router ERP VẪN trả success=true. Lưu lại + cảnh báo, cố ý không ném
  //   (chưa biết bảng mã của proc, ném bừa sẽ chặn nghiệp vụ vì một mã có thể hoàn toàn bình thường).
  if (data && data.returnValue != null && Number(data.returnValue) !== 0) {
    console.warn(`[${nhan}] ⚠ ERP nhận nhưng proc trả returnValue=${data.returnValue} — kiểm ở Hệ thống > Cài đặt API > Lịch sử`);
  }
  return data || {};
}

// Gọi có retry + ghi vết. KHÔNG NÉM LỖI — luôn trả { ok, data?, error?, bo_qua? }.
async function goiErp(maApi, { nhan, url, method = 'POST', body = null, timeoutMs, retry, idBanGhi, moTa, actorId }) {
  if (!(await apiBat(maApi))) {
    console.log(`[${nhan}] ⏸ ĐANG TẮT (Hệ thống > Cài đặt API) — bỏ qua${moTa ? ` ${moTa}` : ''}`);
    return { ok: false, bo_qua: true };
  }
  const soLan = Math.max(1, Number(retry) || 1);
  const batDau = Date.now();
  let loiCuoi;
  for (let i = 1; i <= soLan; i += 1) {
    try {
      const data = await goiMotLan({ nhan, url, method, body, timeoutMs });
      await ghiLog(maApi, {
        thanhCong: true, idBanGhi: idBanGhi || '-', url, soLanThu: i, thoiGianMs: Date.now() - batDau,
        gui: method === 'POST' ? body : null, nhan: data,
        erpMessage: data && data.message, erpReturnValue: data && data.returnValue, actorId,
      });
      return { ok: true, data };
    } catch (e) {
      loiCuoi = e;
      if (i < soLan) {
        const cho = 1000 * i;
        console.warn(`[${nhan}] ⟳ lỗi (lần ${i}/${soLan}), thử lại sau ${cho / 1000}s: ${e.message}`);
        await sleep(cho);
      }
    }
  }
  const ph = loiCuoi && loiCuoi.phanHoi;
  const error = `${loiCuoi && loiCuoi.message} (${url})`;
  console.error(`[${nhan}] ✗ Thất bại sau ${soLan} lần${moTa ? ` — ${moTa}` : ''}: ${error}`);
  await ghiLog(maApi, {
    thanhCong: false, idBanGhi: idBanGhi || '-', url, soLanThu: soLan, thoiGianMs: Date.now() - batDau,
    gui: method === 'POST' ? body : null, nhan: ph,
    erpMessage: ph && ph.message, erpError: ph && ph.error, erpReturnValue: ph && ph.returnValue,
    loi: error, actorId,
  });
  return { ok: false, error };
}

// ─── 2 CHUỖI DANH SÁCH GỬI ERP ───────────────────────────────────────────────
// Proc `MES2SU6` / `MES2SQ0` chỉ nhận MỘT chuỗi cho toàn bộ chi tiết (không có tham số số lượng),
// nên định dạng 2 chuỗi này LÀ hợp đồng dữ liệu — đặt ở đây để chỉ có 1 nguồn, sửa 1 chỗ.

// `DsMaloi` = các BỘ BA `mã lỗi, SL sửa, SL hủy` nối tiếp, ngăn bằng dấu phẩy (người dùng chốt
// 16/09/2026): `L1,2,0,L3,5,1` = lỗi L1 sửa 2 / hủy 0; lỗi L3 sửa 5 / hủy 1.
// ⚠⚠ Số GIỮA = SL ĐEM SỬA, **KHÔNG gồm phần hủy** ⇒ tổng hư của một mã = số giữa + số cuối.
// ⚠ Bỏ dòng KHÔNG có mã lỗi: gửi ô rỗng làm LỆCH VỊ TRÍ mọi bộ ba phía sau (ERP đọc sai toàn bộ).
// ⚠ Mã lỗi chứa dấu phẩy sẽ phá cấu trúc ⇒ thay bằng khoảng trắng (đo prod: không mã nào có dấu phẩy).
function dsMaLoi(dong = []) {
  return dong
    .filter((d) => d && d.ma_loi)
    .map((d) => [String(d.ma_loi).replace(/,/g, ' ').trim(),
      Number(d.so_luong_sua) || 0, Number(d.so_luong_huy) || 0].join(','))
    .join(',');
}

// `DsTemGiao` = DANH SÁCH MÃ TEM ngăn bằng dấu phẩy (người dùng chốt 16/09/2026 — ERP tự tra SL).
// ⚠⚠ GỬI ĐÚNG MÃ IN TRÊN NHÃN: nguồn SỬA → `17…`, nguồn KCS → `15…`, tem gia công đã mang `13…`
//   thì GIỮ NGUYÊN (`maTemNhan`). Ghép tiền tố bừa lên tem 13 ra mã KHÔNG CÓ THẬT, ERP quét không ra.
function dsTemGiao(tems = []) {
  const ds = (tems || [])
    .map((t) => maTemNhan(t.ma_tem, t.nguon === 'SUA' ? 17 : 15, null, t.la_tem_sua))
    .filter(Boolean);
  return [...new Set(ds)].join(',');
}

// ─── 1. XIN ID PHIẾU GIAO ────────────────────────────────────────────────────
// Trả CHUỖI id do ERP cấp, hoặc `null` khi tắt / lỗi (bên gọi lùi về mã MES tự sinh).
// ⚠ Mỗi lần gọi TIÊU MỘT SỐ ⇒ chỉ gọi khi THẬT SỰ tạo phiếu giao, và gọi TRƯỚC transaction
//   (gọi HTTP bên trong transaction sẽ giữ khóa bảng suốt thời gian chờ mạng).
async function layIdPhieuGiao(actorId = null) {
  const kq = await goiErp('ERP_LAY_ID_PHIEU_GIAO', {
    nhan: 'lay-id-phieu-giao',
    url: env.erp.layIdPhieuGiaoUrl,
    method: 'GET',
    timeoutMs: env.erp.layIdPhieuGiaoTimeoutMs,
    retry: env.erp.layIdPhieuGiaoRetry,
    actorId,
  });
  if (!kq.ok) return null;
  const d = kq.data || {};
  // ERP có thể đặt tên khóa khác nhau — nhận mọi biến thể hay gặp rồi mới chịu thua.
  const id = d.id ?? d.ID ?? d.idPhieuGiao ?? d.IDPhieuGiao ?? d.ma_phieu_giao ?? d.maPhieuGiao ?? d.barcode ?? d.data;
  const s = id == null ? '' : String(id).trim();
  if (!s) {
    console.warn('[lay-id-phieu-giao] ⚠ ERP trả về thành công nhưng không có id — dùng mã MES tự sinh');
    return null;
  }
  return s;
}

// ─── 2. ĐẨY PHIẾU GIAO ───────────────────────────────────────────────────────
// Hợp đồng proc `MES_spr_MES2SQ0` — ĐÚNG 4 tham số, tên phân biệt HOA/thường:
//   pIDPhieuGiao NVARCHAR(20) · pNgayct DATETIME · puser NVARCHAR(20) · pDsTemGiao NVARCHAR(4000)
// ⚠⚠ Router ERP destructure `{ IDPhieuGiao, Ngayct, user, DsTemGiao }` từ body ⇒ gửi SAI TÊN là
//   4 tham số đều `undefined` → tedious gửi NULL → proc chạy xong, trả `success:true`, NHƯNG KHÔNG
//   GHI GÌ. Hỏng hoàn toàn im lặng, không lỗi nào hiện ra. Sửa tên trường phải đối chiếu router ERP.
// `idBanGhi` = giao_hang.id để dòng lịch sử liên kết được với phiếu.
async function guiPhieuGiao(payload, { giaoHangId = null, actorId = null } = {}) {
  const body = {
    IDPhieuGiao: catChuoi(payload.IDPhieuGiao, 20),
    Ngayct: ngayGio(payload.Ngayct),
    user: catChuoi(payload.user, 20),
    DsTemGiao: catChuoi(payload.DsTemGiao, 4000),
  };
  return goiErp('ERP_GUI_PHIEU_GIAO', {
    nhan: 'gui-erp-phieu-giao',
    url: env.erp.guiPhieuGiaoUrl,
    method: 'POST',
    body,
    timeoutMs: env.erp.guiPhieuGiaoTimeoutMs,
    retry: env.erp.guiPhieuGiaoRetry,
    idBanGhi: giaoHangId,
    moTa: body.IDPhieuGiao ? `phiếu ${body.IDPhieuGiao}` : null,
    actorId,
  });
}

// ─── 3. ĐẨY PHÂN LOẠI LỖI ────────────────────────────────────────────────────
// Hợp đồng proc `MES_spr_MES2SU6` — ĐÚNG 5 tham số:
//   pIDMes NVARCHAR(20) · pNgayct DATETIME · pnhanvien NVARCHAR(20) · pMaquet NVARCHAR(20)
//   · pDsMaloi NVARCHAR(4000)
// ⚠⚠ Cùng bẫy "sai tên = NULL im lặng" như `guiPhieuGiao` ở trên. Chú ý `IDMes` viết HOA **ID** rồi
//   thường **es** (khác `IDMES` của `ghi-in-tem`), và `nhanvien`/`user` viết THƯỜNG.
// ⚠ Proc KHÔNG có tham số số lượng nào ⇒ mọi thông tin SL nằm trong chuỗi `DsMaloi` (xem `dsMaLoi`).
async function guiPhanLoaiLoi(payload, { temId = null, actorId = null } = {}) {
  const body = {
    IDMes: catChuoi(payload.IDMes, 20),
    Ngayct: ngayGio(payload.Ngayct),
    nhanvien: catChuoi(payload.nhanvien, 20),
    Maquet: catChuoi(payload.Maquet, 20),
    DsMaloi: catChuoi(payload.DsMaloi, 4000),
  };
  return goiErp('ERP_GUI_PHAN_LOAI_LOI', {
    nhan: 'gui-erp-phan-loai-loi',
    url: env.erp.guiPhanLoaiLoiUrl,
    method: 'POST',
    body,
    timeoutMs: env.erp.guiPhanLoaiLoiTimeoutMs,
    retry: env.erp.guiPhanLoaiLoiRetry,
    idBanGhi: temId,
    moTa: body.Maquet ? `tem ${body.Maquet}` : null,
    actorId,
  });
}

module.exports = {
  layIdPhieuGiao, guiPhieuGiao, guiPhanLoaiLoi, goiErp,
  tenDangNhap, catChuoi, ngayGio, dsMaLoi, dsTemGiao,
};
