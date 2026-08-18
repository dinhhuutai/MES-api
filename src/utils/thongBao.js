'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// THÔNG BÁO (chuông cạnh avatar) — NGUỒN LUẬT DÙNG CHUNG. Mig 085.
//
// Giai đoạn 1 chỉ có một họ thông báo: **PHẦN IN BỊ TRẢ VỀ cho Kỹ thuật**, đến từ 3 chặng.
//
// ⚠⚠ NỘI DUNG KHÔNG NHÂN BẢN: thông báo đọc thẳng từ `qc_tra_ve` (mig 042) — bảng đó đã có
//   `phan_in_id`, `ly_do`, `checklist_list`, `created_by`, `created_date`. Migration 085 chỉ thêm
//   TRẠNG THÁI ĐỌC + CẤU HÌNH BẬT/TẮT + ĐĂNG KÝ PUSH. Chép nội dung ra bảng riêng là 2 nguồn sự
//   thật (sửa lý do một nơi, thông báo hiện một nẻo).
//
// ⚠ THÊM LOẠI THÔNG BÁO MỚI = khai thêm ở `LOAI_TB` dưới đây, KHÔNG cần migration
//   (`cai_dat_thong_bao.ma_loai` không có FK, bảng không seed dòng nào).
//
// ⚠⚠ QUY ƯỚC BẬT/TẮT — THIẾU DÒNG = BẬT, và HỆ THỐNG THẮNG NGƯỜI DÙNG:
//     hệ thống TẮT  → không ai nhận, kể cả người đã bật ở trang cá nhân.
//     hệ thống BẬT  → theo cấu hình từng người (thiếu dòng = bật).
//   Fail-open ở mọi nhánh lỗi (thiếu bảng / DB chớp mạng) ⇒ coi như BẬT. Lý do: thông báo hỏng thì
//   cùng lắm là ồn; tự tắt câm lặng thì kỹ thuật KHÔNG BIẾT hàng bị trả về — hậu quả nặng hơn.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../config/db');

// ─── Danh mục LOẠI thông báo (người dùng bật/tắt được từng loại) ─────────────
// `loaiTraVe` = giá trị `qc_tra_ve.loai` tương ứng — đây là dây nối duy nhất tới dữ liệu nguồn.
// ⚠⚠ `tuTram` / `denTram` PHẢI NÓI RÕ ĐI TỪ ĐÂU VỀ ĐÂU (yêu cầu người dùng 18/08/2026): nhìn thông
//   báo là biết ngay "Release 1 → trả về READY Kỹ thuật", không phải đoán. Chỉ ghi mỗi tên trạm
//   nguồn thì người nhận không biết mình phải làm gì ở đâu.
// ⚠ Cả 3 luồng hiện đều đổ về CÙNG một đích (READY Kỹ thuật) — giữ `denTram` riêng từng loại để sau
//   thêm luồng trả về đích khác (vd OQC → Sửa) không phải sửa cấu trúc.
const DEN_READY = 'READY Kỹ thuật';

// ⚠⚠ MỖI LOẠI KHAI `nguon` + `quyenNhan` RIÊNG (mở rộng 18/08/2026 khi thêm luồng DUYỆT):
//   · `nguon` = bảng dữ liệu gốc — `QC_TRA_VE` (mig 042) hay `YEU_CAU_DUYET` (mig 086). Repo dựng
//     câu SQL theo NHÓM nguồn, nên loại thiếu `nguon` sẽ rơi ra ngoài mọi truy vấn.
//   · `quyenNhan` = danh sách mã quyền được nhận loại đó. TRƯỚC ĐÂY là MỘT hằng `QUYEN_NHAN` dùng
//     chung cho cả 3 loại (đều về Kỹ thuật); nay thông báo "có yêu cầu chờ duyệt" phải đến NGƯỜI
//     DUYỆT chứ không phải kỹ thuật ⇒ bắt buộc tách theo từng loại.
//   · `nguoiGuiNhan: true` = gửi cho ĐÍCH DANH người gửi yêu cầu (báo kết quả duyệt), không theo quyền.
const QUYEN_KY_THUAT = ['READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_TECH'];

