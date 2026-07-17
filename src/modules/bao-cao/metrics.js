'use strict';

// =====================================================================
// Catalog dữ liệu có sẵn cho báo cáo tự thiết kế (metric registry).
// MỖI METRIC TỰ MANG MỐC THỜI GIAN RIÊNG (không còn "Kỳ" chung):
//   - nhóm "… hôm nay"  : lọc theo NGÀY HÔM NAY (giờ VN).
//   - nhóm "… (hiện tại)"/"tổng": trạng thái hiện tại hoặc lũy kế, KHÔNG lọc thời gian.
// Giá trị luôn được tính REALTIME tại thời điểm Xem trước / Xuất.
// Thêm metric mới = thêm 1 phần tử vào MẢNG DEFS. compute(maList) không nhận tham số kỳ.
// =====================================================================

const { query } = require('../../config/db');
const dashboardRepo = require('../dashboard/dashboard.repository');

// Cache ngắn kết quả stageCounts (đếm phần in theo giai đoạn — nguồn tin cậy như dashboard) để nhiều
// metric "phần in đang ở trạm" dùng chung 1 lần chạy trong cùng lượt compute (tránh chạy lặp query nặng).
let _scPromise = null; let _scAt = 0;
async function stageCountsCached() {
  if (_scPromise && Date.now() - _scAt < 2000) return _scPromise;
  _scPromise = dashboardRepo.stageCounts();
  _scAt = Date.now();
  return _scPromise;
}
// Số PHẦN IN đang ở giai đoạn (gộp nhiều stage key).
const pinAtStage = (keys) => async () => {
  const sc = await stageCountsCached();
  return keys.reduce((a, k) => a + ((sc.stages && sc.stages[k] && sc.stages[k].phan_in) || 0), 0);
};

// Helper: lấy 1 số vô hướng từ 1 câu SQL trả về cột `v`.
async function scalar(sql) {
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim());
  const v = rows[0] ? rows[0].v : 0;
  return v == null ? 0 : Number(v);
}

// Helper: lấy 1 CHUỖI (text) từ SQL trả cột `v` — cho metric kiểu ngày/giờ/văn bản.
async function scalarText(sql) {
  const { rows } = await query(sql.replace(/\s+/g, ' ').trim());
  return rows[0] && rows[0].v != null ? String(rows[0].v) : '';
}

// Ngày hôm nay theo giờ VN (dùng chung cho mọi lọc "hôm nay").
const VN_TODAY = "(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
// Lọc "hôm nay" cho cột TIMESTAMPTZ.
const TODAY_TS = (col) => `(${col} AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = ${VN_TODAY}`;
// Lọc "hôm nay" cho cột DATE.
const TODAY_DT = (col) => `${col} = ${VN_TODAY}`;

// Đếm ket_qua_checkpoint DAT hôm nay cho 1 mã checkpoint (mức phần in).
const cpDoneToday = (maCp) =>
  `SELECT count(*)::numeric AS v FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
   WHERE cp.ma_checkpoint = '${maCp}' AND kq.trang_thai = 'DAT' AND ${TODAY_TS('kq.tg_xac_nhan')}`;

// Đếm đợt vải đang ở 1 trạm hiện tại (ton_tram) theo mã trạm (cần migration 029 mới có dữ liệu).
const tonTram = (maTram) =>
  `SELECT count(*)::numeric AS v FROM ton_tram tt JOIN tram tr ON tr.id = tt.tram_id
   WHERE tt.dot_vai_ve_id IS NOT NULL AND tr.ma_tram = '${maTram}'`;

