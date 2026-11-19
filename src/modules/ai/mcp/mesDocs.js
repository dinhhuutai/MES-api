'use strict';

// MCP `mes-docs` — tra kho kiến thức MES (hướng dẫn sử dụng, luật nghiệp vụ, cấu trúc dữ liệu, menu). 19/11/2026.

const kienThuc = require('../kienThuc');
const { jsonGon } = require('./rutGon');

const CONG_CU = [
  {
    name: 'mes_docs_tim',
    description: 'Tìm trong tài liệu MES: hướng dẫn thao tác từng màn, luật nghiệp vụ (READY, Test Run, KCS, giao hàng…), ý nghĩa dữ liệu. Dùng khi người dùng hỏi cách làm, vì sao, quy trình, thuật ngữ.',
    inputSchema: {
      type: 'object',
      properties: {
        tu_khoa: { type: 'string', description: 'Từ khóa tiếng Việt, vd "xác nhận test run ngoài giờ", "in phiếu giao"' },
        nguon: { type: 'string', enum: ['HUONG_DAN', 'LUAT_NGHIEP_VU', 'DU_LIEU'], description: 'Lọc nguồn (tùy chọn)' },
        so_doan: { type: 'integer', description: 'Số đoạn muốn lấy (1–8, mặc định 5)' },
      },
      required: ['tu_khoa'],
    },
    chay: async (a) => {
      const r = kienThuc.tim(a.tu_khoa, { k: Math.min(8, Math.max(1, Number(a.so_doan) || 5)), nguon: a.nguon || null });
      return jsonGon(r);
    },
  },
  {
    name: 'mes_docs_menu',
    description: 'Danh sách màn hình MES (module, tên màn, đường dẫn, quyền cần có). Dùng để chỉ người dùng mở đúng màn bằng link [Tên màn](/duong-dan).',
    inputSchema: {
      type: 'object',
      properties: { tu_khoa: { type: 'string', description: 'Lọc theo tên module / màn (tùy chọn)' } },
    },
    chay: async (a) => {
      const q = kienThuc.boDau(a.tu_khoa || '').trim();
      const ds = kienThuc.dsMenu().filter((m) => !q || kienThuc.boDau(`${m.module} ${m.ten} ${m.route}`).includes(q));
      return jsonGon(ds);
    },
  },
];

module.exports = { CONG_CU };
