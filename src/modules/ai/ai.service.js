'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// AGENT MES THLA — nghiệp vụ hỏi đáp (19/11/2026). Chỉ ĐỌC dữ liệu MES; ghi duy nhất nhật ký hỏi đáp của chính người hỏi.
// ═════════════════════════════════════════════════════════════════════════════

const AppError = require('../../utils/AppError');
const { query } = require('../../config/db');
const repo = require('./ai.repository');
const { cauHinhAi } = require('./ai.config');
const { quyenAiCua } = require('./quyenAi');
const { heThong } = require('./heThong');
const kienThuc = require('./kienThuc');
const gemini = require('./gemini');
const { moMcp } = require('./mcp/mcpNoiBo');

// Mẫu robot mỗi người tự chọn ở Thông tin cá nhân (gương FE `features/ai-agent/robot.js MAU_ROBOT`).
const MAU_ROBOT = ['VANG_NANG', 'VANG_KEM'];
const MAU_MAC_DINH = 'VANG_NANG';

// Chặn tải: tối đa 1 câu đang chạy / người, 4 câu / toàn máy chủ (máy chủ chỉ chịu ~4 truy vấn nặng song song).
const DANG_CHAY = new Set();
const TOI_DA_DONG_THOI = 4;

function lyDoTat(cfg, coBang) {
  if (!coBang) return 'Chưa chạy migration 138 (bảng nhật ký AI).';
  if (!cfg.bat) return 'Agent đang tắt (AI_BAT=0 trong backend/.env).';
  if (!cfg.daCauHinh) return 'Chưa cấu hình model hoặc API key (AI_MODEL, GEMINI_API_KEY).';
  return null;
}

async function trangThai(user) {
  const cfg = cauHinhAi();
  const q = await quyenAiCua(user.id);
  const coBang = await repo.coBangAi();
  const [daHoi, mau] = q.dung && coBang
    ? await Promise.all([repo.demCauHoiHomNay(user.id), repo.layMauRobot(user.id)])
    : [0, null];
  return {
    co_quyen: q.dung,
    mau_robot: MAU_ROBOT.includes(mau) ? mau : MAU_MAC_DINH,
    phan_tich: q.phanTich,
    san_sang: q.dung && !lyDoTat(cfg, coBang),
    ly_do_tat: q.dung ? lyDoTat(cfg, coBang) : null,
    nha_cung_cap: cfg.nhaCungCap,
    model: cfg.model || null,
    gioi_han_ngay: cfg.gioiHanNgay,
    da_hoi_hom_nay: daHoi,
    con_lai: Math.max(0, cfg.gioiHanNgay - daHoi),
    doc_database: q.phanTich && require('./mcp/mesDb').coCauHinh(),
    kho_kien_thuc: kienThuc.thongTinKho().so_doan,
  };
}

async function hoTenCua(userId) {
  const { rows } = await query('SELECT ho_ten FROM nguoi_dung WHERE id = $1', [userId]);
  return rows[0] ? rows[0].ho_ten : null;
}

