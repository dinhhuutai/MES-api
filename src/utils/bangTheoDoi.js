'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// BẢNG THEO DÕI THỰC HIỆN CỦA CÁC CHECK POINT (Dashboard → Tổng quan, 20/09/2026)
//
// Đúng tờ giấy xưởng đang dùng: 10 dòng checkpoint × (TỒN ĐẦU · NHẬN · XONG · TỒN CUỐI · NGHẼN),
// mỗi cụm có **Phần** (số phần in) và **SL** (số lượng pcs).
//
// ⚠⚠⚠ KHÔNG VIẾT LẠI CÁCH ĐẾM — dùng NGUYÊN engine sĩ số (`utils/siSoTram.js` + `siso.repository`):
//   mỗi đối tượng ở 1 trạm quy về khoảng `[tg_vao, tg_ra)` nên **Tồn đầu + Nhận − Xong = Tồn cuối**
//   luôn đúng theo toán học, và bảng này KHÔNG THỂ đá nhau với dải "Theo dõi" của 12 màn xác nhận.
//   Viết một cách đếm thứ hai là chắc chắn sinh 2 con số cho cùng một câu hỏi (bài học §6).
//
// ⚠⚠ ĐƠN VỊ ĐẾM CỦA CỘT "PHẦN" LÀ **PHẦN IN** ở cả 10 dòng (đơn vị `pin` của engine) ⇒ 10 con số so
//   ngang được với nhau. Hệ quả ĐÃ BIẾT, đừng "sửa cho khớp": **một phần in có thể nằm ở NHIỀU
//   checkpoint cùng lúc** (MES đi theo ĐỢT VẢI — phần in release một phần thì vừa còn ở Release 1
//   vừa đã sang Test Run) ⇒ **Σ 10 dòng LỚN HƠN tổng số phần in là ĐÚNG**. Đây không phải dominant
//   stage của ô "Tổng quan giai đoạn" (mỗi phần in đúng 1 trạm — DATABASE.md §11.5).
//
// ⚠⚠ CỘT "SL" LẤY THEO ĐƠN VỊ CỦA TỪNG TRẠM (người dùng chốt 20/09/2026):
//     · 3 trạm đi theo PHẦN IN / ĐỢT VẢI (READY KT · READY QA · RELEASE 1): **SL vải về (pcs)** — 2 dòng
//       READY chỉ cộng các đợt của CHU KỲ READY hiện tại (`slDotReady`, 02/10/2026), Release 1 cộng mọi đợt.
//     · 3 trạm đi theo LỆNH SX (TEST RUN · RELEASE 2 · IN): **SL release (pcs)** của chính phần in
//       trong các lệnh đang ở trạm.
//     · 4 trạm đi theo TEM (KIỂM · SỬA · OQC · GIAO): **số lượng trên chính các tem đang ở trạm đó**,
//       lấy đúng biểu thức mà nguồn mốc của trạm dùng để biết "còn hàng hay hết hàng".
//   ⚠ Mỗi đối tượng góp CÙNG một con số vào cả 4 ô nó thuộc về ⇒ bất biến 4 ô vẫn đúng với cột SL.
//     Tuyệt đối đừng đổi sang đại lượng phụ thuộc KỲ (vd "SL đã kiểm trong kỳ") — bất biến vỡ ngay.
//
// ⚠ SQL ở đây được `siso.repository` gửi **gộp 1 dòng** (tránh IPS reset) ⇒ KHÔNG viết comment
//   `-- …` bên trong chuỗi SQL; chú thích để ngoài như file này.
// ─────────────────────────────────────────────────────────────────────────────

// Σ một đại lượng trên CHÍNH các tem đang ở trạm.
// ⚠⚠ `q.ma_tem` là chuỗi `string_agg(DISTINCT x.ma_tem, ', ')` do `gomTheo` dựng — tách đúng dấu
//   `', '` (phẩy + khoảng trắng), sai dấu là mảng 1 phần tử và tổng luôn ra 0.
// ⚠ `ma_tem` có UNIQUE index nên subquery này là tra khóa, không phải quét bảng.
// ⚠ TEM CON (tem 17 — sửa đạt, mig 091) nằm sẵn trong danh sách và mang `so_luong = 0`, `sl_kcs_dat`
//   = SL sửa đạt ⇒ 4 biểu thức dưới đây cộng nó vào ĐÚNG như sổ cái đang tính, không đếm đôi.
const { mocDotMucSql, mocKtXongDotSql, relRoiReadyDotSql } = require('./tech');

