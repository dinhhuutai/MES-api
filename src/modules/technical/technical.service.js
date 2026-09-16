'use strict';

const { withTransaction } = require('../../config/db');
const repo = require('./technical.repository');
const wfCache = require('../../utils/wfCache');
const qaRepo = require('../quality/quality.repository'); // qc_tra_ve dùng chung
const thongBao = require('../thongbao/thongbao.service'); // chuông Kỹ thuật (mig 085)
const wf = require('../workflow/workflow.repository');
const AppError = require('../../utils/AppError');
const { buildMeta } = require('../../utils/pagination');
const sockets = require('../../sockets');
const tracking = require('../workflow/tracking.service');
const { isKhuonOptional } = require('../../utils/tech');
const hsktRepo = require('../hskt/hskt.repository');

// Đổi phương án in của HSKT active của phần in (khi xác nhận Khuôn có nhập phương án in).
async function applyPhuongAnIn(phanInId, phuongAnIn, actorId) {
  if (phuongAnIn == null || phuongAnIn === '') return;
  const p = Number(phuongAnIn);
  if (![1, 2, 3].includes(p)) return;
  const h = await hsktRepo.activeHsktOfPhanIn(phanInId);
  if (h && Number(h.phuong_an_in) !== p) {
    try { await hsktRepo.changePhuongAnIn(h.id, p, actorId); } catch (e) { /* best-effort */ }
  }
}

const READY_TRAM = 'READY';
const INPUT_CPS = ['KHUON', 'FILM', 'MUC']; // 3 mục kỹ thuật, xác nhận độc lập (HSKT đã bỏ)
const OPTION_CPS = ['KHUON', 'FILM', 'MUC']; // cần chọn option khi xác nhận
const QC_CP = 'QC_XAC_NHAN';
const TECH_TOTAL = INPUT_CPS.length; // số mục kỹ thuật cần đủ để hoàn tất READY
// ĐÃ BỎ ràng buộc thứ tự "Khuôn mới cần Film trước" (theo yêu cầu: READY không còn chọn giá trị mới/cũ/gia công,
// chỉ cần XÁC NHẬN là xong). Giữ CP_REQUIRES rỗng để mọi nhánh phụ thuộc thành no-op — không cần sửa call-site.
const CP_REQUIRES = {};
const depKey = (ma) => `${(CP_REQUIRES[ma] || '').toLowerCase()}_done`;
const depApplies = () => false; // không còn ràng buộc phụ thuộc nào
// Option mặc định (dùng khi cấu hình checkpoint chưa khai báo trong DB).
const DEFAULT_OPTIONS = {};

// ─── KHUÔN KÉO THEO FILM (chốt 2026-08-14) ───────────────────────────────────
// Xác nhận Khuôn ⇒ hệ thống TỰ ĐẶT Film = DAT luôn, người làm film không phải bấm nữa.
// ⚠ Film VẪN là 1 mục thật (có người + giờ + lịch sử) — cố ý KHÔNG gỡ checkpoint, vì gỡ là
//   kéo theo quyền `READY_FILM`, cột Film ở READY/QC/Excel, 3 dataset báo cáo và metric `FILM_CHO`.
// ⚠ Lịch sử ghi rõ `LY_DO_TU_DONG` để sau này phân biệt được với lần ai đó bấm Film THẬT
//   (`lich_su_trang_thai` chỉ có dòng DAT — xem DATABASE.md §8).
// ⚠ CỐ Ý áp cho MỌI khách, kể cả khách gia công (II/AD): với họ Film không bắt buộc nên đặt thêm
//   cũng vô hại, mà tránh phải tra tên khách trong đường xác nhận HÀNG LOẠT (thêm 1 query nặng).
const FILM_CP = 'FILM';
const LY_DO_TU_DONG = 'Tự động theo Khuôn';
const keoTheoFilm = (ma) => ma === 'KHUON';

// Đọc options của 1 checkpoint từ cau_hinh_json, fallback về DEFAULT_OPTIONS theo mã.
function optionsFor(ma, cfg) {
  let o = [];
  if (cfg) {
    try { const j = typeof cfg === 'string' ? JSON.parse(cfg) : cfg; o = j.options || []; } catch { o = []; }
  }
  return (o && o.length) ? o : (DEFAULT_OPTIONS[ma] || []);
}

// Đọc cấu hình trạm READY + checkpoint (động từ DB) — 1 query thay vì 3.
// ⚠ Bọc CACHE RAM (`utils/wfCache.js`, TTL 60s): hàm này gọi ở 12 chỗ nên gần như MỌI request của
//   module READY tốn thêm 1 round-trip (~25 ms) cho dữ liệu gần như không bao giờ đổi. Sửa workflow
//   ở trang Hệ thống thì `wfconfig` gọi `xoaCache()` ⇒ có hiệu lực tức thì.
// ⚠ Lỗi (chưa cấu hình workflow…) KHÔNG được cache — `nho` chỉ ghi khi nạp thành công.
async function loadConfig() {
  return wfCache.nho('READY_CONFIG', docConfigTuDb);
}

async function docConfigTuDb() {
  const rows = await repo.loadReadyConfig();
  if (rows.length === 0) throw new AppError('Chưa cấu hình workflow đang hiệu lực', { status: 500, errorCode: 'NO_WORKFLOW' });
  const r0 = rows[0];
  const version = { id: r0.version_id, ma_version: r0.ma_version, ten_version: r0.ten_version };
  if (!r0.tram_id) throw new AppError('Workflow chưa có trạm READY', { status: 500, errorCode: 'NO_TRAM' });
  const tram = {
    id: r0.tram_id, ma_tram: r0.ma_tram, ten_tram: r0.ten_tram,
    thu_tu: r0.tram_thu_tu, thoi_gian_quy_dinh_phut: r0.thoi_gian_quy_dinh_phut,
    canh_bao_truoc_phut: r0.canh_bao_truoc_phut,
  };
  const checkpoints = rows.filter((r) => r.cp_id).map((r) => ({
    id: r.cp_id, ma_checkpoint: r.ma_checkpoint, ten_checkpoint: r.ten_checkpoint,
    bat_buoc: r.bat_buoc, thu_tu: r.cp_thu_tu, cau_hinh_json: r.cau_hinh_json, loai_checkpoint: r.loai_checkpoint,
    thoi_gian_quy_dinh_phut: r.cp_sla, canh_bao_truoc_phut: r.cp_cb,
  }));
  const byMa = {};
  checkpoints.forEach((c) => { byMa[c.ma_checkpoint] = c; });
  return { version, tram, checkpoints, byMa };
}

function buildState(results) {
  const done = (ma) => results.find((r) => r.ma_checkpoint === ma)?.trang_thai === 'DAT';
  const khuon_done = done('KHUON');
  const film_done = done('FILM');
  const muc_done = done('MUC');
  // Khách HÀNG GIA CÔNG (II/AD): miễn CẢ Khuôn LẪN Film → đủ KT = chỉ Mực.
  // Khách thường: Mực + Khuôn (xác nhận Khuôn tự kéo Film theo).
  // ⚠ CỐ Ý không xét `film_done` — Film là HỆ QUẢ của Khuôn, không phải điều kiện. Nếu xét thì
  //   hủy Khuôn xong Film vẫn DAT ⇒ tech_done vẫn true ⇒ QC duyệt được mà khuôn chưa làm lại.
  //   Phải khớp với `utils/tech.js techDoneSql` (nguồn của mọi query) — xem ghi chú ở đó.
  const tenKhach = results[0]?.ten_khach_hang;
  const giaCong = isKhuonOptional(tenKhach);
  return {
    khuon_done,
    film_done,
    muc_done,
    khuon_required: !giaCong,
    film_required: false,   // Film không còn là mục BẮT BUỘC của ai (khách thường: Khuôn kéo theo)
    film_hien: !giaCong,    // nhưng vẫn HIỆN cột/mục Film cho khách thường
    tech_done: muc_done && (giaCong || khuon_done),
    qc_done: done(QC_CP),
  };
}

