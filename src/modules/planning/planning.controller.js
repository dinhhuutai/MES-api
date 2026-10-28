'use strict';

const service = require('./planning.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const { getPaging, TRAN_TAI_HET } = require('../../utils/pagination');
const { ngayHomNayVN } = require('../../utils/khoangNgay');
const { nhoDoc } = require('../../utils/cacheDoc');

// Danh sách các màn dòng chảy dùng chung kết quả giữa mọi người xem cùng tham số (`utils/cacheDoc.js` — mọi thao
// tác ghi làm cache hết hiệu lực ngay). Hàm dựng tham số chỉ đọc `req.query`, không đọc người gọi.
const dsChung = (nhom, dungThamSo, ham) => asyncHandler(async (req, res) => {
  const opts = dungThamSo(req.query);
  return ok(res, await nhoDoc(nhom, opts, () => ham(opts)));
});
const thamSoTimTrang = (q) => ({ search: q.search || '', ...getPaging(q, { tranToiDa: TRAN_TAI_HET }) });

const release1Candidates = dsChung('planning.release1', thamSoTimTrang, (o) => service.listRelease1Candidates(o));

const autoPlanCandidates = asyncHandler(async (req, res) =>
  ok(res, await service.autoPlanCandidates({ search: req.query.search || '' })));

const createRelease1 = asyncHandler(async (req, res) =>
  created(res, await service.createRelease1(req.body, req.user.id), 'Đã Release 1 — tạo lệnh sản xuất'));

// Trả đợt vải ở Release 1 ngược về Kỹ thuật (mở lại READY).
const release1TraVeKyThuat = asyncHandler(async (req, res) =>
  ok(res, await service.traVeKyThuat(req.body, req.user.id), 'Đã trả về Kỹ thuật (mở lại READY)'));

// Tạo Đợt sản xuất (gộp/tách nhiều đợt vải + SL từng đợt vào 1 đợt SX)
const createDotSanXuat = asyncHandler(async (req, res) =>
  created(res, await service.createDotSanXuat(req.body, req.user.id), 'Đã tạo đợt sản xuất'));

const release1History = asyncHandler(async (req, res) => {
  const date = req.query.date || ngayHomNayVN();
  return ok(res, await service.release1History(date));
});

const releaseList = asyncHandler(async (req, res) => {
  const date = req.query.date || ngayHomNayVN();
  // `mode=RELEASE` → lọc theo ngày TẠO LỆNH (ngày bấm Release 1); mặc định theo ngày kế hoạch.
  const mode = String(req.query.mode || '').toUpperCase() === 'RELEASE' ? 'RELEASE' : 'KE_HOACH';
  return ok(res, await service.releaseList(date, mode));
});

const releaseSets = asyncHandler(async (req, res) =>
  ok(res, await service.listReleaseSets(req.query.search || '')));

// Gộp số lượng đợt vải
const gopCandidates = asyncHandler(async (req, res) =>
  ok(res, await service.listGopCandidates({ search: req.query.search || '' })));

const gopDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.gopDotVai(req.body, req.user.id), 'Đã gộp số lượng đợt vải'));

const gopHistory = asyncHandler(async (req, res) =>
  ok(res, await service.gopHistory(req.query.date || null)));

const releaseSet = asyncHandler(async (req, res) =>
  created(res, await service.releaseSet(req.params.setId, req.body, req.user.id), 'Đã release set — tạo lệnh sản xuất chung'));

const testRunCandidates = dsChung('planning.testrun', thamSoTimTrang, (o) => service.listTestRunCandidates(o));

const lenhDetail = asyncHandler(async (req, res) => ok(res, await service.getLenhDetail(req.params.lenhId)));

const recordTestRun = asyncHandler(async (req, res) =>
  ok(res, await service.recordTestRun(req.params.lenhId, req.body, req.user.id), 'Đã ghi nhận lần test'));

const confirmCNSP = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTest(req.params.lenhId, 'cnsp', req.user.id), 'CNSP đã xác nhận'));

const confirmQA = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTest(req.params.lenhId, 'qa', req.user.id, {
    soLuong: req.body?.soLuong ?? null,
    nguoiTest: req.body?.nguoiTest ?? null,
    ghiChu: req.body?.ghiChu ?? null,
    loaiTest: req.body?.loaiTest ?? null,
    inKhongDat: req.body?.inKhongDat ?? null,
    release2: req.body?.release2 === true, // ngoài giờ hành chính ⇒ kiêm Release 2 (service tự kiểm giờ)
  }), req.body?.inKhongDat ? 'QA xác nhận in không đạt' : 'QA đã xác nhận test'));

