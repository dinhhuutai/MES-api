'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./delivery.repository');
const qualityRepo = require('../quality/quality.repository'); // dùng chung: người xác nhận trạm trước
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');
// 2 API ERP của phiếu giao (04/09/2026) — helper KHÔNG BAO GIỜ ném lỗi, xem `utils/erpApiChung.js`.
const erp = require('../../utils/erpApiChung');
const env = require('../../config/env');
const { ghiLog } = require('../../utils/erpApiLog');

// Dùng chung 2 màn (xem `repo.listTemGiao`): `SAN_SANG` = Giao hàng · `CHO_TICH` = Tích tem giao hàng.
async function dsTemGiao(q = {}, cheDo) {
  const { search, ngayTu, ngayDen, tem, khach, don, maHang, mauVai, kichVai, kichPhim } = q;
  const nap = cheDo === 'CHO_TICH' ? repo.listTemChoTich : repo.listTemSanSang;
  const rows = await nap({
    search: search || '',
    filters: { tem, khach, don, maHang, mauVai, kichVai, kichPhim },
    ngayTu: ngayTu || '', ngayDen: ngayDen || '',
  });
  // Gắn "người xác nhận trạm trước" (Giao ← OQC) — query nhẹ theo tem_id.
  const pc = await qualityRepo.prevConfirmerByTems(rows.map((r) => r.tem_id));
  const map = new Map(pc.map((x) => [x.tem_id, x]));
  rows.forEach((r) => { r.nguoi_truoc = (map.get(r.tem_id) || {}).nguoi_oqc || null; });
  return rows;
}

const listTemSanSang = (q = {}) => dsTemGiao(q, 'SAN_SANG');

// ─── CHỐT CHẶN "BÁN HÀNG TÍCH TEM" (mig 092) ─────────────────────────────────────────────────
// Một endpoint phục vụ 2 tab của trang *Tích tem giao hàng*: `daTich` = tab "Đã tích" (để BỎ tích
// khi bấm nhầm) — cố ý KHÔNG bắt tab đó gọi `/tem-san-sang`, route kia gác `DELIVERY_*` mà bán hàng
// thường chỉ có `TICH_GIAO`.
// `co_cot` cho FE biết đã chạy mig 092 chưa để hiện banner thay vì bảng trống khó hiểu.
async function listTemChoTich(q = {}) {
  const rows = await dsTemGiao(q, q && q.daTich ? 'SAN_SANG' : 'CHO_TICH');
  return { items: rows, co_cot: await repo.coCotTichGiao() };
}

function chuanIds(temIds) {
  const ids = [...new Set((Array.isArray(temIds) ? temIds : []).filter(Boolean).map(String))];
  if (!ids.length) throw new AppError('Chọn ít nhất một tem', { status: 422, errorCode: 'NO_TEM' });
  return ids;
}

async function assertCoCotTich() {
  if (!(await repo.coCotTichGiao())) {
    throw new AppError('Chưa chạy migration 092 — chưa dùng được chức năng tích tem giao hàng',
      { status: 409, errorCode: 'THIEU_MIGRATION' });
  }
}

// Tích: mở khóa cho màn Giao hàng lập phiếu. Bấm lại tem đã tích ⇒ bỏ qua im lặng (không ghi đè mốc
// của người tích trước), số thật sự đổi trả về ở `da_tich`.
async function tichTem(temIds, actorId) {
  await assertCoCotTich();
  const ids = chuanIds(temIds);
  const rows = await withTransaction((client) => repo.tichTem(client, ids, actorId));
  if (rows.length) {
    await repo.ghiAuditTich('TICH_GIAO', rows, actorId);
    sockets.emit('delivery:updated', { stage: 'TICH', so_tem: rows.length });
  }
  return { da_tich: rows.length, bo_qua: ids.length - rows.length, tems: rows };
}