const slTem = (bieuThuc) => `COALESCE((SELECT sum(${bieuThuc})::int FROM tem xt
  WHERE q.ma_tem IS NOT NULL AND xt.ma_tem = ANY(string_to_array(q.ma_tem, ', '))), 0)`;

// Σ SL RELEASE mà CHÍNH phần in này góp vào các lệnh đang ở trạm.
// ⚠⚠ ĐỌC `lenh_sx_dot_vai.so_luong` CHỨ KHÔNG PHẢI `lenh_san_xuat.so_luong_release`: lệnh GOM SET
//   trải nhiều phần in, lấy tổng của lệnh là mỗi phần in trong set đều cộng ĐỦ số của cả lệnh ⇒
//   phóng đại. Ràng thêm `xdv.phan_in_id = q.id` để chỉ lấy phần của chính phần in đang xét.
// ⚠ `q.ma_lenh_san_xuat` là `string_agg(DISTINCT …, ', ')` các lệnh CÒN Ở TRẠM (luật `gomTheo`).
const SL_LENH = `COALESCE((SELECT sum(xlsd.so_luong)::int
  FROM lenh_san_xuat xls
  JOIN lenh_sx_dot_vai xlsd ON xlsd.lenh_san_xuat_id = xls.id
  JOIN dot_vai_ve xdv ON xdv.id = xlsd.dot_vai_ve_id AND xdv.phan_in_id = q.id
 WHERE q.ma_lenh_san_xuat IS NOT NULL
   AND xls.ma_lenh_san_xuat = ANY(string_to_array(q.ma_lenh_san_xuat, ', '))), 0)`;

// Σ SL vải CHỈ của các đợt thuộc CHU KỲ READY HIỆN TẠI của phần in (02/10/2026 — người dùng bắt: dòng READY KT
// cột Nhận SL LỚN HƠN dòng OPEN, trong khi theo định nghĩa READY KT phải = OPEN, trừ hàng hệ thống tự xác nhận).
// Lỗi cũ: 2 dòng READY dùng `vai` = Σ MỌI đợt còn hiệu lực ⇒ phần in có đợt mới hôm nay cộng luôn SL các đợt CŨ
// đã release từ lâu (đo prod 02/10: Nhận READY KT 95.856 pcs ↔ OPEN 59.307, chỉ tính đợt của chu kỳ = 57.283).
// Đợt d thuộc chu kỳ ⟺ d CHƯA rời trạm tại `q.tg_vao` (mốc phần in vào trạm của engine sĩ số):
//   · READY KT: rời = sớm nhất(KT xong của CHÍNH đợt, QC của đợt, release của đợt).
//   · READY QA: đợt đã KT xong, rời = sớm nhất(QC của đợt, release của đợt).
// Mốc từng đợt dùng CHUNG với nguồn nghẽn theo đợt (`siso.repository READY_DOT`): `tech.mocDotMucSql`,
// `mocKtXongDotSql`, `relRoiReadyDotSql`. Không phụ thuộc kỳ ⇒ mỗi phần in góp CÙNG một số vào cả 4 ô (bất biến giữ).
// ⚠ Chỉ chạy trong `siso.repository` (đọc `q.id`, `q.tg_vao`, `q.ten_khach_hang` của dòng phần in).
const slDotReady = (laQa) => {
  const kt = mocKtXongDotSql('q.ten_khach_hang', 'zm.khuon', 'zm.muc');
  const conO = laQa
    ? `${kt} IS NOT NULL AND COALESCE(LEAST(zm.qc, zm.rel), 'infinity'::timestamptz) >= q.tg_vao`
    : `COALESCE(LEAST(${kt}, zm.qc, zm.rel), 'infinity'::timestamptz) >= q.tg_vao`;
  return `COALESCE((SELECT sum(zd.so_luong_vai_ve)::int FROM dot_vai_ve zd
    CROSS JOIN LATERAL (SELECT ${mocDotMucSql('zd', 'zd.phan_in_id', 'KHUON')} AS khuon,
      ${mocDotMucSql('zd', 'zd.phan_in_id', 'MUC')} AS muc, ${mocDotMucSql('zd', 'zd.phan_in_id', 'QC_XAC_NHAN')} AS qc,
      ${relRoiReadyDotSql('zd')} AS rel) zm
    WHERE zd.phan_in_id = q.id AND zd.trang_thai NOT IN ('DA_GOP','DA_HUY') AND zd.tg_chuyen_ready IS NOT NULL
      AND q.tg_vao IS NOT NULL AND ${conO}), 0)`;
};