const ownerChoIn = asyncHandler(async (req, res) => ok(res, await service.listOwnerChoIn()));

const cancelCNSP = asyncHandler(async (req, res) =>
  ok(res, await service.cancelTest(req.params.lenhId, 'cnsp', req.user.id), 'Đã hủy xác nhận CNSP'));

const cancelQA = asyncHandler(async (req, res) =>
  ok(res, await service.cancelTest(req.params.lenhId, 'qa', req.user.id), 'Đã hủy xác nhận QA'));

const confirmCNSPBatch = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTestBatch(req.body.lenhIds, 'cnsp', req.user.id), 'CNSP xác nhận hàng loạt'));

const confirmQABatch = asyncHandler(async (req, res) =>
  ok(res, await service.confirmTestBatch(req.body.lenhIds, 'qa', req.user.id, {
    nguoiTest: req.body?.nguoiTest ?? null,
    loaiTest: req.body?.loaiTest ?? null,
    ghiChu: req.body?.ghiChu ?? null,
    release2: req.body?.release2 === true,
  }), 'QA xác nhận hàng loạt'));

const release2Candidates = dsChung('planning.release2', thamSoTimTrang, (o) => service.listRelease2Candidates(o));

const approveRelease2 = asyncHandler(async (req, res) =>
  ok(res, await service.approveRelease2(req.params.lenhId, req.user.id), 'Đã Release 2 — sẵn sàng sản xuất'));

const skipTestRun = asyncHandler(async (req, res) => {
  const kq = await service.skipTestRun(req.params.lenhId, req.user.id, (req.body || {}).lyDo);
  const cv = kq && kq.cong_vao_lenh_chay;
  ok(res, kq, cv
    ? `Đã bỏ Test Run — cộng thẳng số lượng vào lệnh đang chạy ${cv.ma_lenh}`
    : 'Đã bỏ Test Run — đợt sản xuất vào chờ sản xuất');
});

const testRunHistory = asyncHandler(async (req, res) => {
  const date = req.query.date || ngayHomNayVN();
  return ok(res, await service.testRunHistory(date));
});

// Bộ lọc màn Lập kế hoạch lại: `f_<khóa>` (khóa = FILTER_FIELDS FE) + `tuNgay`/`denNgay` (YYYY-MM-DD).
const REPLAN_LOC = ['maLenh', 'codePhan', 'khach', 'don', 'maHang', 'mauVai', 'kichVai', 'kichPhim', 'chuyen', 'nhaGiaCong'];
const replanOpts = (q) => ({
  search: q.search || '',
  loc: Object.fromEntries(REPLAN_LOC.map((k) => [k, q[`f_${k}`] || ''])),
  tuNgay: q.tuNgay || null,
  denNgay: q.denNgay || null,
});
const replanCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  return ok(res, await service.listReplanCandidates({ ...replanOpts(req.query), page, limit, offset }));
});
const replanIds = asyncHandler(async (req, res) => ok(res, await service.listReplanIds(replanOpts(req.query))));
const replanMaQuet = asyncHandler(async (req, res) =>
  ok(res, await service.listReplanMaQuet({ tuNgay: req.query.tuNgay || null, denNgay: req.query.denNgay || null })));

const approveRelease2Batch = asyncHandler(async (req, res) =>
  ok(res, await service.approveRelease2Batch(req.body.lenhIds, req.user.id), 'Duyệt Release 2 hàng loạt'));

const replan = asyncHandler(async (req, res) =>
  ok(res, await service.replan(req.params.lenhId, req.body, req.user.id), 'Đã lập lại kế hoạch'));

const replanDetail = asyncHandler(async (req, res) =>
  ok(res, await service.getReplanDetail(req.params.lenhId)));

// Sửa kế hoạch lệnh từ sidebar "Danh sách release" (28/10/2026) — CHÍNH `replan` với `choDaChay` (như Quản trị phần in:
//   lệnh đã xác nhận chạy vẫn sửa được thông tin kế hoạch). Lý do bắt buộc. ERP: hủy lượt kế hoạch cũ rồi gửi lượt mới
//   (`release1Erp.xepHang` nguồn REPLAN).
const releaseListSuaKeHoach = asyncHandler(async (req, res) =>
  ok(res, await service.suaKeHoachTuDsRelease(req.params.lenhId, req.body || {}, req.user.id), 'Đã sửa kế hoạch — đang báo ERP (hủy kế hoạch cũ, gửi kế hoạch mới)'));