async function getConfig() {
  const { tram, checkpoints } = await loadConfig();
  return { tram, checkpoints: checkpoints.map((c) => ({ ...c, options: optionsFor(c.ma_checkpoint, c.cau_hinh_json) })) };
}

// Giờ VN gọn cho câu giải thích khi quét ("14:22 06/08").
// ⚠ Dựng bằng `formatToParts` chứ KHÔNG `toLocaleString`: dấu phân cách ngày do ICU của từng máy quyết
// định (máy này ra "06/08", máy kia ra "06-08") — ghép tay mới chắc chắn giống nhau ở mọi môi trường.
function gioVN(tg) {
  if (!tg) return '';
  const d = new Date(tg);
  if (Number.isNaN(d.getTime())) return '';
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
    day: '2-digit', month: '2-digit', hour12: false,
  }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return p.hour ? `${p.hour}:${p.minute} ${p.day}/${p.month}` : '';
}

// TRA CỨU MÃ QUÉT — trả lời "quét ra rồi mà sao không thấy trong danh sách?".
// Chỉ dùng cho THÔNG BÁO ở màn READY / QC READY khi `matchRows` không khớp dòng nào; KHÔNG dùng để
// quyết định nghiệp vụ. Phần in đang CÒN ở READY thì nằm sẵn trong danh sách nên không rơi vào đây
// (trường hợp "chưa đủ mục kỹ thuật" đã có `canSelect` ở FE lo).
async function traCuuMaQuet(code) {
  const ma = String(code || '').trim();
  if (!ma) return { tim_thay: false, ly_do: 'KHONG_TON_TAI', mo_ta: null };
  const r = await repo.traCuuMaQuet(ma);
  if (!r) return { tim_thay: false, ly_do: 'KHONG_TON_TAI', mo_ta: null };
  const base = { tim_thay: true, ma_phan: r.ma_phan };
  if (r.dang_hoat_dong === false) {
    return { ...base, ly_do: 'DA_HUY', mo_ta: 'Phần in đã bị hủy (xóa mềm) — xem Hệ thống > Hủy lệnh xác nhận > Mở phần in' };
  }
  if (r.qc_done === true) {
    const tg = gioVN(r.qc_tg);
    const nguoi = r.qc_nguoi ? ` (${r.qc_nguoi})` : '';
    return {
      ...base,
      ly_do: 'DA_QC',
      mo_ta: `Đã QC xác nhận READY${tg ? ` lúc ${tg}` : ''}${nguoi} — xem nút "Đã hoàn thành"`,
    };
  }
  if (r.so_dot_vai > 0 && r.con_dot_cho === false) {
    return { ...base, ly_do: 'DA_RELEASE', mo_ta: 'Đã release hết đợt vải — phần in không còn ở READY' };
  }
  // Còn ở READY mà quét không thấy: dữ liệu trên máy đang cũ (đồng nghiệp vừa thao tác ở máy khác).
  return { ...base, ly_do: 'CON_O_READY', mo_ta: 'Phần in vẫn đang ở READY — bấm đóng rồi mở lại "Quét / tích mã" để tải lại danh sách' };
}

// ─── THEO LOẠI ĐỢT VẢI (mig 098 — người dùng chốt 15/09/2026) ─────────────────
// Phần in đang chờ ở READY bằng ≥2 LOẠI đợt vải (vd "Số lượng" + "Bổ sung") ⇒ màn READY TÁCH DÒNG theo
// loại, và Khuôn/Film/Mực XÁC NHẬN RIÊNG từng dòng ("xác nhận cả 2 lần").
//
// ⚠⚠ DÒNG TỔNG (`ket_qua_checkpoint`) GIỮ NGUYÊN VAI TRÒ: chỉ khi MỌI dòng loại đợt vải đã xác nhận một
//   mục thì mới ghi dòng tổng DAT như cũ ⇒ QC READY, release, dashboard, sĩ số, báo cáo KHÔNG phải sửa.
//   Bảng `ready_xac_nhan_dot` chỉ lưu tiến độ TỪNG ĐỢT cho màn READY.
//
// ⚠⚠ LUẬT "ĐỢT d ĐÃ XÁC NHẬN MỤC cp":
//   (a) dòng tổng DAT **và** đợt d lên READY TRƯỚC lúc xác nhận tổng — dữ liệu cũ (trước mig 098) và mọi
//       đường xác nhận ở MỨC PHẦN IN (panel không theo nhóm, hàng loạt, `simulateReadyDone`) đều phủ đợt
//       đã có mặt lúc đó; đợt về SAU thì KHÔNG được phủ ⇒ phải xác nhận lại đúng dòng của nó; HOẶC
//   (b) có dòng theo đợt DAT và dòng tổng KHÔNG bị HỦY sau mốc `updated_date` của nó — mọi đường hủy ở
//       mức phần in (QC trả về · Test Run trả về · Hủy xác nhận READY · job ERP mở lại READY) tự vô hiệu
//       dòng theo đợt mà KHÔNG phải sửa từng đường đó.
// ⚠ Thiếu mig 098 ⇒ `coBangXacNhanDot()` false ⇒ không tách dòng, mọi thứ chạy như trước.
const tMs = (v) => (v ? new Date(v).getTime() : null);

function dotDaXacNhan(d, tong, pd) {
  if (tong && tong.trang_thai === 'DAT' && tMs(d.tg_chuyen_ready) <= tMs(tong.tg)) {
    return { nguoi: tong.nguoi || null, tg: tong.tg, he_thong: !tong.nguoi_xac_nhan_id };
  }
  if (pd && pd.trang_thai === 'DAT'
      && !(tong && tong.trang_thai === 'HUY' && tMs(tong.updated_date) > tMs(pd.updated_date))) {
    return { nguoi: pd.nguoi || null, tg: pd.tg_xac_nhan, he_thong: false };
  }
  return null;
}

// Gom đợt vải đang chờ theo LOẠI (thứ tự = đợt về sớm nhất trước).
function gomTheoLoai(dots) {
  const m = new Map();
  dots.forEach((d) => {
    const key = d.loai_dot_vai_id || '';
    const g = m.get(key) || { key, ten: d.ten_loai || 'Chưa phân loại', dots: [] };
    g.dots.push(d);
    m.set(key, g);
  });
  return [...m.values()];
}

