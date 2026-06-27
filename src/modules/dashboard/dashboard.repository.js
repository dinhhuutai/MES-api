'use strict';

const { query } = require('../../config/db');

const groupMap = (rows, keyCol, valCol = 'n') =>
  rows.reduce((acc, r) => { acc[r[keyCol]] = Number(r[valCol]); return acc; }, {});

async function summary() {
  const [
    donHang, donHangTT, phanIn, lenhTT, temTT, xePhoi, giaoHangTT, giaoSl, kcs, oqc, nghen,
  ] = await Promise.all([
    query('SELECT count(*)::int AS n FROM don_hang'),
    query('SELECT trang_thai, count(*)::int AS n FROM don_hang GROUP BY trang_thai'),
    query(`SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id=kq.checkpoint_id
                WHERE kq.phan_in_id=pin.id AND cp.ma_checkpoint='QC_XAC_NHAN' AND kq.trang_thai='DAT'))::int AS ready,
             count(*) FILTER (WHERE pin.loi_nhuan IS NOT NULL)::int AS co_loi_nhuan
           FROM phan_in pin`),
    query("SELECT trang_thai, count(*)::int AS n FROM lenh_san_xuat GROUP BY trang_thai"),
    query('SELECT trang_thai, count(*)::int AS n FROM tem GROUP BY trang_thai'),
    query("SELECT count(*)::int AS n FROM tem_xe_phoi WHERE trang_thai='DANG_PHOI'"),
    query('SELECT trang_thai, count(*)::int AS n FROM giao_hang GROUP BY trang_thai'),
    query("SELECT COALESCE(SUM(gt.so_luong_giao),0)::int AS n FROM giao_hang_tem gt JOIN giao_hang gh ON gh.id=gt.giao_hang_id WHERE gh.trang_thai='DA_GIAO'"),
    query('SELECT count(*)::int AS n FROM kcs'),
    query("SELECT count(*) FILTER (WHERE ket_qua='DAT')::int AS dat, count(*) FILTER (WHERE ket_qua='KHONG_DAT')::int AS khong_dat FROM oqc"),
    query("SELECT count(*)::int AS n FROM nghen WHERE trang_thai='DANG_NGHEN'"),
  ]);

  return {
    don_hang: { total: donHang.rows[0].n, by_trang_thai: groupMap(donHangTT.rows, 'trang_thai') },
    phan_in: phanIn.rows[0],
    lenh: groupMap(lenhTT.rows, 'trang_thai'),
    tem: groupMap(temTT.rows, 'trang_thai'),
    xe_phoi: { dang_phoi: xePhoi.rows[0].n },
    giao_hang: { by_trang_thai: groupMap(giaoHangTT.rows, 'trang_thai'), tong_sl_da_giao: giaoSl.rows[0].n },
    chat_luong: { so_kcs: kcs.rows[0].n, oqc_dat: oqc.rows[0].dat, oqc_khong_dat: oqc.rows[0].khong_dat },
    nghen: { dang_nghen: nghen.rows[0].n },
  };
}

async function activity(limit = 12) {
  const { rows } = await query(
    `SELECT lst.id, lst.ly_do, lst.tg_thuc_hien,
            tt.ten_trang_thai AS trang_thai_moi, u.ho_ten AS nguoi
     FROM lich_su_trang_thai lst
     LEFT JOIN trang_thai tt ON tt.id = lst.trang_thai_moi_id
     LEFT JOIN nguoi_dung u ON u.id = lst.nguoi_thuc_hien_id
     ORDER BY lst.tg_thuc_hien DESC NULLS LAST, lst.created_date DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { summary, activity };