const DO_SL = {
  // Σ SL vải về của MỌI đợt vải còn hiệu lực của phần in (`LAT_DOT_CUA_PIN`) — cùng đại lượng với
  // đơn vị "SL vải (pcs)" mà dải "Theo dõi" ở Release 1/2 đang dùng.
  vai: { sql: 'COALESCE(q.so_luong_vai_ve,0)', nhan: 'SL vải về (pcs)' },
  vai_ready_kt: { sql: slDotReady(false), nhan: 'SL vải về (pcs)' },
  vai_ready_qa: { sql: slDotReady(true), nhan: 'SL vải về (pcs)' },
  lenh: { sql: SL_LENH, nhan: 'SL release (pcs)' },
  // Tổng phải kiểm của tem = SL in + chênh lệch (dư/thiếu) — gương `DV.KIEM`.
  tem_kiem: { sql: slTem('COALESCE(xt.so_luong,0) + COALESCE(xt.sl_chenh_lech,0)'), nhan: 'SL phải kiểm (pcs)' },
  tem_sua: { sql: slTem('COALESCE(xt.sl_kcs_sua,0)'), nhan: 'SL chuyển sửa (pcs)' },
  tem_oqc: {
    sql: slTem('COALESCE(xt.sl_kcs_dat,0) + COALESCE(xt.sl_sua_dat,0) - COALESCE(xt.sl_sua_tach,0)'),
    nhan: 'SL vào OQC (pcs)',
  },
  tem_giao: { sql: slTem('COALESCE(xt.sl_oqc_dat,0)'), nhan: 'SL qua giao (pcs)' },
  // Hàng OPEN: Σ SL vải của CHÍNH các đợt lên MES trong kỳ. Phần in chỉ góp mặt vì Nghẽn (không có đợt mới
  //   trong kỳ) ⇒ lùi về Σ SL vải mọi đợt còn hiệu lực của nó (cột SL Nghẽn mới có số).
  // ⚠ Đọc CTE `ky` của `siso.repository` (mốc kỳ báo cáo).
  vai_vao: {
    sql: `COALESCE(NULLIF((SELECT sum(xd.so_luong_vai_ve)::int FROM dot_vai_ve xd WHERE xd.phan_in_id = q.id
      AND xd.trang_thai NOT IN ('DA_GOP','DA_HUY') AND xd.tg_chuyen_ready >= (SELECT tu FROM ky)
      AND xd.tg_chuyen_ready < (SELECT den FROM ky)), 0), q.so_luong_vai_ve, 0)`,
    nhan: 'SL vải lên MES (pcs)',
  },
};