// Cùng bộ tham số lọc với Lập kế hoạch lại (`f_<khóa>` + `tuNgay`/`denNgay`).
const giaCongList = dsChung('planning.giacong',
  (q) => ({ ...replanOpts(q), ...getPaging(q, { tranToiDa: TRAN_TAI_HET }) }), (o) => service.listGiaCong(o));
// Nhận hàng gia công (có thể NHIỀU LẦN). 2 dạng body:
//  · `items: [{ dot_vai_ve_id, so_luong }]` — nhận theo TỪNG CODE PHẦN (tối đa 50/lượt, đường của nút
//    "In tem" ở màn Gia công). Đây là đường chính từ 09/09/2026.
//  · `so_luong` — nhận ở MỨC LỆNH như trước; bỏ trống = nhận nốt phần còn lại (nút hàng loạt).
const giaCongToOqc = asyncHandler(async (req, res) => {
  // `so_luong` = SL ĐẠT (đi tiếp OQC) · `so_luong_huy` = SL HỦY (loại hẳn). Cả hai đều trừ vào phần
  // còn phải nhận của code phần đó — xem `nhanGiaCongTheoPhanIn`.
  const items = Array.isArray(req.body?.items)
    ? req.body.items.map((x) => ({
      dotVaiId: x?.dot_vai_ve_id, soLuong: x?.so_luong, soLuongHuy: x?.so_luong_huy,
      // 02/10/2026: thiếu · lỗi vải (cùng trừ vào còn lại, không sang OQC) · SL 1 bó (chỉ in trên tem).
      soLuongThieu: x?.sl_thieu, soLuongLoiVai: x?.sl_loi_vai, slMotBo: x?.sl_mot_bo,
    }))
    : null;
  const r = await service.confirmGiaCongToOqc(req.params.lenhId,
    { soLuong: req.body?.so_luong, items }, req.user.id);
  return ok(res, r, r.hoan_tat
    ? 'Đã chuyển gia công sang OQC — lệnh nhận đủ số lượng'
    : `Đã chuyển ${r.so_luong} sang OQC — còn lại ${r.con_lai}`);
});

const giaCongHistory = asyncHandler(async (req, res) =>
  ok(res, await service.giaCongHistory(req.query.date)));

const giaCongTemCancelable = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listGiaCongTemCancelable({ search: req.query.search || '', page, limit, offset }));
});

// Kế hoạch đã mang hàng bị OQC trả về giao lại cho nhà gia công.
const giaCongTraLai = asyncHandler(async (req, res) =>
  ok(res, await service.traLaiNhaGiaCong(req.params.lenhId, req.body, req.user.id),
    'Đã ghi nhận trả lại nhà gia công'));

const giaCongTemHuy = asyncHandler(async (req, res) =>
  ok(res, await service.cancelGiaCongTem(req.params.temId, req.body, req.user.id),
    'Đã hủy tem gia công — số lượng quay lại phần chờ nhận'));

const keHoachTamList = dsChung('planning.khtam', thamSoTimTrang, (o) => service.listKeHoachTam(o));

// Lập kế hoạch tạm cho cả gom set (set chưa đủ Ready — chưa release được nhưng vẫn lên kế hoạch trước).
const keHoachTamSet = asyncHandler(async (req, res) =>
  ok(res, await service.keHoachTamSet(req.params.setId, req.body, req.user.id), 'Đã lưu kế hoạch tạm cho set'));

const keHoachTamConfirm = asyncHandler(async (req, res) =>
  ok(res, await service.confirmKeHoachTam(req.params.id, req.user.id), 'Đã xác nhận Release 1 từ kế hoạch tạm'));

const keHoachTamUpdate = asyncHandler(async (req, res) =>
  ok(res, await service.updateKeHoachTam(req.params.id, req.body, req.user.id), 'Đã cập nhật kế hoạch tạm'));

const keHoachTamDelete = asyncHandler(async (req, res) =>
  ok(res, await service.deleteKeHoachTam(req.params.id, req.user.id), 'Đã xóa kế hoạch tạm'));