const LOAI_TB = {
  TRA_VE_QC: {
    ten: 'QC chuẩn bị kỹ thuật trả về',
    mo_ta: 'QC không duyệt READY, trả phần in lại cho kỹ thuật làm lại Khuôn/Film/Mực.',
    loaiTraVe: 'READY',
    nguon: 'QC_TRA_VE',
    quyenNhan: QUYEN_KY_THUAT,
    nhanTram: 'QC chuẩn bị kỹ thuật',
    tuTram: 'QC chuẩn bị kỹ thuật',
    denTram: DEN_READY,
  },
  TRA_VE_RELEASE1: {
    ten: 'Kế hoạch trả về (Release 1)',
    mo_ta: 'Kế hoạch trả phần in về Kỹ thuật từ màn Release 1 / Kế hoạch tạm / Xác nhận chạy.',
    loaiTraVe: 'RELEASE1',
    nguon: 'QC_TRA_VE',
    quyenNhan: QUYEN_KY_THUAT,
    nhanTram: 'Release 1 (Kế hoạch)',
    tuTram: 'Release 1',
    denTram: DEN_READY,
  },
  TRA_VE_TEST_RUN: {
    ten: 'Test Run - QA trả về',
    mo_ta: 'QA test không đạt, trả phần in về Kỹ thuật kèm các mục Khuôn/Film/Mực bị rớt.',
    loaiTraVe: 'TEST_RUN_KT',
    nguon: 'QC_TRA_VE',
    quyenNhan: QUYEN_KY_THUAT,
    nhanTram: 'Test Run - QA',
    tuTram: 'Test Run - QA',
    denTram: DEN_READY,
  },

  // ─── Họ thông báo thứ 2: DUYỆT ĐỔI PHƯƠNG ÁN IN (mig 086) ──────────────────
  // ⚠ Nguồn `YEU_CAU_DUYET` — KHÔNG có `loaiTraVe`. Repo dựng SQL theo `nguon` nên 3 loại này
  //   không bao giờ lọt vào câu truy vấn `qc_tra_ve` (và ngược lại).
  DUYET_PA_IN_MOI: {
    ten: 'Có yêu cầu đổi phương án in chờ duyệt',
    mo_ta: 'Ai đó gửi yêu cầu đổi phương án in và đang chờ người duyệt thông qua.',
    nguon: 'YEU_CAU_DUYET',
    loaiDuyet: 'DOI_PHUONG_AN_IN',
    suKien: 'MOI',
    // ⚠⚠ ĐẾN NGƯỜI DUYỆT, không phải kỹ thuật: kế hoạch đang BỊ CHẶN release cho tới khi có người
    //   bấm duyệt ⇒ báo nhầm người là hàng nằm chờ mà không ai biết.
    quyenNhan: ['PA_IN_APPROVE'],
    tuTram: 'Yêu cầu đổi phương án in',
    denTram: 'người duyệt',
  },
  DUYET_PA_IN_KET_QUA: {
    ten: 'Kết quả duyệt phương án in (yêu cầu của tôi)',
    mo_ta: 'Yêu cầu đổi phương án in do CHÍNH BẠN gửi đã được duyệt hoặc bị từ chối.',
    nguon: 'YEU_CAU_DUYET',
    loaiDuyet: 'DOI_PHUONG_AN_IN',
    suKien: 'KET_QUA',
    // ⚠ Gửi ĐÍCH DANH người gửi yêu cầu (`nguoiGuiNhan`), KHÔNG rải theo quyền.
    nguoiGuiNhan: true,
    // ⚠⚠ NHƯNG VẪN PHẢI KHAI `quyenNhan` = đúng nhóm GỬI ĐƯỢC yêu cầu: đây là danh sách dùng để
    //   quyết định "người này có thấy CÁI CHUÔNG không". Để rỗng + trả `true` vô điều kiện (bản
    //   đầu của tôi) thì `coQuyenNhan([])` ra TRUE ⇒ **chuông hiện cho MỌI tài khoản**, kể cả người
    //   không liên quan gì tới phương án in. Danh sách hiển thị vẫn lọc `nguoi_gui = tôi` nên người
    //   có quyền mà chưa gửi yêu cầu nào thì thấy rỗng — đúng.
    quyenNhan: ['READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_QC', 'PA_IN_APPROVE'],
    tuTram: 'Người duyệt',
    denTram: 'người gửi yêu cầu',
  },
  DUYET_PA_IN_DA_DOI: {
    ten: 'Phương án in đã được đổi',
    mo_ta: 'Một hồ sơ kỹ thuật vừa đổi phương án in (đổi luôn số cuối mã vạch HSKT — '
      + 'phiếu giấy in mã cũ cần đối chiếu lại).',
    nguon: 'YEU_CAU_DUYET',
    loaiDuyet: 'DOI_PHUONG_AN_IN',
    suKien: 'DA_DUYET',
    quyenNhan: QUYEN_KY_THUAT,
    tuTram: 'Duyệt phương án in',
    denTram: 'Kỹ thuật',
  },
};

