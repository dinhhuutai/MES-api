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
const { taoIdKetNoi, idTuBody } = require('./idKetNoi');
const { ngayGioErp } = require('./erpNgayGio');

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
// ⚠⚠ Dạng '…T09:30:00.000Z' = GIỜ VN dán nhãn Z (02/10/2026 — router `/gui-erp-phieu-giao` `new Date(v)` và
//   `/gui-erp-phan-loai-loi` đưa thẳng chuỗi vào `sql.DateTime` ⇒ chuỗi giờ VN bị LÙI 7 tiếng). Xem `utils/erpNgayGio.js`.
const ngayGio = (v) => ngayGioErp(v, 'Z');

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

// Gọi có retry + ghi vết. KHÔNG NÉM LỖI — luôn trả { ok, data?, error?, bo_qua?, id_ket_noi }.
// ⚠⚠ ID KẾT NỐI (27/09/2026): mọi dòng lịch sử PHẢI có — trước đây 3 API qua hàm này không ghi `id_mes`
//   nên cột ID của *Cài đặt API › Lịch sử* trống (phiếu giao, phân loại lỗi, lấy ID phiếu giao).
//   Thứ tự: `idKetNoi` truyền vào → ID trong body (IDMES/IDMes/IDKetNoi) → `layIdTuPhanHoi(data)` → ID sinh mới.
//   ⚠ Từ 30/09/2026 ID kết nối LUÔN do MES tạo — không lấy mã ERP cấp (số phiếu / mã tem) làm ID kết nối.
// `maTem` (tùy chọn) = mã hiện ở cột "Mã" của Lịch sử và tìm được bằng ô tìm (vd danh sách mã lệnh của
//   API Release 1). Không truyền ⇒ như cũ (cột lấy từ `gui.BarcodeIn`/`IDPhieuGiao`).
async function goiErp(maApi, {
  nhan, url, method = 'POST', body = null, timeoutMs, retry, idBanGhi, moTa, actorId,
  idKetNoi = null, layIdTuPhanHoi = null, maTem = null,
}) {
  const idCoSan = idKetNoi || idTuBody(body);
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
      const idKn = idCoSan || (layIdTuPhanHoi && layIdTuPhanHoi(data)) || taoIdKetNoi();
      await ghiLog(maApi, {
        thanhCong: true, idBanGhi: idBanGhi || '-', idMes: idKn, maTem, url, soLanThu: i, thoiGianMs: Date.now() - batDau,
        gui: method === 'POST' ? body : null, nhan: data,
        erpMessage: data && data.message, erpReturnValue: data && data.returnValue, actorId,
      });
      return { ok: true, data, id_ket_noi: idKn };
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
  const idKn = idCoSan || taoIdKetNoi();
  await ghiLog(maApi, {
    thanhCong: false, idBanGhi: idBanGhi || '-', idMes: idKn, maTem, url, soLanThu: soLan, thoiGianMs: Date.now() - batDau,
    gui: method === 'POST' ? body : null, nhan: ph,
    erpMessage: ph && ph.message, erpError: ph && ph.error, erpReturnValue: ph && ph.returnValue,
    loi: error, actorId,
  });
  return { ok: false, error, id_ket_noi: idKn };
}

// ─── 2 CHUỖI DANH SÁCH GỬI ERP ───────────────────────────────────────────────
// Proc `MES2SU6` / `MES2SQ0` chỉ nhận MỘT chuỗi cho toàn bộ chi tiết (không có tham số số lượng),
// nên định dạng 2 chuỗi này LÀ hợp đồng dữ liệu — đặt ở đây để chỉ có 1 nguồn, sửa 1 chỗ.

