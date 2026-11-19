'use strict';

const repo = require('./lichsuphanin.repository');
const AppError = require('../../utils/AppError');
const { maTemNhan } = require('../../utils/temPrefix');

// ─────────────────────────────────────────────────────────────────────────────
// LỊCH SỬ PHẦN IN — dựng dòng thời gian MỌI sự kiện của 1 phần in (repository gom nguồn). Mỗi sự kiện:
//   { id, tg, nhom, ma, tieu_de, chi_tiet, doi_tuong, nguoi, tu_dong, tra_ve, huy, loi, cu, moi }
//   · `nhom` — DON_HANG · READY · KE_HOACH · TEST_RUN · SAN_XUAT · CHAT_LUONG · GIAO_HANG · TRA_VE · ERP · HE_THONG
//   · `tu_dong` — hệ thống / đồng bộ ERP / job tự làm (không có người) · `tra_ve` / `huy` — để lọc nhanh
//   · `cu` / `moi` — vết gốc (audit) cho ô "Chi tiết"; kênh API ERP chỉ có bản tóm tắt.
// Nhãn hành động: `HANH_DONG` dưới đây; mã chưa khai ⇒ hiện nguyên mã (không mất sự kiện).
// ─────────────────────────────────────────────────────────────────────────────
const NHOM = {
  DON_HANG: 'Đơn hàng & ERP', READY: 'READY (Kỹ thuật / QC)', KE_HOACH: 'Kế hoạch', TEST_RUN: 'Test Run',
  SAN_XUAT: 'Sản xuất & tem', CHAT_LUONG: 'KCS · Sửa · OQC', GIAO_HANG: 'Giao hàng', TRA_VE: 'Trả về',
  ERP: 'Gửi ERP', HE_THONG: 'Hệ thống / Quản trị',
};