// Tải trạng thái theo nhóm cho nhiều phần in.
// Trả { loaiCuaPin: Map pin → tên loại của các đợt ĐANG CHỜ, nhomCuaPin: Map pin → [nhóm] (chỉ phần in ≥2 nhóm) }.
// Mỗi nhóm: { key, ten, dots, dot_vai_ids, items: { KHUON|FILM|MUC: { done, nguoi, tg, dotDone:Set } } }.
async function taiNhomLoai(phanInIds, byMa) {
  const loaiCuaPin = new Map();
  const nhomCuaPin = new Map();
  if (!phanInIds.length) return { loaiCuaPin, nhomCuaPin };
  const [coBang, dots] = await Promise.all([repo.coBangXacNhanDot(), repo.dsDotChoReady(phanInIds)]);
  const theoPin = new Map();
  dots.forEach((d) => { const a = theoPin.get(d.phan_in_id) || []; a.push(d); theoPin.set(d.phan_in_id, a); });
  const tach = [];
  theoPin.forEach((ds, pin) => {
    const nhom = gomTheoLoai(ds);
    loaiCuaPin.set(pin, nhom.map((g) => g.ten).join(', '));
    if (coBang && nhom.length >= 2) { tach.push(pin); nhomCuaPin.set(pin, nhom); }
  });
  if (!tach.length) return { loaiCuaPin, nhomCuaPin };

  const cpIds = INPUT_CPS.map((ma) => byMa[ma]?.id).filter(Boolean);
  const [tongRows, pdRows] = await Promise.all([repo.ketQuaTong(tach, cpIds), repo.xacNhanDotRows(tach, cpIds)]);
  const tong = new Map(tongRows.map((r) => [`${r.phan_in_id}|${r.checkpoint_id}`, r]));
  const pd = new Map(pdRows.map((r) => [`${r.dot_vai_ve_id}|${r.checkpoint_id}`, r]));
  nhomCuaPin.forEach((nhom, pin) => {
    nhom.forEach((g) => {
      g.dot_vai_ids = g.dots.map((d) => d.dot_vai_ve_id);
      g.items = {};
      INPUT_CPS.forEach((ma) => {
        const cp = byMa[ma];
        if (!cp) return;
        const t = tong.get(`${pin}|${cp.id}`);
        const dotDone = new Set();
        let moi = null;
        g.dots.forEach((d) => {
          const kq = dotDaXacNhan(d, t, pd.get(`${d.dot_vai_ve_id}|${cp.id}`));
          if (!kq) return;
          dotDone.add(d.dot_vai_ve_id);
          if (!moi || tMs(kq.tg) > tMs(moi.tg)) moi = kq;
        });
        const done = dotDone.size === g.dots.length;
        g.items[ma] = { done, nguoi: done && moi ? moi.nguoi : null, tg: done && moi ? moi.tg : null,
          he_thong: done && moi ? moi.he_thong : false, dotDone, checkpointId: cp.id, tong: t || null };
      });
    });
  });
  return { loaiCuaPin, nhomCuaPin };
}

const techDoneNhom = (g, tenKhach) => !!(g.items.MUC?.done && (isKhuonOptional(tenKhach) || g.items.KHUON?.done));

// Nhóm khớp `dotVaiIds` FE gửi (so tập đợt vải). Không khớp ⇒ null.
function timNhom(nhom, dotVaiIds) {
  if (!nhom || !dotVaiIds || !dotVaiIds.length) return null;
  const s = new Set(dotVaiIds);
  return nhom.find((g) => g.dot_vai_ids.length === s.size && g.dot_vai_ids.every((id) => s.has(id))) || null;
}

// onlyQcReady=true: chỉ phần in đã đủ 3 mục kỹ thuật & chưa QC (cho màn QC bên Chất lượng).
async function listCandidates({ search, page, limit, offset, onlyQcReady = false }) {
  const { tram, byMa } = await loadConfig();
  const inputIds = INPUT_CPS.map((ma) => byMa[ma]?.id).filter(Boolean);
  // SLA hàng READY theo GIAI ĐOẠN (task 3):
  //  - Màn Kỹ thuật (KT chưa đủ 3 mục): dùng SLA trạm READY, đếm từ lúc vào READY. KT xong 3 mục ⇒ ngừng đếm (không đỏ).
  //  - Màn QC (đủ 3 mục, chờ QC): dùng SLA checkpoint QC_XAC_NHAN, đếm từ lúc KT hoàn tất (mục KT cuối được xác nhận).
  const readySla = tram.thoi_gian_quy_dinh_phut != null ? tram.thoi_gian_quy_dinh_phut : 480;
  const readyCanhBao = tram.canh_bao_truoc_phut != null ? tram.canh_bao_truoc_phut : 60;
  const qcCp = byMa[QC_CP] || {};
  const qcSla = qcCp.thoi_gian_quy_dinh_phut != null ? qcCp.thoi_gian_quy_dinh_phut : 60;
  const qcCanhBao = qcCp.canh_bao_truoc_phut != null ? qcCp.canh_bao_truoc_phut : 15;
  const { rows, total } = await repo.listCandidates({
    search, inputIds, qcId: byMa[QC_CP]?.id,
    khuonId: byMa.KHUON?.id, filmId: byMa.FILM?.id, mucId: byMa.MUC?.id,
    onlyQcReady, offset, limit, readySla, readyCanhBao, qcSla, qcCanhBao, techTotal: TECH_TOTAL,
  });
  // ⚠⚠ 4 query HOÀN TOÀN ĐỘC LẬP ⇒ chạy SONG SONG. Bản cũ `await` tuần tự = 4 × ~25 ms round-trip
  //   mạng tới DB (BE và DB ở 2 nơi — DATABASE.md §7) = 100 ms lãng phí trên MỌI lượt mở màn READY.
  //   Cộng với việc `loadConfig` nay có cache, endpoint này đi từ 6 lượt tuần tự xuống còn 2.
  const ids = rows.map((r) => r.id);
  const [rm, rkh, rtt, ci, nl] = await Promise.all([
    // Phần in bị QC (READY) trả về (badge + lọc "chỉ hiện phần bị trả về").
    qaRepo.activeReturnsMap('READY', ids),
    // ... bị KẾ HOẠCH trả về từ Release 1 (loai='RELEASE1') — hiện lý do ngay tại READY.
    qaRepo.activeReturnsMap('RELEASE1', ids),
    // ... bị TEST RUN (QA) trả về (loai='TEST_RUN_KT') — kèm checklist mục rớt (Khuôn/Film/Mực).
    qaRepo.activeReturnsMap('TEST_RUN_KT', ids),
    // Người + giờ xác nhận từng mục KT (query nhẹ theo PK) → phục vụ bảng/Excel màn READY.
    repo.confirmInfoByPins(ids),
    // Đợt vải đang chờ theo LOẠI (+ tiến độ từng nhóm cho phần in ≥2 loại — mig 098).
    taiNhomLoai(ids, byMa),
  ]);
  const CI_KEY = { KHUON: 'khuon', FILM: 'film', MUC: 'muc' };
  const ciMap = {};
  ci.forEach((c) => {
    const k = CI_KEY[c.ma_checkpoint];
    if (!k) return;
    (ciMap[c.phan_in_id] || (ciMap[c.phan_in_id] = {}))[k] = { nguoi: c.nguoi, tg: c.tg };
  });
  const base = rows.map((r) => {
    const c = ciMap[r.id] || {};
    return {
      ...r,
      _key: r.id,
      // ⚠ Cột "Loại đợt vải" = loại của các đợt ĐANG CHỜ ở READY (15/09/2026). Bản cũ `string_agg` MỌI
      //   đợt kể cả đợt đã release từ lâu ⇒ phần in có đợt "Số lượng" cũ + đợt "Bổ sung" mới hiện
      //   "Bổ sung, Số lượng" dù đang chờ đúng 1 loại. Không còn đợt chờ (nhánh Test Run trả về) ⇒ giữ cũ.
      loai_dot_vai: nl.loaiCuaPin.get(r.id) || r.loai_dot_vai,
      trang_thai_ready: r.qc_done ? 'DONE' : r.tech_done ? 'CHO_QC' : r.n_tech_done > 0 ? 'DANG' : 'CHUA',
      tra_ve: rm[r.id] || null,
      tra_ve_ly_do: rm[r.id]?.ly_do || null, // giữ tương thích cũ
      tra_ve_kh: rkh[r.id] || null,          // Kế hoạch (Release 1) trả về Kỹ thuật
      tra_ve_test: rtt[r.id] || null,        // Test Run (QA) trả về Kỹ thuật — kèm mục rớt
      film_nguoi: c.film?.nguoi || null, film_tg: c.film?.tg || null,
      khuon_nguoi: c.khuon?.nguoi || null, khuon_tg: c.khuon?.tg || null,
      muc_nguoi: c.muc?.nguoi || null, muc_tg: c.muc?.tg || null,
    };
  });

  // ⚠⚠ TÁCH DÒNG theo loại đợt vải (chỉ phần in chờ ≥2 loại). Mỗi dòng mang `dot_vai_ids` để FE gửi
  //   kèm khi xác nhận/bỏ tích/mở panel; `id` VẪN là phần in (mọi chỗ khác dùng `id` như cũ), khóa
  //   dòng duy nhất là `_key`.
  const items = [];
  base.forEach((r) => {
    const nhom = nl.nhomCuaPin.get(r.id);
    if (!nhom) { items.push(r); return; }
    const tatCaXong = nhom.every((g) => techDoneNhom(g, r.ten_khach_hang));
    if (onlyQcReady) {
      // Màn QC giữ 1 dòng / phần in — nhưng CHƯA đủ mục ở mọi dòng loại đợt vải thì chưa cho QC duyệt.
      if (r.tech_done && !tatCaXong) {
        items.push({ ...r, tech_done: false, tg_vao: null, sla_phut: null, trang_thai_ready: 'DANG',
          loai_dot_vai_chua_xong: nhom.filter((g) => !techDoneNhom(g, r.ten_khach_hang)).map((g) => g.ten).join(', ') });
      } else items.push(r);
      return;
    }
    nhom.forEach((g) => {
      const it = g.items;
      const techDone = techDoneNhom(g, r.ten_khach_hang);
      const nDone = ['KHUON', 'FILM', 'MUC'].filter((ma) => it[ma]?.done).length;
      const vao = g.dots.map((d) => tMs(d.tg_chuyen_ready)).filter(Boolean);
      const han = g.dots.map((d) => d.han_giao_hang).filter(Boolean).sort();
      items.push({
        ...r,
        _key: `${r.id}|${g.key}`,
        tach_theo_loai: true,
        so_nhom_loai: nhom.length,
        loai_dot_vai: g.ten,
        dot_vai_ids: g.dot_vai_ids,
        ma_dot_vai_list: g.dots.map((d) => d.ma_dot_vai).join(', '),
        barcode: [...new Set(g.dots.map((d) => d.barcode).filter(Boolean))].join(','),
        han_giao_hang: han[0] || null,
        tg_qua_ready: vao.length ? new Date(Math.max(...vao)).toISOString() : r.tg_qua_ready,
        khuon_done: !!it.KHUON?.done, film_done: !!it.FILM?.done, muc_done: !!it.MUC?.done,
        tech_done: techDone,
        n_tech_done: nDone,
        trang_thai_ready: techDone ? 'CHO_QC' : nDone > 0 ? 'DANG' : 'CHUA',
        // SLA màn Kỹ thuật theo NHÓM: đếm từ đợt về sớm nhất của nhóm, đủ mục thì ngừng.
        tg_vao: vao.length ? new Date(Math.min(...vao)).toISOString() : r.tg_vao,
        sla_phut: techDone ? null : r.sla_phut ?? readySla,
        film_nguoi: it.FILM?.nguoi || null, film_tg: it.FILM?.tg || null,
        khuon_nguoi: it.KHUON?.nguoi || null, khuon_tg: it.KHUON?.tg || null,
        muc_nguoi: it.MUC?.nguoi || null, muc_tg: it.MUC?.tg || null,
      });
    });
  });
  return { items, meta: buildMeta(page, limit, total) };
}

