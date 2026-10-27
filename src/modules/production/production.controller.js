'use strict';

const service = require('./production.service');
const planningService = require('../planning/planning.service'); // dùng chung candidate Test Run
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const AppError = require('../../utils/AppError');
const { getPaging, TRAN_TAI_HET } = require('../../utils/pagination');
const { nhoDoc } = require('../../utils/cacheDoc');
const { HAU_TO_CA } = require('../../utils/ca');

// Chờ chạy / Đang chạy dùng chung kết quả giữa mọi người xem (`utils/cacheDoc.js` — ghi là hết hiệu lực ngay).
const candidates = asyncHandler(async (req, res) => {
  const opts = { search: req.query.search || '', ...getPaging(req.query, { tranToiDa: TRAN_TAI_HET }) };
  return ok(res, await nhoDoc('production.candidates', opts, () => service.listCandidates(opts)));
});

const getRun = asyncHandler(async (req, res) => ok(res, await service.getRun(req.params.lenhId)));

// Báo cáo sản xuất ngày (02/10/2026) — `?ngay=YYYY-MM-DD`, thiếu/sai ⇒ hôm nay theo giờ VN.
const { baoCaoNgay } = require('./baoCaoSanXuat');
const ngayHomNayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const baoCaoSanXuat = asyncHandler(async (req, res) => {
  const q = String(req.query.ngay || '').trim();
  const ngay = /^\d{4}-\d{2}-\d{2}$/.test(q) && !Number.isNaN(Date.parse(q)) ? q : ngayHomNayVN();
  return ok(res, await baoCaoNgay(ngay));
});

// Theo dõi sản xuất THEO TỔ (21/10/2026) — `?ngay=YYYY-MM-DD` (thiếu/sai ⇒ hôm nay). Xem `theoDoiTo.js`.
const theoDoiTo = asyncHandler(async (req, res) => {
  const q = String(req.query.ngay || '').trim();
  const ngay = /^\d{4}-\d{2}-\d{2}$/.test(q) && !Number.isNaN(Date.parse(q)) ? q : ngayHomNayVN();
  return ok(res, await require('./theoDoiTo').theoDoiTo(ngay));
});

// Báo cáo bất thường dừng chuyền (02/10/2026) — `?tuNgay=&denNgay=` (YYYY-MM-DD, ngày SX 06:00→06:00).
// Thiếu/sai ⇒ hôm nay; đảo ngược ⇒ tự đổi chỗ; dài quá `NGAY_TOI_DA` ⇒ cắt bớt đầu (giữ đúng ngày cuối).
const { baoCaoDungChuyen: docBaoCaoDungChuyen } = require('./baoCaoDungChuyen');
// Khoảng ngày SX từ query — dùng chung cho 2 báo cáo theo khoảng ngày (luật ở `utils/khoangNgay.js`).
const { khoangNgayTuQuery } = require('../../utils/khoangNgay');
const NGAY_TOI_DA = 93;
const khoangNgay = (req) => khoangNgayTuQuery(req.query, NGAY_TOI_DA);
const baoCaoDungChuyen = asyncHandler(async (req, res) => {
  const { tu, den } = khoangNgay(req);
  return ok(res, await docBaoCaoDungChuyen(tu, den));
});

// Báo cáo kết quả kiểm hàng (02/10/2026) — cùng quy ước khoảng ngày SX. Luật: `utils/baoCaoKiemHang.js`.
const { baoCaoKiemHang: docBaoCaoKiemHang } = require('./baoCaoKiemHang');
const baoCaoKiemHang = asyncHandler(async (req, res) => {
  const { tu, den } = khoangNgay(req);
  return ok(res, await docBaoCaoKiemHang(tu, den));
});

// Báo cáo sửa hàng (09/10/2026) — cùng quy ước khoảng ngày SX. Luật: `utils/baoCaoSuaHang.js`.
const { baoCaoSuaHang: docBaoCaoSuaHang } = require('./baoCaoSuaHang');
const baoCaoSuaHang = asyncHandler(async (req, res) => {
  const { tu, den } = khoangNgay(req);
  return ok(res, await docBaoCaoSuaHang(tu, den));
});