// [nhóm, nhãn, cờ] — cờ: 'h' hủy · 't' trả về · 'a' luôn tự động.
const HANH_DONG = {
  // phần in
  ERP_DONG_BO_DOI: ['DON_HANG', 'Đồng bộ ERP thay đổi thông tin', 'a'],
  ERP_CAP_NHAT_CODE_PHAN: ['DON_HANG', 'Cập nhật lại theo code phần (ERP)'],
  HUY_PHAN_IN: ['DON_HANG', 'Hủy phần in', 'h'], MO_PHAN_IN: ['DON_HANG', 'Mở lại phần in'],
  MO_PHAN_IN_DOT_MOI: ['DON_HANG', 'Tự mở lại phần in vì có đợt vải mới', 'a'],
  KHOA_ERP: ['HE_THONG', 'Khóa đồng bộ ERP'], MO_KHOA_ERP: ['HE_THONG', 'Mở khóa đồng bộ ERP'],
  DOI_LUONG_SX: ['HE_THONG', 'Đổi luồng sản xuất'], BO_CONG_DOAN: ['HE_THONG', 'Bỏ 1 công đoạn'],
  THEM_CONG_DOAN: ['HE_THONG', 'Thêm 1 công đoạn'],
  QUAN_TRI_SUA_PHAN_IN: ['HE_THONG', 'Quản trị: sửa phần in'], QUAN_TRI_HUY_LE: ['HE_THONG', 'Quản trị: hủy lẻ bản ghi', 'h'],
  QUAN_TRI_HUY_MUC_READY: ['HE_THONG', 'Quản trị: hủy mục READY', 'h'],
  MO_LAI_READY: ['READY', 'Mở lại READY'],
  TU_XAC_NHAN_READY_THEO_DOT: ['READY', 'Hệ thống tự xác nhận READY theo đợt (KTCankiemtra = 0)', 'a'],
  QC_XAC_NHAN_THEO_DOT: ['READY', 'QC xác nhận READY theo đợt'],
  TRA_VE_KY_THUAT: ['TRA_VE', 'Release 1 trả về Kỹ thuật', 't'],
  // READY
  HUY_XAC_NHAN: ['READY', 'Hủy xác nhận', 'h'],
  KHOI_PHUC_READY_TU_DONG_DE: ['READY', 'Khôi phục xác nhận READY bị lượt tự động ghi đè', 'a'],
  NHAN_FILE_BH: ['READY', 'Nhận file Bán hàng'], HUY_NHAN_FILE_BH: ['READY', 'Hủy nhận file Bán hàng', 'h'],
  // đợt vải
  HUY_DOT_VAI: ['DON_HANG', 'Hủy đợt vải', 'h'], MO_DOT_VAI: ['DON_HANG', 'Mở lại đợt vải'],
  QUAN_TRI_DAT_GIAI_DOAN: ['HE_THONG', 'Quản trị: đặt lại giai đoạn đợt', 't'],
  QUAN_TRI_SUA_DOT_VAI: ['HE_THONG', 'Quản trị: sửa đợt vải'],
  THEM_DAU_BTP: ['KE_HOACH', 'Thêm 1 đầu BTP khác kế hoạch'], BO_DAU_BTP: ['KE_HOACH', 'Bỏ đầu BTP chờ'],
  // kế hoạch tạm
  LUU_KE_HOACH_TAM: ['KE_HOACH', 'Lưu kế hoạch tạm'], SUA_KE_HOACH_TAM: ['KE_HOACH', 'Sửa kế hoạch tạm'],
  XAC_NHAN_KE_HOACH_TAM: ['KE_HOACH', 'Xác nhận kế hoạch tạm → Release 1'], XOA_KE_HOACH_TAM: ['KE_HOACH', 'Xóa kế hoạch tạm', 'h'],
  HUY_KE_HOACH_TAM: ['KE_HOACH', 'Hủy kế hoạch tạm', 'h'], QUAN_TRI_SUA_KE_HOACH: ['HE_THONG', 'Quản trị: sửa kế hoạch'],
  // lệnh
  TAO_LENH_CONG_DOAN: ['KE_HOACH', 'Tạo lệnh theo công đoạn'],
  REPLAN: ['KE_HOACH', 'Sửa / lập lại kế hoạch'], UPDATE_SL_RELEASE: ['KE_HOACH', 'Cập nhật SL release'],
  RELEASE_2: ['KE_HOACH', 'Release 2 (duyệt chạy)'], HUY_RELEASE_2: ['KE_HOACH', 'Hủy Release 2', 'h'],
  XAC_NHAN_LAI_RELEASE_1: ['KE_HOACH', 'Xác nhận lại Release 1'],
  GOP_LENH_SX: ['SAN_XUAT', 'Gộp lệnh khác vào lệnh này (chạy chung)'], GOP_VAO_LENH: ['SAN_XUAT', 'Lệnh được gộp vào lệnh khác (chạy chung)'],
  TACH_LENH_NGC: ['SAN_XUAT', 'Tách lệnh theo nhà gia công'],
  TACH_LENH_GOP: ['KE_HOACH', 'Tách 1 lệnh ra khỏi lệnh gộp (chạy chung)', 't'],
  HUY_LENH: ['KE_HOACH', 'Hủy lệnh sản xuất', 'h'], HUY_LAN_TEST: ['TEST_RUN', 'Hủy lần test', 'h'],
  TRA_VE_KY_THUAT_TEST_RUN: ['TRA_VE', 'Test Run trả về Kỹ thuật', 't'],
  TRA_VE_KY_THUAT_RELEASE_2: ['TRA_VE', 'Release 2 trả về Kỹ thuật', 't'],
  TRA_VE_KY_THUAT_SAN_XUAT: ['TRA_VE', 'Sản xuất trả về Kỹ thuật', 't'],
  TRA_VE_KE_HOACH_TEST_RUN: ['TRA_VE', 'Test Run trả về Kế hoạch', 't'],
  TRA_VE_KE_HOACH_SX: ['TRA_VE', 'Sản xuất trả về Kế hoạch (đang chạy)', 't'],
  QUAN_TRI_LUI_VE: ['HE_THONG', 'Quản trị: lùi lệnh về trạm', 't'],
  GIA_CONG_CHUYEN_OQC: ['SAN_XUAT', 'Nhận hàng gia công → OQC'],
  CHAY_DAC_BIET_BO_TEST: ['SAN_XUAT', 'Chạy đặc biệt (bỏ Test Run)'],
  HE_THONG_CHAY_DEN_GIAO: ['HE_THONG', 'Script hệ thống chạy đến giao', 'a'],
  HOAN_TAC_CHAY_DEN_GIAO: ['HE_THONG', 'Hoàn tác script chạy đến giao', 'a'],
  // phiếu
  CHAY_HOAN_TAT: ['SAN_XUAT', 'Chạy hoàn tất'], DONG_LENH_SX: ['SAN_XUAT', 'Đóng lệnh sản xuất'],
  MO_LAI_LENH_SX: ['SAN_XUAT', 'Mở lại lệnh sản xuất'], DOI_CHUYEN: ['SAN_XUAT', 'Đổi chuyền chạy'],
  HUY_XAC_NHAN_CHAY: ['SAN_XUAT', 'Hủy xác nhận chạy', 'h'], VAI_CHO_TEM: ['SAN_XUAT', 'Ghi vải hủy / thiếu chờ tem'],
  // tem
  SUA_TEM: ['SAN_XUAT', 'Sửa tem'], SUA_VAI_THEO_TEM: ['SAN_XUAT', 'Sửa vải hủy / thiếu của tem'],
  HUY_IN_TEM: ['SAN_XUAT', 'Hủy tem in', 'h'], MO_LAI_TEM_IN: ['SAN_XUAT', 'Mở lại tem in'],
  NGAY_CT_TEM: ['SAN_XUAT', 'Ngày chứng từ của tem'], XAC_NHAN_KHO: ['SAN_XUAT', 'Xác nhận khô (sớm)'],
  SUA_PHAN_CONG_TEM: ['SAN_XUAT', 'Sửa phân công của tem'],
  PHAN_LOAI_LOI: ['CHAT_LUONG', 'Phân loại lỗi'], HUY_PHAN_LOAI_LOI: ['CHAT_LUONG', 'Hủy phân loại lỗi', 'h'],
  HUY_TEM_SUA: ['CHAT_LUONG', 'Hủy tem sửa', 'h'], MO_TEM_SUA: ['CHAT_LUONG', 'Mở lại tem sửa'],
  TICH_GIAO: ['GIAO_HANG', 'Giao nhận tích tem'], BO_TICH_GIAO: ['GIAO_HANG', 'Bỏ tích tem giao', 'h'],
  OQC_TRA_VE_KCS: ['TRA_VE', 'OQC trả về — trừ lượt KCS', 't'], GUI_ERP_KHI_IN_TEM_17: ['ERP', 'Đã gửi SK6 khi in tem 17', 'a'],
  IN_KHONG_DAT: ['TEST_RUN', 'Test Run: in không đạt — owner cho in'],
  // giao
  HUY_PHIEU_GIAO: ['GIAO_HANG', 'Hủy phiếu giao', 'h'], SUA_GIAO_HANG_TAI: ['GIAO_HANG', 'Sửa "Giao hàng tại"'],
  // trả về GN
  TRA_VE_GN: ['TRA_VE', 'Trả về Giao nhận', 't'], GN_ERP_HUY: ['TRA_VE', 'Đã gửi ERP hủy đợt READY (trả về GN)', 'a'],
  GN_ERP_VANG: ['TRA_VE', 'ERP không còn gửi đợt (GN đang sửa)', 'a'], GN_ERP_NHAN_LAI: ['TRA_VE', 'ERP gửi lại đợt sau khi GN sửa', 'a'],
  GN_ERP_CAP_NHAT: ['TRA_VE', 'Cập nhật thông tin theo ERP (GN sửa)', 'a'], GN_XAC_NHAN_LAI: ['TRA_VE', 'GN xác nhận lại — phần in về màn cũ'],
  GN_HUY_DOT_VAI: ['TRA_VE', 'GN hủy vải không in', 'h'],
  // gom set / HSKT
  CREATE_SET: ['DON_HANG', 'Gom set'], RELEASE_SET: ['KE_HOACH', 'Release theo set'],
  NAN_HSKT_GAN_SAI_PHAN_IN: ['HE_THONG', 'Nắn HSKT gắn sai phần in', 'a'],
};
// Bỏ hẳn (trùng với sự kiện dựng từ bảng gốc): người kiểm KCS gắn vào dòng KCS; xác nhận giao = dòng phiếu giao.
const BO_AUDIT = new Set(['NGUOI_KIEM_KCS', 'XAC_NHAN_GIAO', 'DAU_CA_IN_TEM', 'DAU_CA_PHAN_CONG']);