// Đếm số phần in CHƯA xác nhận từng mục kỹ thuật (KHUON/FILM/MUC) trên toàn hệ thống.
async function itemCounts() {
  const { byMa } = await loadConfig();
  return repo.countReadyItems({
    khuonId: byMa.KHUON?.id, filmId: byMa.FILM?.id, mucId: byMa.MUC?.id, qcId: byMa[QC_CP]?.id,
  });
}

// QC chuẩn bị kỹ thuật TRẢ VỀ Ready kỹ thuật: chọn các checklist rớt → hủy xác nhận các mục đó
// (+ hủy QC nếu đã có) để bộ phận kỹ thuật làm lại. Lý do bắt buộc.
async function returnToTech(phanInId, { checklists, lyDo }, actorId) {
  const reason = (lyDo || '').trim();
  if (!reason) throw new AppError('Nhập lý do trả về', { status: 422, errorCode: 'NO_LY_DO' });
  const chosen = (Array.isArray(checklists) ? checklists : [])
    .map((m) => String(m || '').toUpperCase()).filter((m) => INPUT_CPS.includes(m));
  if (chosen.length === 0) throw new AppError('Chọn ít nhất 1 mục kỹ thuật không đạt', { status: 422, errorCode: 'NO_ITEM' });

  if (await repo.isPhanInReleased(phanInId)) {
    throw new AppError('Phần in đã release — không thể trả về kỹ thuật', { status: 409, errorCode: 'ALREADY_RELEASED' });
  }
  const { tram, byMa } = await loadConfig();
  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);

  const huyList = [];
  await withTransaction(async (client) => {
    for (const ma of chosen) {
      if (!byMa[ma]) continue;
      const cur = results.find((r) => r.ma_checkpoint === ma);
      if (cur?.trang_thai === 'DAT') { await repo.cancelResult(client, phanInId, byMa[ma].id, actorId); huyList.push(ma); }
    }
    // Hủy luôn QC nếu đã xác nhận (để làm lại từ kỹ thuật → QC).
    if (state.qc_done && byMa[QC_CP]) { await repo.cancelResult(client, phanInId, byMa[QC_CP].id, actorId); }
  });
  await qaRepo.insertQcTraVe({ loai: 'READY', phanInId, checklistList: chosen.join(','), lyDo: reason }, actorId);
  thongBao.banThongBao({ loaiTraVe: 'READY', phanInId, actorId }); // chuông Kỹ thuật (mig 085)
  sockets.emit('ready:confirmed', { phanInId, tra_ve: chosen });
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: phanInId, huy: huyList, checklists: chosen };
}

async function getDetail(phanInId, dotVaiIds = []) {
  const { tram, byMa } = await loadConfig();
  const phanIn = await repo.getPhanInBasic(phanInId);
  if (!phanIn) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  const results = await repo.getResults(tram.id, phanInId);
  // Thời điểm vào trạm READY (để FE tính SLA checklist). Best-effort — thiếu 029/ton_tram thì null.
  let readyTgVao = null;
  try { readyTgVao = await repo.getReadyEntryTime(phanInId); } catch { readyTgVao = null; }
  // Lý do bị trả về (QC READY & Kế hoạch/Release 1) — hiện banner trong panel READY.
  const [rmQc, rmKh, rmTest] = await Promise.all([
    qaRepo.activeReturnsMap('READY', [phanInId]),
    qaRepo.activeReturnsMap('RELEASE1', [phanInId]),
    qaRepo.activeReturnsMap('TEST_RUN_KT', [phanInId]),
  ]);
  // Panel mở từ 1 DÒNG LOẠI ĐỢT VẢI (mig 098) ⇒ Khuôn/Film/Mực hiện trạng thái CỦA NHÓM đó, không phải
  // của dòng tổng — không thì panel nói "đã xác nhận" trong khi dòng trên bảng vẫn chưa.
  let nhomLoai = null;
  let hienThi = results;
  if (dotVaiIds && dotVaiIds.length) {
    const { nhomCuaPin } = await taiNhomLoai([phanInId], byMa);
    const nhom = nhomCuaPin.get(phanInId);
    const g = timNhom(nhom, dotVaiIds);
    if (g) {
      nhomLoai = {
        ten: g.ten, dot_vai_ids: g.dot_vai_ids, ma_dot_vai: g.dots.map((d) => d.ma_dot_vai),
        so_nhom: nhom.length, cac_nhom: nhom.map((x) => x.ten),
      };
      hienThi = results.map((r) => {
        const it = g.items[r.ma_checkpoint];
        if (!it) return r;
        return {
          ...r, trang_thai: it.done ? 'DAT' : (r.trang_thai === 'DAT' ? 'CHO' : r.trang_thai),
          nguoi_xac_nhan_ten: it.done ? it.nguoi : null, tg_xac_nhan: it.done ? it.tg : null,
          ghi_chu: it.done && it.he_thong ? r.ghi_chu : null,
        };
      });
    }
  }
  return {
    phan_in: phanIn,
    ready_tg_vao: readyTgVao,
    tra_ve: rmQc[phanInId] || null,
    tra_ve_kh: rmKh[phanInId] || null,
    tra_ve_test: rmTest[phanInId] || null,
    checkpoints: hienThi.map((r) => ({ ...r, options: optionsFor(r.ma_checkpoint, r.cau_hinh_json) })),
    state: buildState(hienThi),
    nhom_loai: nhomLoai,
  };
}