// Lịch sử thao tác + Đã hoàn thành (đã xác nhận Release 1) của Kế hoạch tạm — theo ngày (giờ VN).
const keHoachTamHistory = asyncHandler(async (req, res) =>
  ok(res, await service.keHoachTamHistory(req.query.date || ngayHomNayVN())));

const keHoachTamDone = asyncHandler(async (req, res) =>
  ok(res, await service.keHoachTamDone(req.query.date || ngayHomNayVN())));

const keHoachTamTheoDoi = asyncHandler(async (req, res) =>
  ok(res, await service.keHoachTamTheoDoi(req.query)));

// Tab "Hủy kế hoạch tạm" ở *Hủy lệnh xác nhận* (19/10/2026).
const keHoachTamHuyCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  return ok(res, await service.listKeHoachTamHuy({ search: req.query.search || '', page, limit, offset }));
});
const keHoachTamHuy = asyncHandler(async (req, res) =>
  ok(res, await service.huyKeHoachTam(req.params.id, req.body, req.user.id), 'Đã hủy kế hoạch tạm — đợt vải về lại Release 1'));

const replanBatch = asyncHandler(async (req, res) =>
  ok(res, await service.replanBatch(req.body.lenhIds, req.body, req.user.id), 'Lập lại kế hoạch hàng loạt'));

const planHistory = asyncHandler(async (req, res) => {
  const date = req.query.date || ngayHomNayVN();
  return ok(res, await service.planHistory(date));
});

// HỦY TÙY CHỌN (mọi trạng thái, kể cả lệnh đã in tem) — chỉ mở cho quyền `LENH_CANCEL_ANY` (mig 065).
// ⚠ Kiểm quyền Ở SERVER: FE gửi `moRong`/`force` gì cũng vô nghĩa nếu user không có quyền.
const HUY_TUY_CHON = 'LENH_CANCEL_ANY';
const coQuyenHuyTuyChon = (req) => {
  const perms = (req.user && req.user.permissions) || [];
  return perms.includes('*') || perms.includes(HUY_TUY_CHON);
};

const cancelableLenh = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  const moRong = String(req.query.moRong || '') === 'true' && coQuyenHuyTuyChon(req);
  const data = await service.listCancelableLenh({ search: req.query.search || '', page, limit, offset, moRong });
  // Trả cờ quyền để FE biết có nên hiện ô "Hủy tùy chọn" hay không (khỏi đoán từ danh sách permission).
  return ok(res, { ...data, mo_rong: moRong, cho_phep_tuy_chon: coQuyenHuyTuyChon(req) });
});

const lanTestChoHuy = asyncHandler(async (req, res) => ok(res, await service.testRunsChoHuy(req.params.lenhId)));

// Tab "Hủy test run" (02/10/2026) — mọi lượt test còn sống của lệnh chưa vào sản xuất.
const lanTestCancelable = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listLanTestChoHuy({ search: req.query.search || '', page, limit, offset }));
});
const huyLanTest = asyncHandler(async (req, res) => {
  const r = await service.huyLanTest(req.params.testRunId, req.body || {}, req.user.id);
  return ok(res, r, r.ve_test_run
    ? `Đã hủy lần test ${r.lan_test} — lệnh ${r.ma_lenh} quay lại Test Run`
    : `Đã hủy lần test ${r.lan_test} của lệnh ${r.ma_lenh}`);
});

const cancelLenh = asyncHandler(async (req, res) => {
  const force = !!req.body?.force && coQuyenHuyTuyChon(req);
  const r = await service.rollbackLenh(req.params.lenhId, { ...req.body, force }, req.user.id);
  return ok(res, r, force
    ? `Đã hủy lệnh (tùy chọn, từ trạng thái ${r.trang_thai_cu}${r.so_tem_huy ? ` — hủy kèm ${r.so_tem_huy} tem` : ''})`
    : 'Đã hoàn tác chuyển trạm');
});

// Test Run không đạt → trả về KỸ THUẬT (READY): chọn mục rớt (Khuôn/Film/Mực) + lý do. GIỮ NGUYÊN lệnh
// → QC xác nhận READY xong là đợt vải nhảy thẳng lại Test Run, không phải Release 1 lại.
const returnTestRunToReady = asyncHandler(async (req, res) =>
  ok(res, await service.returnTestRunToReady(req.params.lenhId, { ...req.body, nguon: 'TEST_RUN' }, req.user.id),
    'Đã trả về Kỹ thuật — phần in quay lại READY'));