// Bỏ tích (sửa khi bấm nhầm). ⚠ Tem đã nằm trong phiếu giao thì KHÔNG bỏ được — trả rõ mã phiếu
// để người dùng biết đường xử lý, thay vì im lặng bỏ qua rồi tưởng hệ thống hỏng.
async function boTichTem(temIds, actorId) {
  await assertCoCotTich();
  const ids = chuanIds(temIds);
  const vuong = await repo.temDaVaoPhieu(ids);
  const rows = await withTransaction((client) => repo.boTichTem(client, ids, actorId));
  if (rows.length) {
    await repo.ghiAuditTich('BO_TICH_GIAO', rows, actorId);
    sockets.emit('delivery:updated', { stage: 'BO_TICH', so_tem: rows.length });
  }
  return { da_bo: rows.length, tems: rows, vuong_phieu: vuong };
}

// Quét không ra thì phải NÓI VÌ SAO (khuôn `technical.traCuuMaQuet`, §6): người quét chỉ thấy
// "không thấy mã" sẽ đi nghi máy quét hỏng trong khi lý do thật là tem chưa qua OQC / đã tích rồi.
async function traCuuTemTich(code) {
  const ma = String(code || '').trim();
  if (!ma) return { tim_thay: false, ly_do: 'RONG', mo_ta: 'Chưa nhập mã' };
  const t = await repo.traCuuTemTich(ma);
  if (!t) return { tim_thay: false, ly_do: 'KHONG_TON_TAI', mo_ta: `Không có tem nào mang mã "${ma}"` };
  const g = { tim_thay: true, ma_tem: t.ma_tem };
  if (t.trang_thai === 'HUY') return { ...g, ly_do: 'DA_HUY', mo_ta: `Tem ${t.ma_tem} đã bị HỦY` };
  if (Number(t.sl_oqc_dat) <= 0) {
    return { ...g, ly_do: 'CHUA_OQC', mo_ta: `Tem ${t.ma_tem} chưa được OQC xác nhận đạt — chưa tới lượt tích` };
  }
  if (Number(t.con_giao) <= 0) {
    return { ...g, ly_do: 'DA_GIAO_HET', mo_ta: `Tem ${t.ma_tem} đã giao hết (${t.sl_da_giao}/${t.sl_oqc_dat})` };
  }
  if (t.da_tich_giao) {
    const ai = t.nguoi_tich_giao ? ` bởi ${t.nguoi_tich_giao}` : '';
    return { ...g, ly_do: 'DA_TICH', mo_ta: `Tem ${t.ma_tem} đã được tích${ai} — xem ở màn Giao hàng` };
  }
  // Còn đủ điều kiện mà danh sách trên máy không có ⇒ dữ liệu đang cũ (khuôn `CON_O_READY`).
  return { ...g, ly_do: 'CON_CHO_TICH', mo_ta: `Tem ${t.ma_tem} vẫn đang chờ tích — dữ liệu trên máy đang cũ, đóng/mở lại danh sách` };
}