// Báo cáo phân loại lỗi (11/10/2026) — cùng quy ước khoảng ngày SX. Luật: `utils/baoCaoPhanLoaiLoi.js`.
const { baoCaoPhanLoaiLoi: docBaoCaoPhanLoaiLoi } = require('./baoCaoPhanLoaiLoi');
const baoCaoPhanLoaiLoi = asyncHandler(async (req, res) => {
  const { tu, den } = khoangNgay(req);
  return ok(res, await docBaoCaoPhanLoaiLoi(tu, den));
});

const start = asyncHandler(async (req, res) =>
  ok(res, await service.startProduction(req.params.lenhId, req.user.id, req.body.chuyenId || null), 'Đã xác nhận chạy'));

// Xác nhận chạy NHIỀU lệnh (modal Chờ chạy, 08/10/2026): body { items: [{ lenhId, chuyenId? }] } ⇒ { ok, loi }.
const startBatch = asyncHandler(async (req, res) => {
  const kq = await service.startProductionBatch((req.body || {}).items, req.user.id);
  return ok(res, kq, `Đã xác nhận chạy ${kq.ok.length} lệnh${kq.loi.length ? ` · ${kq.loi.length} lệnh lỗi` : ''}`);
});

// Chạy đặc biệt (bỏ Test Run): danh sách = CÙNG candidate Test Run; hành động = khởi chạy thẳng.
const chayDacBietCandidates = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await planningService.listTestRunCandidates({ search: req.query.search || '', page, limit, offset }));
});
const chayDacBiet = asyncHandler(async (req, res) =>
  ok(res, await service.startProductionSpecial(req.params.lenhId, req.user.id, req.body.chuyenId || null, req.body.lyDo || null),
    'Đã chạy đặc biệt (bỏ Test Run)'));

// `req.body` mang thêm ngày ca / giờ SX từ→đến / cờ BTP của LƯỢT IN này (mig 066).
const printTem = asyncHandler(async (req, res) =>
  ok(res, await service.printTem(req.params.phieuId, req.body.soLuong, req.user.id, req.body), 'Đã in tem'));

// In tem NHIỀU phần in 1 lượt (lệnh gom set): body { items: [{ dotVaiId, soLuong }] }.
const printTemBatch = asyncHandler(async (req, res) => {
  const data = await service.printTemBatch(req.params.phieuId, req.body?.items, req.user.id, req.body);
  return ok(res, data, `Đã in ${data.tems_in.length} tem`);
});

const finish = asyncHandler(async (req, res) =>
  ok(res, await service.finishRun(req.params.phieuId, req.user.id), 'Đã hoàn tất chạy'));

const reprintTem = asyncHandler(async (req, res) =>
  ok(res, await service.reprintTem(req.params.temId, req.body.lyDo, req.user.id), 'Đã in lại tem'));

// ?dotVaiId= → nhãn lấy đúng phần in của đợt vải đó (in tem lệnh gom set).
const temLabel = asyncHandler(async (req, res) =>
  ok(res, await service.temLabel(req.params.temId, req.query.dotVaiId || null)));

const temLogs = asyncHandler(async (req, res) => ok(res, await service.temLogs(req.params.phieuId)));

const addVaiHuy = asyncHandler(async (req, res) =>
  ok(res, await service.addVaiHuy(req.params.phieuId, req.body, req.user.id),
    req.body?.loai === 'THIEU' ? 'Đã ghi vải thiếu' : 'Đã ghi vải hủy'));

// Vải hủy / thiếu NHẬP Ở TEM (21/10/2026) — body { huy, thieu, dotVaiId?, lyDo? }. Xem `service.suaVaiTheoTem`.
const xemVaiTem = asyncHandler(async (req, res) => ok(res, await service.xemVaiTem(req.params.temId)));
const suaVaiTheoTem = asyncHandler(async (req, res) =>
  ok(res, await service.suaVaiTheoTem(req.params.temId, req.body || {}, req.user.id), 'Đã lưu vải hủy / thiếu của tem'));
const gopLenh = asyncHandler(async (req, res) =>
  ok(res, await service.gopLenhCungPhan((req.body || {}).lenhIds, req.user.id, { lyDo: (req.body || {}).lyDo || '' }), 'Đã gộp lệnh'));