// Câu mô tả luồng, dùng CHUNG cho chuông · trang thông báo · popup hệ điều hành.
// ⚠ Một nguồn duy nhất — 3 nơi hiện khác chữ nhau là người dùng tưởng 3 việc khác nhau.
// ⚠ Họ TRẢ VỀ ghi "→ trả về …"; họ DUYỆT chỉ ghi "→ …" (nói "trả về" ở đó là sai nghiệp vụ).
const nhanLuong = (v) => (v.nguon === 'YEU_CAU_DUYET'
  ? `${v.tuTram} → ${v.denTram}`
  : `${v.tuTram} → trả về ${v.denTram}`);

// Bấm thông báo ĐỔI PHƯƠNG ÁN IN → về màn **Danh sách phần in vải về**, chip **"Tất cả"**, tìm sẵn
// code phần đó (người dùng chốt 18/08/2026).
// ⚠⚠ KHÁC HẲN họ "trả về" (về màn READY Kỹ thuật) — đừng dùng chung 1 đường dẫn cho cả hai.
// ⚠ Bản FE gương y hệt ở `frontend/src/utils/thongBaoHienThi.js` — sửa thì sửa CẢ HAI, lệch nhau là
//   bấm ở chuông và bấm ở trang thông báo vào 2 màn khác nhau.
// ⚠ `stage=ALL` là mã chip; `PhanInListPage` khi vào "Tất cả" tự đặt lọc ngày = HÔM NAY, nên phải
//   kèm `boNgay=1` để KHÔNG giấu mất phần in của ngày khác.
const duongDanDoiPa = (maPhan) =>
  `/don-hang/phan-in?stage=ALL&boNgay=1&q=${encodeURIComponent(maPhan || '')}`;

// Nhóm loại theo NGUỒN dữ liệu — repo dựng SQL riêng cho từng nguồn.
// ⚠ Thiếu bộ lọc này thì bộ dựng `CASE q.loai WHEN 'undefined' …` của nguồn `qc_tra_ve` sẽ nuốt cả
//   3 loại duyệt và sinh SQL rác.
const loaiTheoNguon = (nguon) => Object.entries(LOAI_TB)
  .filter(([, v]) => v.nguon === nguon);
const LOAI_QC = loaiTheoNguon('QC_TRA_VE');
const LOAI_DUYET_TB = loaiTheoNguon('YEU_CAU_DUYET');

// ─── Cờ CHỈ Ở MỨC HỆ THỐNG (không hiện ở trang cá nhân) ──────────────────────
// ⚠ Lưu CHUNG bảng `cai_dat_thong_bao` với `LOAI_TB` — 2 loại khóa, 1 bảng. Phân biệt bằng chính
//   2 hằng này; `LOAI_TB` mới là thứ hiện ở trang cá nhân.
const CO_HE_THONG = {
  PUSH_NEN: {
    ten: 'Thông báo cả khi đã đóng app (Web Push)',
    mo_ta: 'BẬT: gửi push xuống thiết bị kể cả khi người dùng đã đóng trình duyệt/PWA. '
      + 'TẮT: chỉ hiện popup khi app đang mở.',
  },
};