// Xác nhận 1 mục kỹ thuật (KHUON/FILM/MUC/HSKT) độc lập. phuongAnIn (tùy chọn, ở mục Khuôn) → cập nhật HSKT.
async function confirmItem(phanInId, ma, value, actorId, phuongAnIn = null, dotVaiIds = []) {
  // Xác nhận theo DÒNG LOẠI ĐỢT VẢI (mig 098) ⇒ dùng chung đường batch (1 mục).
  if (dotVaiIds && dotVaiIds.length) {
    return confirmItemsBatch(phanInId, [{ ma, value }], actorId, phuongAnIn, dotVaiIds);
  }
  if (!INPUT_CPS.includes(ma)) {
    throw new AppError('Mục kỹ thuật không hợp lệ', { status: 400, errorCode: 'INVALID_ITEM' });
  }
  // Giá trị (mới/cũ/gia công) KHÔNG còn bắt buộc — chỉ cần xác nhận là xong.
  const { tram, byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });

  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  if (state.qc_done) throw new AppError('Đã QC xác nhận — dữ liệu đã khóa', { status: 409, errorCode: 'LOCKED' });
  const cur = results.find((r) => r.ma_checkpoint === ma);
  if (cur?.trang_thai === 'DAT') throw new AppError(`Mục ${cp.ten_checkpoint} đã được xác nhận`, { status: 409, errorCode: 'ALREADY' });
  // Ràng buộc phụ thuộc: vd chưa xác nhận Film thì không xác nhận Khuôn (chỉ khi Khuôn MỚI).
  const dep = CP_REQUIRES[ma];
  if (dep && !state[depKey(ma)] && depApplies(ma, value)) {
    throw new AppError(`Phải xác nhận ${byMa[dep]?.ten_checkpoint || dep} trước khi xác nhận ${cp.ten_checkpoint} (khuôn mới)`, { status: 409, errorCode: 'DEP_NOT_MET' });
  }

  // Khuôn kéo theo Film — bỏ qua nếu Film đã DAT sẵn (không ghi đè người/giờ của lần bấm thật).
  const filmCp = byMa[FILM_CP];
  const themFilm = keoTheoFilm(ma) && filmCp
    && results.find((r) => r.ma_checkpoint === FILM_CP)?.trang_thai !== 'DAT';

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    const kqId = await repo.upsertResult(client, {
      phanInId,
      checkpointId: cp.id,
      trangThai: 'DAT',
      giaTriText: OPTION_CPS.includes(ma) ? (value ?? null) : null,
      nguoiXacNhanId: actorId,
      tgXacNhan: new Date(),
      actorId,
    });
    await repo.insertStatusLog(client, {
      ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `Xác nhận ${cp.ten_checkpoint}`,
    });
    if (themFilm) {
      const filmId = await repo.upsertResult(client, {
        phanInId, checkpointId: filmCp.id, trangThai: 'DAT', giaTriText: null,
        nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
      });
      await repo.insertStatusLog(client, {
        ketQuaId: filmId, trangThaiMoiId: datId, nguoiId: actorId,
        lyDo: `Xác nhận ${filmCp.ten_checkpoint} — ${LY_DO_TU_DONG}`,
      });
    }
  });

  if (ma === 'KHUON') await applyPhuongAnIn(phanInId, phuongAnIn, actorId);
  const after = buildState(await repo.getResults(tram.id, phanInId));
  await tracking.moveByPhanIn(phanInId, READY_TRAM, actorId); // theo dõi dòng chảy: đợt vải vào trạm READY
  sockets.emit('ready:confirmed', { phanInId, buoc: themFilm ? [ma, FILM_CP] : ma, tech_done: after.tech_done });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

// Xác nhận nhiều mục kỹ thuật cùng lúc (1 transaction). items: [{ ma, value }]. phuongAnIn: cập nhật HSKT nếu có Khuôn.
async function confirmItemsBatch(phanInId, items, actorId, phuongAnIn = null, dotVaiIds = []) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('Chưa chọn mục nào để xác nhận', { status: 400, errorCode: 'EMPTY' });
  }
  const { tram, byMa } = await loadConfig();
  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  if (state.qc_done) throw new AppError('Đã QC xác nhận — dữ liệu đã khóa', { status: 409, errorCode: 'LOCKED' });
  if (dotVaiIds && dotVaiIds.length) {
    const kq = await xacNhanTheoNhom(phanInId, items, actorId, dotVaiIds, { byMa, results });
    if (kq) {
      if (kq.todo.some((t) => t.ma === 'KHUON')) await applyPhuongAnIn(phanInId, phuongAnIn, actorId);
      await tracking.moveByPhanIn(phanInId, READY_TRAM, actorId);
      sockets.emit('ready:confirmed', { phanInId, buoc: kq.todo.map((t) => t.ma), dotVaiIds });
      sockets.emit('dashboard:refresh', {});
      return getDetail(phanInId, dotVaiIds);
    }
    // kq = null ⇒ phần in không còn ≥2 loại đợt vải (vd 1 nhóm vừa được release) ⇒ đi đường cũ bên dưới.
  }

  // Chuẩn hóa + lọc: mục hợp lệ, có checkpoint, chưa DAT, option có value.
  const todo = [];
  for (const it of items) {
    const ma = String(it.ma || '').toUpperCase();
    if (!INPUT_CPS.includes(ma) || !byMa[ma]) continue;
    if (results.find((r) => r.ma_checkpoint === ma)?.trang_thai === 'DAT') continue;
    // Giá trị không bắt buộc — lưu nếu có gửi, không thì null.
    todo.push({ ma, value: OPTION_CPS.includes(ma) ? (it.value ?? null) : null });
  }
  if (todo.length === 0) throw new AppError('Không có mục nào đủ điều kiện xác nhận', { status: 422, errorCode: 'NOTHING' });
  // Khuôn kéo theo Film: chèn Film vào cùng lô nếu chưa DAT và người dùng chưa tự chọn.
  // ⚠ Đặt SAU guard `todo.length === 0` — nếu không, lô chỉ toàn mục đã DAT sẽ bị Film "cứu" thành
  //   hợp lệ và ta ghi Film cho một lượt bấm mà thực chất không xác nhận được gì.
  if (todo.some((t) => keoTheoFilm(t.ma)) && byMa[FILM_CP]
      && !todo.some((t) => t.ma === FILM_CP)
      && results.find((r) => r.ma_checkpoint === FILM_CP)?.trang_thai !== 'DAT') {
    todo.push({ ma: FILM_CP, value: null, tuDong: true });
  }
  // Ràng buộc phụ thuộc: mục phụ thuộc phải đã DAT HOẶC được xác nhận cùng lô này (vd Khuôn cần Film).
  for (const t of todo) {
    const dep = CP_REQUIRES[t.ma];
    if (dep && !state[depKey(t.ma)] && !todo.some((x) => x.ma === dep) && depApplies(t.ma, t.value)) {
      throw new AppError(`Phải xác nhận ${byMa[dep]?.ten_checkpoint || dep} trước (hoặc cùng lúc) khi xác nhận ${byMa[t.ma].ten_checkpoint} (khuôn mới)`, { status: 409, errorCode: 'DEP_NOT_MET' });
    }
  }

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    for (const t of todo) {
      const kqId = await repo.upsertResult(client, {
        phanInId, checkpointId: byMa[t.ma].id, trangThai: 'DAT',
        giaTriText: t.value, nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
      });
      await repo.insertStatusLog(client, {
        ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId,
        lyDo: `Xác nhận ${byMa[t.ma].ten_checkpoint}${t.tuDong ? ` — ${LY_DO_TU_DONG}` : ''}`,
      });
    }
  });

  if (todo.some((t) => t.ma === 'KHUON')) await applyPhuongAnIn(phanInId, phuongAnIn, actorId);
  const after = buildState(await repo.getResults(tram.id, phanInId));
  await tracking.moveByPhanIn(phanInId, READY_TRAM, actorId); // theo dõi dòng chảy
  sockets.emit('ready:confirmed', { phanInId, buoc: todo.map((t) => t.ma), tech_done: after.tech_done });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