const tachLenhNgc = asyncHandler(async (req, res) =>
  ok(res, await service.tachLenhTheoNgc(req.params.lenhId, req.user.id, { lyDo: (req.body || {}).lyDo || '' }), 'Đã tách lệnh theo nhà gia công'));
const suaTem = asyncHandler(async (req, res) =>
  ok(res, await service.suaTem(req.params.temId, req.body || {}, req.user.id), 'Đã sửa tem'));

// Phân công sản xuất: body { caTruongId, chuyenTruong, items: [{ dotVaiId, thoIn, soLuongHuy, soLuongThieu }] }
const savePhanCong = asyncHandler(async (req, res) =>
  ok(res, await service.savePhanCong(req.params.phieuId, req.body || {}, req.user.id), 'Đã lưu phân công'));

const stopLine = asyncHandler(async (req, res) =>
  ok(res, await service.stopLine(req.params.phieuId, req.body.lyDo, req.user.id, req.body.gioBd || null,
    req.body.lyDoId || null, req.body.gioKt || null), 'Đã ngừng chuyền'));

// ─── Danh mục lý do ngừng chuyền (mig 076) ───────────────────────────────────
const lyDoNgungList = asyncHandler(async (req, res) =>
  ok(res, await service.dsLyDoNgung({ search: req.query.search || '', all: req.query.all === '1' })));
const lyDoNgungCreate = asyncHandler(async (req, res) =>
  ok(res, await service.taoLyDoNgung(req.body, req.user.id), 'Đã thêm lý do'));
const lyDoNgungUpdate = asyncHandler(async (req, res) => {
  await service.suaLyDoNgung(req.params.id, req.body, req.user.id); ok(res, null, 'Đã cập nhật');
});
const lyDoNgungToggle = asyncHandler(async (req, res) => {
  await service.doiTrangThaiLyDoNgung(req.params.id, req.body.active !== false, req.user.id);
  ok(res, null, 'Đã cập nhật');
});

// ─── Danh mục TỔ IN (mig 084) ────────────────────────────────────────────────
const toInList = asyncHandler(async (req, res) =>
  ok(res, await service.dsToIn({ search: req.query.search || '', all: req.query.all === '1' })));
const toInCreate = asyncHandler(async (req, res) =>
  ok(res, await service.taoToIn(req.body, req.user.id), 'Đã thêm tổ in'));
const toInUpdate = asyncHandler(async (req, res) => {
  await service.suaToIn(req.params.id, req.body, req.user.id); ok(res, null, 'Đã cập nhật');
});
const toInToggle = asyncHandler(async (req, res) => {
  await service.doiTrangThaiToIn(req.params.id, req.body.active !== false, req.user.id);
  ok(res, null, 'Đã cập nhật');
});

// ─── Danh mục lý do bổ sung + ghi cho đợt vải (mig 077) ──────────────────────
const lyDoBoSungList = asyncHandler(async (req, res) =>
  ok(res, await service.dsLyDoBoSung({ search: req.query.search || '', all: req.query.all === '1' })));
const lyDoBoSungCreate = asyncHandler(async (req, res) =>
  ok(res, await service.taoLyDoBoSung(req.body, req.user.id), 'Đã thêm lý do'));
const lyDoBoSungUpdate = asyncHandler(async (req, res) => {
  await service.suaLyDoBoSung(req.params.id, req.body, req.user.id); ok(res, null, 'Đã cập nhật');
});
const lyDoBoSungToggle = asyncHandler(async (req, res) => {
  await service.doiTrangThaiLyDoBoSung(req.params.id, req.body.active !== false, req.user.id);
  ok(res, null, 'Đã cập nhật');
});
const luuLyDoBoSungDotVai = asyncHandler(async (req, res) =>
  ok(res, await service.luuLyDoBoSungDotVai(req.params.dotVaiId, req.body, req.user.id), 'Đã lưu lý do bổ sung'));

const resumeLine = asyncHandler(async (req, res) =>
  ok(res, await service.resumeLine(req.params.phieuId, req.user.id, req.body?.gioKt || null), 'Chuyền hoạt động lại'));

