'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// VỊ TRÍ 1 PHẦN IN — NGUỒN ĐÚNG cho Agent MES THLA (23/11/2026). `GET /api/ai/vi-tri-phan-in/:id` ⇒ công cụ `mes_web_tra_ma`.
//
// Vì sao: bản đầu công cụ đọc `/dashboard/tinh-trang/phan-in/:id` — câu đó lấy trạm từ `ton_tram` (chỉ còn phục vụ đồng hồ
//   SLA, chỉ kéo đợt CHƯA release) + `lich_su_luan_chuyen` (HỎNG — DATABASE.md §7) ⇒ người dùng hỏi "SL-2609-002-A07-F01-C01
//   đang ở đâu" thì Agent báo READY (đợt mới về) trong khi đợt khác đang ở Chờ sản xuất.
// ⇒ Ở đây giai đoạn đi qua ĐÚNG `utils/stage.js dotStageCase` (cùng nguồn chip Danh sách phần in vải về / Quản trị phần in):
//   · mức ĐỢT VẢI: lệnh sống công đoạn CUỐI trước (`ORDER BY la_cong_doan_dau, created_date DESC` — gương `dotSource`);
//   · mức (ĐỢT × LỆNH): mỗi lệnh sống 1 dòng ⇒ phần in 2 công đoạn thấy riêng In / Ép-Logo;
//   · công đoạn CHƯA có lệnh của đợt In + Ép/Logo (`IN_EP`): Ready cho công đoạn đó chưa (`qcDotGdSql`), có Kế hoạch tạm chưa.
//   + tem sống theo trạng thái, trả về chưa xử lý, đang ở Giao nhận.
// ⚠ 1 code phần ĐỒNG THỜI ở nhiều trạm là ĐÚNG (sản xuất đi theo đợt vải) — trả đủ, đừng gộp thành 1 trạm.
// ⚠ Chỉ đọc. Repository gửi SQL 1 dòng ⇒ không `-- …` trong chuỗi.
// ─────────────────────────────────────────────────────────────────────────────
const { query } = require('../../config/db');
const { dotStageCase, STAGE_LABEL } = require('../../utils/stage');
const { qcDotGdSql } = require('../../utils/giuReadyCongDoan');
const { CHO_GN_SQL } = require('../../utils/traVeGn');

const TEN_CD = (luong, gd) => {
  if (gd === 'EP_UI') return luong === 'IN_KIENG' ? 'Ép' : 'Ép/Logo';
  if (luong === 'LOGO') return 'Logo';
  if (luong === 'IN_KIENG' || luong === 'KIENG_KHONG_EP') return 'In kiếng';
  return 'In';
};
const TEN_TEM = {
  IN: 'Mới in', DANG_PHOI: 'Đang phơi (chờ khô)', DA_KHO: 'Đã khô (chờ KCS)', CHO_CD_SAU: 'Chờ công đoạn sau',
  CHO_SUA: 'Chờ sửa', CHO_OQC: 'Chờ OQC', OQC_DAT: 'OQC đạt (chờ giao)', DA_GIAO: 'Đã giao', DA_TACH: 'Đã tách sang tem 17', LOAI: 'Loại',
};
const nhan = (ma) => STAGE_LABEL[ma] || ma;