// mỗi def: { ma, ten, mo_ta, nhom, don_vi, kieu?, run() }
const DEFS = [
  // ---------- THỜI GIAN HIỆN TẠI (text — tự cập nhật mỗi lần render) ----------
  { ma: 'NGAY_GIO_HIEN_TAI', ten: 'Ngày giờ hiện tại', nhom: 'Thời gian hiện tại', don_vi: 'giờ VN', kieu: 'text',
    mo_ta: 'Ngày giờ hiện tại (giờ VN), dạng DD/MM/YYYY HH:mm. Tự cập nhật mỗi lần Xem trước / Xuất.',
    run: () => scalarText(`SELECT to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI') AS v`) },
  { ma: 'NGAY_HIEN_TAI', ten: 'Ngày hiện tại', nhom: 'Thời gian hiện tại', don_vi: 'giờ VN', kieu: 'text',
    mo_ta: 'Ngày hiện tại (giờ VN), dạng DD/MM/YYYY. Tự cập nhật mỗi lần Xem trước / Xuất.',
    run: () => scalarText(`SELECT to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY') AS v`) },
  { ma: 'GIO_HIEN_TAI', ten: 'Giờ hiện tại', nhom: 'Thời gian hiện tại', don_vi: 'giờ VN', kieu: 'text',
    mo_ta: 'Giờ:phút hiện tại (giờ VN), dạng HH:mm. Tự cập nhật mỗi lần Xem trước / Xuất.',
    run: () => scalarText(`SELECT to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI') AS v`) },

  // ---------- ĐƠN HÀNG (hôm nay) ----------
  { ma: 'SO_DON_HOM_NAY', ten: 'Số đơn hàng hôm nay', nhom: 'Đơn hàng (hôm nay)', don_vi: 'đơn',
    mo_ta: 'Số đơn hàng tạo trong hôm nay (giờ VN).',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM don_hang WHERE ${TODAY_TS('created_date')}`) },
  { ma: 'SO_MA_HANG_HOM_NAY', ten: 'Số mã hàng hôm nay', nhom: 'Đơn hàng (hôm nay)', don_vi: 'mã',
    mo_ta: 'Số mã hàng tạo trong hôm nay (giờ VN).',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM ma_hang WHERE ${TODAY_TS('created_date')}`) },
  { ma: 'SO_PHAN_IN_HOM_NAY', ten: 'Số phần in hôm nay', nhom: 'Đơn hàng (hôm nay)', don_vi: 'phần',
    mo_ta: 'Số phần in tạo trong hôm nay (giờ VN).',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM phan_in WHERE ${TODAY_TS('created_date')}`) },
  { ma: 'TONG_SL_DON_HOM_NAY', ten: 'Tổng SL đặt (phần in hôm nay)', nhom: 'Đơn hàng (hôm nay)', don_vi: 'pcs',
    mo_ta: 'Tổng SL đặt của phần in tạo hôm nay (sum phan_in.so_luong_don_hang).',
    run: () => scalar(`SELECT COALESCE(sum(so_luong_don_hang),0)::numeric AS v FROM phan_in WHERE ${TODAY_TS('created_date')}`) },

  // ---------- ĐƠN HÀNG (tổng) ----------
  { ma: 'SO_DON_TONG', ten: 'Tổng số đơn hàng', nhom: 'Đơn hàng (tổng)', don_vi: 'đơn',
    mo_ta: 'Tổng số đơn hàng hiện có (lũy kế, không theo thời gian).',
    run: () => scalar('SELECT count(*)::numeric AS v FROM don_hang') },
  { ma: 'SO_MA_HANG_TONG', ten: 'Tổng số mã hàng', nhom: 'Đơn hàng (tổng)', don_vi: 'mã',
    mo_ta: 'Tổng số mã hàng hiện có (lũy kế).',
    run: () => scalar('SELECT count(*)::numeric AS v FROM ma_hang') },
  { ma: 'SO_PHAN_IN_TONG', ten: 'Tổng số phần in', nhom: 'Đơn hàng (tổng)', don_vi: 'phần',
    mo_ta: 'Tổng số phần in hiện có (lũy kế).',
    run: () => scalar('SELECT count(*)::numeric AS v FROM phan_in') },

  // ---------- VẢI VỀ (hôm nay) ----------
  { ma: 'SO_DOT_VAI_HOM_NAY', ten: 'Số đợt vải về hôm nay', nhom: 'Vải về (hôm nay)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải về theo ngày vải về = hôm nay.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM dot_vai_ve WHERE ${TODAY_DT('ngay_vai_ve')}`) },
  { ma: 'TONG_SL_VAI_VE_HOM_NAY', ten: 'Tổng SL vải về hôm nay', nhom: 'Vải về (hôm nay)', don_vi: 'pcs',
    mo_ta: 'Tổng SL vải về (sum so_luong_vai_ve) theo ngày vải về = hôm nay.',
    run: () => scalar(`SELECT COALESCE(sum(so_luong_vai_ve),0)::numeric AS v FROM dot_vai_ve WHERE ${TODAY_DT('ngay_vai_ve')}`) },

  // ---------- KỸ THUẬT (hôm nay) ----------
  { ma: 'KHUON_HOM_NAY', ten: 'Khuôn hoàn thành hôm nay', nhom: 'Kỹ thuật (hôm nay)', don_vi: 'phần',
    mo_ta: 'Số phần in được xác nhận KHUÔN (DAT) trong hôm nay.',
    run: () => scalar(cpDoneToday('KHUON')) },
  { ma: 'FILM_HOM_NAY', ten: 'Film hoàn thành hôm nay', nhom: 'Kỹ thuật (hôm nay)', don_vi: 'phần',
    mo_ta: 'Số phần in được xác nhận FILM (DAT) trong hôm nay.',
    run: () => scalar(cpDoneToday('FILM')) },
  { ma: 'MUC_HOM_NAY', ten: 'Mực hoàn thành hôm nay', nhom: 'Kỹ thuật (hôm nay)', don_vi: 'phần',
    mo_ta: 'Số phần in được xác nhận MỰC (DAT) trong hôm nay.',
    run: () => scalar(cpDoneToday('MUC')) },
  { ma: 'HSKT_HOM_NAY', ten: 'HSKT hoàn thành hôm nay', nhom: 'Kỹ thuật (hôm nay)', don_vi: 'phần',
    mo_ta: 'Số phần in được xác nhận HSKT (DAT) trong hôm nay.',
    run: () => scalar(cpDoneToday('HSKT')) },
  { ma: 'READY_KT_DU_HOM_NAY', ten: 'Phần in đủ mục KT hôm nay', nhom: 'Kỹ thuật (hôm nay)', don_vi: 'phần',
    mo_ta: 'Số phần in hoàn tất đủ 3 mục kỹ thuật, với mốc xác nhận mục cuối cùng trong hôm nay.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM (
      SELECT kq.phan_in_id, count(*) AS n, max(kq.tg_xac_nhan) AS tgmax
      FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
      WHERE cp.ma_checkpoint IN ('KHUON','FILM','MUC') AND kq.trang_thai = 'DAT'
      GROUP BY kq.phan_in_id HAVING count(*) >= 3
    ) t WHERE ${TODAY_TS('t.tgmax')}`) },
  { ma: 'QC_READY_HOM_NAY', ten: 'Phần in QC-READY hôm nay', nhom: 'Kỹ thuật (hôm nay)', don_vi: 'phần',
    mo_ta: 'Số phần in được QC xác nhận READY (QC_XAC_NHAN=DAT) trong hôm nay.',
    run: () => scalar(cpDoneToday('QC_XAC_NHAN')) },

  // ---------- READY / DÒNG CHẢY (hiện tại) ----------
  { ma: 'PHAN_DA_READY', ten: 'Phần in đã READY', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'phần',
    mo_ta: 'Số phần in đã hoàn tất READY (có QC_XAC_NHAN=DAT). Hiện tại, không theo thời gian.',
    run: () => scalar(`SELECT count(DISTINCT kq.phan_in_id)::numeric AS v FROM ket_qua_checkpoint kq
      JOIN checkpoint cp ON cp.id = kq.checkpoint_id WHERE cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT'`) },
  { ma: 'PHAN_CHUA_READY', ten: 'Phần in chưa READY', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'phần',
    mo_ta: 'Số phần in CHƯA hoàn tất READY (chưa có QC_XAC_NHAN=DAT). Hiện tại.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM phan_in pin WHERE NOT EXISTS (
      SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
      WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT')`) },
  { ma: 'DANG_O_READY', ten: 'Đợt vải đang ở READY', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải hiện đang ở trạm READY (ton_tram — cần migration 029).',
    run: () => scalar(tonTram('READY')) },
  { ma: 'DANG_O_TEST_RUN', ten: 'Đợt vải đang ở TEST RUN', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải hiện đang ở trạm TEST_RUN (ton_tram).',
    run: () => scalar(tonTram('TEST_RUN')) },
  { ma: 'DANG_O_SAN_XUAT', ten: 'Đợt vải đang sản xuất', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải hiện đang ở trạm SAN_XUAT (ton_tram).',
    run: () => scalar(tonTram('SAN_XUAT')) },
  { ma: 'DANG_O_CHO_KHO', ten: 'Đợt vải đang chờ khô', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải hiện đang ở trạm CHO_KHO (ton_tram).',
    run: () => scalar(tonTram('CHO_KHO')) },
  { ma: 'DANG_O_KIEM', ten: 'Đợt vải đang ở KIỂM (KCS)', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải hiện đang ở trạm KIEM (ton_tram).',
    run: () => scalar(tonTram('KIEM')) },
  { ma: 'DANG_O_SUA', ten: 'Đợt vải đang ở SỬA', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải hiện đang ở trạm SUA (ton_tram).',
    run: () => scalar(tonTram('SUA')) },
  { ma: 'DANG_O_OQC', ten: 'Đợt vải đang ở OQC', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải hiện đang ở trạm OQC (ton_tram).',
    run: () => scalar(tonTram('OQC')) },
  { ma: 'DANG_NGHEN', ten: 'Đang nghẽn (quá SLA)', nhom: 'READY / dòng chảy (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Số đợt vải đang ở 1 trạm quá thời gian SLA (now - tg_vao > SLA trạm). Cần migration 029 + SLA.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM ton_tram tt JOIN tram tr ON tr.id = tt.tram_id
      WHERE tt.dot_vai_ve_id IS NOT NULL AND tr.thoi_gian_quy_dinh_phut IS NOT NULL
        AND EXTRACT(EPOCH FROM (now() - tt.tg_vao))/60 > tr.thoi_gian_quy_dinh_phut`) },

  // ---------- SẢN XUẤT (hôm nay) ----------
  { ma: 'SL_IN_HOM_NAY', ten: 'Tổng SL in hôm nay', nhom: 'Sản xuất (hôm nay)', don_vi: 'pcs',
    mo_ta: 'Tổng SL đã in (sum tem.so_luong, loại tem HUY) theo ngày tạo tem = hôm nay.',
    run: () => scalar(`SELECT COALESCE(sum(so_luong),0)::numeric AS v FROM tem WHERE trang_thai <> 'HUY' AND ${TODAY_TS('created_date')}`) },
  { ma: 'SO_TEM_IN_HOM_NAY', ten: 'Số tem in hôm nay', nhom: 'Sản xuất (hôm nay)', don_vi: 'tem',
    mo_ta: 'Số tem đã in (loại HUY) tạo trong hôm nay.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM tem WHERE trang_thai <> 'HUY' AND ${TODAY_TS('created_date')}`) },
  { ma: 'PHIEU_BAT_DAU_HOM_NAY', ten: 'Phiếu SX bắt đầu hôm nay', nhom: 'Sản xuất (hôm nay)', don_vi: 'phiếu',
    mo_ta: 'Số phiếu sản xuất tạo (bắt đầu chạy) trong hôm nay.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM phieu_san_xuat WHERE ${TODAY_TS('created_date')}`) },
  { ma: 'PHIEU_HOAN_TAT_HOM_NAY', ten: 'Phiếu SX hoàn tất hôm nay', nhom: 'Sản xuất (hôm nay)', don_vi: 'phiếu',
    mo_ta: 'Số phiếu sản xuất HOÀN TẤT cập nhật trong hôm nay (trang_thai=HOAN_TAT).',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM phieu_san_xuat WHERE trang_thai = 'HOAN_TAT' AND ${TODAY_TS('COALESCE(updated_date, created_date)')}`) },
  { ma: 'PHUT_NGUNG_CHUYEN_HOM_NAY', ten: 'Số phút ngừng chuyền hôm nay', nhom: 'Sản xuất (hôm nay)', don_vi: 'phút',
    mo_ta: 'Tổng số phút ngừng chuyền (sum ngung_chuyen.so_phut) bắt đầu ngừng trong hôm nay.',
    run: () => scalar(`SELECT COALESCE(sum(so_phut),0)::numeric AS v FROM ngung_chuyen WHERE ${TODAY_TS('tg_bd_ngung')}`) },

  // ---------- SẢN XUẤT (hiện tại) ----------
  { ma: 'TEM_DANG_PHOI', ten: 'Tem đang phơi', nhom: 'Sản xuất (hiện tại)', don_vi: 'tem',
    mo_ta: 'Số tem đang phơi hiện tại (tem_xe_phoi trang_thai=DANG_PHOI).',
    run: () => scalar("SELECT count(*)::numeric AS v FROM tem_xe_phoi WHERE trang_thai = 'DANG_PHOI'") },
  { ma: 'PHIEU_DANG_CHAY', ten: 'Phiếu SX đang chạy', nhom: 'Sản xuất (hiện tại)', don_vi: 'phiếu',
    mo_ta: 'Số phiếu sản xuất đang chạy hiện tại (trang_thai=DANG_CHAY).',
    run: () => scalar("SELECT count(*)::numeric AS v FROM phieu_san_xuat WHERE trang_thai = 'DANG_CHAY'") },
  { ma: 'LENH_RELEASE_2', ten: 'Lệnh đã Release 2 (chờ SX)', nhom: 'Sản xuất (hiện tại)', don_vi: 'lệnh',
    mo_ta: 'Số lệnh sản xuất đang ở trạng thái RELEASE_2 (sẵn sàng sản xuất).',
    run: () => scalar("SELECT count(*)::numeric AS v FROM lenh_san_xuat WHERE trang_thai = 'RELEASE_2'") },
  { ma: 'LENH_SAN_XUAT', ten: 'Lệnh đang sản xuất', nhom: 'Sản xuất (hiện tại)', don_vi: 'lệnh',
    mo_ta: 'Số lệnh sản xuất đang ở trạng thái SAN_XUAT.',
    run: () => scalar("SELECT count(*)::numeric AS v FROM lenh_san_xuat WHERE trang_thai = 'SAN_XUAT'") },

  // ---------- CHẤT LƯỢNG (hôm nay) ----------
  { ma: 'KCS_DAT_HOM_NAY', ten: 'SL đạt KCS hôm nay', nhom: 'Chất lượng (hôm nay)', don_vi: 'pcs',
    mo_ta: 'Tổng SL đạt khi KCS (sum kcs.so_luong_dat) trong hôm nay.',
    run: () => scalar(`SELECT COALESCE(sum(so_luong_dat),0)::numeric AS v FROM kcs WHERE ${TODAY_TS('created_date')}`) },
  { ma: 'KCS_LOI_HOM_NAY', ten: 'SL lỗi KCS hôm nay', nhom: 'Chất lượng (hôm nay)', don_vi: 'pcs',
    mo_ta: 'Tổng SL lỗi khi KCS (sum kcs.so_luong_loi) trong hôm nay.',
    run: () => scalar(`SELECT COALESCE(sum(so_luong_loi),0)::numeric AS v FROM kcs WHERE ${TODAY_TS('created_date')}`) },
  { ma: 'OQC_DAT_HOM_NAY', ten: 'OQC đạt hôm nay', nhom: 'Chất lượng (hôm nay)', don_vi: 'lần',
    mo_ta: 'Số lần OQC kết quả ĐẠT trong hôm nay.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM oqc WHERE ket_qua = 'DAT' AND ${TODAY_TS('created_date')}`) },
  { ma: 'OQC_KHONG_DAT_HOM_NAY', ten: 'OQC không đạt hôm nay', nhom: 'Chất lượng (hôm nay)', don_vi: 'lần',
    mo_ta: 'Số lần OQC kết quả KHÔNG ĐẠT trong hôm nay.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM oqc WHERE ket_qua = 'KHONG_DAT' AND ${TODAY_TS('created_date')}`) },
  { ma: 'LOI_INLINE_HOM_NAY', ten: 'SL lỗi QC in-line hôm nay', nhom: 'Chất lượng (hôm nay)', don_vi: 'pcs',
    mo_ta: 'Tổng SL lỗi QC in-line (sum qc_in_line.so_luong_loi) trong hôm nay.',
    run: () => scalar(`SELECT COALESCE(sum(so_luong_loi),0)::numeric AS v FROM qc_in_line WHERE ${TODAY_TS('created_date')}`) },

  // ---------- GIAO HÀNG (hôm nay) ----------
  { ma: 'PHIEU_GIAO_HOM_NAY', ten: 'Số phiếu giao hôm nay', nhom: 'Giao hàng (hôm nay)', don_vi: 'phiếu',
    mo_ta: 'Số phiếu giao đã giao (DA_GIAO) theo ngày giao = hôm nay.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM giao_hang WHERE trang_thai = 'DA_GIAO' AND ${TODAY_DT('ngay_giao')}`) },
  { ma: 'SL_GIAO_HOM_NAY', ten: 'Tổng SL giao hôm nay', nhom: 'Giao hàng (hôm nay)', don_vi: 'pcs',
    mo_ta: 'Tổng SL giao (sum giao_hang_tem.so_luong_giao) của phiếu DA_GIAO theo ngày giao = hôm nay.',
    run: () => scalar(`SELECT COALESCE(sum(gt.so_luong_giao),0)::numeric AS v FROM giao_hang_tem gt
      JOIN giao_hang gh ON gh.id = gt.giao_hang_id WHERE gh.trang_thai = 'DA_GIAO' AND ${TODAY_DT('gh.ngay_giao')}`) },
  { ma: 'TEM_GIAO_HOM_NAY', ten: 'Số tem giao hôm nay', nhom: 'Giao hàng (hôm nay)', don_vi: 'tem',
    mo_ta: 'Số tem đã giao (giao_hang_tem của phiếu DA_GIAO) theo ngày giao = hôm nay.',
    run: () => scalar(`SELECT count(*)::numeric AS v FROM giao_hang_tem gt
      JOIN giao_hang gh ON gh.id = gt.giao_hang_id WHERE gh.trang_thai = 'DA_GIAO' AND ${TODAY_DT('gh.ngay_giao')}`) },

  // ---------- TEM (hiện tại, theo trạng thái) ----------
  { ma: 'TEM_CHO_OQC', ten: 'Tem chờ OQC', nhom: 'Tem (hiện tại)', don_vi: 'tem',
    mo_ta: 'Số tem đang ở trạng thái CHO_OQC.',
    run: () => scalar("SELECT count(*)::numeric AS v FROM tem WHERE trang_thai = 'CHO_OQC'") },
  { ma: 'TEM_CHO_SUA', ten: 'Tem chờ sửa', nhom: 'Tem (hiện tại)', don_vi: 'tem',
    mo_ta: 'Số tem đang ở trạng thái CHO_SUA.',
    run: () => scalar("SELECT count(*)::numeric AS v FROM tem WHERE trang_thai = 'CHO_SUA'") },
  { ma: 'TEM_OQC_DAT', ten: 'Tem OQC đạt (chờ giao)', nhom: 'Tem (hiện tại)', don_vi: 'tem',
    mo_ta: 'Số tem đã OQC đạt, sẵn sàng giao (trang_thai=OQC_DAT).',
    run: () => scalar("SELECT count(*)::numeric AS v FROM tem WHERE trang_thai = 'OQC_DAT'") },
  { ma: 'TEM_DA_GIAO', ten: 'Tem đã giao', nhom: 'Tem (hiện tại)', don_vi: 'tem',
    mo_ta: 'Số tem đã giao (trang_thai=DA_GIAO). Lũy kế.',
    run: () => scalar("SELECT count(*)::numeric AS v FROM tem WHERE trang_thai = 'DA_GIAO'") },
];

// ================= HOÀN THÀNH THEO TRẠM & TỔNG THỂ (phần/mã/đơn) =================
// Chuỗi join từ phần in → tem (đợt vải → lệnh → phiếu → tem).
const TEM_CHAIN = `dot_vai_ve dv JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = dv.id
  JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = lsd.lenh_san_xuat_id
  JOIN tem t ON t.phieu_san_xuat_id = ps.id`;

// Điều kiện "đã hoàn thành / đi qua" từng trạm (dựa trên trạng thái runtime, KHÔNG cần migration 029).
const PRED = {
  READY: `EXISTS (SELECT 1 FROM ket_qua_checkpoint kq JOIN checkpoint cp ON cp.id = kq.checkpoint_id
            WHERE kq.phan_in_id = pin.id AND cp.ma_checkpoint = 'QC_XAC_NHAN' AND kq.trang_thai = 'DAT')`,
  TEST: `EXISTS (SELECT 1 FROM dot_vai_ve dv JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = dv.id
            JOIN ket_qua_checkpoint kq ON kq.lenh_san_xuat_id = lsd.lenh_san_xuat_id
            JOIN checkpoint cp ON cp.id = kq.checkpoint_id
            WHERE dv.phan_in_id = pin.id AND cp.ma_checkpoint = 'TEST_QA' AND kq.trang_thai = 'DAT')`,
  SANXUAT: `EXISTS (SELECT 1 FROM ${TEM_CHAIN} WHERE dv.phan_in_id = pin.id AND t.trang_thai <> 'HUY')`,
  KCS: `EXISTS (SELECT 1 FROM ${TEM_CHAIN} JOIN kcs k ON k.tem_id = t.id WHERE dv.phan_in_id = pin.id)`,
  OQC: `EXISTS (SELECT 1 FROM ${TEM_CHAIN} WHERE dv.phan_in_id = pin.id AND t.trang_thai IN ('OQC_DAT','DA_GIAO'))`,
  GIAO: `EXISTS (SELECT 1 FROM ${TEM_CHAIN} WHERE dv.phan_in_id = pin.id AND t.trang_thai = 'DA_GIAO')`,
};
// Có phát sinh sản xuất hôm nay (phiếu SX tạo hôm nay).
const PRED_CHAY_HOM_NAY = `EXISTS (SELECT 1 FROM dot_vai_ve dv JOIN lenh_sx_dot_vai lsd ON lsd.dot_vai_ve_id = dv.id
  JOIN phieu_san_xuat ps ON ps.lenh_san_xuat_id = lsd.lenh_san_xuat_id
  WHERE dv.phan_in_id = pin.id AND ${TODAY_TS('ps.created_date')})`;

const LEVEL_COL = { phan: 'pin.id', ma: 'mh.id', don: 'dh.id' };
// Đếm distinct phần in / mã hàng / đơn hàng thỏa điều kiện.
const countBy = (level, pred) =>
  `SELECT count(DISTINCT ${LEVEL_COL[level]})::numeric AS v
   FROM phan_in pin JOIN ma_hang mh ON mh.id = pin.ma_hang_id JOIN don_hang dh ON dh.id = mh.don_hang_id
   WHERE ${pred}`;

const STAGE_LABEL = { READY: 'READY', TEST: 'Test Run', SANXUAT: 'Sản xuất', KCS: 'KCS (kiểm)', OQC: 'OQC', GIAO: 'Giao hàng' };
const LEVELS = [{ k: 'phan', ten: 'phần in', dv: 'phần' }, { k: 'ma', ten: 'mã hàng', dv: 'mã' }, { k: 'don', ten: 'đơn hàng', dv: 'đơn' }];

// Tổng thể HÔM NAY: phần/mã/đơn có phát sinh sản xuất hôm nay.
LEVELS.forEach((lv) => DEFS.push({
  ma: `CHAY_HOM_NAY_${lv.k.toUpperCase()}`,
  ten: `Chạy SX hôm nay — ${lv.ten}`, nhom: 'Tổng thể hôm nay', don_vi: lv.dv,
  mo_ta: `Số ${lv.ten} có phiếu sản xuất tạo trong hôm nay (giờ VN).`,
  run: () => scalar(countBy(lv.k, PRED_CHAY_HOM_NAY)),
}));

// Hoàn thành/đã đi qua từng trạm — theo phần in / mã hàng / đơn hàng.
Object.entries(PRED).forEach(([st, pred]) => LEVELS.forEach((lv) => DEFS.push({
  ma: `HT_${st}_${lv.k.toUpperCase()}`,
  ten: `Đã qua ${STAGE_LABEL[st]} — ${lv.ten}`,
  nhom: `Hoàn thành theo trạm — ${lv.ten}`, don_vi: lv.dv,
  mo_ta: `Số ${lv.ten} đã hoàn thành / đi qua trạm ${STAGE_LABEL[st]} (hiện tại, lũy kế). Chia cho tổng ${lv.ten} (nhóm "Đơn hàng (tổng)") để ra tỉ lệ.`,
  run: () => scalar(countBy(lv.k, pred)),
})));

// ---------- PHẦN IN ĐANG Ở TRẠM (hiện tại) — đếm theo PHẦN IN, nguồn tin cậy như dashboard ----------
const PIN_STAGES = [
  { ma: 'PIN_O_READY', ten: 'Phần in đang ở READY', keys: ['READY_KT', 'READY_QA'] },
  { ma: 'PIN_O_RELEASE_1', ten: 'Phần in đang ở Release 1', keys: ['RELEASE_1'] },
  { ma: 'PIN_O_TEST_RUN', ten: 'Phần in đang ở Test Run', keys: ['TESTRUN_CNSP', 'TESTRUN_QA'] },
  { ma: 'PIN_O_RELEASE_2', ten: 'Phần in đang ở Release 2', keys: ['RELEASE_2'] },
  { ma: 'PIN_O_CHO_SAN_XUAT', ten: 'Phần in chờ sản xuất', keys: ['CHO_SAN_XUAT'] },
  { ma: 'PIN_O_SAN_XUAT', ten: 'Phần in đang sản xuất', keys: ['SAN_XUAT'] },
  { ma: 'PIN_O_CHO_KHO', ten: 'Phần in đang chờ khô', keys: ['CHO_KHO'] },
  { ma: 'PIN_O_KCS', ten: 'Phần in đang ở KCS (kiểm)', keys: ['KCS'] },
  { ma: 'PIN_O_SUA', ten: 'Phần in đang ở Sửa', keys: ['SUA'] },
  { ma: 'PIN_O_OQC', ten: 'Phần in đang ở OQC', keys: ['OQC'] },
  { ma: 'PIN_O_DANG_GIAO', ten: 'Phần in đang chờ giao', keys: ['DANG_GIAO'] },
];
PIN_STAGES.forEach((s) => DEFS.push({
  ma: s.ma, ten: s.ten, nhom: 'Phần in đang ở trạm (hiện tại)', don_vi: 'phần',
  mo_ta: `${s.ten} hiện tại — đếm theo phần in (giai đoạn suy từ trạng thái runtime, khớp dashboard).`,
  run: pinAtStage(s.keys),
}));

// ================= DÒNG CHẢY THEO CHECKPOINT (trả lời: hôm nay vào bao nhiêu, đi tiếp bao nhiêu,
//                    đang đứng bao nhiêu, nghẽn / sắp nghẽn bao nhiêu, kẹt ở đâu) =================
// NGUỒN (cố ý dùng đúng nguồn của dashboard để KHÔNG ra 2 con số đá nhau):
//   · Vào / Rời hôm nay → `lich_su_luan_chuyen` (nơi DUY NHẤT có mốc tg_bd/tg_kt của lượt chuyển trạm).
//   · Đang ở            → `dashboardRepo.stageCounts()` (dominant stage, y hệt ô giai đoạn dashboard).
//   · Nghẽn / sắp nghẽn → `dashboardRepo.flowRows()` + `slaStatus()` (y hệt bản đồ nghẽn dashboard).
// ⚠ `lich_su_luan_chuyen` do tracking.service ghi BEST-EFFORT ⇒ "Vào/Rời hôm nay" có thể thiếu lượt
//   nếu ghi log lỗi; "Đang ở"/"Nghẽn" thì luôn khớp dashboard vì suy từ trạng thái runtime.
const { slaStatus } = require('../../utils/sla');
// flowRows = query nặng → cache dùng chung với datasets.js (1 báo cáo có cả metric nghẽn lẫn khối danh sách).
const { flowRowsCached } = require('./flowCache');

// Đếm đợt vải đang ở trạm `maTram`; `st` = null → đếm hết, 'NGHEN'/'SAP_NGHEN' → lọc theo SLA.
// Cùng 1 nguồn (flowRows) nên LUÔN cộng khớp: Nghẽn + Sắp nghẽn ≤ Đợt đang ở.
const slaCount = (maTram, st) => async () => {
  const rows = await flowRowsCached();
  return rows.filter((r) => r.ma_tram === maTram
    && (st === null || slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut) === st)).length;
};