const KENH_ERP = {
  ERP_GHI_IN_TEM: 'in tem (SF0)', ERP_GUI_TEM_GIA_CONG: 'tem gia công (JQ6)', ERP_GUI_KIEM_PHAM: 'kiểm phẩm KCS (Sh6)',
  ERP_GUI_SUA_DAT: 'sửa đạt (SK6)', ERP_GUI_OQC: 'OQC (QO6)', ERP_GUI_PHAN_LOAI_LOI: 'phân loại lỗi (SU6)',
  ERP_GUI_PHIEU_GIAO: 'phiếu giao (SQ0)', ERP_GUI_RELEASE_1: 'kế hoạch Release 1', ERP_GUI_HUY_RELEASE_1: 'hủy kế hoạch Release 1',
  ERP_GUI_HUY_IDMES: 'hủy chứng từ', ERP_GUI_DS_HUY_VAI: 'hủy đợt READY (trả về GN)', ERP_DS_SUA_THONG_TIN: 'danh sách sửa thông tin',
};

const LOAI_TRA_VE = {
  READY: 'QC READY trả về Kỹ thuật', RELEASE1: 'Release 1 trả về Kỹ thuật', TEST_RUN: 'Test Run không đạt (đợt)',
  TEST_RUN_KT: 'Trả về Kỹ thuật (Test Run / Release 2)', TEST_RUN_KH: 'Test Run trả về Kế hoạch', OQC: 'OQC trả về KCS',
  OQC_SUA: 'OQC trả về Sửa', OQC_GIA_CONG: 'OQC hàng gia công trả về Kế hoạch', TRA_VE_GN: 'Trả về Giao nhận',
};
const KQ_TEST = { DAT: 'Đạt', CO_LOI: 'Có lỗi (không đạt)', KHONG_DAT_CHO_IN: 'In không đạt — owner cho in', HUY: 'Lượt test đã hủy' };

// Nhãn khóa trong vết (gia_tri_cu / gia_tri_moi) cho dòng chi tiết.
const NHAN_KHOA = {
  so_luong_release: 'SL release', ngay_ke_hoach: 'Ngày KH', gio_bd: 'Giờ BĐ', gio_kt: 'Giờ KT', chuyen_id: 'Chuyền',
  tho_in_kh: 'Thợ in KH', dinh_muc_gio: 'Định mức', ly_do: 'Lý do', nguon: 'Nguồn', trang_thai: 'Trạng thái',
  vao_lenh: 'Gộp vào', tu_lenh: 'Gộp từ', so_tem_chuyen: 'Tem chuyển', han_giao_hang: 'Hạn giao', ngay_vai_ve: 'Ngày vải về',
  loai_dot_vai_id: 'Loại đợt', mau_vai: 'Màu vải', kich_vai: 'Kích vải', kich_phim: 'Kích film', so_luong_don_hang: 'SLĐH',
  tinh_chat_in: 'Tính chất in', mau_in: 'Màu mực', barcode: 'Mã vạch', ddh_sub_id: 'DDHSUBID', inset: 'Inset',
  nha_gia_cong: 'NGC', du_an: 'Dự án', so_dau_btp: 'Số đầu BTP', ghi_chu: 'Ghi chú', owner: 'Owner', so_luong: 'SL',
  ma_lenh: 'Lệnh', chuyen_cu: 'Chuyền cũ', chuyen_moi: 'Chuyền mới', dich: 'Đích', so_buoc: 'Số bước', tra_ve: 'SL trả về',
  cach: 'Cách', da_in: 'Đã in', luong_sx: 'Luồng', bo: 'Bỏ công đoạn', ma: 'Mục', ten: 'Tên', lsd_so_luong: 'SL đợt',
  sl_bo_sung_cty: 'BS công ty', sl_bo_sung_khach: 'BS khách', ma_ngay_ca: 'Mã ngày ca', gio_sx_bd: 'Giờ SX từ', gio_sx_kt: 'Giờ SX đến',
  gc_mau_vai: 'GC màu vải', ngay_ct: 'Ngày CT', so_luong_kiem: 'SL kiểm', ve_man: 'Về màn', nguon_ten: 'Từ màn',
  owner_ten: 'Owner', ly_do_khac: 'Lý do khác', bo_test_run: 'Không test run', qa_ngoai_gio: 'QA ngoài giờ',
  ma_dot_vai: 'Đợt', chi_tiet: 'Chi tiết', so_phut: 'Số phút', som_phut: 'Khô sớm (phút)', d_nhan: 'Hạ đã nhận',
  ma_tem: 'Mã tem', sl_hu: 'SL hư', sl_kcs_huy: 'Hủy', sl_kcs_sua: 'Sửa', so_dong: 'Số dòng lỗi', khac: 'Khác',
  trang_thai_cu: 'Trạng thái trước', phan_cong: 'Phân công', ngay_ca: 'Ngày ca', thong_tin: 'Mục sai',
  tg_kt_phoi_du_kien: 'Khô dự kiến', ket_qua: 'Kết quả', ma_set: 'Set',
};
const THU_TU_KHOA = Object.keys(NHAN_KHOA);
const BO_KHOA = new Set(['id', 'phan_in_id', 'tu_lenh_ids', 'vao_lenh_id', 'lenh_id', 'phieu_id', 'xe_phoi_ids', 'sau',
  'dot_vai_ids', 'dot_vai_id', 'checklist_list', 'tem_ids', 'owner_ids', 'nguoi_id', 'nguoi_xac_nhan_id']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NGAY = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

function giaTri(v, ten) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Có' : 'Không';
  if (Array.isArray(v)) return v.map((x) => giaTri(x, ten)).join(', ');
  if (typeof v === 'object') return v.ma || v.ten || v.ma_lenh || v.tho_in || JSON.stringify(v).slice(0, 80);
  const s = String(v);
  if (UUID.test(s)) return ten.get(s) || '…';
  const m = s.match(NGAY);
  if (m && s.length <= 10) return `${m[3]}/${m[2]}/${m[1]}`;
  if (m) { const d = new Date(s); if (!Number.isNaN(+d)) return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }); }
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

