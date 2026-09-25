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
const { slaQcReady, slaReadyHan } = require('../../utils/slaTheoGio');
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
  if (r.dang_o_gn === true) {
    return { ...base, ly_do: 'DANG_O_GN', mo_ta: 'Phần in đã bị TRẢ VỀ GIAO NHẬN sửa thông tin — chờ GN xác nhận lại (Đơn hàng › Phần in chờ sửa thông tin)' };
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

// ⚠⚠⚠ GOM THEO **TỪNG ĐỢT VẢI** — mỗi đợt 1 nhóm (đổi 16/09/2026; trước đây gom theo LOẠI đợt vải).
//   Người dùng chốt: "bây giờ là theo đợt vải, có đợt vải là vào lại READY hết" ⇒ 2 đợt CÙNG LOẠI
//   (vd 2 đợt "Số lượng" về 2 ngày khác nhau) cũng phải tách dòng và xác nhận riêng, vì đợt về sau
//   chưa ai kiểm khuôn/film/mực cho nó. Gom theo loại thì 2 đợt đó dính chung 1 dòng và đợt mới
//   "thừa hưởng" xác nhận của đợt cũ — đúng lỗi người dùng báo.
// ⚠ Thứ tự = đợt về sớm nhất trước (`dsDotChoReady` đã ORDER BY `tg_chuyen_ready`).
function gomTheoDot(dots) {
  return dots.map((d) => ({
    key: d.dot_vai_ve_id,
    ten: d.ten_loai || 'Chưa phân loại',
    dots: [d],
  }));
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
    const nhom = gomTheoDot(ds);
    // Cột "Loại đợt vải" ở mức phần in vẫn gom theo LOẠI (khử trùng) — 3 đợt "Số lượng" thì hiện
    // "Số lượng", không phải "Số lượng, Số lượng, Số lượng".
    loaiCuaPin.set(pin, [...new Set(nhom.map((g) => g.ten))].join(', '));
    // ⚠⚠ LUÔN TÍNH THEO ĐỢT, KỂ CẢ KHI CHỈ CÓ 1 ĐỢT CHỜ (bỏ ngưỡng `nhom.length >= 2` cũ).
    //   Ca phổ biến nhất chính là 1 đợt: phần in đã QC xong từ đợt trước (dòng TỔNG đang DAT), nay
    //   đợt vải MỚI về và là đợt chờ DUY NHẤT ⇒ nếu lùi về đường mức phần in thì màn READY hiện
    //   "đã xác nhận đủ" trong khi chưa ai đụng vào đợt mới. Đo prod 16/09: 34 ca/7 ngày.
    //   Tách DÒNG vẫn chỉ khi ≥2 nhóm (xem `listCandidates`) — 1 đợt thì giữ 1 dòng như cũ, chỉ
    //   trạng thái 3 mục được lấy theo đợt.
    if (coBang) { tach.push(pin); nhomCuaPin.set(pin, nhom); }
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

// ⚠⚠⚠ "READY ĐÃ KHÓA" ≠ "dòng TỔNG đang DAT" (đổi 16/09/2026 — READY đi theo ĐỢT VẢI).
//   Phần in đã QC xong cho đợt trước, nay có ĐỢT VẢI MỚI về thì READY của đợt mới CHƯA ai làm ⇒ nếu
//   vẫn khóa theo dòng tổng thì kỹ thuật bấm xác nhận Khuôn/Mực ăn 409 "Đã QC xác nhận — dữ liệu đã
//   khóa" và QC bấm duyệt ăn 409 "Đã QC xác nhận" ⇒ **đợt mới không có đường nào đi tiếp**.
//   Khóa chỉ khi dòng tổng DAT VÀ không còn đợt vải đang chờ nào chưa được QC phủ.
// ⚠ Dùng ở 4 guard: confirmItem · confirmItemsBatch · confirmQC · uncheckItem.
async function daKhoaReady(phanInId, state) {
  if (!state.qc_done) return false;
  return !(await repo.conDotChuaReady(phanInId));
}

// ⚠⚠⚠ CHỌN CÁC NHÓM THEO `dotVaiIds` FE GỬI — NHẬN **TẬP CON BẤT KỲ** của các đợt đang chờ
// (đổi 16/09/2026; trước đây `timNhom` đòi khớp CHÍNH XÁC tập đợt của ĐÚNG 1 nhóm).
//
// Vì sao phải nới:
//   (a) FE nay LUÔN gửi `dot_vai_ids` (kể cả phần in chỉ còn 1 đợt chờ) — xem lỗi "đợt 2 về mà không
//       xác nhận được" ở `ReadyPage`; khớp chính xác vẫn chạy được, nhưng
//   (b) QUÉT MÃ phải xác nhận **CẢ 2 ĐỢT trong MỘT lần quét** (người dùng chốt 16/09/2026): máy quét
//       chỉ đọc được code phần / mã vạch phần in, KHÔNG nói được là đợt nào ⇒ gửi hết id đợt lên.
//       Với luật cũ, tập 2 đợt không khớp nhóm nào (mỗi nhóm 1 đợt) ⇒ ăn 409 NHOM_DOI.
// ⚠ VẪN GIỮ GUARD chống dữ liệu cũ: id nào KHÔNG còn trong danh sách đợt đang chờ ⇒ 409 `NHOM_DOI`
//   (đợt vừa được release / vừa bị hủy ở máy khác). Không có guard này thì thao tác ghi vào đợt đã
//   rời READY mà không ai biết.
function chonNhom(nhom, dotVaiIds) {
  const ids = [...new Set((dotVaiIds || []).filter(Boolean))];
  if (!nhom || !ids.length) return null;
  const dangCho = new Set(nhom.flatMap((g) => g.dot_vai_ids));
  if (ids.some((id) => !dangCho.has(id))) {
    throw new AppError('Danh sách đợt vải của dòng này đã thay đổi — tải lại màn READY rồi thử lại',
      { status: 409, errorCode: 'NHOM_DOI' });
  }
  const s = new Set(ids);
  return nhom.filter((g) => g.dot_vai_ids.some((id) => s.has(id)));
}

// Nhãn các đợt được chọn, dùng cho thông điệp lỗi/lịch sử ("Số lượng (RD026LA-000974)").
const nhanNhom = (chon) => chon.map((g) => {
  const d = g.dots[0] || {};
  return `${g.ten}${d.barcode || d.ma_dot_vai ? ` (${d.barcode || d.ma_dot_vai})` : ''}`;
}).join(', ');

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
    // ⚠ Khử trùng tên loại: tách theo TỪNG ĐỢT nên 2 đợt cùng loại sẽ cho ra "Số lượng, Số lượng".
    const chuaXong = [...new Set(nhom.filter((g) => !techDoneNhom(g, r.ten_khach_hang)).map((g) => g.ten))];
    const nhieu = nhom.length > 1;

    if (onlyQcReady) {
      // ⚠⚠⚠ MÀN QC NAY CŨNG TÁCH DÒNG THEO ĐỢT VẢI (người dùng chốt 16/09/2026) — trước đây giữ 1 dòng
      //   / phần in nên cột "Loại đợt vải" gộp nhiều loại ("Bổ sung, Số lượng") và QC không nhìn ra
      //   ĐỢT NÀO kỹ thuật chưa làm xong.
      // ⚠⚠ NHƯNG QC VẪN XÁC NHẬN Ở MỨC PHẦN IN — `ket_qua_checkpoint` khóa theo `phan_in_id`, và luật
      //   `utils/tech.js qcDotSql` nói QC duyệt 1 lần là PHỦ MỌI ĐỢT đang chờ. Vì vậy:
      //     · `tech_done` (cờ quyết định QC bấm được hay không) GIỮ Ở MỨC PHẦN IN = mọi đợt đủ mục —
      //       đúng như guard `confirmQC`, để tick 1 dòng rồi bấm không bao giờ ăn 409.
      //     · các cờ HIỂN THỊ (`khuon_done`/`film_done`/`muc_done` + `tech_done_dot`) lấy THEO ĐỢT.
      //   Đổi `tech_done` sang mức đợt là dòng "đợt 1 xong" bật checkbox trong khi đợt 2 còn thiếu.
      // ⚠⚠⚠ ĐỔI 21/09/2026 (người dùng chốt): QC XÁC NHẬN THEO ĐỢT — đợt 1 kỹ thuật xong thì QC duyệt
      //   được ngay, không phải chờ đợt 2. Màn QC CHỈ hiện đợt KỸ THUẬT ĐÃ XONG (hàng đợi của QC);
      //   `tech_done` nay = của CHÍNH ĐỢT đó. Ghi chú cũ phía trên ("QC vẫn xác nhận ở mức phần in")
      //   ĐÃ LỖI THỜI — giữ để thấy vì sao từng làm khác.
      // ⚠⚠⚠ SỬA 24/09/2026 (người dùng chốt 23/09): DANH SÁCH màn QC = y như màn READY Kỹ thuật —
      //   hiện MỌI đợt đang chờ, kể cả đợt kỹ thuật CHƯA xác nhận đủ. Bản 21/09 chỉ đẩy các đợt đã đủ
      //   mục KT (`choQc`) ⇒ đo prod 24/09: màn QC 23 dòng vs màn KT 83 dòng. Luật "chỉ đợt KT đã xong"
      //   CHỈ còn áp cho dải "Theo dõi" (`siSoTram DV.READY_QC`), KHÔNG áp cho bảng.
      //   `tech_done` vẫn THEO ĐỢT ⇒ đợt chưa xong hiện ra nhưng khóa checkbox, không tính SLA QC.
      nhom.forEach((g) => {
        const it = g.items;
        const vao = g.dots.map((d) => tMs(d.tg_chuyen_ready)).filter(Boolean);
        const han = g.dots.map((d) => d.han_giao_hang).filter(Boolean).sort();
        const xongDot = techDoneNhom(g, r.ten_khach_hang);
        const nDone = ['KHUON', 'FILM', 'MUC'].filter((ma) => it[ma]?.done).length;
        // Mốc KT xong CỦA ĐỢT = lần xác nhận muộn nhất (Khuôn/Mực) — bắt đầu đếm SLA của QC.
        const ktTg = [it.KHUON?.tg, it.MUC?.tg].map(tMs).filter(Boolean);
        items.push({
          ...r,
          _key: nhieu ? `${r.id}|${g.key}` : r.id,
          tach_theo_loai: nhieu,
          so_nhom_loai: nhom.length,
          thu_tu_dot: nhom.indexOf(g) + 1,
          so_luong_dot: g.dots.reduce((s, d) => s + (Number(d.so_luong_vai_ve) || 0), 0),
          ngay_dot: g.dots.map((d) => d.ngay_vai_ve).filter(Boolean).sort()[0] || null,
          loai_dot_vai: nhieu ? g.ten : r.loai_dot_vai,
          dot_vai_ids: g.dot_vai_ids,
          ma_dot_vai_list: nhieu ? g.dots.map((d) => d.ma_dot_vai).join(', ') : r.ma_dot_vai_list,
          barcode: nhieu ? [...new Set(g.dots.map((d) => d.barcode).filter(Boolean))].join(',') : r.barcode,
          // ⚠ Hạn giao của CHÍNH các đợt trên dòng (25/09/2026) — kể cả khi chỉ 1 đợt chờ: giá trị mức
          //   phần in lấy min MỌI đợt nên đợt bổ sung từng hiện hạn của đợt số lượng đã release.
          han_giao_hang: han[0] || r.han_giao_hang,
          tg_qua_ready: vao.length ? new Date(Math.max(...vao)).toISOString() : r.tg_qua_ready,
          khuon_done: !!it.KHUON?.done, film_done: !!it.FILM?.done, muc_done: !!it.MUC?.done,
          tech_done_dot: xongDot,
          tech_done: xongDot,
          n_tech_done: nDone,
          loai_dot_vai_chua_xong: tatCaXong ? null : (chuaXong.length ? chuaXong.join(', ') : null),
          // SLA QC chỉ đếm khi KT của đợt đã xong (mốc = mục KT cuối); chưa xong ⇒ không đỏ ở QC.
          tg_vao: xongDot ? (ktTg.length ? new Date(Math.max(...ktTg)).toISOString() : r.tg_vao) : null,
          // KT xong sau 16:30 ⇒ QC có 16 giờ (utils/slaTheoGio KHUNG_SLA_QC — 25/09/2026).
          sla_phut: xongDot ? slaQcReady(ktTg.length ? new Date(Math.max(...ktTg)) : r.tg_vao, qcSla) : null,
          trang_thai_ready: xongDot ? 'CHO_QC' : nDone > 0 ? 'DANG' : 'CHUA',
        });
      });
      return;
    }
    // ⚠⚠ CHỈ TÁCH DÒNG khi phần in có ≥2 đợt vải đang chờ. 1 đợt ⇒ vẫn 1 dòng như cũ (FE không thấy
    //   cờ `tach_theo_loai`, không đổi giao diện) nhưng TRẠNG THÁI 3 MỤC lấy THEO ĐỢT — đó mới là
    //   điểm sửa: đợt mới về sau khi phần in đã Ready phải hiện "chưa xác nhận".
    // ⚠ Các cột nhận diện đợt (mã đợt / barcode / hạn giao) chỉ thu hẹp khi THẬT SỰ tách dòng; giữ
    //   nguyên giá trị mức phần in khi 1 đợt để việc QUÉT mã vạch đợt vải cũ ở READY không hụt.
    nhom.forEach((g) => {
      const it = g.items;
      const techDone = techDoneNhom(g, r.ten_khach_hang);
      const nDone = ['KHUON', 'FILM', 'MUC'].filter((ma) => it[ma]?.done).length;
      const vao = g.dots.map((d) => tMs(d.tg_chuyen_ready)).filter(Boolean);
      const han = g.dots.map((d) => d.han_giao_hang).filter(Boolean).sort();
      items.push({
        ...r,
        _key: nhieu ? `${r.id}|${g.key}` : r.id,
        tach_theo_loai: nhieu,
        so_nhom_loai: nhom.length,
        // SL + ngày vải về của ĐỢT trong dòng này — 2 đợt CÙNG LOẠI thì đây là thứ duy nhất phân biệt
        // chúng trên màn hình (người dùng: "2 dòng, khác nhau số lượng và loại đợt vải").
        so_luong_dot: g.dots.reduce((s, d) => s + (Number(d.so_luong_vai_ve) || 0), 0),
        ngay_dot: g.dots.map((d) => d.ngay_vai_ve).filter(Boolean).sort()[0] || null,
        thu_tu_dot: nhom.indexOf(g) + 1,
        loai_dot_vai: nhieu ? g.ten : r.loai_dot_vai,
        dot_vai_ids: g.dot_vai_ids,
        ma_dot_vai_list: nhieu ? g.dots.map((d) => d.ma_dot_vai).join(', ') : r.ma_dot_vai_list,
        barcode: nhieu ? [...new Set(g.dots.map((d) => d.barcode).filter(Boolean))].join(',') : r.barcode,
        // ⚠ Hạn giao của CHÍNH các đợt trên dòng (25/09/2026) — xem nhánh QC ở trên.
        han_giao_hang: han[0] || r.han_giao_hang,
        tg_qua_ready: vao.length ? new Date(Math.max(...vao)).toISOString() : r.tg_qua_ready,
        khuon_done: !!it.KHUON?.done, film_done: !!it.FILM?.done, muc_done: !!it.MUC?.done,
        tech_done: techDone,
        n_tech_done: nDone,
        trang_thai_ready: techDone ? 'CHO_QC' : nDone > 0 ? 'DANG' : 'CHUA',
        // SLA màn Kỹ thuật theo NHÓM: đếm từ đợt về sớm nhất của nhóm, đủ mục thì ngừng.
        tg_vao: vao.length ? new Date(Math.min(...vao)).toISOString() : r.tg_vao,
        // ⚠⚠ SLA READY THEO HẠN GIAO CỦA ĐỢT (utils/slaTheoGio luật (4) — 25/09/2026): còn ≤1 ngày ⇒ đỏ,
        //   còn 2 ngày ⇒ vàng. Đợt thiếu hạn ⇒ lùi về luật giờ lên MES (07:30–15:00 ⇒ 8h, 15:00–20:30 ⇒ 21h).
        ...(() => {
          if (techDone) return { sla_phut: null };
          const moc = vao.length ? new Date(Math.min(...vao)) : r.tg_vao;
          const k = slaReadyHan(moc, han[0] || r.han_giao_hang, moc, readySla, readyCanhBao);
          return { sla_phut: k.sla, canh_bao_truoc_phut: k.canhBao };
        })(),
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
    // ⚠ Dữ liệu cũ trên máy (đợt vừa release ở máy khác) ⇒ `chonNhom` ném 409. Panel là màn XEM —
    //   không được chặn, cứ lùi về trạng thái mức phần in như trước.
    let chon = null;
    try { chon = chonNhom(nhom, dotVaiIds); } catch (e) { chon = null; }
    if (chon && chon.length) {
      nhomLoai = {
        ten: [...new Set(chon.map((x) => x.ten))].join(', '),
        dot_vai_ids: chon.flatMap((x) => x.dot_vai_ids),
        ma_dot_vai: chon.flatMap((x) => x.dots.map((d) => d.ma_dot_vai)),
        so_nhom: nhom.length, so_dot_chon: chon.length, cac_nhom: nhom.map((x) => x.ten),
      };
      // ⚠⚠⚠ QC CŨNG PHẢI XÉT THEO ĐỢT — nếu không, panel mở cho ĐỢT MỚI của phần in đã Ready từ đợt
      //   trước sẽ thấy `qc_done = true` (dòng tổng còn DAT) ⇒ banner "READY hoàn thành" + **ẩn sạch
      //   nút Xác nhận** (`ReadyPanel`: `eligible = state.qc_done ? [] : …` và `canEdit = … && !qc_done`)
      //   ⇒ kỹ thuật không bấm được gì. Cùng họ lỗi với việc FE quên gửi `dot_vai_ids`.
      // ⚠ Luật gương ĐÚNG `utils/tech.js qcDotSql`: đợt được QC phủ khi nó lên READY TRƯỚC mốc QC.
      //   QC không có dòng `ready_xac_nhan_dot` (bảng đó chỉ cho Khuôn/Film/Mực) nên chỉ có nhánh mốc.
      const qcRow = results.find((r) => r.ma_checkpoint === QC_CP);
      const qcMoc = qcRow && qcRow.trang_thai === 'DAT'
        ? tMs(qcRow.tg_xac_nhan || qcRow.kq_updated_date) : null;
      const qcPhuHet = qcMoc != null
        && chon.every((x) => x.dots.every((d) => tMs(d.tg_chuyen_ready) <= qcMoc));
      hienThi = results.map((r) => {
        if (r.ma_checkpoint === QC_CP) {
          return qcPhuHet ? r : { ...r, trang_thai: r.trang_thai === 'DAT' ? 'CHO' : r.trang_thai };
        }
        const its = chon.map((x) => x.items[r.ma_checkpoint]).filter(Boolean);
        if (!its.length) return r;
        // Panel mở cho NHIỀU đợt (quét) ⇒ chỉ coi là xong khi MỌI đợt được chọn đã xác nhận;
        // người/giờ lấy của lần MUỘN NHẤT để khớp với thứ bảng đang hiện.
        const done = its.every((i) => i.done);
        const moi = its.reduce((a, b) => (!a || tMs(b.tg) > tMs(a.tg) ? b : a), null);
        return {
          ...r, trang_thai: done ? 'DAT' : (r.trang_thai === 'DAT' ? 'CHO' : r.trang_thai),
          nguoi_xac_nhan_ten: done ? moi?.nguoi || null : null, tg_xac_nhan: done ? moi?.tg || null : null,
          ghi_chu: done && moi?.he_thong ? r.ghi_chu : null,
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
  if (await daKhoaReady(phanInId, state)) throw new AppError('Đã QC xác nhận — dữ liệu đã khóa', { status: 409, errorCode: 'LOCKED' });
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
  if (await daKhoaReady(phanInId, state)) throw new AppError('Đã QC xác nhận — dữ liệu đã khóa', { status: 409, errorCode: 'LOCKED' });
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
  const chon = chonNhom(nhom, dotVaiIds);
  if (!chon || !chon.length) return null;
  const chonSet = new Set(chon);
  const todo = [];
  for (const it of items) {
    const ma = String(it.ma || '').toUpperCase();
    if (!INPUT_CPS.includes(ma) || !byMa[ma]) continue;
    // Bỏ qua mục mà MỌI đợt được chọn đã xác nhận rồi (quét cả 2 đợt mà 1 đợt xong trước thì vẫn phải
    // ghi cho đợt còn lại ⇒ điều kiện là `every`, KHÔNG phải `some`).
    if (chon.every((g) => g.items[ma]?.done)) continue;
    if (todo.some((t) => t.ma === ma)) continue;
    todo.push({ ma, value: OPTION_CPS.includes(ma) ? (it.value ?? null) : null });
  }
  if (todo.length === 0) {
    throw new AppError(`Đợt vải ${nhanNhom(chon)} không còn mục nào đủ điều kiện xác nhận`,
      { status: 422, errorCode: 'NOTHING' });
  }
  // Khuôn kéo theo Film — cùng luật đường phần in (đặt SAU guard rỗng).
  if (todo.some((t) => keoTheoFilm(t.ma)) && byMa[FILM_CP] && !todo.some((t) => t.ma === FILM_CP)
      && chon.some((g) => !g.items[FILM_CP]?.done)) {
    todo.push({ ma: FILM_CP, value: null, tuDong: true });
  }
  const datId = await wf.getTrangThaiId('DAT');
  const bayGio = new Date();
  await withTransaction(async (client) => {
    for (const t of todo) {
      for (const g of chon) {
        const it = g.items[t.ma];
        if (!it) continue;
        for (const d of g.dots) {
          if (it.dotDone.has(d.dot_vai_ve_id)) continue;
          await repo.ghiXacNhanDot(client, {
            phanInId, dotVaiId: d.dot_vai_ve_id, checkpointId: byMa[t.ma].id, trangThai: 'DAT',
            nguoiId: actorId, tg: bayGio, actorId,
          });
        }
      }
      // Mọi đợt vải KHÁC (ngoài tập đang xác nhận) đã xong mục này chưa?
      const conNhomChua = nhom.some((x) => !chonSet.has(x) && !x.items[t.ma]?.done);
      const tongDat = results.find((r) => r.ma_checkpoint === t.ma)?.trang_thai === 'DAT';
      if (!conNhomChua && !tongDat) {
        const kqId = await repo.upsertResult(client, {
          phanInId, checkpointId: byMa[t.ma].id, trangThai: 'DAT',
          giaTriText: t.value, nguoiXacNhanId: actorId, tgXacNhan: bayGio, actorId,
        });
        await repo.insertStatusLog(client, {
          ketQuaId: kqId, trangThaiMoiId: datId, nguoiId: actorId,
          lyDo: `Xác nhận ${byMa[t.ma].ten_checkpoint}${t.tuDong ? ` — ${LY_DO_TU_DONG}` : ''} (đủ ${nhom.length} đợt vải)`,
        });
      }
    }
  });
  return { todo, nhom: chon };
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
  const chon = chonNhom(nhom, dotVaiIds);
  if (!chon || !chon.length) return null;
  const chonSet = new Set(chon);
  // Chỉ bỏ tích những đợt THẬT SỰ đang được tính là đã xác nhận (quét cả 2 đợt rồi hủy thì đợt nào
  // chưa xác nhận cũng không có gì để hủy).
  const daXn = chon.filter((g) => g.items[ma]?.done);
  if (!daXn.length) throw new AppError('Mục này chưa được xác nhận', { status: 409, errorCode: 'NOT_CONFIRMED' });
  const tong = daXn[0].items[ma].tong;
  const cpId = byMa[ma].id;
  // ⚠ Bỏ qua MỌI đợt đang chọn khi "bồi" mốc hiệu lực — kể cả đợt chưa xác nhận, để lần hủy tổng
  //   không vô tình làm sống lại dòng nào của chính tập đang bỏ tích.
  const boQua = chon.flatMap((g) => g.dot_vai_ids);
  await withTransaction(async (client) => {
    if (tong && tong.trang_thai === 'DAT') {
      for (const x of nhom) {
        if (chonSet.has(x)) continue;
        const xi = x.items[ma];
        if (!xi) continue;
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
      await repo.boiHieuLucDot(client, phanInId, cpId, boQua);
      await repo.cancelResult(client, phanInId, cpId, actorId);
    }
    for (const g of daXn) {
      for (const d of g.dots) {
        await repo.ghiXacNhanDot(client, { phanInId, dotVaiId: d.dot_vai_ve_id, checkpointId: cpId, trangThai: 'HUY', actorId });
      }
    }
  });
  return { phan_in_id: phanInId, ma, dot_vai_ids: daXn.flatMap((g) => g.dot_vai_ids) };
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

// ⚠⚠⚠ QC XÁC NHẬN THEO ĐỢT VẢI (21/09/2026). `dotVaiIds` = đợt của dòng QC bấm.
//   · Các đợt được chọn phải ĐỦ MỤC kỹ thuật (của CHÍNH đợt đó) — đợt khác chưa xong KHÔNG còn chặn.
//   · Chọn HẾT các đợt đang chờ ⇒ ghi dòng TỔNG như cũ (dây chuyền phía sau đọc dòng tổng).
//   · Còn đợt khác đang chờ ⇒ CHỈ ghi dòng THEO ĐỢT (`ready_xac_nhan_dot`) — ghi dòng tổng mốc now()
//     là theo luật mốc `qcDotSql` sẽ PHỦ LUÔN đợt còn lại mà kỹ thuật chưa làm (đúng lỗi 18/09).
//   Trả null nếu phần in không có đợt nào đang chờ (nhánh Test Run trả về) ⇒ đi đường mức phần in.
async function confirmQcTheoDot(phanInId, actorId, dotVaiIds, byMa) {
  const { nhomCuaPin } = await taiNhomLoai([phanInId], byMa);
  const nhom = nhomCuaPin.get(phanInId);
  if (!nhom || !nhom.length) return null;
  const chon = chonNhom(nhom, dotVaiIds);
  if (!chon || !chon.length) return null;
  const tenKhach = (await repo.getPhanInBasic(phanInId))?.ten_khach_hang;
  const chua = chon.filter((g) => !techDoneNhom(g, tenKhach));
  if (chua.length) {
    throw new AppError(`Kỹ thuật chưa xác nhận đủ mục cho đợt vải: ${nhanNhom(chua)}`,
      { status: 409, errorCode: 'TECH_NOT_DONE' });
  }
  const chonSet = new Set(chon);
  if (nhom.every((g) => chonSet.has(g))) return null; // chọn hết ⇒ đường dòng tổng (bên dưới)
  const cpId = byMa[QC_CP].id;
  const bayGio = new Date();
  await withTransaction(async (client) => {
    for (const g of chon) {
      for (const d of g.dots) {
        await repo.ghiXacNhanDot(client, {
          phanInId, dotVaiId: d.dot_vai_ve_id, checkpointId: cpId, trangThai: 'DAT',
          nguoiId: actorId, tg: bayGio, actorId,
        });
      }
    }
  });
  await repo.logQcTheoDot(phanInId, chon.flatMap((g) => g.dot_vai_ids), actorId);
  sockets.emit('ready:confirmed', { phanInId, buoc: 'QC', dotVaiIds });
  sockets.emit('workflow:updated', { phanInId, stage: 'RELEASE_1' });
  sockets.emit('dashboard:refresh', {});
  return getDetail(phanInId);
}

async function confirmQC(phanInId, actorId, dotVaiIds = []) {
  const { tram, byMa } = await loadConfig();
  if (dotVaiIds && dotVaiIds.length && byMa[QC_CP]) {
    const kq = await confirmQcTheoDot(phanInId, actorId, dotVaiIds, byMa);
    if (kq) return kq;
  }
  const state = buildState(await repo.getResults(tram.id, phanInId));
  if (!state.tech_done) {
    throw new AppError('Kỹ thuật chưa hoàn tất — QC không thể xác nhận', { status: 409, errorCode: 'TECH_NOT_DONE' });
  }
  if (await daKhoaReady(phanInId, state)) throw new AppError('Đã QC xác nhận', { status: 409, errorCode: 'ALREADY' });
  if (!byMa[QC_CP]) throw new AppError('Workflow chưa có checkpoint QC', { status: 500, errorCode: 'NO_CHECKPOINT' });
  // ⚠⚠ MỌI ĐỢT VẢI ĐANG CHỜ phải đủ mục kỹ thuật mới cho QC duyệt (mở rộng 16/09/2026 từ mức LOẠI
  //   sang mức ĐỢT). `state.tech_done` ở trên đọc dòng TỔNG — dòng đó có thể đang DAT từ đợt TRƯỚC,
  //   nên nếu thiếu khối này thì QC duyệt được ngay cho đợt vải mới mà kỹ thuật chưa hề đụng tới.
  // ⚠ Nêu MÃ ĐỢT VẢI (khử trùng tên loại) — nhiều đợt cùng loại thì chỉ ghi tên loại sẽ lặp
  //   "Số lượng, Số lượng" mà người đọc không biết là đợt nào.
  {
    const { nhomCuaPin } = await taiNhomLoai([phanInId], byMa);
    const nhom = nhomCuaPin.get(phanInId);
    if (nhom) {
      const tenKhach = (await repo.getPhanInBasic(phanInId))?.ten_khach_hang;
      const chua = nhom.filter((g) => !techDoneNhom(g, tenKhach));
      if (chua.length) {
        const mo = chua.map((g) => {
          const d = g.dots[0] || {};
          return `${g.ten}${d.barcode || d.ma_dot_vai ? ` (${d.barcode || d.ma_dot_vai})` : ''}`;
        }).join(', ');
        throw new AppError(`Kỹ thuật chưa xác nhận đủ mục cho đợt vải: ${mo}`,
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
  // Phần tử là id phần in (cũ) HOẶC { id, dot_vai_ids } (QC theo đợt, 21/09/2026).
  // ⚠ Chạy TUẦN TỰ: 2 dòng cùng phần in thì lượt đầu ghi theo đợt, lượt sau thấy đợt kia đã Ready
  //   nên chọn hết ⇒ ghi dòng tổng. Chạy song song là 2 lượt tranh nhau đọc cùng trạng thái.
  for (const it of phanInIds) {
    const id = typeof it === 'object' && it ? it.id : it;
    const dv = typeof it === 'object' && it && Array.isArray(it.dot_vai_ids) ? it.dot_vai_ids : [];
    try {
      await confirmQC(id, actorId, dv);
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
  if (await daKhoaReady(phanInId, state)) throw new AppError('Đã QC xác nhận — không thể bỏ tích', { status: 409, errorCode: 'LOCKED' });
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