async function viTriPhanIn(phanInId) {
  const { rows: [pin] } = await query(
    `SELECT pin.id, pin.ma_phan, pin.mau_in, pin.mau_vai, pin.kich_vai, pin.tinh_chat_in, pin.luong_sx, pin.ep_truoc,
            pin.dang_hoat_dong, pin.so_luong_don_hang, kh.ten_khach_hang, dh.ma_don_hang, mh.ma_hang,
            ${CHO_GN_SQL('pin.id')} AS dang_o_giao_nhan
       FROM phan_in pin JOIN ma_hang mh ON mh.id = pin.ma_hang_id JOIN don_hang dh ON dh.id = mh.don_hang_id
       JOIN khach_hang kh ON kh.id = dh.khach_hang_id WHERE pin.id = $1`.replace(/\s+/g, ' '), [phanInId]);
  if (!pin) return null;

  // Mức ĐỢT VẢI — giai đoạn của đợt (gương `utils/stage.js dotSource`).
  const { rows: dots } = await query(
    `SELECT d.id, d.ma_dot_vai, d.barcode, d.so_luong_vai_ve, d.ngay_vai_ve, d.han_giao_hang, d.trang_thai, d.tg_chuyen_ready,
            ldv.ten_loai AS loai_dot_vai, ${dotStageCase('d')} AS giai_doan
       FROM (SELECT dv.*, l.lenh_id, l.lenh_tt FROM dot_vai_ve dv
               LEFT JOIN LATERAL (SELECT ls.id AS lenh_id, ls.trang_thai AS lenh_tt FROM lenh_sx_dot_vai lsd
                                    JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id
                                   WHERE lsd.dot_vai_ve_id = dv.id AND ls.trang_thai <> 'HUY'
                                   ORDER BY ls.la_cong_doan_dau, ls.created_date DESC LIMIT 1) l ON true
              WHERE dv.phan_in_id = $1) d
       LEFT JOIN loai_dot_vai ldv ON ldv.id = d.loai_dot_vai_id
      ORDER BY d.created_date`.replace(/\s+/g, ' '), [phanInId]);

  // Mức (ĐỢT × LỆNH sống) — giai đoạn riêng từng lệnh / công đoạn + tem của lệnh.
  const { rows: lenhs } = await query(
    `SELECT x.dot_id, x.ma_lenh_san_xuat, x.giai_doan_lenh, x.lenh_tt, x.sl_dot, x.so_luong_release, x.ngay_ke_hoach,
            x.ten_chuyen, x.ma_chuyen, ${dotStageCase('x')} AS giai_doan,
            (SELECT json_object_agg(t.trang_thai, t.n) FROM (SELECT tm.trang_thai, count(*)::int AS n FROM phieu_san_xuat ps
               JOIN tem tm ON tm.phieu_san_xuat_id = ps.id WHERE ps.lenh_san_xuat_id = x.lenh_id AND tm.trang_thai <> 'HUY'
               GROUP BY tm.trang_thai) t) AS tem_theo_trang_thai
       FROM (SELECT d.id, d.id AS dot_id, d.phan_in_id, d.tg_chuyen_ready, d.created_date, ls.id AS lenh_id, ls.trang_thai AS lenh_tt,
                    ls.ma_lenh_san_xuat, ls.giai_doan AS giai_doan_lenh, ls.so_luong_release, ls.ngay_ke_hoach, ls.created_date AS lenh_tao,
                    lsd.so_luong AS sl_dot, cs.ten_chuyen, cs.ma_chuyen
               FROM dot_vai_ve d JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = d.id
               JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
               LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
              WHERE d.phan_in_id = $1) x
      ORDER BY x.lenh_tao`.replace(/\s+/g, ' '), [phanInId]);

  // Công đoạn CHƯA có lệnh của đợt In + Ép/Logo: Ready cho công đoạn đó chưa + Kế hoạch tạm.
  const { rows: cdCho } = pin.luong_sx === 'IN_EP' ? await query(
    `SELECT d.id AS dot_id, g.gd, ${qcDotGdSql('d', 'd.phan_in_id', 'g.gd')} AS da_ready,
            EXISTS (SELECT 1 FROM ke_hoach_tam k WHERE k.dot_vai_ve_id = d.id AND k.trang_thai = 'CHO'
                      AND COALESCE(to_jsonb(k)->>'giai_doan', 'IN') = g.gd) AS co_ke_hoach_tam
       FROM dot_vai_ve d CROSS JOIN (VALUES ('IN'), ('EP_UI')) g(gd)
      WHERE d.phan_in_id = $1 AND d.trang_thai NOT IN ('DA_GOP','DA_HUY') AND d.tg_chuyen_ready IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai l JOIN lenh_san_xuat ls ON ls.id = l.lenh_san_xuat_id
                         WHERE l.dot_vai_ve_id = d.id AND ls.trang_thai <> 'HUY'
                           AND (CASE WHEN ls.giai_doan = 'EP_UI' THEN 'EP_UI' ELSE 'IN' END) = g.gd)`.replace(/\s+/g, ' '),
    [phanInId]) : { rows: [] };

  const { rows: traVe } = await query(
    `SELECT loai, ly_do, created_date, dot_vai_ve_id FROM qc_tra_ve WHERE phan_in_id = $1 AND da_xu_ly = false
      ORDER BY created_date DESC LIMIT 10`, [phanInId]);

  const dotSong = (d) => !['DA_GOP', 'DA_HUY'].includes(d.trang_thai);
  const dsDot = dots.map((d) => {
    const ls = lenhs.filter((l) => l.dot_id === d.id);
    const cho = cdCho.filter((c) => c.dot_id === d.id);
    const tram = new Set();
    if (dotSong(d)) {
      if (!ls.length) tram.add(nhan(d.giai_doan));
      ls.forEach((l) => tram.add(`${nhan(l.giai_doan)} (${TEN_CD(pin.luong_sx, l.giai_doan_lenh)})`));
      cho.forEach((c) => tram.add(`${c.co_ke_hoach_tam ? 'Kế hoạch tạm' : c.da_ready ? 'Release 1 (chờ lập lệnh)' : 'READY'} (${TEN_CD(pin.luong_sx, c.gd)})`));
    }
    return {
      ma_dot_vai: d.ma_dot_vai, phieu_ready: d.barcode, loai_dot_vai: d.loai_dot_vai, so_luong_vai: d.so_luong_vai_ve,
      ngay_vai_ve: d.ngay_vai_ve, han_giao: d.han_giao_hang, len_mes: d.tg_chuyen_ready,
      trang_thai_dot: d.trang_thai === 'DA_HUY' ? 'Đã hủy' : d.trang_thai === 'DA_GOP' ? 'Đã gộp' : 'Đang hiệu lực',
      giai_doan_cua_dot: dotSong(d) ? nhan(d.giai_doan) : null,
      dang_o: [...tram],
      lenh: ls.map((l) => ({
        ma_lenh: l.ma_lenh_san_xuat, cong_doan: TEN_CD(pin.luong_sx, l.giai_doan_lenh), giai_doan: nhan(l.giai_doan),
        trang_thai_lenh: l.lenh_tt, sl_cua_dot: l.sl_dot, sl_release_lenh: l.so_luong_release, ngay_ke_hoach: l.ngay_ke_hoach,
        chuyen: l.ma_chuyen || l.ten_chuyen || null,
        tem: l.tem_theo_trang_thai ? Object.fromEntries(Object.entries(l.tem_theo_trang_thai).map(([k, v]) => [TEN_TEM[k] || k, v])) : {},
      })),
      cong_doan_chua_lenh: cho.map((c) => ({ cong_doan: TEN_CD(pin.luong_sx, c.gd), da_ready: c.da_ready, co_ke_hoach_tam: c.co_ke_hoach_tam })),
    };
  });

  const tong = {};
  dsDot.forEach((d) => d.dang_o.forEach((t) => { tong[t] = (tong[t] || 0) + 1; }));
  return {
    phan_in: {
      ma_phan: pin.ma_phan, mau_muc: pin.mau_in, mau_vai: pin.mau_vai, kich_vai: pin.kich_vai, tinh_chat_in: pin.tinh_chat_in,
      cong_doan: pin.luong_sx === 'IN_EP' || pin.luong_sx === 'IN_KIENG' ? `2 công đoạn (${TEN_CD(pin.luong_sx, 'IN')} + ${TEN_CD(pin.luong_sx, 'EP_UI')})` : `1 công đoạn (${TEN_CD(pin.luong_sx, 'IN')})`,
      khach: pin.ten_khach_hang, don_hang: pin.ma_don_hang, ma_hang: pin.ma_hang, sldh: pin.so_luong_don_hang,
      con_hieu_luc: pin.dang_hoat_dong, dang_o_giao_nhan: pin.dang_o_giao_nhan,
    },
    ghi_chu: '1 phần in có thể ĐỒNG THỜI ở nhiều trạm vì sản xuất đi theo ĐỢT VẢI (và theo công đoạn). Trả lời phải nêu ĐỦ từng đợt / công đoạn trong "dang_o", không chọn 1 trạm.',
    tong_hop_dang_o: tong,
    dot_vai: dsDot,
    tra_ve_chua_xu_ly: traVe,
  };
}

module.exports = { viTriPhanIn };