// Dòng chi tiết từ vết: "Nhãn: cũ → mới" (đổi) · "Nhãn: mới" (chỉ có mới).
function chiTietVet(cu, moi, ten) {
  const a = cu && typeof cu === 'object' ? cu : {};
  const b = moi && typeof moi === 'object' ? moi : {};
  const out = [];
  // Thứ tự theo `NHAN_KHOA` (SL · ngày · giờ · chuyền trước), Lý do / Nguồn xuống cuối.
  const viTri = (k) => (k === 'ly_do' || k === 'nguon' ? 900 : THU_TU_KHOA.indexOf(k));
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !BO_KHOA.has(k) && NHAN_KHOA[k])
    .sort((x, y) => viTri(x) - viTri(y));
  for (const k of keys) {
    const nhan = NHAN_KHOA[k];
    if (!nhan) continue;
    const coA = k in a; const coB = k in b;
    if (coA && coB) {
      const x = giaTri(a[k], ten); const y = giaTri(b[k], ten);
      out.push(x === y ? `${nhan}: ${y}` : `${nhan}: ${x} → ${y}`);
    } else if (coB) out.push(`${nhan}: ${giaTri(b[k], ten)}`);
    else out.push(`${nhan} (cũ): ${giaTri(a[k], ten)}`);
    if (out.length >= 10) break;
  }
  return out.join(' · ');
}

const rutGon = (j) => {
  if (j == null) return null;
  const s = JSON.stringify(j);
  return s.length > 6000 ? { _rut_gon: true, noi_dung: `${s.slice(0, 6000)}…` } : j;
};
const tgMs = (v) => (v ? new Date(v).getTime() : 0);
const so = (v) => (v == null ? 0 : Number(v) || 0);
const fmtSo = (v) => so(v).toLocaleString('vi-VN');

async function timPhanIn(q) {
  return repo.timPhanIn(q);
}