// Số PHẦN IN vào trạm trong hôm nay (lượt chuyển tới trạm — `den_tram_id`).
const vaoTramHomNay = (maTram) =>
  `SELECT count(DISTINCT l.phan_in_id)::numeric AS v FROM lich_su_luan_chuyen l
   JOIN tram tr ON tr.id = l.den_tram_id
   WHERE tr.ma_tram = '${maTram}' AND ${TODAY_TS('l.tg_bd')}`;

// Số PHẦN IN rời trạm trong hôm nay (hoàn tất trạm đó & đi tiếp — mốc `tg_kt` của lượt Ở trạm này).
const roiTramHomNay = (maTram) =>
  `SELECT count(DISTINCT l.phan_in_id)::numeric AS v FROM lich_su_luan_chuyen l
   JOIN tram tr ON tr.id = l.den_tram_id
   WHERE tr.ma_tram = '${maTram}' AND l.tg_kt IS NOT NULL AND ${TODAY_TS('l.tg_kt')}`;

// Trạm (checkpoint) đưa vào catalog + map sang key stageCounts (dominant) của dashboard.
// stageCounts tách READY→READY_KT/READY_QA và Test Run→TESTRUN_CNSP/TESTRUN_QA nên phải gộp lại.
const CP_FLOW = [
  { ma: 'READY', ten: 'READY (chuẩn bị KT)', sc: ['READY_KT', 'READY_QA'] },
  { ma: 'RELEASE_1', ten: 'Release 1', sc: ['RELEASE_1'] },
  { ma: 'TEST_RUN', ten: 'Test Run', sc: ['TESTRUN_CNSP', 'TESTRUN_QA'] },
  { ma: 'RELEASE_2', ten: 'Release 2', sc: ['RELEASE_2'] },
  { ma: 'SAN_XUAT', ten: 'Sản xuất', sc: ['CHO_SAN_XUAT', 'SAN_XUAT'] },
  { ma: 'CHO_KHO', ten: 'Chờ khô', sc: ['CHO_KHO'] },
  { ma: 'KIEM', ten: 'KCS (kiểm)', sc: ['KCS'] },
  { ma: 'SUA', ten: 'Sửa', sc: ['SUA'] },
  { ma: 'OQC', ten: 'OQC', sc: ['OQC'] },
  { ma: 'FINISH', ten: 'Hoàn tất', sc: ['DANG_GIAO'] },
];