// Xác nhận các mục cho ĐÚNG 1 NHÓM LOẠI ĐỢT VẢI (mig 098). Trả null nếu phần in không còn ≥2 nhóm.
// ⚠⚠ Chỉ ghi dòng TỔNG `ket_qua_checkpoint` khi MỌI đợt vải đang chờ (mọi nhóm) đã xác nhận mục đó —
//   dây chuyền phía sau (QC READY · release · dashboard · sĩ số · báo cáo) vẫn đọc dòng tổng như cũ.
async function xacNhanTheoNhom(phanInId, items, actorId, dotVaiIds, { byMa, results }) {
  const { nhomCuaPin } = await taiNhomLoai([phanInId], byMa);
  const nhom = nhomCuaPin.get(phanInId);
  if (!nhom) return null;
  const g = timNhom(nhom, dotVaiIds);
  if (!g) {
    throw new AppError('Danh sách đợt vải của dòng này đã thay đổi — tải lại màn READY rồi thử lại',
      { status: 409, errorCode: 'NHOM_DOI' });
  }
  const todo = [];
  for (const it of items) {
    const ma = String(it.ma || '').toUpperCase();
    if (!INPUT_CPS.includes(ma) || !byMa[ma] || g.items[ma]?.done) continue;
    if (todo.some((t) => t.ma === ma)) continue;
    todo.push({ ma, value: OPTION_CPS.includes(ma) ? (it.value ?? null) : null });
  }
  if (todo.length === 0) {
    throw new AppError(`Dòng loại "${g.ten}" không còn mục nào đủ điều kiện xác nhận`, { status: 422, errorCode: 'NOTHING' });
  }
  // Khuôn kéo theo Film — cùng luật đường phần in (đặt SAU guard rỗng).
  if (todo.some((t) => keoTheoFilm(t.ma)) && byMa[FILM_CP] && !todo.some((t) => t.ma === FILM_CP)
      && !g.items[FILM_CP]?.done) {
    todo.push({ ma: FILM_CP, value: null, tuDong: true });
  }
  const datId = await wf.getTrangThaiId('DAT');
  const bayGio = new Date();
  await withTransaction(async (client) => {
    for (const t of todo) {
      const it = g.items[t.ma];
      for (const d of g.dots) {
        if (it.dotDone.has(d.dot_vai_ve_id)) continue;
        await repo.ghiXacNhanDot(client, {
          phanInId, dotVaiId: d.dot_vai_ve_id, checkpointId: byMa[t.ma].id, trangThai: 'DAT',
          nguoiId: actorId, tg: bayGio, actorId,
        });
      }
      // Mọi nhóm KHÁC đã xong mục này chưa? (nhóm đang xác nhận coi như xong ngay sau lệnh ghi trên)
      const conNhomChua = nhom.some((x) => x !== g && !x.items[t.ma]?.done);
      const tongDat = results.find((r) => r.ma_checkpoint === t.ma)?.trang_thai === 'DAT';
      if (!conNhomChua && !tongDat) {
        const kqId = await repo.upsertResult(client, {
          phanInId, checkpointId: byMa[t.ma].id, trangThai: 'DAT',
          giaTriText: t.value, nguoiXacNhanId: actorId, tgXacNhan: bayGio, actorId,
        });
        await repo.insertStatusLog(client, {
          ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId,
          lyDo: `Xác nhận ${byMa[t.ma].ten_checkpoint}${t.tuDong ? ` — ${LY_DO_TU_DONG}` : ''} (đủ ${nhom.length} loại đợt vải)`,
        });
      }
    }
  });
  return { todo, nhom: g };
}

// Bỏ tích 1 mục cho ĐÚNG 1 NHÓM LOẠI ĐỢT VẢI (mig 098). Trả null nếu phần in không còn ≥2 nhóm.
// ⚠⚠ Dòng tổng đang DAT ⇒ phải HỦY dòng tổng (nhóm này không còn đủ), nhưng TRƯỚC ĐÓ:
//   (1) "chốt" các đợt vải của nhóm KHÁC đang được tính là đã xác nhận thành dòng theo đợt riêng, và
//   (2) bồi mốc hiệu lực cho mọi dòng theo đợt của nhóm khác —
//   thiếu 2 bước này thì lần hủy tổng sẽ xóa luôn công đã xác nhận của nhóm kia.
async function boTichTheoNhom(phanInId, ma, actorId, dotVaiIds, byMa) {
  const { nhomCuaPin } = await taiNhomLoai([phanInId], byMa);
  const nhom = nhomCuaPin.get(phanInId);
  if (!nhom) return null;
  const g = timNhom(nhom, dotVaiIds);
  if (!g) throw new AppError('Danh sách đợt vải của dòng này đã thay đổi — tải lại màn READY', { status: 409, errorCode: 'NHOM_DOI' });
  const it = g.items[ma];
  if (!it || !it.done) throw new AppError('Mục này chưa được xác nhận', { status: 409, errorCode: 'NOT_CONFIRMED' });
  const cpId = byMa[ma].id;
  await withTransaction(async (client) => {
    if (it.tong && it.tong.trang_thai === 'DAT') {
      for (const x of nhom) {
        if (x === g) continue;
        const xi = x.items[ma];
        for (const d of x.dots) {
          if (!xi.dotDone.has(d.dot_vai_ve_id)) continue;
          // Ghi lại (idempotent). Đợt đang được dòng tổng phủ ⇒ mang người/giờ của dòng tổng.
          const phuBoiTong = xi.tong && tMs(d.tg_chuyen_ready) <= tMs(xi.tong.tg);
          await repo.ghiXacNhanDot(client, {
            phanInId, dotVaiId: d.dot_vai_ve_id, checkpointId: cpId, trangThai: 'DAT',
            nguoiId: phuBoiTong ? xi.tong.nguoi_xac_nhan_id : actorId,
            tg: (phuBoiTong ? xi.tong.tg : xi.tg) || new Date(), actorId,
          });
        }
      }
      await repo.boiHieuLucDot(client, phanInId, cpId, g.dot_vai_ids);
      await repo.cancelResult(client, phanInId, cpId, actorId);
    }
    for (const d of g.dots) {
      await repo.ghiXacNhanDot(client, { phanInId, dotVaiId: d.dot_vai_ve_id, checkpointId: cpId, trangThai: 'HUY', actorId });
    }
  });
  return { phan_in_id: phanInId, ma, dot_vai_ids: g.dot_vai_ids };
}