const release2TraVeKyThuat = asyncHandler(async (req, res) =>
  ok(res, await service.returnTestRunToReady(req.params.lenhId, { ...req.body, nguon: 'RELEASE2' }, req.user.id),
    'Đã trả về Kỹ thuật từ Release 2 — phần in quay lại READY'));

// Test Run trả về KẾ HOẠCH (giữ lệnh) + khối "Test Run trả về" / xác nhận lại ở màn Release 1 (07/10/2026).
const testRunTraVeKeHoach = asyncHandler(async (req, res) =>
  ok(res, await service.traVeKeHoachTuTestRun(req.params.lenhId, req.body, req.user.id),
    'Đã trả về Kế hoạch — lệnh được giữ, chờ Kế hoạch xác nhận lại Release 1'));
const release1TestRunTraVe = asyncHandler(async (req, res) => ok(res, await service.listTestRunTraVeKh()));
const release1XacNhanLai = asyncHandler(async (req, res) =>
  ok(res, await service.xacNhanLaiTestRunTraVe(req.params.lenhId, req.body, req.user.id),
    'Đã xác nhận lại Release 1 — lệnh quay về Test Run'));

const today = () => ngayHomNayVN();
const release1Done = asyncHandler(async (req, res) => ok(res, await service.release1Done(req.query.date || today())));
const release2Done = asyncHandler(async (req, res) => ok(res, await service.release2Done(req.query.date || today())));
const replanDone = asyncHandler(async (req, res) => ok(res, await service.replanDone(req.query.date || today())));
const testCnspDone = asyncHandler(async (req, res) => ok(res, await service.testCnspDone(req.query.date || today())));
const testQaDone = asyncHandler(async (req, res) => ok(res, await service.testQaDone(req.query.date || today())));

const listCaTuan = asyncHandler(async (req, res) => ok(res, await service.listCaTuan()));
const upsertCaTuan = asyncHandler(async (req, res) =>
  ok(res, await service.upsertCaTuan(req.body, req.user.id), 'Đã lưu cài đặt ca tuần'));

// BTP khác kế hoạch (mig 120) — trang Hệ thống: tìm phần in, bật/tắt cờ theo đợt vải.
const btpKhacKhTim = asyncHandler(async (req, res) => ok(res, await service.timBtpKhacKh(req.query.q || '')));
const btpKhacKhDat = asyncHandler(async (req, res) =>
  ok(res, await service.datBtpKhacKh(req.params.dotVaiId, req.body || {}, req.user.id),
    req.body && req.body.bat ? 'Đã bật BTP khác KH — đợt quay về Release 1' : 'Đã tắt BTP khác KH'));

module.exports = {
  btpKhacKhTim, btpKhacKhDat,
  listCaTuan, upsertCaTuan,
  release1Candidates, autoPlanCandidates, createRelease1, release1TraVeKyThuat, createDotSanXuat, release1History, releaseList, releaseSets, releaseSet,
  gopCandidates, gopDotVai, gopHistory,
  testRunCandidates, lenhDetail, recordTestRun,
  confirmCNSP, confirmQA, ownerChoIn, cancelCNSP, cancelQA, confirmCNSPBatch, confirmQABatch,
  release2Candidates, approveRelease2, approveRelease2Batch, skipTestRun, testRunHistory,
  replanCandidates, replanIds, replanMaQuet, replan, replanDetail, replanBatch, planHistory, releaseListSuaKeHoach,
  giaCongList, giaCongToOqc, giaCongHistory, giaCongTemCancelable, giaCongTemHuy, giaCongTraLai,
  keHoachTamList, keHoachTamSet, keHoachTamConfirm, keHoachTamUpdate, keHoachTamDelete, keHoachTamHistory, keHoachTamDone, keHoachTamTheoDoi,
  keHoachTamHuyCandidates, keHoachTamHuy,
  cancelableLenh, cancelLenh, lanTestChoHuy, lanTestCancelable, huyLanTest, returnTestRunToReady, release2TraVeKyThuat,
  testRunTraVeKeHoach, release1TestRunTraVe, release1XacNhanLai,
  release1Done, release2Done, replanDone, testCnspDone, testQaDone,
};