CP_FLOW.forEach((cp) => {
  const nhom = `Dòng chảy theo checkpoint — ${cp.ten}`;
  DEFS.push(
    { ma: `CP_${cp.ma}_VAO_HOM_NAY`, ten: `${cp.ten}: Vào hôm nay`, nhom, don_vi: 'phần',
      mo_ta: `Số phần in CHUYỂN VÀO checkpoint ${cp.ten} trong hôm nay (giờ VN, theo lịch sử luân chuyển).`,
      run: () => scalar(vaoTramHomNay(cp.ma)) },
    { ma: `CP_${cp.ma}_ROI_HOM_NAY`, ten: `${cp.ten}: Hoàn tất & qua trạm khác hôm nay`, nhom, don_vi: 'phần',
      mo_ta: `Số phần in ĐÃ RỜI checkpoint ${cp.ten} (làm xong, đi tiếp trạm sau) trong hôm nay.`,
      run: () => scalar(roiTramHomNay(cp.ma)) },
    { ma: `CP_${cp.ma}_DANG_O`, ten: `${cp.ten}: Đang ở checkpoint (phần in)`, nhom, don_vi: 'phần',
      mo_ta: `Số PHẦN IN hiện đang ở checkpoint ${cp.ten} — dominant stage, KHỚP ô giai đoạn của dashboard.`
        + ' ⚠ Khác đơn vị với "Nghẽn/Sắp nghẽn" (đếm ĐỢT VẢI): muốn 1 hàng cộng khớp thì dùng'
        + ' "Đang ở checkpoint (đợt vải)" thay cho ô này.',
      run: pinAtStage(cp.sc) },
    { ma: `CP_${cp.ma}_DOT_DANG_O`, ten: `${cp.ten}: Đang ở checkpoint (đợt vải)`, nhom, don_vi: 'đợt',
      mo_ta: `Số ĐỢT VẢI hiện đang ở checkpoint ${cp.ten}. Cùng nguồn với Nghẽn/Sắp nghẽn nên LUÔN cộng khớp:`
        + ' Nghẽn + Sắp nghẽn + đúng hạn = ô này.',
      run: slaCount(cp.ma, null) },
    { ma: `CP_${cp.ma}_NGHEN`, ten: `${cp.ten}: Nghẽn (quá SLA)`, nhom, don_vi: 'đợt',
      mo_ta: `Số ĐỢT VẢI đang kẹt ở ${cp.ten} QUÁ thời gian SLA của trạm (khớp bản đồ nghẽn dashboard).`,
      run: slaCount(cp.ma, 'NGHEN') },
    { ma: `CP_${cp.ma}_SAP_NGHEN`, ten: `${cp.ten}: Sắp nghẽn`, nhom, don_vi: 'đợt',
      mo_ta: `Số ĐỢT VẢI ở ${cp.ten} sắp quá SLA (đã vào ngưỡng cảnh báo trước của trạm).`,
      run: slaCount(cp.ma, 'SAP_NGHEN') },
  );
});