async function lichSu(phanInId) {
  if (!UUID.test(String(phanInId || ''))) throw new AppError('Mã phần in không hợp lệ', { status: 422, errorCode: 'VALIDATION' });
  const info = await repo.thongTinPhanIn(phanInId);
  if (!info) throw new AppError('Không tìm thấy phần in', { status: 404, errorCode: 'NOT_FOUND' });
  const pv = await repo.phamVi(phanInId);
  const [audit, B] = await Promise.all([repo.auditTrongPhamVi(pv), repo.suKienBang(pv)]);

  // Tên người + tên cho id trong vết.
  const idNguoi = [info.created_by];
  const thuId = (o) => { if (o && typeof o === 'object') Object.values(o).forEach((v) => { if (typeof v === 'string' && UUID.test(v)) idNguoi.push(v); }); };
  audit.forEach((a) => { idNguoi.push(a.nguoi_thuc_hien_id); thuId(a.gia_tri_cu); thuId(a.gia_tri_moi); });
  Object.values(B).forEach((rows) => (rows || []).forEach((r) => {
    ['created_by', 'updated_by', 'nguoi_thuc_hien_id', 'nguoi_xac_nhan_id', 'nguoi_in_id', 'nguoi_id', 'owner_cho_giao_id'].forEach((k) => idNguoi.push(r[k]));
  }));
  const [nguoiMap, tenMap] = await Promise.all([repo.tenNguoi(idNguoi), repo.tenTheoId(idNguoi)]);
  const nguoi = (id) => { const u = id && nguoiMap.get(String(id)); return u ? u.ho_ten || u.ten_dang_nhap : null; };

  const E = [];
  const them = (e) => E.push({ tu_dong: false, tra_ve: false, huy: false, loi: false, cu: null, moi: null, chi_tiet: '', doi_tuong: '', ...e });
  const maTem = (m) => (m ? maTemNhan(m) : '');

  // ── AUDIT ─────────────────────────────────────────────────────────────────
  const maLenh = new Map(pv.lenhs.map((l) => [String(l.id), l.ma_lenh_san_xuat]));
  const maDot = new Map(pv.dots.map((d) => [String(d.id), d.ma_dot_vai]));
  const maTemTheoId = new Map((B.tem || []).map((t) => [String(t.id), t.ma_tem]));
  const kcsNguoi = new Map(audit.filter((a) => a.hanh_dong === 'NGUOI_KIEM_KCS')
    .map((a) => [a.id_ban_ghi, (a.gia_tri_moi && (a.gia_tri_moi.ten || a.gia_tri_moi.nguoi_kiem || a.gia_tri_moi.ho_ten)) || '']));
  const coAuditKho = new Set(audit.filter((a) => a.hanh_dong === 'XAC_NHAN_KHO').map((a) => a.id_ban_ghi));
  const coAuditPll = new Set(audit.filter((a) => a.hanh_dong === 'PHAN_LOAI_LOI').map((a) => a.id_ban_ghi));
  const phieuHoanTat = new Set(audit.filter((a) => ['CHAY_HOAN_TAT', 'DONG_LENH_SX'].includes(a.hanh_dong)).map((a) => a.id_ban_ghi));
  const doiTuongAudit = (a) => {
    const id = a.id_ban_ghi;
    switch (a.ten_bang) {
      case 'lenh_san_xuat': return maLenh.get(id) || '';
      case 'dot_vai_ve': case 'ke_hoach_tam': case 'nhan_file_bh': return maDot.get(id) ? `Đợt ${maDot.get(id)}` : '';
      case 'tem': case 'tem_phan_cong': return maTemTheoId.get(id) ? `Tem ${maTem(maTemTheoId.get(id))}` : '';
      default: return '';
    }
  };
  for (const a of audit) {
    if (BO_AUDIT.has(a.hanh_dong)) continue;
    const laErp = /^ERP_/.test(a.hanh_dong) && !['ERP_DONG_BO_DOI', 'ERP_CAP_NHAT_CODE_PHAN'].includes(a.hanh_dong);
    const loiErp = laErp && /_LOI$/.test(a.hanh_dong);
    if (laErp) {
      const ma = a.hanh_dong.replace(/_LOI$/, '');
      const m = a.gia_tri_moi || {};
      const ok = !loiErp && m.thanh_cong !== false;
      them({
        id: `a${a.id}`, tg: a.thoi_gian, nhom: 'ERP', ma: a.hanh_dong,
        tieu_de: `Gửi ERP ${KENH_ERP[ma] || ma} — ${ok ? 'thành công' : 'LỖI'}`,
        chi_tiet: [m.id_mes && `IDMES ${m.id_mes}`, m.nguon && `Nguồn ${m.nguon}`, m.so_luong != null && `SL ${fmtSo(m.so_luong)}`,
          m.tu_gui_lai && `hàng đợi tự gửi lại lần ${m.tu_gui_lai.lan || ''}`, m.sua_tay && 'sửa & gửi tay',
          !ok && (m.erp_message || m.loi)].filter(Boolean).join(' · '),
        doi_tuong: doiTuongAudit(a) || (m.ma_tem ? String(m.ma_tem) : ''), nguoi: nguoi(a.nguoi_thuc_hien_id),
        tu_dong: !a.nguoi_thuc_hien_id || !!m.tu_gui_lai, loi: !ok, moi: rutGon(m),
      });
      continue;
    }
    const [nhom, nhan, co] = HANH_DONG[a.hanh_dong] || ['HE_THONG', a.hanh_dong.replace(/_/g, ' ').toLowerCase()];
    let tieuDe = nhan;
    if (a.hanh_dong === 'HUY_XAC_NHAN') {
      const bang = { kcs: 'KCS', sua: 'Sửa', oqc: 'OQC', ket_qua_checkpoint: 'READY' }[a.ten_bang] || a.ten_bang;
      tieuDe = `Hủy xác nhận ${bang}`;
    }
    if (a.ten_bang === 'ket_qua_checkpoint' && a.gia_tri_moi && a.gia_tri_moi.ma) {
      tieuDe += ` — ${[].concat(a.gia_tri_moi.ma).join(', ')}`;
    }
    const nhomThat = a.hanh_dong === 'HUY_XAC_NHAN' && ['kcs', 'sua', 'oqc'].includes(a.ten_bang) ? 'CHAT_LUONG' : nhom;
    them({
      id: `a${a.id}`, tg: a.thoi_gian, nhom: nhomThat, ma: a.hanh_dong, tieu_de: tieuDe,
      chi_tiet: chiTietVet(a.gia_tri_cu, a.gia_tri_moi, tenMap),
      doi_tuong: doiTuongAudit(a), nguoi: nguoi(a.nguoi_thuc_hien_id),
      tu_dong: !a.nguoi_thuc_hien_id || (co || '').includes('a'), tra_ve: (co || '').includes('t'), huy: (co || '').includes('h'),
      cu: rutGon(a.gia_tri_cu), moi: rutGon(a.gia_tri_moi),
    });
  }

  // ── BẢNG GỐC ──────────────────────────────────────────────────────────────
  them({ id: `pin${info.id}`, tg: info.created_date, nhom: 'DON_HANG', ma: 'TAO_PHAN_IN', tieu_de: 'Phần in lên MES',
    chi_tiet: [info.ma_phan, info.mau_vai, info.kich_vai, info.kich_phim].filter(Boolean).join(' · '),
    nguoi: nguoi(info.created_by), tu_dong: !info.created_by });

  (B.dot || []).forEach((d) => {
    them({ id: `dot${d.id}`, tg: d.created_date, nhom: 'DON_HANG', ma: 'TAO_DOT_VAI',
      tieu_de: d.created_by ? 'Nhập tay đợt vải' : 'Đợt vải về từ ERP', doi_tuong: `Đợt ${d.ma_dot_vai}`,
      chi_tiet: [`SL ${fmtSo(d.so_luong_vai_ve)}`, d.loai_dot && `Loại ${d.loai_dot}`, d.barcode && `Phiếu ready ${d.barcode}`,
        d.ngay_vai_ve && `Vải về ${giaTri(d.ngay_vai_ve, tenMap)}`, d.han_giao_hang && `Hạn giao ${giaTri(d.han_giao_hang, tenMap)}`,
        d.nha_gia_cong && `NGC ${d.nha_gia_cong}`, d.kt_can_kiem_tra === 'false' && 'Không qua kỹ thuật (KTCankiemtra = 0)',
        ['DA_HUY', 'DA_GOP'].includes(d.trang_thai) && `Hiện: ${d.trang_thai === 'DA_HUY' ? 'đã hủy' : 'đã gộp'}`].filter(Boolean).join(' · '),
      nguoi: nguoi(d.created_by), tu_dong: !d.created_by });
    if (d.tg_chuyen_ready && Math.abs(tgMs(d.tg_chuyen_ready) - tgMs(d.created_date)) > 60000) {
      them({ id: `dotr${d.id}`, tg: d.tg_chuyen_ready, nhom: 'READY', ma: 'LEN_READY', tieu_de: 'Đợt vải lên READY',
        doi_tuong: `Đợt ${d.ma_dot_vai}`, tu_dong: true });
    }
  });

  const lstMoc = [];
  (B.lst || []).forEach((r) => {
    const laReady = r.ma_tram === 'READY';
    const dat = r.tt_moi === 'DAT';
    const huy = r.tt_moi === 'HUY';
    lstMoc.push({ ma: r.ma_checkpoint, tg: tgMs(r.tg) });
    them({ id: `lst${r.id}`, tg: r.tg, nhom: laReady ? 'READY' : 'TEST_RUN', ma: `CHECKLIST_${r.tt_moi || ''}`,
      tieu_de: `${huy ? 'Hủy xác nhận' : dat ? (r.nguoi_thuc_hien_id ? 'Xác nhận' : 'Hệ thống tự xác nhận') : `Đổi trạng thái (${r.tt_moi || '?'})`} ${r.ten_checkpoint || r.ma_checkpoint}`,
      chi_tiet: [r.lenh_san_xuat_id && maLenh.get(String(r.lenh_san_xuat_id)), r.ly_do && `Lý do: ${r.ly_do}`, r.ghi_chu].filter(Boolean).join(' · '),
      doi_tuong: r.lenh_san_xuat_id ? maLenh.get(String(r.lenh_san_xuat_id)) || '' : '',
      nguoi: nguoi(r.nguoi_thuc_hien_id), tu_dong: !r.nguoi_thuc_hien_id, huy });
  });
  (B.rxd || []).forEach((r) => {
    const t = tgMs(r.tg);
    if (lstMoc.some((x) => x.ma === r.ma_checkpoint && Math.abs(x.tg - t) < 5000)) return;
    const huy = r.trang_thai === 'HUY';
    them({ id: `rxd${r.id}`, tg: r.tg, nhom: 'READY', ma: `CHECKLIST_DOT_${r.trang_thai}`,
      tieu_de: `${huy ? 'Hủy xác nhận' : r.nguoi_xac_nhan_id ? 'Xác nhận' : 'Hệ thống tự xác nhận'} ${r.ten_checkpoint || r.ma_checkpoint} theo đợt`,
      doi_tuong: r.ma_dot_vai ? `Đợt ${r.ma_dot_vai}` : '', nguoi: nguoi(r.nguoi_xac_nhan_id), tu_dong: !r.nguoi_xac_nhan_id, huy });
  });

  (B.lenh || []).forEach((l) => {
    them({ id: `lenh${l.id}`, tg: l.created_date, nhom: 'KE_HOACH', ma: 'TAO_LENH',
      tieu_de: `Tạo lệnh sản xuất ${l.ma_lenh_san_xuat}${l.giai_doan === 'EP_UI' ? ' (công đoạn Ép/Logo)' : ''}`,
      chi_tiet: [l.ma_chuyen && `Chuyền KH hiện tại ${l.ma_chuyen}`, l.la_in_lai && 'Lệnh in lại'].filter(Boolean).join(' · '),
      doi_tuong: l.ma_lenh_san_xuat, nguoi: nguoi(l.created_by), tu_dong: !l.created_by });
  });
  (B.test || []).forEach((t) => {
    them({ id: `test${t.id}`, tg: t.tg, nhom: 'TEST_RUN', ma: `TEST_${t.ket_qua}`,
      tieu_de: `Test Run lần ${t.lan_test || '?'}: ${KQ_TEST[t.ket_qua] || t.ket_qua || '—'}`,
      chi_tiet: [t.so_luong && `SL test ${fmtSo(t.so_luong)}`, t.ghi_chu].filter(Boolean).join(' · '),
      doi_tuong: t.ma_lenh_san_xuat, nguoi: nguoi(t.created_by), huy: t.ket_qua === 'HUY' });
  });
  (B.phieu || []).forEach((p) => {
    them({ id: `ps${p.id}`, tg: p.tg_bd, nhom: 'SAN_XUAT', ma: 'XAC_NHAN_CHAY', tieu_de: `Xác nhận chạy (${p.ma_phieu_san_xuat})`,
      chi_tiet: p.ma_chuyen ? `Chuyền thực tế ${p.ma_chuyen}` : '', doi_tuong: p.ma_lenh_san_xuat, nguoi: nguoi(p.created_by) });
    if (p.tg_kt && !phieuHoanTat.has(String(p.id))) {
      const laGop = /Gộp vào lệnh/i.test(p.ghi_chu || '');
      if (!laGop) {
        them({ id: `pskt${p.id}`, tg: p.tg_kt, nhom: 'SAN_XUAT', ma: `PHIEU_${p.trang_thai}`,
          tieu_de: p.trang_thai === 'HUY' ? `Phiếu ${p.ma_phieu_san_xuat} bị hủy` : `Phiếu ${p.ma_phieu_san_xuat} kết thúc`,
          chi_tiet: p.ghi_chu || '', doi_tuong: p.ma_lenh_san_xuat, nguoi: nguoi(p.updated_by), huy: p.trang_thai === 'HUY' });
      }
    }
  });
  (B.ngung || []).forEach((n) => {
    them({ id: `ng${n.id}`, tg: n.tg_bd_ngung, nhom: 'SAN_XUAT', ma: 'NGUNG_CHUYEN',
      tieu_de: `Ngừng chuyền ${n.ma_chuyen || ''}${n.trang_thai === 'HUY' ? ' (đã hủy lần ngừng)' : ''}`,
      chi_tiet: [n.ly_do, n.so_phut && `${fmtSo(n.so_phut)} phút`].filter(Boolean).join(' · '),
      doi_tuong: n.ma_phieu_san_xuat || '', nguoi: nguoi(n.created_by), huy: n.trang_thai === 'HUY' });
    if (n.tg_kt_ngung && n.trang_thai !== 'HUY') {
      them({ id: `ngk${n.id}`, tg: n.tg_kt_ngung, nhom: 'SAN_XUAT', ma: 'HOAT_DONG_LAI', tieu_de: `Chuyền ${n.ma_chuyen || ''} hoạt động lại`,
        doi_tuong: n.ma_phieu_san_xuat || '', nguoi: nguoi(n.updated_by) });
    }
  });
  (B.tem || []).forEach((t) => {
    const laCon = !!t.tem_goc_id;
    const laGc = !!t.dot_gc && !laCon;
    const tieuDe = laGc ? `Nhận hàng gia công — tem ${maTem(t.ma_tem)}`
      : laCon ? `Tạo tem ${maTem(t.ma_tem)} (${t.kcs_tach_id ? 'KCS một phần' : 'sửa đạt'}) từ tem ${maTem(t.ma_tem_goc)}`
        : `In tem ${maTem(t.ma_tem)}`;
    them({ id: `tem${t.id}`, tg: t.created_date, nhom: laCon ? 'CHAT_LUONG' : 'SAN_XUAT', ma: laGc ? 'TEM_GIA_CONG' : laCon ? 'TEM_CON' : 'IN_TEM',
      tieu_de: tieuDe,
      chi_tiet: [`SL ${fmtSo(laCon || laGc ? t.sl_kcs_dat || t.so_luong : t.so_luong)}`, t.ma_ngay_ca && `Ca ${t.ma_ngay_ca}`,
        t.ma_chuyen && `Chuyền ${t.ma_chuyen}`, t.trang_thai === 'HUY' && 'Hiện: đã hủy'].filter(Boolean).join(' · '),
      doi_tuong: t.ma_lenh_san_xuat || '', nguoi: nguoi(t.created_by), huy: false });
  });
  (B.in_lai || []).forEach((l) => {
    them({ id: `il${l.id}`, tg: l.tg_in, nhom: 'SAN_XUAT', ma: 'IN_LAI_TEM', tieu_de: `In lại tem ${maTem(l.ma_tem)} (lần ${l.so_lan_in || '?'})`,
      chi_tiet: [l.ly_do_in_lai && `Lý do: ${l.ly_do_in_lai}`, l.ghi_chu].filter(Boolean).join(' · '),
      doi_tuong: `Tem ${maTem(l.ma_tem)}`, nguoi: nguoi(l.nguoi_in_id) });
  });
  (B.phoi || []).forEach((x) => {
    const xe = x.ten_xe_phoi || x.ma_xe_phoi || '';
    them({ id: `phoi${x.id}`, tg: x.tg_bd_phoi, nhom: 'SAN_XUAT', ma: 'LEN_XE_PHOI', tieu_de: `Lên xe phơi ${xe}`,
      doi_tuong: `Tem ${maTem(x.ma_tem)}`, tu_dong: true, huy: x.trang_thai === 'HUY' });
    if (x.trang_thai === 'XONG' && x.tg_kt_phoi && !coAuditKho.has(String(x.tem_id))) {
      them({ id: `kho${x.id}`, tg: x.tg_kt_phoi, nhom: 'SAN_XUAT', ma: 'PHOI_XONG', tieu_de: `Phơi xong — rời xe ${xe}`,
        chi_tiet: 'Hết thời gian chờ khô (hệ thống tự chuyển)', doi_tuong: `Tem ${maTem(x.ma_tem)}`, tu_dong: true });
    }
  });
  (B.vai_huy || []).forEach((v) => {
    them({ id: `vh${v.id}`, tg: v.created_date, nhom: 'SAN_XUAT', ma: `VAI_${v.loai || 'HUY'}`,
      tieu_de: `Vải ${v.loai === 'THIEU' ? 'thiếu' : 'hủy'} ${fmtSo(v.so_luong)}`,
      chi_tiet: [v.ma_dot_vai && `Đợt ${v.ma_dot_vai}`, v.ly_do].filter(Boolean).join(' · '),
      doi_tuong: v.ma_tem ? `Tem ${maTem(v.ma_tem)}` : '', nguoi: nguoi(v.created_by) });
  });
  (B.kcs || []).forEach((k) => {
    them({ id: `kcs${k.id}`, tg: k.created_date, nhom: 'CHAT_LUONG', ma: 'KCS', tieu_de: `KCS tem ${maTem(k.ma_tem)}`,
      chi_tiet: [`Kiểm ${fmtSo(k.so_luong_kiem)}`, `đạt ${fmtSo(k.so_luong_dat)}`, `hư ${fmtSo(k.so_luong_loi)}`,
        so(k.so_luong_huy) && `hủy ${fmtSo(k.so_luong_huy)}`, so(k.so_luong_chenh_lech) && `chênh lệch ${fmtSo(k.so_luong_chenh_lech)}`,
        so(k.so_luong_mau) && `mẫu ${fmtSo(k.so_luong_mau)}`, kcsNguoi.get(String(k.id)) && `Người kiểm ${kcsNguoi.get(String(k.id))}`,
        k.ghi_chu].filter(Boolean).join(' · '),
      doi_tuong: `Tem ${maTem(k.ma_tem)}`, nguoi: nguoi(k.created_by) });
  });
  (B.pll || []).forEach((p) => {
    if (coAuditPll.has(String(p.tem_id))) return;
    them({ id: `pll${p.id}`, tg: p.created_date, nhom: 'CHAT_LUONG', ma: 'PHAN_LOAI_LOI', tieu_de: `Phân loại lỗi tem ${maTem(p.ma_tem)}`,
      chi_tiet: [p.dong, p.ghi_chu].filter(Boolean).join(' · '), doi_tuong: `Tem ${maTem(p.ma_tem)}`, nguoi: nguoi(p.created_by) });
  });
  (B.nhan_sua || []).forEach((n) => {
    them({ id: `ns${n.id}`, tg: n.created_date, nhom: 'CHAT_LUONG', ma: 'NHAN_SUA', tieu_de: `Nhận sửa ${fmtSo(n.so_luong)} — tem ${maTem(n.ma_tem)}`,
      chi_tiet: [n.loai === 'CU' && 'Dữ liệu cũ (coi như đã nhận)', n.ghi_chu].filter(Boolean).join(' · '),
      doi_tuong: `Tem ${maTem(n.ma_tem)}`, nguoi: nguoi(n.created_by), tu_dong: n.loai === 'CU' });
    if (n.da_huy) {
      them({ id: `nsh${n.id}`, tg: n.tg_huy || n.updated_date, nhom: 'CHAT_LUONG', ma: 'HUY_NHAN_SUA', tieu_de: `Hủy lượt nhận sửa ${fmtSo(n.so_luong)}`,
        chi_tiet: n.ly_do_huy ? `Lý do: ${n.ly_do_huy}` : '', doi_tuong: `Tem ${maTem(n.ma_tem)}`, nguoi: nguoi(n.nguoi_huy_id), huy: true });
    }
  });
  (B.sua || []).forEach((s) => {
    them({ id: `sua${s.id}`, tg: s.created_date, nhom: 'CHAT_LUONG', ma: 'SUA', tieu_de: `Sửa tem ${maTem(s.ma_tem)}`,
      chi_tiet: [`Sửa đạt ${fmtSo(s.so_luong_sua_dat)}`, `hủy ${fmtSo(s.so_luong_sua_huy)}`, s.nguoi_sua && `Người sửa ${s.nguoi_sua}`,
        s.ma_tem_con && `→ tem ${maTem(s.ma_tem_con)}`, s.ghi_chu].filter(Boolean).join(' · '),
      doi_tuong: `Tem ${maTem(s.ma_tem)}`, nguoi: nguoi(s.created_by) });
  });
  (B.oqc || []).forEach((o) => {
    const dat = o.ket_qua === 'DAT';
    them({ id: `oqc${o.id}`, tg: o.created_date, nhom: 'CHAT_LUONG', ma: `OQC_${o.ket_qua}`,
      tieu_de: `OQC tem ${maTem(o.ma_tem)} (${o.nguon === 'SUA' ? 'hàng sửa' : 'hàng KCS'}): ${dat ? 'Đạt' : 'Không đạt'}`,
      chi_tiet: [`Mẫu ${fmtSo(o.so_luong_kiem)}`, `đạt ${fmtSo(o.so_luong_dat)}`, so(o.so_luong_loi) && `lỗi ${fmtSo(o.so_luong_loi)}`,
        so(o.sl_qua_giao) && `qua giao ${fmtSo(o.sl_qua_giao)}`, o.cho_giao && `Giao ngoại lệ (owner ${nguoi(o.owner_cho_giao_id) || '?'}${o.ly_do_cho_giao ? ` — ${o.ly_do_cho_giao}` : ''})`,
        o.ghi_chu].filter(Boolean).join(' · '),
      doi_tuong: `Tem ${maTem(o.ma_tem)}`, nguoi: nguoi(o.created_by) });
  });
  (B.giao || []).forEach((g) => {
    them({ id: `gh${g.id}`, tg: g.created_date, nhom: 'GIAO_HANG', ma: 'GIAO_HANG',
      tieu_de: `Giao hàng — phiếu ${g.ma_phieu_giao}${g.trang_thai === 'HUY' ? ' (phiếu đã hủy)' : ''}`,
      chi_tiet: [`SL ${fmtSo(g.so_luong_giao)}`, g.nguon === 'SUA' && 'hàng sửa', g.giao_hang_tai && `Giao tại ${g.giao_hang_tai}`].filter(Boolean).join(' · '),
      doi_tuong: `Tem ${maTem(g.ma_tem)}`, nguoi: nguoi(g.created_by), huy: g.trang_thai === 'HUY' });
  });
  (B.tra_ve || []).forEach((q) => {
    const dt = q.ma_tem ? `Tem ${maTem(q.ma_tem)}` : q.ma_lenh_san_xuat || (q.ma_dot_vai ? `Đợt ${q.ma_dot_vai}` : '');
    const ds = Array.isArray(q.checklist_list) ? q.checklist_list : [];
    them({ id: `tv${q.id}`, tg: q.created_date, nhom: 'TRA_VE', ma: `TRA_VE_${q.loai}`, tieu_de: LOAI_TRA_VE[q.loai] || `Trả về (${q.loai})`,
      chi_tiet: [q.ly_do && `Lý do: ${q.ly_do}`, ds.length && `Mục: ${ds.map((x) => (typeof x === 'object' ? x.ma || x.ten : x)).join(', ')}`].filter(Boolean).join(' · '),
      doi_tuong: dt, nguoi: nguoi(q.created_by), tra_ve: true });
    if (q.da_xu_ly && q.updated_date && tgMs(q.updated_date) - tgMs(q.created_date) > 1000) {
      them({ id: `tvx${q.id}`, tg: q.updated_date, nhom: 'TRA_VE', ma: `XU_LY_TRA_VE_${q.loai}`,
        tieu_de: `Đã xử lý: ${LOAI_TRA_VE[q.loai] || q.loai}`, doi_tuong: dt, nguoi: nguoi(q.updated_by), tu_dong: !q.updated_by });
    }
  });
  (B.hskt || []).forEach((h) => {
    them({ id: `hskt${h.id}`, tg: h.tg, nhom: 'DON_HANG', ma: `HSKT_${h.hanh_dong}`,
      tieu_de: h.hanh_dong === 'DOI_PHUONG_AN_IN' ? 'Đổi phương án in (HSKT)' : h.hanh_dong === 'TAO' ? 'Tạo hồ sơ kỹ thuật' : `Hồ sơ kỹ thuật: ${h.hanh_dong}`,
      chi_tiet: [h.chi_tiet, h.phien_ban && `phiên bản ${h.phien_ban}`, h.barcode_hskt && `mã ${h.barcode_hskt}`].filter(Boolean).join(' · '),
      nguoi: nguoi(h.nguoi_id), tu_dong: !h.nguoi_id });
  });
  (B.nghen || []).forEach((n) => {
    them({ id: `ngh${n.id}`, tg: n.created_date, nhom: 'HE_THONG', ma: 'LY_DO_NGHEN', tieu_de: `Lý do nghẽn (${n.ma_trang})`,
      chi_tiet: [n.ly_do, n.so_phut_nghen && `nghẽn ${fmtSo(n.so_phut_nghen)} phút`, n.ma_doi_tuong].filter(Boolean).join(' · '),
      nguoi: nguoi(n.created_by) });
  });
  (B.ghi_chu || []).forEach((g) => {
    const bt = g.loai === 'BAT_THUONG';
    them({ id: `gc${g.id}`, tg: g.created_date, nhom: 'DON_HANG', ma: g.loai, tieu_de: bt ? 'Đánh dấu phần in bất thường' : 'Ghi chú phần in',
      chi_tiet: g.noi_dung || '', nguoi: nguoi(g.created_by) });
    if (!g.dang_hoat_dong && g.updated_date) {
      them({ id: `gcx${g.id}`, tg: g.updated_date, nhom: 'DON_HANG', ma: `GO_${g.loai}`, tieu_de: bt ? 'Gỡ dấu bất thường' : 'Xóa ghi chú',
        nguoi: nguoi(g.updated_by), huy: true });
    }
  });
  (B.set || []).forEach((s) => {
    them({ id: `set${s.id}`, tg: s.created_date, nhom: 'DON_HANG', ma: 'GOM_SET', tieu_de: `Vào set ${s.ma_set}`,
      chi_tiet: s.trang_thai ? `Set hiện: ${s.trang_thai}` : '', doi_tuong: `Đợt ${s.ma_dot_vai}`, nguoi: nguoi(s.created_by), tu_dong: !s.created_by });
  });

  const ds = E.filter((e) => e.tg).sort((a, b) => tgMs(b.tg) - tgMs(a.tg) || String(a.id).localeCompare(String(b.id)));
  const dem = {};
  ds.forEach((e) => { dem[e.nhom] = (dem[e.nhom] || 0) + 1; });
  return {
    phan_in: info,
    pham_vi: { so_dot: pv.dotIds.length, so_lenh: pv.lenhIds.length, so_tem: pv.temIds.length,
      lenh: pv.lenhs.map((l) => l.ma_lenh_san_xuat), dot: pv.dots.map((d) => d.ma_dot_vai) },
    su_kien: ds, nhom: NHOM, dem,
  };
}

module.exports = { timPhanIn, lichSu, NHOM, HANH_DONG };
