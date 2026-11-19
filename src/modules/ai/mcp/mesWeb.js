'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// MCP `mes-web` — AI ĐỌC WEBSITE MES qua chính API của nó (19/11/2026).
// Gọi http://127.0.0.1:<PORT>/api<đường> bằng JWT của NGƯỜI ĐANG HỎI ⇒ quyền của họ áp nguyên vẹn.
// CHỈ GET + chỉ đường trong `danhMucApi.js` (danh sách trắng).
// ═════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const env = require('../../../config/env');
const { DANH_MUC_API, duocPhep } = require('./danhMucApi');
const { jsonGon } = require('./rutGon');

const GOC = `http://127.0.0.1:${env.port}/api`;

function phanTichTruyVan(s) {
  const ra = {};
  String(s || '').replace(/^\?/, '').split('&').forEach((cap) => {
    if (!cap) return;
    const i = cap.indexOf('=');
    const k = decodeURIComponent((i < 0 ? cap : cap.slice(0, i)).trim());
    const v = i < 0 ? '' : decodeURIComponent(cap.slice(i + 1).trim());
    if (/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)) ra[k] = v.slice(0, 200);
  });
  return ra;
}

async function docApi(duongDan, truyVan, ctx) {
  const p = duocPhep(duongDan);
  if (!p) {
    return { loi: `Đường dẫn "${duongDan}" không nằm trong danh mục được đọc. Gọi mes_web_danh_muc để xem các đường được phép.` };
  }
  try {
    const res = await axios.get(GOC + p, {
      params: phanTichTruyVan(truyVan),
      headers: { Authorization: ctx.authorization, 'X-Agent-Mes': '1' },
      timeout: 30000,
      validateStatus: () => true,
    });
    if (res.status === 403) return { loi: 'Người đang hỏi không có quyền xem dữ liệu này trên MES (403).' };
    if (res.status === 404) return { loi: 'Không tìm thấy (404) — kiểm lại id / mã.' };
    if (res.status >= 400) return { loi: `MES trả lỗi ${res.status}: ${res.data && res.data.message ? res.data.message : ''}`.trim() };
    const body = res.data || {};
    return { duong_dan: p, du_lieu: body.data !== undefined ? body.data : body };
  } catch (e) {
    return { loi: `Không gọi được API MES: ${e.code || e.message}` };
  }
}

const CONG_CU = [
  {
    name: 'mes_web_danh_muc',
    description: 'Liệt kê các API ĐỌC của website MES mà bạn được gọi (đường dẫn, ý nghĩa, tham số). Gọi khi chưa biết đường nào chứa số liệu cần.',
    inputSchema: { type: 'object', properties: {} },
    chay: async () => jsonGon(DANH_MUC_API),
  },
  {
    name: 'mes_web_doc',
    description: 'Đọc dữ liệu thật từ website MES (chỉ GET, theo quyền của người đang hỏi). Số liệu ở đây đã được MES tính đúng luật nghiệp vụ — ƯU TIÊN dùng trước SQL.',
    inputSchema: {
      type: 'object',
      properties: {
        duong_dan: { type: 'string', description: 'Đường dẫn trong danh mục, thay :tham_so bằng giá trị thật. Vd /dashboard/sla-tong-quan, /production/bao-cao-ngay' },
        truy_van: { type: 'string', description: 'Tham số dạng query string, vd "ngay=2026-11-18" hoặc "tram=READY&filter=NGHEN". Bỏ trống nếu không cần.' },
      },
      required: ['duong_dan'],
    },
    chay: async (a, ctx) => jsonGon(await docApi(a.duong_dan, a.truy_van, ctx)),
  },
  {
    name: 'mes_web_tra_ma',
    description: 'Tra nhanh 1 mã người dùng đưa (code phần, mã tem, barcode đợt vải / HSKT): ra phần in và tình trạng từng đợt vải (đang ở trạm nào, bao lâu, SLA).',
    inputSchema: {
      type: 'object',
      properties: { ma: { type: 'string', description: 'Mã cần tra' } },
      required: ['ma'],
    },
    chay: async (a, ctx) => {
      const ma = String(a.ma || '').trim();
      if (!ma) return jsonGon({ loi: 'Thiếu mã' });
      const giai = await docApi('/dashboard/tinh-trang/resolve', `code=${encodeURIComponent(ma)}`, ctx);
      if (giai.loi) return jsonGon(giai);
      const kq = giai.du_lieu || {};
      if (!kq.type) return jsonGon({ loi: `Không tìm thấy mã "${ma}" trong MES.` });
      if (kq.type !== 'PHAN_IN') return jsonGon({ loai: kq.type, ...kq });
      const ds = await docApi('/dashboard/tinh-trang/phan-in', `search=${encodeURIComponent(kq.ma_phan)}&limit=10`, ctx);
      if (ds.loi) return jsonGon(ds);
      const items = (ds.du_lieu && ds.du_lieu.items) || [];
      const khop = items.filter((x) => x.ma_phan === kq.ma_phan);
      if (!khop.length) return jsonGon({ loai: 'PHAN_IN', ma_phan: kq.ma_phan, ghi_chu: 'Không đọc được tình trạng chi tiết' });
      const chiTiet = [];
      for (const pin of khop.slice(0, 3)) {
        const ct = await docApi(`/dashboard/tinh-trang/phan-in/${pin.id}`, '', ctx);
        chiTiet.push({ phan_in: pin, tinh_trang: ct.loi ? { loi: ct.loi } : ct.du_lieu });
      }
      return jsonGon({ loai: 'PHAN_IN', ma_phan: kq.ma_phan, so_phan_in: khop.length, chi_tiet: chiTiet });
    },
  },
];

module.exports = { CONG_CU };