const monitor = asyncHandler(async (req, res) => ok(res, await nhoDoc('production.monitor', '', () => service.monitor())));

const xePhoi = asyncHandler(async (req, res) => ok(res, await service.getXePhoi()));

const temChoPhoi = asyncHandler(async (req, res) => ok(res, await service.listTemChoPhoi(req.query.search || '')));

const themTem = asyncHandler(async (req, res) =>
  ok(res, await service.addToXe(req.body, req.user.id), 'Đã đưa tem vào xe phơi'));

const adjustPhoi = asyncHandler(async (req, res) =>
  ok(res, await service.adjustPhoi(req.params.id, req.body.phut, req.user.id), 'Đã điều chỉnh thời gian phơi'));

const drying = asyncHandler(async (req, res) => ok(res, await service.listDrying(req.query.search || '')));

const confirmDry = asyncHandler(async (req, res) =>
  ok(res, await service.confirmDry(req.params.temId, req.user.id, req.body || {}), 'Đã xác nhận khô'));
// Báo cáo tem KCS kiểm TRƯỚC giờ phơi xong dự kiến (27/10/2026, nút ở màn KCS).
const kiemTruocKho = asyncHandler(async (req, res) =>
  ok(res, await service.listKiemTruocKho(req.query.tuNgay, req.query.denNgay)));

const redry = asyncHandler(async (req, res) =>
  ok(res, await service.redry(req.params.temId, req.body.phut, req.user.id), 'Đã đưa tem phơi lại'));

// Hủy lệnh in tem (tem chưa kiểm)
const cancelableTem = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listCancelableTem({ search: req.query.search || '', page, limit, offset }));
});

const cancelPrintTem = asyncHandler(async (req, res) =>
  ok(res, await service.cancelPrintTem(req.params.temId, req.body.lyDo, req.user.id), 'Đã hủy lệnh in tem'));
// Nút "Hủy" ở danh sách Tem đã in (14/10/2026) — lý do bắt buộc.
const cancelPrintTemLichSu = asyncHandler(async (req, res) => {
  const lyDo = String((req.body && req.body.lyDo) || '').trim();
  if (!lyDo) throw new AppError('Phải nhập lý do hủy tem', { status: 422, errorCode: 'NO_LY_DO' });
  return ok(res, await service.cancelPrintTem(req.params.temId, lyDo, req.user.id), 'Đã hủy tem');
});

// MỞ LẠI TEM IN ĐÃ HỦY (14/10/2026) — lý do BẮT BUỘC ở cả 2 lối (trang Hủy lệnh xác nhận · "Tem đã in").
const reopenableTem = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query);
  return ok(res, await service.listReopenableTem({ search: req.query.search || '', page, limit, offset }));
});
const reopenPrintTem = asyncHandler(async (req, res) =>
  ok(res, await service.reopenPrintTem(req.params.temId, (req.body && req.body.lyDo) || '', req.user.id), 'Đã mở lại tem'));

// DANH SÁCH TEM ĐÃ IN (xem thông tin tem, không cần in). `laGiaCong` do ROUTE quyết, không nhận từ
// query — xem ghi chú ở `service.listTemDaIn`.
const dsTemDaIn = (laGiaCong) => asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPaging(req.query, { tranToiDa: TRAN_TAI_HET });
  const q = req.query;
  return ok(res, await service.listTemDaIn({
    search: q.search || '', ngayTu: q.ngayTu || '', ngayDen: q.ngayDen || '',
    // Lọc NGÀY CA (14/10/2026): khoảng `tem.ngay_ca` + chuỗi mã ngày ca. Ngày sai định dạng ⇒ bỏ (không lỗi 500).
    ngayCaTu: /^\d{4}-\d{2}-\d{2}$/.test(q.ngayCaTu || '') ? q.ngayCaTu : '',
    ngayCaDen: /^\d{4}-\d{2}-\d{2}$/.test(q.ngayCaDen || '') ? q.ngayCaDen : '',
    maNgayCa: String(q.maNgayCa || '').trim().slice(0, 20),
    ca: HAU_TO_CA[String(q.ca || '').toUpperCase()] || '',
    khach: q.khach || '', don: q.don || '', maHang: q.maHang || '', codePhan: q.codePhan || '',
    maTem: q.maTem || '', chuyen: q.chuyen || '', chuyenId: q.chuyenId || '',
    // Khu chuyền (26/10/2026) — chip loại ⇒ `loaiChuyen`, chip khu ⇒ `maChuyen` (danh sách mã, ngăn dấu phẩy).
    loaiChuyen: /^[A-Z_]{1,30}$/i.test(q.loaiChuyen || '') ? q.loaiChuyen : '',
    maChuyenDs: String(q.maChuyen || '').slice(0, 400),
    page, limit, offset,
  }, laGiaCong));
});

