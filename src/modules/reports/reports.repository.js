'use strict';

const { query } = require('../../config/db');

async function sanLuong() {
  const { rows } = await query(
    `SELECT ls.ma_lenh_san_xuat, cs.ma_chuyen, ls.so_luong_release AS ke_hoach, ls.trang_thai,
            (SELECT COALESCE(SUM(t.so_luong),0)::int FROM tem t JOIN phieu_san_xuat ps ON ps.id=t.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=ls.id) AS da_in,
            (SELECT count(*) FROM tem t JOIN phieu_san_xuat ps ON ps.id=t.phieu_san_xuat_id WHERE ps.lenh_san_xuat_id=ls.id)::int AS so_tem
     FROM lenh_san_xuat ls LEFT JOIN chuyen_san_xuat cs ON cs.id=ls.chuyen_id
     ORDER BY ls.created_date DESC`
  );
  return rows;
}

async function chatLuong() {
  const { rows } = await query(
    `SELECT t.ma_tem, ls.ma_lenh_san_xuat,
            k.so_luong_kiem, k.so_luong_dat, k.so_luong_loi, k.so_luong_huy, k.ket_qua
     FROM kcs k JOIN tem t ON t.id=k.tem_id
     LEFT JOIN phieu_san_xuat ps ON ps.id=t.phieu_san_xuat_id
     LEFT JOIN lenh_san_xuat ls ON ls.id=ps.lenh_san_xuat_id
     ORDER BY k.created_date DESC`
  );
  return rows;
}

async function giaoHang() {
  const { rows } = await query(
    `SELECT gh.ma_phieu_giao, kh.ten_khach_hang, dh.ma_don_hang, gh.ngay_giao, gh.trang_thai,
            (SELECT count(*) FROM giao_hang_tem gt WHERE gt.giao_hang_id=gh.id)::int AS so_tem,
            (SELECT COALESCE(SUM(gt.so_luong_giao),0)::int FROM giao_hang_tem gt WHERE gt.giao_hang_id=gh.id) AS tong_sl
     FROM giao_hang gh
     LEFT JOIN don_hang dh ON dh.id=gh.don_hang_id
     LEFT JOIN khach_hang kh ON kh.id=dh.khach_hang_id
     ORDER BY gh.created_date DESC`
  );
  return rows;
}

module.exports = { sanLuong, chatLuong, giaoHang };