// Xác nhận 1 mục cho NHIỀU phần in cùng lúc (theo mã hàng / chọn nhiều). 1 mục + 1 giá trị áp cho tất cả.
async function confirmItemBulk(phanInIds, ma, value, actorId) {
  if (!Array.isArray(phanInIds) || phanInIds.length === 0) {
    throw new AppError('Chưa chọn phần in nào', { status: 400, errorCode: 'EMPTY' });
  }
  if (!INPUT_CPS.includes(ma)) throw new AppError('Mục kỹ thuật không hợp lệ', { status: 400, errorCode: 'INVALID_ITEM' });
  // Giá trị không còn bắt buộc — chỉ cần xác nhận.
  const { byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });
  const qcId = byMa[QC_CP]?.id;
  const depMa = CP_REQUIRES[ma];
  const depId = (depMa && depApplies(ma, value)) ? byMa[depMa]?.id : null; // Khuôn cũ/Gia công → bỏ ràng buộc Film

  // Khuôn kéo theo Film — cần biết phần in nào ĐÃ có Film để không ghi đè người/giờ của lần bấm thật.
  const filmCp = keoTheoFilm(ma) ? byMa[FILM_CP] : null;

  // Bỏ qua phần in đã xác nhận mục này, đã QC (khóa), hoặc CHƯA xác nhận mục phụ thuộc (vd Khuôn cần Film).
  const states = await repo.getBulkStates(phanInIds, [cp.id, qcId, depId, filmCp?.id].filter(Boolean));
  const itemDone = new Set(states.filter((s) => s.checkpoint_id === cp.id).map((s) => s.phan_in_id));
  const qcDone = new Set(qcId ? states.filter((s) => s.checkpoint_id === qcId).map((s) => s.phan_in_id) : []);
  const depDone = new Set(depId ? states.filter((s) => s.checkpoint_id === depId).map((s) => s.phan_in_id) : []);
  const filmDone = new Set(filmCp ? states.filter((s) => s.checkpoint_id === filmCp.id).map((s) => s.phan_in_id) : []);
  const eligible = phanInIds.filter((id) => !qcDone.has(id) && !itemDone.has(id) && (!depId || depDone.has(id)));

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    for (const id of eligible) {
      const kqId = await repo.upsertResult(client, {
        phanInId: id, checkpointId: cp.id, trangThai: 'DAT',
        giaTriText: OPTION_CPS.includes(ma) ? (value ?? null) : null,
        nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
      });
      await repo.insertStatusLog(client, {
        ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: `Xác nhận ${cp.ten_checkpoint}`,
      });
      if (filmCp && !filmDone.has(id)) {
        const filmId = await repo.upsertResult(client, {
          phanInId: id, checkpointId: filmCp.id, trangThai: 'DAT', giaTriText: null,
          nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
        });
        await repo.insertStatusLog(client, {
          ketQuaId: filmId, trangThaiMoiId: datId, nguoiId: actorId,
          lyDo: `Xác nhận ${filmCp.ten_checkpoint} — ${LY_DO_TU_DONG}`,
        });
      }
    }
  });
  for (const id of eligible) await tracking.moveByPhanIn(id, READY_TRAM, actorId); // theo dõi dòng chảy
  sockets.emit('ready:confirmed', { bulk: true, ma, count: eligible.length });
  sockets.emit('dashboard:refresh', {});
  return { okCount: eligible.length, skippedCount: phanInIds.length - eligible.length };
}

