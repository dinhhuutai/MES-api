'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// 3 MCP SERVER NỘI BỘ của Agent MES THLA (19/11/2026) — chuẩn Model Context Protocol (SDK chính thức),
// chạy NGAY TRONG backend, nối với client qua InMemoryTransport (không mở cổng mạng nào).
//   mes-docs  tra tài liệu (RAG)                         — mọi người có AI_AGENT
//   mes-web   đọc API website MES bằng JWT người hỏi       — mọi người có AI_AGENT
//   mes-db    đọc PostgreSQL bằng user chỉ đọc             — chỉ AI_AGENT_PHAN_TICH + đã cấu hình AI_DB_USER
// Mỗi câu hỏi mở 1 bộ server gắn NGỮ CẢNH người hỏi (JWT, quyền) rồi đóng ⇒ công cụ không thể đọc lẫn quyền người khác.
// SDK nạp lười: máy chủ quên `npm install` thì chỉ Agent lỗi, không sập cả backend.
// ═════════════════════════════════════════════════════════════════════════════

function dsMayChu(ctx) {
  const ra = [
    { ten: 'mes-docs', congCu: require('./mesDocs').CONG_CU },
    { ten: 'mes-web', congCu: require('./mesWeb').CONG_CU },
  ];
  const mesDb = require('./mesDb');
  if (ctx.phanTich && mesDb.coCauHinh()) ra.push({ ten: 'mes-db', congCu: mesDb.CONG_CU });
  return ra;
}

function ketQuaText(kq) {
  return { content: [{ type: 'text', text: typeof kq === 'string' ? kq : JSON.stringify(kq) }] };
}

/** Mở các MCP server cho 1 lượt hỏi. Trả { congCu, goi(ten, args), dong() }. */
async function moMcp(ctx) {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

  const daMo = [];
  const congCu = [];
  const banDo = new Map();
  for (const mc of dsMayChu(ctx)) {
    const server = new Server({ name: mc.ten, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: mc.congCu.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const cc = mc.congCu.find((c) => c.name === req.params.name);
      if (!cc) return { ...ketQuaText({ loi: `Không có công cụ ${req.params.name}` }), isError: true };
      try {
        return ketQuaText(await cc.chay(req.params.arguments || {}, ctx));
      } catch (e) {
        return { ...ketQuaText({ loi: e.message }), isError: true };
      }
    });
    const [phiaClient, phiaServer] = InMemoryTransport.createLinkedPair();
    await server.connect(phiaServer);
    const client = new Client({ name: 'agent-mes-thla', version: '1.0.0' });
    await client.connect(phiaClient);
    daMo.push({ server, client });
    const { tools } = await client.listTools();
    tools.forEach((t) => { congCu.push({ ...t, mayChu: mc.ten }); banDo.set(t.name, { client, mayChu: mc.ten }); });
  }

  return {
    congCu,
    mayChuCua: (ten) => (banDo.get(ten) || {}).mayChu || null,
    async goi(ten, args) {
      const m = banDo.get(ten);
      if (!m) return { loi: true, text: JSON.stringify({ loi: `Không có công cụ ${ten}` }) };
      const r = await m.client.callTool({ name: ten, arguments: args || {} });
      const text = (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      return { loi: !!r.isError, text };
    },
    async dong() {
      for (const m of daMo) {
        try { await m.client.close(); } catch (_) { /* bỏ qua */ }
        try { await m.server.close(); } catch (_) { /* bỏ qua */ }
      }
    },
  };
}

module.exports = { moMcp };