// Đóng lệnh sản xuất (= Chạy hoàn tất)
const closeCandidates = asyncHandler(async (req, res) => ok(res, await service.listCloseCandidates()));

const closeProduction = asyncHandler(async (req, res) =>
  ok(res, await service.closeProduction(req.params.phieuId, req.body.lyDo, req.user.id), 'Đã đóng lệnh sản xuất'));

// Mở lại lệnh sản xuất (đã đóng/hoàn tất, cần in tiếp) — trong 2 ngày
const reopenCandidates = asyncHandler(async (req, res) => ok(res, await service.listReopenCandidates()));

const reopenProduction = asyncHandler(async (req, res) =>
  ok(res, await service.reopenProduction(req.params.phieuId, req.user.id), 'Đã mở lại lệnh sản xuất'));

// Ngừng lệnh chạy (ngừng phần in để in hàng gấp) → lệnh về chờ chạy
const pauseLenhChay = asyncHandler(async (req, res) =>
  ok(res, await service.pauseLenhChay(req.params.phieuId, req.user.id), 'Đã ngừng lệnh chạy — lệnh về chờ chạy'));

// Đổi chuyền của lượt chạy (máy hỏng / dồn tải) — đổi cả phiếu lẫn lệnh.
const doiChuyen = asyncHandler(async (req, res) =>
  ok(res, await service.doiChuyen(req.params.phieuId, req.body || {}, req.user.id), 'Đã đổi chuyền'));

// Hủy lệnh đang chạy (bấm nhầm Xác nhận chạy) → về chờ chạy
const undoStartCandidates = asyncHandler(async (req, res) => ok(res, await service.listUndoStartCandidates()));

const undoStartProduction = asyncHandler(async (req, res) =>
  ok(res, await service.undoStartProduction(req.params.phieuId, req.user.id), 'Đã hủy lệnh đang chạy — đưa về chờ chạy'));

// Trả về Kỹ thuật từ màn Xác nhận chạy (chờ chạy / đang chạy) → hủy lệnh + phần in quay lại READY
const traVeKyThuat = asyncHandler(async (req, res) =>
  ok(res, await service.traVeKyThuat(req.params.lenhId, req.body || {}, req.user.id),
    'Đã trả về Kỹ thuật — phần in quay lại READY'));
// Trả về Kế hoạch khi ĐANG CHẠY (22/10/2026): body { items: [{ lenhId, soLuong }], lyDo } ⇒ { ok, loi }.
const traVeKeHoachSx = asyncHandler(async (req, res) =>
  ok(res, await service.traVeKeHoachSx(req.body || {}, req.user.id), 'Đã xử lý trả về Kế hoạch'));

const vuotSanXuat = asyncHandler(async (req, res) =>
  ok(res, await service.vuotSanXuat(req.params.phieuId, req.body?.soLuong, req.user.id), 'Đã ghi nhận vượt sản xuất'));