const laLoaiHopLe = (ma) => Object.hasOwn(LOAI_TB, ma) || Object.hasOwn(CO_HE_THONG, ma);

// `qc_tra_ve.loai` → mã loại thông báo (dò ngược).
// ⚠ CHỈ nhóm nguồn `QC_TRA_VE`: gộp cả loại duyệt vào đây sẽ sinh khóa `undefined` và làm
//   `banThongBao` khớp nhầm.
const LOAI_TRA_VE_TO_TB = Object.fromEntries(LOAI_QC.map(([ma, v]) => [v.loaiTraVe, ma]));
const CAC_LOAI_TRA_VE = LOAI_QC.map(([, v]) => v.loaiTraVe);

// ─── AI ĐƯỢC NHẬN ────────────────────────────────────────────────────────────
// ⚠⚠ CỐ Ý CHỈ NGƯỜI PHẢI LÀM LẠI, KHÔNG lấy `READY_VIEW` (người dùng chốt 18/08/2026):
//   `READY_VIEW` đang gắn cho cả vai trò **QA** (8 người) và *Kiểm tra báo cáo* — QA chính là bên
//   BẤM trả về, cho họ nhận là tự báo cho mình. Đối chiếu prod: bộ quyền dưới đây phủ đúng
//   KT_KHUON · KT_FILM · KT_MUC · KT · KT_HSKT · MANAGER (+ ADMIN qua '*').
// ⚠ `READY_HSKT` CỐ Ý KHÔNG có mặt: checkpoint HSKT đã bị vô hiệu hóa từ mig 040 nên tổ đó không
//   còn mục nào để xác nhận lại. Hệ quả: vai trò KT_HSKT (1 người, chỉ có READY_HSKT + READY_VIEW)
//   hiện KHÔNG nhận thông báo. Muốn họ nhận thì cấp thêm 1 quyền thật (Khuôn/Film/Mực), đừng nới
//   danh sách này bằng `READY_VIEW` — nới là kéo theo cả 8 QA.
const QUYEN_NHAN = ['READY_KHUON', 'READY_FILM', 'READY_MUC', 'READY_TECH'];

// ─── Cache cấu hình hệ thống (RAM, TTL 30s — khuôn `caiDatApi`/`phienCache`) ──
// ⚠ KHÔNG query DB mỗi lần dựng danh sách thông báo / mỗi lần gửi push.
let _cache = null;
let _cacheAt = 0;
const TTL = 30 * 1000;

function xoaCache() { _cache = null; _cacheAt = 0; }

async function layCaiDatHeThong() {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;
  let m = {};
  try {
    const { rows } = await query('SELECT ma_loai, bat FROM cai_dat_thong_bao');
    rows.forEach((r) => { m[r.ma_loai] = r.bat; });
  } catch (e) {
    // ⚠ FAIL-OPEN: chưa chạy mig 085 / DB chớp mạng ⇒ coi như BẬT HẾT. Tuyệt đối không tắt bừa.
    m = {};
  }
  _cache = m; _cacheAt = Date.now();
  return m;
}

// Hệ thống có bật loại này không (thiếu khóa = BẬT).
async function heThongBat(maLoai) {
  const m = await layCaiDatHeThong();
  return m[maLoai] !== false;
}