async function hoi(req, body = {}) {
  const user = req.user;
  const cauHoi = String(body.cau_hoi || '').trim();
  if (!cauHoi) throw new AppError('Chưa nhập câu hỏi', { status: 422, errorCode: 'THIEU_CAU_HOI' });
  if (cauHoi.length > 2000) throw new AppError('Câu hỏi dài quá 2.000 ký tự', { status: 422, errorCode: 'CAU_HOI_QUA_DAI' });

  const cfg = cauHinhAi();
  const coBang = await repo.coBangAi();
  const tat = lyDoTat(cfg, coBang);
  if (tat) throw new AppError(tat, { status: coBang ? 503 : 409, errorCode: coBang ? 'AI_DANG_TAT' : 'CHUA_MIGRATION_138' });

  const daHoi = await repo.demCauHoiHomNay(user.id);
  if (daHoi >= cfg.gioiHanNgay) {
    throw new AppError(`Hôm nay anh/chị đã hỏi đủ ${cfg.gioiHanNgay} câu (hạn mức mỗi người mỗi ngày). Mai hỏi tiếp nhé.`,
      { status: 429, errorCode: 'AI_HET_LUOT_NGAY' });
  }
  if (DANG_CHAY.has(user.id)) {
    throw new AppError('Câu trước của anh/chị chưa trả lời xong, đợi một chút nhé.', { status: 429, errorCode: 'AI_DANG_TRA_LOI' });
  }
  if (DANG_CHAY.size >= TOI_DA_DONG_THOI) {
    throw new AppError('Agent đang trả lời nhiều người cùng lúc, thử lại sau vài giây.', { status: 429, errorCode: 'AI_BAN' });
  }

  let hoiThoai = null;
  if (body.hoi_thoai_id) {
    hoiThoai = await repo.layHoiThoai(body.hoi_thoai_id, user.id);
    if (!hoiThoai) throw new AppError('Không tìm thấy cuộc trò chuyện', { status: 404, errorCode: 'KHONG_CO_HOI_THOAI' });
  } else {
    hoiThoai = await repo.taoHoiThoai(user.id, cauHoi.slice(0, 80), cfg.nhaCungCap, cfg.model);
  }

  DANG_CHAY.add(user.id);
  const t0 = Date.now();
  let mcp = null;
  try {
    const [lichSu, hoTen] = await Promise.all([repo.lichSuGanNhat(hoiThoai.id, 12), hoTenCua(user.id)]);
    await repo.themTinNhan({ hoiThoaiId: hoiThoai.id, vaiTro: 'NGUOI_DUNG', noiDung: cauHoi, userId: user.id });

    mcp = await moMcp({ userId: user.id, authorization: req.headers.authorization, phanTich: req.quyenAi.phanTich });
    let kq;
    try {
      kq = await gemini.traLoi({
        cfg,
        heThong: heThong({ hoTen, vaiTro: user.roles, phanTich: req.quyenAi.phanTich, trangHienTai: String(body.trang_hien_tai || '').slice(0, 120) }),
        lichSu,
        cauHoi,
        mcp,
      });
    } catch (e) {
      await repo.themTinNhan({
        hoiThoaiId: hoiThoai.id, vaiTro: 'AI', loi: `${e.errorCode || 'LOI'}: ${String(e.message).slice(0, 400)}`,
        model: cfg.model, thoiGianMs: Date.now() - t0, userId: user.id,
      }).catch(() => {});
      await repo.capNhatTongHoiThoai(hoiThoai.id, { cauHoi: 1 }, user.id).catch(() => {});
      throw e;
    }
    const tin = await repo.themTinNhan({
      hoiThoaiId: hoiThoai.id, vaiTro: 'AI', noiDung: kq.text, congCu: kq.buoc, model: cfg.model,
      tokenVao: kq.tokenVao, tokenRa: kq.tokenRa, thoiGianMs: Date.now() - t0, userId: user.id,
    });
    await repo.capNhatTongHoiThoai(hoiThoai.id, { cauHoi: 1, tokenVao: kq.tokenVao, tokenRa: kq.tokenRa }, user.id);
    return {
      hoi_thoai_id: hoiThoai.id,
      tieu_de: hoiThoai.tieu_de,
      tin_nhan: tin,
      con_lai: Math.max(0, cfg.gioiHanNgay - daHoi - 1),
    };
  } finally {
    DANG_CHAY.delete(user.id);
    if (mcp) mcp.dong().catch(() => {});
  }
}

async function dsHoiThoai(userId) {
  if (!(await repo.coBangAi())) return [];
  return repo.dsHoiThoai(userId);
}

async function chiTietHoiThoai(id, userId) {
  const ht = await repo.layHoiThoai(id, userId);
  if (!ht) throw new AppError('Không tìm thấy cuộc trò chuyện', { status: 404, errorCode: 'KHONG_CO_HOI_THOAI' });
  return { hoi_thoai: ht, tin_nhan: await repo.dsTinNhan(id) };
}

async function xoaHoiThoai(id, userId) {
  if (!(await repo.xoaMemHoiThoai(id, userId))) {
    throw new AppError('Không tìm thấy cuộc trò chuyện', { status: 404, errorCode: 'KHONG_CO_HOI_THOAI' });
  }
  return { id };
}

async function danhGia(tinNhanId, userId, body = {}) {
  const d = Number(body.danh_gia);
  if (![1, -1, 0].includes(d)) throw new AppError('Đánh giá phải là 1, -1 hoặc 0', { status: 422, errorCode: 'VALIDATION' });
  if (!(await repo.danhGiaTinNhan(tinNhanId, userId, d || null, body.ghi_chu))) {
    throw new AppError('Không tìm thấy tin nhắn', { status: 404, errorCode: 'KHONG_CO_TIN_NHAN' });
  }
  return { id: tinNhanId, danh_gia: d || null };
}

async function datMauRobot(userId, body = {}) {
  const mau = String(body.mau_robot || '').trim().toUpperCase();
  if (!MAU_ROBOT.includes(mau)) throw new AppError('Mẫu robot không hợp lệ', { status: 422, errorCode: 'VALIDATION', details: MAU_ROBOT });
  if (!(await repo.coBangAi())) throw new AppError('Chưa chạy migration 138', { status: 409, errorCode: 'CHUA_MIGRATION_138' });
  await repo.datMauRobot(userId, mau);
  return { mau_robot: mau };
}

module.exports = { trangThai, hoi, dsHoiThoai, chiTietHoiThoai, xoaHoiThoai, danhGia, datMauRobot, MAU_ROBOT };