async function confirmQC(phanInId, actorId) {
  const { tram, byMa } = await loadConfig();
  const state = buildState(await repo.getResults(tram.id, phanInId));
  if (!state.tech_done) {
    throw new AppError('Kỹ thuật chưa hoàn tất — QC không thể xác nhận', { status: 409, errorCode: 'TECH_NOT_DONE' });
  }
  if (state.qc_done) throw new AppError('Đã QC xác nhận', { status: 409, errorCode: 'ALREADY' });
  if (!byMa[QC_CP]) throw new AppError('Workflow chưa có checkpoint QC', { status: 500, errorCode: 'NO_CHECKPOINT' });
  // Phần in chờ ≥2 loại đợt vải (mig 098): MỌI dòng loại phải đủ mục kỹ thuật mới cho QC duyệt — dòng
  // tổng có thể đang DAT từ trước khi đợt vải loại mới về.
  {
    const { nhomCuaPin } = await taiNhomLoai([phanInId], byMa);
    const nhom = nhomCuaPin.get(phanInId);
    if (nhom) {
      const tenKhach = (await repo.getPhanInBasic(phanInId))?.ten_khach_hang;
      const chua = nhom.filter((g) => !techDoneNhom(g, tenKhach));
      if (chua.length) {
        throw new AppError(`Kỹ thuật chưa xác nhận đủ mục cho đợt vải loại: ${chua.map((g) => g.ten).join(', ')}`,
          { status: 409, errorCode: 'TECH_NOT_DONE' });
      }
    }
  }

  const datId = await wf.getTrangThaiId('DAT');
  await withTransaction(async (client) => {
    const kqId = await repo.upsertResult(client, {
      phanInId, checkpointId: byMa[QC_CP].id, trangThai: 'DAT', nguoiXacNhanId: actorId, tgXacNhan: new Date(), actorId,
    });
    await repo.insertStatusLog(client, { ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId, lyDo: 'QC xác nhận — READY hoàn thành' });
  });
  await qaRepo.resolveReturns('READY', phanInId);      // QC đạt lại → tắt cờ "bị QC trả về"
  await qaRepo.resolveReturns('RELEASE1', phanInId);   // ... và cờ "Kế hoạch trả về Kỹ thuật"
  await qaRepo.resolveReturns('TEST_RUN_KT', phanInId); // ... và cờ "Test Run trả về Kỹ thuật"

  // TEST RUN TRẢ VỀ: lệnh được GIỮ NGUYÊN nên làm lại xong là ĐI THẲNG LẠI TEST RUN — Kế hoạch KHÔNG
  // phải Release 1 lần nữa. (Lệnh vẫn RELEASE_1 + kết quả test đã bị hủy ⇒ tự hiện lại ở màn Test Run.)
  let veTestRun = null;
  try {
    const l = await repo.lenhChoKyThuatByPhanIn(phanInId);
    if (l && l.lenh_id) {
      const dvIds = l.dot_vai_ids || [];
      await qaRepo.resolveReturnsMany('TEST_RUN', dvIds);
      if (dvIds.length) await tracking.moveDotVaiTo(dvIds, 'TEST_RUN', actorId);
      veTestRun = l.lenh_id;
    }
  } catch (e) {
    console.error(`[ready-qc] ✗ Đưa lệnh về Test Run lỗi (${phanInId}): ${e.message}`);
  }
  sockets.emit('ready:confirmed', { phanInId, buoc: 'QC', ready: true, ve_test_run: veTestRun });
  if (veTestRun) sockets.emit('workflow:updated', { lenhId: veTestRun, stage: 'TEST_RUN' });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

// QC xác nhận hàng loạt nhiều phần in. Mỗi id tự validate; gom kết quả.
async function confirmQcBatch(phanInIds, actorId) {
  if (!Array.isArray(phanInIds) || phanInIds.length === 0) {
    throw new AppError('Chưa chọn phần in nào', { status: 400, errorCode: 'EMPTY' });
  }
  const ok = [];
  const failed = [];
  for (const id of phanInIds) {
    try {
      await confirmQC(id, actorId);
      ok.push(id);
    } catch (e) {
      failed.push({ id, message: e.message || 'Lỗi' });
    }
  }
  sockets.emit('dashboard:refresh', {});
  return { ok, failed, okCount: ok.length, failedCount: failed.length };
}

// Hủy xác nhận 1 mục READY (Admin/quyền READY_CANCEL) — khi bấm nhầm.
// Hủy 1 mục kỹ thuật mà QC đã xác nhận → hủy luôn QC để giữ nhất quán (QC cần đủ 4 mục).
async function cancelItem(phanInId, ma, actorId) {
  const CANCELABLE = [...INPUT_CPS, QC_CP];
  if (!CANCELABLE.includes(ma)) {
    throw new AppError('Mục không hợp lệ để hủy', { status: 400, errorCode: 'INVALID_ITEM' });
  }
  const { tram, byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });

  // Chỉ chặn khi phần in ĐÃ RELEASE HẾT các đợt vải (không còn đợt nào ở READY để mà sửa).
  // Còn ít nhất 1 đợt CHƯA release ⇒ phần in vẫn đang ở READY cho đợt đó ⇒ CHO hủy xác nhận
  // (chốt 2026-08-03 — trước đây chặn ngay khi có 1 đợt CŨ đã release, kể cả đã sản xuất xong).
  const rel = await repo.readyCancelState(phanInId);
  if (rel.da_release && !rel.con_cho) {
    throw new AppError('Mọi đợt vải của phần in đã release — hãy hủy lệnh ở trạm sau (Release/Test Run) trước khi hủy READY', { status: 409, errorCode: 'ALREADY_RELEASED' });
  }

  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  const cur = results.find((r) => r.ma_checkpoint === ma);
  if (cur?.trang_thai !== 'DAT') throw new AppError('Mục này chưa được xác nhận', { status: 409, errorCode: 'NOT_CONFIRMED' });

  const huyList = [ma];
  await withTransaction(async (client) => {
    await repo.cancelResult(client, phanInId, cp.id, actorId);
    if (INPUT_CPS.includes(ma) && state.qc_done && byMa[QC_CP]) {
      await repo.cancelResult(client, phanInId, byMa[QC_CP].id, actorId);
      huyList.push(QC_CP);
    }
  });
  await repo.logCancel(phanInId, huyList, actorId);
  sockets.emit('ready:confirmed', { phanInId, huy: huyList });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

// Bỏ tích 1 mục kỹ thuật (KHUON/FILM/MUC) NGAY TRONG luồng Quét/tích — cho phép người có quyền tech
// tự sửa khi tích LỘN phần in (khác `cancelItem` cần quyền READY_CANCEL). Chỉ mục kỹ thuật, chưa QC, chưa release.
async function uncheckItem(phanInId, ma, actorId, dotVaiIds = []) {
  if (!INPUT_CPS.includes(ma)) throw new AppError('Mục kỹ thuật không hợp lệ', { status: 400, errorCode: 'INVALID_ITEM' });
  const { tram, byMa } = await loadConfig();
  const cp = byMa[ma];
  if (!cp) throw new AppError(`Checkpoint ${ma} không còn hiệu lực`, { status: 404, errorCode: 'NO_CHECKPOINT' });
  if (await repo.isPhanInReleased(phanInId)) {
    throw new AppError('Phần in đã release — không thể bỏ tích', { status: 409, errorCode: 'ALREADY_RELEASED' });
  }
  const results = await repo.getResults(tram.id, phanInId);
  const state = buildState(results);
  if (state.qc_done) throw new AppError('Đã QC xác nhận — không thể bỏ tích', { status: 409, errorCode: 'LOCKED' });
  if (dotVaiIds && dotVaiIds.length) {
    const kq = await boTichTheoNhom(phanInId, ma, actorId, dotVaiIds, byMa);
    if (kq) {
      await repo.logCancel(phanInId, [ma], actorId);
      sockets.emit('ready:confirmed', { phanInId, huy: [ma], dotVaiIds });
      sockets.emit('dashboard:refresh', {});
      return kq;
    }
  }
  const cur = results.find((r) => r.ma_checkpoint === ma);
  if (cur?.trang_thai !== 'DAT') throw new AppError('Mục này chưa được xác nhận', { status: 409, errorCode: 'NOT_CONFIRMED' });
  await withTransaction(async (client) => { await repo.cancelResult(client, phanInId, cp.id, actorId); });
  await repo.logCancel(phanInId, [ma], actorId);
  sockets.emit('ready:confirmed', { phanInId, huy: [ma] });
  sockets.emit('dashboard:refresh', {});
  return { phan_in_id: phanInId, ma };
}

// Lịch sử xác nhận READY đang hiệu lực (cho trang "Lịch sử trạng thái" — Hệ thống). Kèm nhãn mục.
async function confirmHistory(date, search) {
  const LABEL = { KHUON: 'Khuôn', FILM: 'Film', MUC: 'Mực', HSKT: 'HSKT', QC_XAC_NHAN: 'QC xác nhận' };
  const rows = await repo.listConfirmHistory({ date, search: search || '' });
  return rows.map((r) => ({ ...r, muc_label: LABEL[r.ma_checkpoint] || r.ten_checkpoint || r.ma_checkpoint }));
}

async function history(date, scope) {
  const maList = scope === 'qc' ? ['QC_XAC_NHAN'] : INPUT_CPS;
  const rows = await repo.historyByDate(date, maList);
  return rows.map((r) => ({
    tg: r.tg,
    nguoi: r.nguoi || '—',
    hanh_dong: r.hanh_dong || 'Xác nhận',
    doi_tuong: [r.ma_phan, r.ma_hang].filter(Boolean).join(' · '),
    chi_tiet: r.chi_tiet || '',
  }));
}

// Danh sách phần in đã hoàn thành checkpoint READY theo ngày (cho DonePanel).
async function done(date, scope) {
  return repo.doneByDate(date, scope === 'qc' ? 'qc' : 'tech');
}

// ─── "Mở READY" (admin) — phần in đi tắt READY (đợt mới tự vào Release 1) ─────
async function reopenCandidates(search) {
  return repo.listReopenCandidates({ search: search || '' });
}

// Mở lại READY cho 1 phần in: hủy xác nhận READY (Khuôn/Film/Mực/QC) + gắn cờ đợt mới làm lại READY/Test Run.
// Phần in quay lại danh sách Chuẩn bị kỹ thuật (đợt đã sản xuất trước không bị ảnh hưởng).
async function reopenReady(phanInId, actorId) {
  const pin = await repo.getPhanInBasic(phanInId);
  if (!pin) throw new AppError('Phần in không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  let huy = 0; let flagged = 0;
  await withTransaction(async (client) => {
    huy = await repo.reopenReadyResults(client, phanInId, actorId);
    flagged = await repo.flagUnreleasedDotLamLai(client, phanInId, actorId);
  });
  if (huy === 0 && flagged === 0) {
    throw new AppError('Phần in không ở trạng thái đi tắt READY (không có gì để mở lại)', { status: 409, errorCode: 'NOTHING_TO_REOPEN' });
  }
  await repo.logReopenReady(phanInId, { huy_xac_nhan: huy, dot_lam_lai: flagged }, actorId);
  sockets.emit('ready:confirmed', { phanInId, mo_lai_ready: true });
  sockets.emit('dashboard:refresh', {});
  return { phanInId, huy, flagged };
}

module.exports = {
  getConfig, listCandidates, itemCounts, getDetail, confirmItem, confirmItemsBatch, confirmItemBulk,
  confirmQC, confirmQcBatch, cancelItem, uncheckItem, history, done, confirmHistory, returnToTech, traCuuMaQuet,
  reopenCandidates, reopenReady,
};