// ─── Lọc người nhận ──────────────────────────────────────────────────────────
// Trả về danh sách `user_id` ĐỦ ĐIỀU KIỆN nhận 1 loại thông báo:
//   (a) còn hoạt động, (b) có quyền trong `QUYEN_NHAN` (hoặc '*'), (c) chưa TẮT loại đó.
// ⚠ Quyền tính Y HỆT `auth.repository.getPermissions`: role ∪ cấp trực tiếp \ bị thu hồi.
//   Lệch công thức là người bị thu hồi quyền vẫn nhận thông báo.
// ⚠ Cấu hình HỆ THỐNG kiểm ở NGOÀI (bên gọi) — hàm này chỉ lo tầng người dùng.
// ⚠⚠ `boQuaUserId` CÒN TRONG CHỮ KÝ NHƯNG KHÔNG CÒN AI TRUYỀN (bỏ 18/08/2026 — lỗi thật người dùng
//   bắt được: "phải F5 mới thấy số nhảy").
//   Trước đây `banThongBao` loại NGƯỜI BẤM trả về ra khỏi `user_ids` của socket, nhưng `danhSach`
//   thì KHÔNG loại ⇒ hai đường lệch nhau: người đó vẫn có thông báo trong danh sách nhưng KHÔNG bao
//   giờ nhận được sự kiện realtime ⇒ số trên chuông chỉ nhảy sau khi tải lại trang. Người dùng test
//   một mình bằng 1 tài khoản (admin có đủ quyền nên vừa là người bấm vừa là người nhận) dính đúng ca này.
//   ⇒ Nay KHÔNG loại ai: danh sách và socket dùng CHUNG một tập người nhận.
//   Đánh đổi đã cân nhắc: MANAGER/ADMIN tự bấm trả về sẽ tự nhận 1 thông báo. Chấp nhận được — đó là
//   bản ghi việc cần làm, không phải lời khen; và trong luồng thật QA/Kế hoạch không có quyền
//   READY_KHUON/FILM/MUC/TECH nên họ vốn đã không nằm trong tập nhận.
// ⚠⚠ QUYỀN NHẬN LẤY THEO TỪNG LOẠI (`LOAI_TB[maLoai].quyenNhan`), KHÔNG còn 1 hằng dùng chung:
//   3 loại "trả về" đi tới Kỹ thuật, còn "có yêu cầu chờ duyệt" phải tới NGƯỜI DUYỆT. Dùng chung
//   một danh sách là báo nhầm người và hàng nằm chờ mà không ai biết.
// ⚠ `userIds` = gửi ĐÍCH DANH (báo kết quả duyệt cho chính người gửi yêu cầu). Vẫn đi qua đủ 2 tầng
//   lọc "còn hoạt động" + "chưa tắt loại này ở trang cá nhân" — người tắt rồi thì không nhận.
async function nguoiNhan(maLoai, { boQuaUserId, userIds } = {}) {
  const cfg = LOAI_TB[maLoai] || {};
  const quyen = cfg.quyenNhan || [];

  // Nhánh gửi đích danh — không tra quyền, chỉ lọc hoạt động + cấu hình cá nhân.
  if (Array.isArray(userIds)) {
    const ds = userIds.filter(Boolean);
    if (!ds.length) return [];
    try {
      const { rows } = await query(
        `SELECT u.id FROM nguoi_dung u
          WHERE u.id = ANY($1::uuid[]) AND u.dang_hoat_dong
            AND NOT EXISTS (SELECT 1 FROM thong_bao_nguoi_dung t
                             WHERE t.user_id = u.id AND t.ma_loai = $2 AND t.bat = false)`
          .replace(/\s+/g, ' '),
        [ds, maLoai]
      );
      return rows.map((r) => r.id);
    } catch (e) {
      // Chưa chạy mig 085 → vẫn phải gửi, nếu không thông báo im lặng không đến ai.
      return ds;
    }
  }
  if (!quyen.length) return [];
  return nguoiNhanTheoQuyen(maLoai, quyen, boQuaUserId);
}

