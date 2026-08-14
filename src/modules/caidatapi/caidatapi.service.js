'use strict';

const axios = require('axios');
const repo = require('./caidatapi.repository');
const AppError = require('../../utils/AppError');
const env = require('../../config/env');
const { MA_HOP_LE, DANH_MUC_API, tachCodePhan, xoaCache, danhSachCauHinh, urlCua } = require('../../utils/caiDatApi');

// Danh sách API + trạng thái bật/tắt + URL đang gọi + người/giờ sửa gần nhất.
async function danhSach() {
  const [ds, sua] = await Promise.all([danhSachCauHinh(), thongTinSuaAnToan()]);
  const theoMa = new Map(sua.map((r) => [r.ma_api, r]));
  return ds.map((x) => {
    const s = theoMa.get(x.ma) || {};
    return { ...x, ghi_chu: s.ghi_chu || null, nguoi_sua: s.nguoi || null, tg_sua: s.updated_date || null };
  });
}

// Thiếu bảng (chưa chạy mig 083) thì vẫn mở được trang — chỉ không có thông tin người sửa.
async function thongTinSuaAnToan() {
  try { return await repo.thongTinSua(); } catch { return []; }
}

// Lưu nhiều dòng 1 lượt. Mã lạ bị bỏ qua (danh mục nằm ở code, không tin dữ liệu từ client).
async function luu(items, actorId) {
  const ds = (Array.isArray(items) ? items : []).filter((x) => x && MA_HOP_LE.has(x.ma));
  if (!ds.length) throw new AppError('Không có mục hợp lệ để lưu', { status: 422, errorCode: 'EMPTY' });
  // ⚠ Chuẩn hóa danh sách code phần NGAY LÚC LƯU (bỏ dòng trống, viết HOA, mỗi mã 1 dòng) — để
  //   người dùng dán từ Excel vào cũng khớp, và người sau mở ra thấy đúng thứ đã có hiệu lực.
  //   Chỉ API nào khai `loc_code_phan` mới lưu; API khác luôn ghi null (tránh dữ liệu rác).
  for (const it of ds) {
    const meta = DANH_MUC_API.find((x) => x.ma === it.ma);
    const codePhan = meta && meta.loc_code_phan ? tachCodePhan(it.code_phan).join('\n') : null;
    await repo.luu({ ma: it.ma, bat: it.bat, ghiChu: it.ghi_chu, codePhan }, actorId);
  }
  xoaCache(); // có hiệu lực NGAY, không chờ hết TTL 30s
  return danhSach();
}

// ⚠⚠ THỬ KẾT NỐI = CHỈ KIỂM TỚI ĐƯỢC MÁY CHỦ ERP HAY KHÔNG — cố ý KHÔNG gọi vào endpoint nghiệp vụ:
//   · `/barcode-tem` mỗi lần gọi là **TIÊU MỘT MÃ TEM** của ERP (thủng dãy số vì mã đó không dùng);
//   · `/ghi-in-tem` gọi thử sẽ **ghi một bản ghi rác** vào ERP;
//   · `/phieu-nhan-vai-60` chạy proc rất nặng (timeout mặc định 10 phút).
//   Mà thứ cần biết đúng là "có ra tới host không" — đúng sự cố 11/08/2026 (gọi nhầm host LAN,
//   đồng bộ vẫn xanh mà lấy mã tem thì timeout). Bất kỳ phản hồi HTTP nào (kể cả 404) = mạng thông.
async function thuKetNoi(ma) {
  if (!MA_HOP_LE.has(ma)) throw new AppError('API không hợp lệ', { status: 400, errorCode: 'INVALID' });
  const url = urlCua(ma);
  if (!url) throw new AppError('API này chưa cấu hình URL', { status: 422, errorCode: 'NO_URL' });

  let goc;
  try { goc = new URL(url).origin; }
  catch { throw new AppError(`URL không hợp lệ: ${url}`, { status: 422, errorCode: 'BAD_URL' }); }

  const t0 = Date.now();
  try {
    const res = await axios.get(goc, {
      timeout: 8000,
      proxy: erpProxy(),
      validateStatus: () => true, // 404/401 vẫn là "tới được máy chủ"
      headers: { ...(env.erp.apiHeaders || {}) },
    });
    return {
      ok: true, url, goc, http: res.status, ms: Date.now() - t0,
      thong_diep: `Tới được máy chủ ERP (HTTP ${res.status}) sau ${Date.now() - t0}ms`,
    };
  } catch (e) {
    return {
      ok: false, url, goc, ms: Date.now() - t0,
      thong_diep: `KHÔNG tới được ${goc}: ${e.message}`,
    };
  }
}

function erpProxy() {
  if (!env.erp.proxyUrl) return undefined;
  try {
    const u = new URL(env.erp.proxyUrl);
    return { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') };
  } catch { return undefined; }
}

module.exports = { danhSach, luu, thuKetNoi };