// ─── 10 DÒNG ─────────────────────────────────────────────────────────────────
// `man` = mã màn trong `MAN` của `utils/siSoTram.js` (nguồn mốc vào/ra).
// `sla` = nơi lấy SLA trong workflow HIỆN HÀNH — khớp hằng `TRAM_TG` của *Thời gian trạm* để
//   "nghẽn" ở 2 trang không bao giờ lệch nhau. `null` ⇒ trạm không đo nghẽn được.
// `slaKieu` (24/09/2026) = SLA KHÔNG cố định, luật ở `utils/slaTheoGio.js`: READY theo giờ đợt lên MES,
//   Test Run theo giờ SX kế hoạch − 1h, QC READY theo giờ KT xong (sau 16:30 ⇒ 16h). Không khai ⇒ SLA cố định của trạm như cũ.
//   (Nhãn mô tả — luật nghẽn THẬT của từng dòng nằm ở `siso.repository NGHEN_CON`, khóa = `ma`, đo theo
//   ĐƠN VỊ CON đợt/lệnh/tem từ 02/10/2026. Thêm dòng mới ⇒ khai thêm nguồn ở đó, thiếu thì dòng đó nghẽn = 0.)
// ⚠ CỐ Ý bỏ *Kế hoạch tạm* và *Gia công* khỏi bảng: tờ giấy của xưởng không có 2 dòng đó, và cả hai
//   là nhánh rẽ chứ không nằm trên dòng chảy chính. Muốn thêm thì khai thêm 1 dòng ở đây là đủ.
// ⚠ OPEN (02/10/2026, người dùng chốt): KHÔNG có màn/sĩ số riêng ⇒ `man: null`, nguồn phần in là
//   `siSoTram.OPEN_PIN_SQL` (`nguonPin: 'OPEN'`). Nhận = Xong = phần in có đợt lên MES trong ngày, Tồn = 0.
//   NGHẼN = phần in READY Kỹ thuật đánh dấu BẤT THƯỜNG · trả về GN mà GN "Xác nhận lại" quá SLA trạm OPEN
//   (`tram.OPEN` 240 phút) — kèm lý do từng phần in. `nghenMoi: true` ⇒ Nghẽn KHÔNG bị gác trong Tồn cuối
//   (lỗi OPEN có thể phát sinh nhiều ngày sau khi đợt lên MES).
const BANG_THEO_DOI = [
  { ma: 'OPEN', ten: 'OPEN', man: null, nguonPin: 'OPEN', sla: { tram: 'OPEN' }, sl: 'vai_vao', nghenMoi: true,
    ghiChu: 'Đầu vào = đợt vải ERP đưa lên MES trong ngày · Nghẽn = READY KT đánh dấu Bất thường / trả về GN mà GN xác nhận lại quá SLA' },
  { ma: 'READY_KT', ten: 'READY KT', man: 'KT_READY', sla: { tram: 'READY' }, slaKieu: 'READY_THEO_GIO', sl: 'vai_ready_kt',
    ghiChu: 'Vào = đợt vải lên READY · Xong = kỹ thuật xác nhận đủ mục' },
  { ma: 'READY_QA', ten: 'READY QA', man: 'CL_QC_READY', sla: { checkpoint: 'QC_XAC_NHAN' }, slaKieu: 'QC_THEO_GIO', sl: 'vai_ready_qa',
    ghiChu: 'Vào = kỹ thuật xong hết mục · Xong = QC xác nhận READY' },
  { ma: 'RELEASE_1', ten: 'RELEASE 1', man: 'KH_RELEASE1', sla: { tram: 'RELEASE_1' }, sl: 'vai',
    ghiChu: 'Vào = đợt vải lên READY · Xong = release hết SL (hoặc sang Kế hoạch tạm)' },
  { ma: 'TEST_RUN', ten: 'TEST RUN', man: 'CL_TEST_RUN', sla: { tram: 'TEST_RUN' }, slaKieu: 'TEST_RUN_KE_HOACH', sl: 'lenh',
    ghiChu: 'Vào = tạo lệnh · Xong = QA xác nhận đạt (lệnh đi tắt Test Run không tính vào trạm này)' },
  { ma: 'RELEASE_2', ten: 'RELEASE 2', man: 'KH_RELEASE2', sla: { tram: 'RELEASE_2' }, sl: 'lenh',
    ghiChu: 'Vào = test xong · Xong = duyệt Release 2' },
  { ma: 'IN', ten: 'IN', man: 'SX_CHO_CHAY', sla: { tram: 'SAN_XUAT' }, sl: 'lenh',
    ghiChu: 'Chờ chạy + đang chạy · Vào = duyệt Release 2 · Xong = chạy hoàn tất' },
  { ma: 'KIEM', ten: 'KIỂM', man: 'SX_KCS', sla: { tram: 'KIEM' }, sl: 'tem_kiem',
    ghiChu: 'Vào = tem khô · Xong = kiểm hết phần còn lại' },
  { ma: 'SUA', ten: 'SỬA', man: 'SX_SUA', sla: { tram: 'SUA' }, sl: 'tem_sua',
    ghiChu: 'Vào = KCS có hàng phải sửa · Xong = sửa hết phần chờ' },
  { ma: 'OQC', ten: 'OQC', man: 'CL_OQC', sla: { tram: 'OQC' }, sl: 'tem_oqc',
    ghiChu: 'Vào = có hàng đạt (KCS hoặc Sửa) · Xong = OQC duyệt hết' },
  { ma: 'GIAO', ten: 'GIAO', man: 'GH_TEM', sla: { tram: 'FINISH' }, sl: 'tem_giao',
    ghiChu: 'Vào = OQC cho qua giao · Xong = giao hết phần còn lại' },
];

module.exports = { BANG_THEO_DOI, DO_SL };