async function nguoiNhanTheoQuyen(maLoai, QUYEN_NHAN, boQuaUserId) {
  // ⚠⚠ THU HỒI QUYỀN XÉT THEO TỪNG MÃ, KHÔNG loại cả người: một người có thể bị thu hồi
  //   `READY_KHUON` nhưng vẫn còn `READY_MUC` từ vai trò ⇒ vẫn phải nhận. Bản đầu tôi loại nguyên
  //   người khi thấy BẤT KỲ mã nào bị thu hồi — sai, và sai theo hướng làm người ta mất thông báo.
  const sql = `
    WITH quyen AS (
      SELECT ur.user_id, p.ma_permission
        FROM user_role ur
        JOIN role_permission rp ON rp.role_id = ur.role_id
        JOIN permission p ON p.id = rp.permission_id AND p.dang_hoat_dong
      UNION
      SELECT up.user_id, p.ma_permission
        FROM user_permission up JOIN permission p ON p.id = up.permission_id
       WHERE up.duoc_phep = true
    ),
    hieu_luc AS (
      SELECT q.user_id FROM quyen q
       WHERE (q.ma_permission = ANY($1::text[]) OR q.ma_permission = '*')
         AND NOT EXISTS (SELECT 1 FROM user_permission ux
                           JOIN permission px ON px.id = ux.permission_id
                          WHERE ux.user_id = q.user_id AND ux.duoc_phep = false
                            AND px.ma_permission = q.ma_permission)
    )
    SELECT DISTINCT u.id
      FROM hieu_luc h
      JOIN nguoi_dung u ON u.id = h.user_id AND u.dang_hoat_dong
     WHERE NOT EXISTS (SELECT 1 FROM thong_bao_nguoi_dung t
                        WHERE t.user_id = u.id AND t.ma_loai = $2 AND t.bat = false)
       AND ($3::uuid IS NULL OR u.id <> $3::uuid)`;
  try {
    const { rows } = await query(sql.replace(/\s+/g, ' '), [QUYEN_NHAN, maLoai, boQuaUserId || null]);
    return rows.map((r) => r.id);
  } catch (e) {
    // ⚠ Chưa chạy mig 085 (thiếu `thong_bao_nguoi_dung`) → vẫn phải trả đúng người có quyền,
    //   nếu không thì thông báo im lặng không đến ai. Lùi về truy vấn KHÔNG có bảng cấu hình.
    try {
      const { rows } = await query(
        `SELECT DISTINCT u.id FROM nguoi_dung u
           JOIN user_role ur ON ur.user_id = u.id
           JOIN role_permission rp ON rp.role_id = ur.role_id
           JOIN permission p ON p.id = rp.permission_id AND p.dang_hoat_dong
          WHERE u.dang_hoat_dong AND (p.ma_permission = ANY($1::text[]) OR p.ma_permission = '*')
            AND ($2::uuid IS NULL OR u.id <> $2::uuid)`.replace(/\s+/g, ' '),
        [QUYEN_NHAN, boQuaUserId || null]
      );
      return rows.map((r) => r.id);
    } catch (e2) { return []; }
  }
}

// Người này có được nhận loại NÀY không (dùng để lọc danh sách/chuông của CHÍNH họ).
// ⚠⚠ LUÔN xét `quyenNhan`, KỂ CẢ loại gửi đích danh (`nguoiGuiNhan`): bản đầu trả `true` vô điều
//   kiện cho loại đó và hậu quả là `coQuyenNhan([])` ra TRUE ⇒ chuông hiện cho MỌI tài khoản.
//   Với loại đích danh, `quyenNhan` khai đúng nhóm GỬI ĐƯỢC yêu cầu, còn việc "chỉ thấy yêu cầu
//   của chính mình" do tầng truy vấn lo (`nguoi_gui = $1`).
const coQuyenNhanLoai = (perms = [], maLoai) => {
  const v = LOAI_TB[maLoai];
  if (!v) return false;
  if (perms.includes('*')) return true;
  return (v.quyenNhan || []).some((q) => perms.includes(q));
};

// Có thấy CÁI CHUÔNG không = nhận được ÍT NHẤT 1 loại.
// ⚠ Giữ nguyên tên `coQuyenNhan` (đang dùng ở controller/service) nhưng nay xét MỌI loại, không
//   chỉ bộ quyền kỹ thuật — nếu không thì người duyệt (chỉ có `PA_IN_APPROVE`) sẽ bị ẩn mất chuông
//   dù chính họ là người phải nhận yêu cầu chờ duyệt.
const coQuyenNhan = (perms = []) => Object.keys(LOAI_TB).some((ma) => coQuyenNhanLoai(perms, ma));

module.exports = {
  LOAI_TB, CO_HE_THONG, QUYEN_NHAN, LOAI_QC, LOAI_DUYET_TB, duongDanDoiPa,
  LOAI_TRA_VE_TO_TB, CAC_LOAI_TRA_VE, nhanLuong,
  laLoaiHopLe, layCaiDatHeThong, heThongBat, xoaCache, nguoiNhan,
  coQuyenNhan, coQuyenNhanLoai,
};