// ---------- ĐIỂM NGHẼN (text) — "kẹt ở đâu, vì sao" ----------
DEFS.push(
  { ma: 'DIEM_NGHEN_NANG_NHAT', ten: 'Điểm nghẽn nặng nhất', nhom: 'Điểm nghẽn (hiện tại)', don_vi: 'trạm', kieu: 'text',
    mo_ta: 'Checkpoint đang nghẽn nhiều nhất + số đợt đang quá SLA. Không có nghẽn → "OK." (giống cột "Điểm nghẽn" của báo cáo giấy).',
    run: async () => {
      const rows = await flowRowsCached();
      const dem = {};
      rows.forEach((r) => {
        if (slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut) !== 'NGHEN') return;
        const k = r.ten_tram || r.ma_tram;
        dem[k] = (dem[k] || 0) + 1;
      });
      const top = Object.entries(dem).sort((a, b) => b[1] - a[1])[0];
      return top ? `${top[0]} (${top[1]} đợt quá SLA)` : 'OK.';
    } },
  { ma: 'TONG_NGHEN_MOI_TRAM', ten: 'Tổng nghẽn (mọi checkpoint)', nhom: 'Điểm nghẽn (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Tổng số đợt vải đang quá SLA trên TOÀN BỘ dòng chảy.',
    run: async () => (await flowRowsCached())
      .filter((r) => slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut) === 'NGHEN').length },
  { ma: 'TONG_SAP_NGHEN_MOI_TRAM', ten: 'Tổng sắp nghẽn (mọi checkpoint)', nhom: 'Điểm nghẽn (hiện tại)', don_vi: 'đợt',
    mo_ta: 'Tổng số đợt vải sắp quá SLA trên TOÀN BỘ dòng chảy.',
    run: async () => (await flowRowsCached())
      .filter((r) => slaStatus(r.phut_da_o, r.sla_phut, r.canh_bao_truoc_phut) === 'SAP_NGHEN').length },
);

const BY_MA = Object.fromEntries(DEFS.map((d) => [d.ma, d]));

// Danh mục cho FE (không kèm hàm run).
function catalog() {
  return DEFS.map(({ run, ...d }) => ({ ...d, kieu: d.kieu || 'so' }));
}

// Tính giá trị cho 1 tập mã metric (chỉ metric được dùng) → { ma: value }. Giá trị realtime.
async function compute(maList) {
  const uniq = [...new Set(maList)].filter((ma) => BY_MA[ma]);
  const results = await Promise.all(uniq.map(async (ma) => {
    try { return [ma, await BY_MA[ma].run()]; }
    catch (e) { return [ma, { loi: e.message }]; }
  }));
  return Object.fromEntries(results);
}

module.exports = { catalog, compute, BY_MA };