async function getDetail(giaoHangId) {
  const gh = await repo.getGiaoHang(giaoHangId);
  if (!gh) throw new AppError('Phiếu giao không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const tems = await repo.getGiaoHangTems(giaoHangId);
  return { ...gh, tems };
}

// items: [{ temId, soLuong }] — soLuong = SL giao lần này (không nhập → giao hết phần còn lại).
// Vẫn nhận temIds (mảng id) để tương thích: giao hết phần còn lại của mỗi tem.
//
// ⚠⚠ `xacNhan = true` ⇒ TẠO PHIẾU RỒI CHỐT LUÔN (người dùng chốt 08/09/2026: "in phiếu = xác nhận
//   giao"): cộng sổ cái `sl_da_giao`, tem sang DONE_DELIVERY, đẩy phiếu sang ERP. Nhờ vậy tem RỜI
//   màn *Danh sách tem giao* ngay khi in xong — muốn lấy lại thì dùng *Hủy phiếu giao* ở Hệ thống.
//   Bỏ trống ⇒ giữ luồng 2 bước như trước (tạo phiếu, xác nhận sau).
// ⚠ `giaoHangTai` = ô người lập gõ lúc IN (gợi ý sẵn từ `khach_hang.dia_chi_giao`, sửa được). Lưu vào
//   CHÍNH phiếu (mig 099) chứ không suy ngược từ khách hàng: khách đổi địa chỉ thì phiếu CŨ phải giữ
//   nguyên địa điểm đã giao. Thiếu migration ⇒ repository tự bỏ qua, không chặn việc lập phiếu.
async function createGiaoHang({ items, temIds, ngayGiao, ghiChu, giaoHangTai, xacNhan }, actorId) {
  const list = Array.isArray(items) && items.length
    ? items.map((it) => ({ temId: it.temId, nguon: it.nguon === 'SUA' ? 'SUA' : 'KCS', soLuong: it.soLuong != null ? Number(it.soLuong) : null,
      klg: it.klg }))
    : (Array.isArray(temIds) ? temIds.map((t) => ({ temId: t, nguon: 'KCS', soLuong: null })) : []);
  if (list.length === 0) throw new AppError('Chọn ít nhất một tem để giao', { status: 422, errorCode: 'NO_TEM' });
  const temIdList = [...new Set(list.map((x) => x.temId))];
  const donIds = await repo.donHangIdsForTems(temIdList);
  const donHangId = donIds.length === 1 ? donIds[0] : null;
  const maPhieu = await layMaPhieuGiao(actorId);

  const id = await withTransaction(async (client) => {
    const ghId = await repo.createGiaoHang(client, {
      maPhieu, donHangId, ngayGiao, ghiChu,
      giaoHangTai: typeof giaoHangTai === 'string' ? giaoHangTai.trim().slice(0, 500) || null : null,
    }, actorId);
    for (const it of list) await repo.addTem(client, ghId, it.temId, it.soLuong, it.nguon, actorId);
    // KLG hàng RCS (mig 102) nhập ở modal in — ghi cùng transaction; thiếu cột thì repository bỏ qua.
    const coKlg = list.filter((it) => it.klg != null && it.klg !== '');
    if (coKlg.length) {
      await repo.setKlgDong(client, ghId, coKlg.map((it) => ({ tem_id: it.temId, nguon: it.nguon, klg: it.klg })), actorId);
    }
    return ghId;
  });
  sockets.emit('delivery:updated', { giaoHangId: id, stage: 'TAO' });
  if (xacNhan) return confirmGiao(id, actorId);
  return getDetail(id);
}

// SỐ PHIẾU GIAO — ưu tiên số do ERP cấp, lỗi/tắt thì lùi về dãy MES `PG0001`.
// ⚠⚠ GỌI TRƯỚC transaction: mỗi lượt gọi TIÊU MỘT SỐ của ERP, và gọi HTTP bên trong transaction sẽ
//   giữ khóa bảng `giao_hang` suốt thời gian chờ mạng (xấu nhất ~33s với retry).
// ⚠⚠ CỐ Ý KHÔNG CHẶN khi ERP lỗi (khác `erpTemBarcode` chặn in tem): tem là thứ ERP BẮT BUỘC quét,
//   còn số phiếu giao thì không — chặn ở đây là xưởng không giao được hàng vì mạng.
// ⚠ Vẫn phải kiểm TRÙNG: ERP restart/đếm lại có thể cấp số đã dùng, mà `ma_phieu_giao` là UNIQUE ⇒
//   INSERT sẽ nổ giữa transaction. Trùng thì lùi về dãy MES + ghi cảnh báo.
async function layMaPhieuGiao(actorId) {
  let ma = null;
  try { ma = await erp.layIdPhieuGiao(actorId); } catch (e) { ma = null; }
  if (ma) {
    if (!(await repo.maPhieuGiaoDaDung(ma))) return ma;
    console.warn(`[lay-id-phieu-giao] ⚠ ERP cấp số "${ma}" nhưng MES đã có phiếu mang mã này — dùng dãy MES`);
  }
  return repo.nextMaPhieuGiao();
}

async function listGiaoHang(q = {}) {
  // Tương thích: bên gọi cũ truyền THẲNG chuỗi tìm kiếm.
  if (typeof q === 'string') return repo.listGiaoHang({ search: q });
  return repo.listGiaoHang({
    search: q.search || '', trangThai: q.trangThai || '',
    ngayTu: q.ngayTu || '', ngayDen: q.ngayDen || '',
  });
}

const historyGiao = (date) => repo.historyGiaoByDate(date || new Date().toISOString().slice(0, 10));
const doneGiao = (date) => repo.doneGiaoByDate(date || new Date().toISOString().slice(0, 10));

// ─── HỦY PHIẾU GIAO ───────────────────────────────────────────────────────────────────────────
// Đảo sổ cái đã giao ⇒ tem quay lại màn *Danh sách tem giao* (vẫn giữ cờ `da_tich_giao`, không bắt
// bán hàng tích lại). Phiếu chuyển `trang_thai='HUY'` — GIỮ dòng `giao_hang_tem` làm dấu vết, mọi nơi
// kiểm "tem đã vào phiếu" đều bỏ qua phiếu HỦY.
//
// ⚠ LÝ DO BẮT BUỘC (khuôn chung của mọi thao tác hủy trong hệ — §10).
// ⚠⚠ KHÔNG báo ngược cho ERP: `gui-erp-phieu-giao` chưa có hợp đồng "hủy phiếu" từ ERP. Vết hủy nằm
//   ở `audit_log` `HUY_PHIEU_GIAO`; khi ERP chốt API hủy thì nối THÊM ở đây.
async function huyPhieuGiao(giaoHangId, lyDo, actorId) {
  const ly = String(lyDo || '').trim();
  if (!ly) throw new AppError('Phải nhập lý do hủy phiếu giao', { status: 422, errorCode: 'NO_LY_DO' });

  const gh = await repo.getGiaoHang(giaoHangId);
  if (!gh) throw new AppError('Phiếu giao không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (gh.trang_thai === 'HUY') throw new AppError('Phiếu đã bị hủy', { status: 409, errorCode: 'ALREADY' });

  // Guard TRƯỚC MỌI thao tác ghi: sổ cái phải đủ để trừ ngược.
  // ⚠⚠ CHỈ ÁP CHO PHIẾU `DA_GIAO` — phiếu `TAO` chưa hề cộng sổ cái nên `sl_da_giao` của nó vốn
  //   NHỎ HƠN `so_luong_giao`, chạy guard ở đó thì lần nào cũng báo "sổ cái đã thay đổi" ⇒ phiếu
  //   chưa xác nhận KHÔNG BAO GIỜ hủy được (mà `listPhieuGiaoCancelable` vẫn liệt kê nó ra, nên
  //   người dùng bấm hủy chỉ nhận được một câu lỗi khó hiểu). Guard này đo "có đủ số để TRỪ không",
  //   mà nhánh `TAO` phía dưới cố ý KHÔNG trừ gì cả.
  if (gh.trang_thai === 'DA_GIAO') {
    const thieu = await repo.temThieuSoDeHuy(giaoHangId);
    if (thieu.length) {
      throw new AppError(
        `Không hủy được: sổ cái của ${thieu.length} tem đã thay đổi (vd ${thieu[0].ma_tem} đã giao `
        + `${thieu[0].sl_da_giao} < ${thieu[0].so_luong_giao} của phiếu). Xử lý ở tem đó trước.`,
        { status: 409, errorCode: 'SO_CAI_LECH' }
      );
    }
  }

  await withTransaction(async (client) => {
    // Phiếu chưa xác nhận giao thì sổ cái chưa hề cộng ⇒ KHÔNG trừ (trừ là làm âm số của tem).
    if (gh.trang_thai === 'DA_GIAO') await repo.revertGiaoLedger(client, giaoHangId, actorId);
    await repo.markGiaoHuy(client, giaoHangId, actorId);
  });

  try { await repo.insertHuyPhieuAudit(giaoHangId, gh, ly, actorId); } catch (e) { /* best-effort */ }
  sockets.emit('delivery:updated', { giaoHangId, stage: 'HUY' });
  sockets.emit('dashboard:refresh', {});
  return getDetail(giaoHangId);
}

const listPhieuGiaoCancelable = (q = {}) => repo.listPhieuGiaoCancelable({ search: q.search || '' });

async function confirmGiao(giaoHangId, actorId) {
  const gh = await repo.getGiaoHang(giaoHangId);
  if (!gh) throw new AppError('Phiếu giao không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (gh.trang_thai === 'DA_GIAO') throw new AppError('Phiếu đã giao', { status: 409, errorCode: 'ALREADY' });
  if (gh.so_tem === 0) throw new AppError('Phiếu chưa có tem', { status: 422, errorCode: 'EMPTY' });

  // Cộng dồn sổ cái đã giao + đóng phiếu; tem chỉ chuyển DA_GIAO khi đã giao đủ (recompute dominant).
  await withTransaction(async (client) => {
    await repo.applyGiaoLedger(client, giaoHangId, actorId);
    await repo.markGiaoDone(client, giaoHangId, actorId);
  });
  // Theo dõi dòng chảy: các tem trong phiếu giao → trạm DONE_DELIVERY.
  const tems = await repo.getGiaoHangTems(giaoHangId);
  for (const t of tems) await tracking.moveByTem(t.tem_id || t.id, 'DONE_DELIVERY', actorId);
  // Ghi audit_log (ai giao / lúc nào / SL bao nhiêu) — best-effort, không chặn luồng giao.
  try { await repo.insertGiaoAudit(giaoHangId, gh.ma_phieu_giao, tems, actorId); } catch (e) { /* bỏ qua */ }
  // Đẩy phiếu sang ERP — CHẠY NGẦM, KHÔNG `await`: nghiệp vụ đã ghi xong vào MES, ERP chỉ là bên nhận
  // tin. `guiPhieuGiao` không bao giờ ném lỗi; hỏng thì có vết ở *Hệ thống > Cài đặt API > Lịch sử*.
  guiErpPhieuGiao(giaoHangId, gh, tems, actorId);
  sockets.emit('delivery:updated', { giaoHangId, stage: 'DA_GIAO' });
  sockets.emit('dashboard:refresh', {});
  return getDetail(giaoHangId);
}

// Dựng payload phiếu giao rồi bắn sang ERP.
// ⚠⚠ HỢP ĐỒNG proc `MES_spr_MES2SQ0` — ĐÚNG 4 tham số, không hơn: `IDPhieuGiao` · `Ngayct` ·
//   `user` · `DsTemGiao`. (Bản 04/09/2026 gửi 8 trường tự đặt — MaPhieuGiao/Ngaygiao/Khachhang/
//   ChiTiet[]… — nên router ERP nhận `undefined` cả 4 tham số và proc GHI RỖNG mà vẫn trả
//   `success:true`. Sửa 16/09/2026 theo router ERP người dùng gửi.)
// ⚠ Bọc try/catch TOÀN BỘ: kể cả câu đọc dữ liệu mô tả hỏng cũng không được kéo theo lỗi cho `confirmGiao`.
// ⚠ TRẢ kết quả `{ ok, error?, bo_qua? }` của `erp.guiPhieuGiao` — nhánh `confirmGiao` không `await`
//   nên không dùng tới, nhưng nút "Gửi lại ERP" thì cần để báo cho người bấm. Lỗi vẫn bị NUỐT như cũ.
// ID phiếu do ERP cấp có dạng `SQ026LA-009650`; mã MES tự sinh khi ERP lỗi là `PG0001` (`nextMaPhieuGiao`).
const laIdErp = (ma) => !!ma && !/^PG\d+$/i.test(String(ma).trim());

// Ghi 1 dòng LỖI vào lịch sử API khi CHƯA đủ điều kiện gửi — để dòng đó hiện ở *Cài đặt API › Lịch sử* kèm
//   nút "Gửi lại ERP" (nếu im lặng bỏ qua thì phiếu biến mất khỏi mọi chỗ tra cứu).
async function ghiChuaGui(giaoHangId, gh, loi, actorId) {
  await ghiLog('ERP_GUI_PHIEU_GIAO', {
    thanhCong: false, idBanGhi: giaoHangId, url: env.erp.guiPhieuGiaoUrl,
    gui: { IDPhieuGiao: gh.ma_phieu_giao }, loi, actorId,
  });
}

async function guiErpPhieuGiao(giaoHangId, gh, tems, actorId) {
  try {
    // ⚠⚠ CHỈ GỬI KHI ĐÃ CÓ ID PHIẾU GIAO CỦA ERP + CÓ DỮ LIỆU (người dùng chốt 26/09/2026): phiếu đang mang
    //   mã MES tự sinh (ERP không cấp được số lúc lập) mà gửi đi thì `@pID` là mã ERP không hề biết. Ghi 1 dòng
    //   lỗi ⇒ bấm "Gửi lại ERP" (Cài đặt API › Lịch sử / panel phiếu giao) sẽ xin ID rồi mới gửi.
    if (!laIdErp(gh.ma_phieu_giao)) {
      const loi = `Chưa có ID phiếu giao của ERP (đang mang mã MES ${gh.ma_phieu_giao}) — bấm "Gửi lại ERP" để xin ID rồi gửi`;
      await ghiChuaGui(giaoHangId, gh, loi, actorId);
      return { ok: false, error: loi, chua_co_id: true };
    }
    const dsTem = erp.dsTemGiao(tems);
    if (!dsTem) {
      const loi = 'Phiếu không có mã tem nào để gửi';
      await ghiChuaGui(giaoHangId, gh, loi, actorId);
      return { ok: false, error: loi, thieu_du_lieu: true };
    }
    return await erp.guiPhieuGiao({
      IDPhieuGiao: gh.ma_phieu_giao,
      // Ngày chứng từ = NGÀY GIAO của phiếu (lùi về hôm nay nếu thiếu).
      Ngayct: ngayErp(gh.ngay_giao),
      user: await erp.tenDangNhap(actorId),
      DsTemGiao: dsTem,
    }, { giaoHangId, actorId });
  } catch (e) {
    console.error(`[gui-erp-phieu-giao] ✗ Không gửi được (phiếu ${gh.ma_phieu_giao}): ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ─── GỬI LẠI PHIẾU GIAO SANG ERP (bằng tay) ───────────────────────────────────────────────────
// ⚠⚠ VÌ SAO CẦN: chiều đẩy chạy NGẦM và KHÔNG BAO GIỜ ném lỗi ⇒ ERP hỏng thì phiếu vẫn giao bình
//   thường trong MES, nhưng bên ERP **không có gì cả** và chẳng ai biết cho tới khi mở
//   *Hệ thống → Cài đặt API → Lịch sử*. Trước khi có nút này, phiếu đã trượt là **mất luôn** — không
//   có đường nào đẩy lại ngoài việc sửa tay dưới DB.
//   Ca thật: 16/09 → 18/09/2026 có 3 phiếu (`SQ026LA-009547` · `-009612` · `-009650`) ăn HTTP 500
//   *"MES_spr_MES2SQ0 expects parameter '@pID', which was not supplied"* — lỗi nằm ở ROUTER ERP
//   (`request.input('pIDPhieuGiao', …)` trong khi proc khai `@pID`), payload MES gửi đã đúng hợp đồng.
//   Sửa xong bên ERP thì bấm nút này để đẩy lại 3 phiếu đó, không phải giao lại hàng.
// ⚠ Khác 2 đường gọi kia: hàm này **CÓ `await`** và TRẢ KẾT QUẢ cho người bấm (họ đang đứng chờ để
//   biết ERP đã nhận chưa) — đừng chạy ngầm ở đây.
// ⚠ CHỈ cho phiếu ĐÃ XÁC NHẬN GIAO: phiếu `TAO` chưa cộng sổ cái, phiếu `HUY` thì ERP không nên nhận.
async function guiLaiErp(giaoHangId, actorId) {
  const gh = await repo.getGiaoHang(giaoHangId);
  if (!gh) throw new AppError('Phiếu giao không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (gh.trang_thai !== 'DA_GIAO') {
    throw new AppError('Chỉ gửi lại được phiếu ĐÃ xác nhận giao', { status: 409, errorCode: 'CHUA_GIAO' });
  }
  const ma0 = gh.ma_phieu_giao;
  const tems = await repo.getGiaoHangTems(giaoHangId);
  if (!erp.dsTemGiao(tems)) {
    throw new AppError('Phiếu không có mã tem nào — không có dữ liệu để gửi ERP', { status: 409, errorCode: 'THIEU_DU_LIEU' });
  }
  // Phiếu đang mang mã MES tự sinh ⇒ XIN ID ERP TRƯỚC, đổi mã phiếu sang ID đó rồi mới gửi.
  if (!laIdErp(gh.ma_phieu_giao)) {
    let moi = null;
    try { moi = await erp.layIdPhieuGiao(actorId); } catch { moi = null; }
    if (!moi) {
      throw new AppError('Chưa lấy được ID phiếu giao từ ERP (API "Lấy ID phiếu giao" lỗi hoặc đang tắt) — chưa gửi',
        { status: 409, errorCode: 'CHUA_CO_ID' });
    }
    if (await repo.maPhieuGiaoDaDung(moi)) {
      throw new AppError(`ERP cấp số "${moi}" nhưng MES đã có phiếu mang mã này — chưa gửi, thử lại sau`,
        { status: 409, errorCode: 'TRUNG_ID' });
    }
    await repo.doiMaPhieuGiao(giaoHangId, gh.ma_phieu_giao, moi, actorId);
    gh.ma_phieu_giao = moi;
  }
  const kq = await guiErpPhieuGiao(giaoHangId, gh, tems, actorId);
  // `guiErpPhieuGiao` nuốt mọi lỗi (trả undefined khi ném) ⇒ chuẩn hóa về 1 hình dạng cho FE.
  if (kq && kq.ok) return { ok: true, ma_phieu_giao: gh.ma_phieu_giao, so_tem: tems.length, doi_ma: !laIdErp(ma0) };
  if (kq && kq.bo_qua) {
    throw new AppError('API "Gửi phiếu giao" đang TẮT ở Hệ thống → Cài đặt API',
      { status: 409, errorCode: 'API_DANG_TAT' });
  }
  throw new AppError((kq && kq.error) || 'ERP không nhận được phiếu — xem Hệ thống → Cài đặt API → Lịch sử',
    { status: 502, errorCode: 'ERP_LOI' });
}

// ─── ĐẶT "GIAO HÀNG TẠI" CHO PHIẾU ĐÃ LẬP (dùng khi IN LẠI) ────────────────────────────────
// Lúc TẠO phiếu, địa điểm được hỏi trước rồi lưu vào chính phiếu (mig 099). Nhưng in LẠI từ tab
// *Phiếu giao* / 2 sidebar thì phiếu đã tồn tại ⇒ muốn đổi nơi giao phải ghi đè vào phiếu, nếu không
// tờ in ra vẫn mang địa điểm cũ mà người dùng tưởng đã sửa.
// ⚠⚠ GHI ĐÈ VÀO PHIẾU là CỐ Ý (không phải "chỉ áp cho lần in này"): địa điểm là thuộc tính của
//   CHUYẾN GIAO — in 2 tờ cho cùng một phiếu mà mỗi tờ một nơi giao thì không đối soát được.
//   Mọi lần đổi đều ghi `audit_log` (`SUA_GIAO_HANG_TAI`, lưu cả giá trị cũ).
// ⚠ Phiếu ĐÃ HỦY thì chặn — sửa dữ liệu của phiếu không còn hiệu lực chỉ gây hiểu nhầm khi tra cứu.
async function datGiaoHangTai(giaoHangId, giaoHangTai, actorId) {
  const gh = await repo.getGiaoHang(giaoHangId);
  if (!gh) throw new AppError('Phiếu giao không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (gh.trang_thai === 'HUY') {
    throw new AppError('Phiếu đã hủy — không sửa được nơi giao', { status: 409, errorCode: 'DA_HUY' });
  }
  const moi = giaoHangTai == null ? '' : String(giaoHangTai).trim().slice(0, 500);
  // Không đổi gì ⇒ không ghi, không audit (in lại nhiều lần không được đẻ ra hàng chục dòng audit).
  if ((gh.giao_hang_tai || '') === moi) return { id: giaoHangId, giao_hang_tai: gh.giao_hang_tai || null, doi: false };

  const kq = await repo.setGiaoHangTai(giaoHangId, moi, actorId);
  if (!kq) {
    throw new AppError('Chưa chạy migration 099 — chưa lưu được "Giao hàng tại"',
      { status: 409, errorCode: 'THIEU_MIGRATION' });
  }
  try { await repo.insertGiaoHangTaiAudit(giaoHangId, gh, moi, actorId); }
  catch (e) { console.error(`[giao-hang] ✗ Ghi audit SUA_GIAO_HANG_TAI lỗi: ${e.message}`); }
  return { id: giaoHangId, giao_hang_tai: kq.giao_hang_tai, doi: true };
}

// ─── KLG HÀNG RCS KHI IN LẠI (mig 102) ────────────────────────────────────────────────────────
// `dong` = [{ id (giao_hang_tem.id), klg }]. Ghi đè vào phiếu (in lại ra đúng số) — như "Giao hàng tại".
async function datKlg(giaoHangId, dong, actorId) {
  const gh = await repo.getGiaoHang(giaoHangId);
  if (!gh) throw new AppError('Phiếu giao không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (gh.trang_thai === 'HUY') throw new AppError('Phiếu đã hủy — không sửa được KLG', { status: 409, errorCode: 'DA_HUY' });
  if (!(await repo.coCotKlg())) {
    throw new AppError('Chưa chạy migration 102 — chưa lưu được KLG', { status: 409, errorCode: 'THIEU_MIGRATION' });
  }
  const ds = (Array.isArray(dong) ? dong : []).filter((d) => d && d.id);
  const n = await repo.setKlgDong(null, giaoHangId, ds, actorId);
  return { id: giaoHangId, so_dong: n };
}

// `sql.DateTime` bên ERP: gửi chuỗi `YYYY/MM/DD` (khuôn của `ghi-in-tem` đang chạy thật).
// ⚠ Cắt ngày bằng giờ LOCAL — `toISOString()` quy về UTC nên giờ VN trước 07:00 sẽ LÙI 1 NGÀY.
function ngayErp(v) {
  const d = v ? new Date(v) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

module.exports = {
  listTemSanSang, getDetail, createGiaoHang, listGiaoHang, confirmGiao,
  listTemChoTich, tichTem, boTichTem, traCuuTemTich,
  historyGiao, doneGiao, huyPhieuGiao, listPhieuGiaoCancelable,
  guiErpPhieuGiao, // export để kiểm thực payload + gửi lại bằng tay khi ERP lỗi
  guiLaiErp, datGiaoHangTai, datKlg,
};
