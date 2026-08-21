'use strict';

const service = require('./planning.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const { getPaging, TRAN_TAI_HET } = require('../../utils/pagination');

const release1Candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  return ok(res, await service.listRelease1Candidates({ search: req.query.search || '', page, limit, offset }));
});

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
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.release1History(date));
});

const releaseList = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
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

const testRunCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  return ok(res, await service.listTestRunCandidates({ search: req.query.search || '', page, limit, offset }));
});

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
  }), 'QA đã xác nhận test'));

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
  }), 'QA xác nhận hàng loạt'));

const release2Candidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  return ok(res, await service.listRelease2Candidates({ search: req.query.search || '', page, limit, offset }));
});

const approveRelease2 = asyncHandler(async (req, res) =>
  ok(res, await service.approveRelease2(req.params.lenhId, req.user.id), 'Đã Release 2 — sẵn sàng sản xuất'));

const skipTestRun = asyncHandler(async (req, res) =>
  ok(res, await service.skipTestRun(req.params.lenhId, req.user.id), 'Đã bỏ Test Run — đợt sản xuất vào chờ sản xuất'));

const testRunHistory = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return ok(res, await service.testRunHistory(date));
});

const replanCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  return ok(res, await service.listReplanCandidates({ search: req.query.search || '', page, limit, offset }));
});

const approveRelease2Batch = asyncHandler(async (req, res) =>
  ok(res, await service.approveRelease2Batch(req.body.lenhIds, req.user.id), 'Duyệt Release 2 hàng loạt'));

const replan = asyncHandler(async (req, res) =>
  ok(res, await service.replan(req.params.lenhId, req.body, req.user.id), 'Đã lập lại kế hoạch'));

const replanDetail = asyncHandler(async (req, res) =>
  ok(res, await service.getReplanDetail(req.params.lenhId)));

const giaCongList = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  return ok(res, await service.listGiaCong({ search: req.query.search || '', page, limit, offset }));
});

// Nhận hàng gia công (có thể NHIỀU LẦN): body `so_luong` = SL của lần nhận này; bỏ trống = nhận nốt phần còn lại.
const giaCongToOqc = asyncHandler(async (req, res) => {
  const r = await service.confirmGiaCongToOqc(req.params.lenhId, { soLuong: req.body?.so_luong }, req.user.id);
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

const keHoachTamList = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  return ok(res, await service.listKeHoachTam({ search: req.query.search || '', page, limit, offset }));
});

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
  ok(res, await service.keHoachTamHistory(req.query.date || new Date().toISOString().slice(0, 10))));

const keHoachTamDone = asyncHandler(async (req, res) =>
  ok(res, await service.keHoachTamDone(req.query.date || new Date().toISOString().slice(0, 10))));

const replanBatch = asyncHandler(async (req, res) =>
  ok(res, await service.replanBatch(req.body.lenhIds, req.body, req.user.id), 'Lập lại kế hoạch hàng loạt'));

const planHistory = asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
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
  ok(res, await service.returnTestRunToReady(req.params.lenhId, req.body, req.user.id),
    'Đã trả về Kỹ thuật — phần in quay lại READY'));

const today = () => new Date().toISOString().slice(0, 10);
const release1Done = asyncHandler(async (req, res) => ok(res, await service.release1Done(req.query.date || today())));
const release2Done = asyncHandler(async (req, res) => ok(res, await service.release2Done(req.query.date || today())));
const replanDone = asyncHandler(async (req, res) => ok(res, await service.replanDone(req.query.date || today())));
const testCnspDone = asyncHandler(async (req, res) => ok(res, await service.testCnspDone(req.query.date || today())));
const testQaDone = asyncHandler(async (req, res) => ok(res, await service.testQaDone(req.query.date || today())));

const listCaTuan = asyncHandler(async (req, res) => ok(res, await service.listCaTuan()));
const upsertCaTuan = asyncHandler(async (req, res) =>
  ok(res, await service.upsertCaTuan(req.body, req.user.id), 'Đã lưu cài đặt ca tuần'));

module.exports = {
  listCaTuan, upsertCaTuan,
  release1Candidates, autoPlanCandidates, createRelease1, release1TraVeKyThuat, createDotSanXuat, release1History, releaseList, releaseSets, releaseSet,
  gopCandidates, gopDotVai, gopHistory,
  testRunCandidates, lenhDetail, recordTestRun,
  confirmCNSP, confirmQA, cancelCNSP, cancelQA, confirmCNSPBatch, confirmQABatch,
  release2Candidates, approveRelease2, approveRelease2Batch, skipTestRun, testRunHistory,
  replanCandidates, replan, replanDetail, replanBatch, planHistory,
  giaCongList, giaCongToOqc, giaCongHistory, giaCongTemCancelable, giaCongTemHuy, giaCongTraLai,
  keHoachTamList, keHoachTamSet, keHoachTamConfirm, keHoachTamUpdate, keHoachTamDelete, keHoachTamHistory, keHoachTamDone,
  cancelableLenh, cancelLenh, returnTestRunToReady,
  release1Done, release2Done, replanDone, testCnspDone, testQaDone,
};