// ─── DANH SÁCH RELEASE CỦA SẢN XUẤT (26/10/2026) ─────────────────────────────────────────────────────────────
const dsRelease = require('./dsReleaseSx');
const RE_NGAY = /^\d{4}-\d{2}-\d{2}$/;
const RE_ID = /^[0-9a-f-]{36}$/i;
// Khoảng NGÀY IN TEM (26/10/2026): `tuNgay` + `denNgay` (≤ 62 ngày); `ngay` cũ = 1 ngày.
const khoangNgayIn = (q) => {
  const tu = String(q.tuNgay || q.ngay || '');
  const den = String(q.denNgay || tu);
  if (!RE_NGAY.test(tu) || !RE_NGAY.test(den) || den < tu) throw new AppError('Ngày không hợp lệ', { status: 422, errorCode: 'VALIDATION' });
  if ((Date.parse(den) - Date.parse(tu)) / 86400000 > 62) throw new AppError('Khoảng ngày tối đa 62 ngày', { status: 422, errorCode: 'VALIDATION' });
  return [tu, den];
};
const dsReleaseSx = asyncHandler(async (req, res) => {
  ok(res, await dsRelease.dsReleaseSx(...khoangNgayIn(req.query)));
});
const nhatKyIn = asyncHandler(async (req, res) => {
  ok(res, await dsRelease.nhatKyIn(...khoangNgayIn(req.query)));
});
// DM+TEST = số nguyên ≥ 0 (trống = xóa); ghi chú ≤ 500 ký tự. Chỉ khóa có trong body bị đổi.
const luuDongDsRelease = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!RE_ID.test(String(b.lenhId || '')) || !RE_ID.test(String(b.phanInId || ''))) {
    throw new AppError('Thiếu lệnh / phần in', { status: 422, errorCode: 'VALIDATION' });
  }
  const d = { lenhId: b.lenhId, phanInId: b.phanInId };
  if ('dmTest' in b) {
    const v = b.dmTest === '' || b.dmTest == null ? null : Number(b.dmTest);
    if (v != null && (!Number.isInteger(v) || v < 0 || v > 1e7)) throw new AppError('DM + TEST phải là số nguyên ≥ 0', { status: 422, errorCode: 'VALIDATION' });
    d.dmTest = v;
  }
  if ('ghiChu' in b) {
    const g = String(b.ghiChu == null ? '' : b.ghiChu).trim();
    if (g.length > 500) throw new AppError('Ghi chú tối đa 500 ký tự', { status: 422, errorCode: 'VALIDATION' });
    d.ghiChu = g || null;
  }
  ok(res, await dsRelease.luuDong(d, req.user.id), 'Đã lưu');
});
const docChuyenThem = asyncHandler(async (req, res) => {
  ok(res, await dsRelease.docChuyenThem(req.user.id, String(req.query.khu || '').slice(0, 40)));
});
const luuChuyenThem = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.maChuyen)) throw new AppError('Thiếu danh sách chuyền', { status: 422, errorCode: 'VALIDATION' });
  ok(res, await dsRelease.luuChuyenThem(req.user.id, String(b.khu || '').slice(0, 40), b.maChuyen), 'Đã lưu chuyền thêm');
});

module.exports = {
  dsReleaseSx, nhatKyIn, luuDongDsRelease, docChuyenThem, luuChuyenThem,
  candidates, getRun, start, startBatch, chayDacBietCandidates, chayDacBiet, printTem, printTemBatch, reprintTem, temLabel, temLogs, finish, monitor,
  theoDoiTo,
  xePhoi, temChoPhoi, themTem, adjustPhoi, drying, confirmDry, kiemTruocKho, redry,
  stopLine, resumeLine, addVaiHuy, xemVaiTem, suaVaiTheoTem, suaTem, gopLenh, tachLenhNgc, savePhanCong, vuotSanXuat,
  lyDoNgungList, lyDoNgungCreate, lyDoNgungUpdate, lyDoNgungToggle,
  toInList, toInCreate, toInUpdate, toInToggle, baoCaoSanXuat, baoCaoDungChuyen, baoCaoKiemHang, baoCaoSuaHang,
  baoCaoPhanLoaiLoi,
  lyDoBoSungList, lyDoBoSungCreate, lyDoBoSungUpdate, lyDoBoSungToggle, luuLyDoBoSungDotVai,
  cancelableTem, cancelPrintTem, cancelPrintTemLichSu, reopenableTem, reopenPrintTem,
  temDaInSX: dsTemDaIn(false), temDaInGiaCong: dsTemDaIn(true),
  closeCandidates, closeProduction,
  reopenCandidates, reopenProduction, pauseLenhChay, doiChuyen,
  undoStartCandidates, undoStartProduction,
  traVeKyThuat,
  traVeKeHoachSx,
};