// `DsMaloi` = các BỘ BA `mã lỗi, SL SỬA, SL HỦY` nối tiếp, ngăn bằng dấu phẩy:
//   `L1,2,0,L3,5,1` = lỗi L1 sửa 2 hủy 0; lỗi L3 sửa 5 hủy 1. Ví dụ thật: KCS hư 24 → phân loại
//   20 sửa + 4 hủy ⇒ `HA1,20,4` (KHÔNG phải `HA1,24,4`).
// ⚠⚠ ĐỔI LẠI 30/09/2026 (người dùng chốt: số giữa = SL SỬA). Lịch sử: 16/09 gửi SL sửa → 26/09 đổi sang
//   TỔNG HƯ vì SP `MES_spr_MES2SU6` lúc đó tính `SoluongSuaNhe = Soluong − SoluongHuy` → 30/09 về lại SL sửa.
//   ⚠ Nếu proc ERP VẪN còn phép trừ đó thì ERP sẽ ghi SL sửa = sửa − hủy (vd 16 thay vì 20) — phải để
//   bên ERP bỏ phép trừ, ĐỪNG sửa lại ở đây mà không hỏi người dùng.
// ⚠ Bỏ dòng KHÔNG có mã lỗi: gửi ô rỗng làm LỆCH VỊ TRÍ mọi bộ ba phía sau (ERP đọc sai toàn bộ).
// ⚠ Mã lỗi chứa dấu phẩy sẽ phá cấu trúc ⇒ thay bằng khoảng trắng (đo prod: không mã nào có dấu phẩy).
function dsMaLoi(dong = []) {
  return dong
    .filter((d) => d && d.ma_loi)
    .map((d) => {
      const sua = Number(d.so_luong_sua) || 0;
      const huy = Number(d.so_luong_huy) || 0;
      return [String(d.ma_loi).replace(/,/g, ' ').trim(), sua, huy].join(',');
    })
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
// ERP có thể đặt tên khóa khác nhau — nhận mọi biến thể hay gặp rồi mới chịu thua.
function idPhieuTuPhanHoi(d) {
  const x = d || {};
  const id = x.id ?? x.ID ?? x.idPhieuGiao ?? x.IDPhieuGiao ?? x.ma_phieu_giao ?? x.maPhieuGiao ?? x.barcode ?? x.data;
  const s = id == null || typeof id === 'object' ? '' : String(id).trim();
  return s || null;
}

async function layIdPhieuGiao(actorId = null) {
  // ⚠⚠ ID KẾT NỐI = mã MES SINH (30/09/2026), KHÔNG lấy số phiếu ERP cấp; gửi kèm query `IDKetNoi`.
  //   Số phiếu ERP cấp vẫn nằm trong `nhan` của dòng lịch sử.
  const idKn = taoIdKetNoi('IDPG');
  const goc = env.erp.layIdPhieuGiaoUrl;
  const url = goc ? `${goc}${goc.includes('?') ? '&' : '?'}IDKetNoi=${encodeURIComponent(idKn)}` : goc;
  const kq = await goiErp('ERP_LAY_ID_PHIEU_GIAO', {
    nhan: 'lay-id-phieu-giao',
    url,
    method: 'GET',
    timeoutMs: env.erp.layIdPhieuGiaoTimeoutMs,
    retry: env.erp.layIdPhieuGiaoRetry,
    actorId,
    idKetNoi: idKn,
  });
  if (!kq.ok) return null;
  const s = idPhieuTuPhanHoi(kq.data) || '';
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
// ⚠⚠ ID KẾT NỐI = `IDMES` do MES CẤP (30/09/2026, người dùng chốt: ID kết nối là mã DUY NHẤT MES tạo ra,
//   KHÔNG lấy mã phiếu giao do ERP cấp). Gửi ở khóa `IDMES` ⇒ router ERP truyền vào `@pIDMES` (ERP đang
//   bổ sung); `goiErp` cũng rút khóa này làm ID kết nối cho lịch sử.
async function guiPhieuGiao(payload, { giaoHangId = null, actorId = null } = {}) {
  const body = {
    IDMES: payload.IDMES != null ? payload.IDMES : null,
    IDPhieuGiao: catChuoi(payload.IDPhieuGiao, 20),
    Ngayct: ngayGio(payload.Ngayct),
    user: catChuoi(payload.user, 20),
    DsTemGiao: catChuoi(payload.DsTemGiao, 4000),
  };
  // ⚠⚠ `@pID` CỦA PROC `MES2SQ0` = MÃ PHIẾU GIAO (người dùng chốt lại 30/09/2026). Gửi kèm `ID` + `pID` cùng
  //   giá trị `IDPhieuGiao` để router ERP đọc tên nào cũng nhận được (lỗi cũ "@pID was not supplied" là do
  //   router khai `pIDPhieuGiao`). ID KẾT NỐI đi ở khóa RIÊNG `IDMES` — router ERP bổ sung
  //   `request.input('pIDMES', …)` đọc `req.body.IDMES`. Khóa thừa router bỏ qua, vô hại.
  body.ID = body.IDPhieuGiao;
  body.pID = body.IDPhieuGiao;
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

// ─── 4. BÁO ERP DANH SÁCH CODE PHẦN GN HỦY VẢI (27/09/2026) ─────────────────────
// Router ERP `/gui-ds-huy-vai` → proc `SX_spr_DSPhieuNhanvaiReadyHuy`. Body:
//   `DsPhan`   NVARCHAR(4000) — code phần ngăn bằng dấu phẩy, không khoảng trắng (khuôn `@pDsPhan` của
//              `SX_spr_DSPhieuNhanvaiReady`, cùng họ proc).
//   `IDKetNoi` NVARCHAR(50)   — ID kết nối của lượt (truy vết 2 bên); router bỏ qua cũng không sao.
// ⚠ KHÔNG ném lỗi — trả kết quả để bên gọi báo cho người bấm (nút Hủy vải đang chờ).
async function guiDsHuyVai(dsPhan, { actorId = null, idKetNoi = null } = {}) {
  const ds = [...new Set((dsPhan || []).map((x) => String(x || '').trim().replace(/,/g, ' ')).filter(Boolean))];
  if (!ds.length) return { ok: false, bo_qua: true, ly_do: 'THIEU_DU_LIEU' };
  // ⚠ Chia LÔ ≤ 4000 ký tự thay vì `catChuoi` — cắt cụt sẽ xé đôi 1 code phần và ERP hủy nhầm/sót mã.
  const lo = [];
  let cur = [];
  for (const m of ds) {
    if (cur.length && [...cur, m].join(',').length > 4000) { lo.push(cur); cur = []; }
    cur.push(m);
  }
  if (cur.length) lo.push(cur);
  const ketQua = [];
  for (let i = 0; i < lo.length; i += 1) {
    const id = idKetNoi && lo.length === 1 ? idKetNoi : taoIdKetNoi('HV');
    const body = { DsPhan: lo[i].join(','), IDKetNoi: id };
    // eslint-disable-next-line no-await-in-loop
    const kq = await goiErp('ERP_GUI_DS_HUY_VAI', {
      nhan: 'gui-ds-huy-vai',
      url: env.erp.guiDsHuyVaiUrl,
      method: 'POST',
      body,
      timeoutMs: env.erp.guiDsHuyVaiTimeoutMs,
      retry: env.erp.guiDsHuyVaiRetry,
      moTa: `${lo[i].length} code phần`,
      actorId,
    });
    ketQua.push(kq);
    if (kq.bo_qua) break; // API đang tắt — các lô sau cũng vậy
  }
  const loi = ketQua.filter((k) => !k.ok && !k.bo_qua);
  return {
    ok: ketQua.every((k) => k.ok),
    bo_qua: ketQua.some((k) => k.bo_qua),
    error: loi.length ? loi.map((k) => k.error).join(' | ') : undefined,
    id_ket_noi: ketQua.map((k) => k.id_ket_noi).filter(Boolean).join(', '),
    so_ma: ds.length,
  };
}

module.exports = {
  layIdPhieuGiao, guiPhieuGiao, guiPhanLoaiLoi, guiDsHuyVai, goiErp,
  tenDangNhap, catChuoi, ngayGio, dsMaLoi, dsTemGiao,
};
