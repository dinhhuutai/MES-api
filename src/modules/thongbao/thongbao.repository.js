'use strict';

// THÔNG BÁO — truy vấn. Luật + danh mục ở `utils/thongBao.js`.
// ⚠ SQL gửi GỘP 1 DÒNG (IPS, §9) ⇒ KHÔNG viết comment `-- …` bên trong chuỗi SQL.

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
const { LOAI_TB, LOAI_QC, nhanLuong } = require('../../utils/thongBao');

const NGUON = 'QC_TRA_VE';

// ⚠⚠ CHỈ DỰNG CASE TỪ `LOAI_QC` (các loại có nguồn `qc_tra_ve`), KHÔNG duyệt cả `LOAI_TB`:
//   từ 18/08/2026 `LOAI_TB` còn chứa 3 loại thuộc nguồn `yeu_cau_duyet` (không có `loaiTraVe`) —
//   duyệt hết sẽ sinh `WHEN 'undefined' THEN …` và khớp lung tung.
// `qc_tra_ve.loai` → mã loại thông báo, dựng ngay trong SQL để FE nhận sẵn khóa cấu hình.
const CASE_MA_LOAI = `CASE q.loai ${LOAI_QC
  .map(([ma, v]) => `WHEN '${v.loaiTraVe}' THEN '${ma}'`).join(' ')} END`;
const CASE_TEN_TRAM = `CASE q.loai ${LOAI_QC
  .map(([, v]) => `WHEN '${v.loaiTraVe}' THEN '${v.nhanTram}'`).join(' ')} END`;
// ⚠ Trạm ĐI và trạm ĐẾN trả riêng + câu gộp sẵn: người nhận phải thấy ngay "Release 1 → trả về
//   READY Kỹ thuật", không phải suy từ mỗi tên trạm nguồn (yêu cầu 18/08/2026).
const CASE_TU_TRAM = `CASE q.loai ${LOAI_QC
  .map(([, v]) => `WHEN '${v.loaiTraVe}' THEN '${v.tuTram}'`).join(' ')} END`;
const CASE_DEN_TRAM = `CASE q.loai ${LOAI_QC
  .map(([, v]) => `WHEN '${v.loaiTraVe}' THEN '${v.denTram}'`).join(' ')} END`;
const CASE_NHAN_LUONG = `CASE q.loai ${LOAI_QC
  .map(([, v]) => `WHEN '${v.loaiTraVe}' THEN '${nhanLuong(v)}'`).join(' ')} END`;

// ⚠⚠ THÔNG TIN NGƯỜI TRẢ VỀ lấy ĐẦY ĐỦ ngay trong danh sách (họ tên · @username · chức vụ · phòng
//   ban · email · điện thoại · avatar) — trang thông báo yêu cầu "thông tin đầy đủ của người trả về".
//   Rẻ: chỉ là JOIN 2 bảng nhỏ theo khóa chính, không phải subquery tương quan.
const FROM = `
  FROM qc_tra_ve q
  JOIN phan_in pin ON pin.id = q.phan_in_id AND pin.dang_hoat_dong
  JOIN ma_hang mh ON mh.id = pin.ma_hang_id
  JOIN don_hang dh ON dh.id = mh.don_hang_id
  JOIN khach_hang kh ON kh.id = dh.khach_hang_id
  LEFT JOIN nguoi_dung nd ON nd.id = q.created_by
  LEFT JOIN phong_ban pb ON pb.id = nd.phong_ban_id
  LEFT JOIN thong_bao_da_doc dd ON dd.user_id = $1 AND dd.nguon = '${NGUON}' AND dd.nguon_id = q.id`;

const COT = `q.id, q.loai AS loai_tra_ve, ${CASE_MA_LOAI} AS ma_loai, ${CASE_TEN_TRAM} AS ten_tram,
  ${CASE_TU_TRAM} AS tu_tram, ${CASE_DEN_TRAM} AS den_tram, ${CASE_NHAN_LUONG} AS nhan_luong,
  q.ly_do, q.checklist_list, q.created_date AS tg, q.da_xu_ly,
  pin.id AS phan_in_id, pin.ma_phan, pin.mau_vai, pin.kich_vai, pin.kich_phim, pin.tinh_chat_in,
  pin.so_luong_don_hang, mh.ma_hang, dh.ma_don_hang, kh.ten_khach_hang,
  nd.id AS nguoi_id, nd.ho_ten AS nguoi_ho_ten, nd.ten_dang_nhap AS nguoi_username,
  nd.chuc_vu AS nguoi_chuc_vu, nd.email AS nguoi_email, nd.so_dien_thoai AS nguoi_sdt,
  nd.avatar_url AS nguoi_avatar, pb.ten_phong_ban AS nguoi_phong_ban,
  (dd.user_id IS NOT NULL) AS da_doc`;

// Điều kiện lọc chung. `$2` = mảng `qc_tra_ve.loai` mà NGƯỜI NÀY đang bật (đã tính ở service).
const WHERE = 'WHERE q.phan_in_id IS NOT NULL AND q.loai = ANY($2::text[])';

// Danh sách thông báo của 1 người.
// ⚠ `chuaDoc` lọc ở tầng SQL (không lọc ở JS sau khi phân trang) — nếu không thì trang 1 có thể
//   rỗng trong khi tổng vẫn báo còn chưa đọc.
// ⚠⚠ FAIL-OPEN: chưa chạy mig 085 (`thong_bao_da_doc` chưa tồn tại) ⇒ trả RỖNG, KHÔNG ném.
//   Đây là bảo hiểm cho ca deploy backend TRƯỚC khi chạy migration — thiếu nó thì chuông và trang
//   thông báo trả 500 cho MỌI người dùng và log đầy lỗi. Đã đo thật trên prod trước khi vá.
//   Trang *Hệ thống > Cài đặt thông báo* vẫn báo rõ "Chưa chạy migration 085" (cờ `thieu_bang`).
async function danhSach(userId, {
  loaiBat, chuaDoc = false, timKiem = '', tuNgay = '', denNgay = '', maLoai = '',
  limit = 20, offset = 0,
}) {
  if (!loaiBat || !loaiBat.length) return { items: [], total: 0 };
  const dk = [WHERE];
  const p = [userId, loaiBat];
  if (chuaDoc) dk.push('AND dd.user_id IS NULL');
  if (timKiem) {
    p.push(mauTim(timKiem));
    dk.push(`AND (pin.ma_phan ~* $${p.length} OR kh.ten_khach_hang ~* $${p.length}
      OR mh.ma_hang ~* $${p.length} OR dh.ma_don_hang ~* $${p.length} OR pin.mau_vai ~* $${p.length}
      OR q.ly_do ~* $${p.length} OR nd.ho_ten ~* $${p.length})`);
  }
  // ⚠ Lọc theo NGÀY TRẢ VỀ, quy về ngày giờ VN (server có thể chạy múi giờ khác) — cùng khuôn với
  //   mọi màn "Lịch sử theo ngày" khác (DATABASE.md §11.8). `den` là ngày CUỐI có bao gồm.
  if (tuNgay) { p.push(tuNgay); dk.push(`AND (q.created_date ${VN})::date >= $${p.length}::date`); }
  if (denNgay) { p.push(denNgay); dk.push(`AND (q.created_date ${VN})::date <= $${p.length}::date`); }
  // Lọc theo 1 loại cụ thể (chip trên trang thông báo). ⚠ Vẫn giao với `loaiBat` ở `WHERE` nên
  //   không thể dùng tham số này để xem loại mà mình/hệ thống đã TẮT.
  if (maLoai && LOAI_TB[maLoai]) { p.push(LOAI_TB[maLoai].loaiTraVe); dk.push(`AND q.loai = $${p.length}`); }
  const than = `${FROM} ${dk.join(' ')}`;
  try {
    const dem = await query(`SELECT count(*)::int AS n ${than}`.replace(/\s+/g, ' '), p);
    const ds = await query(
      `SELECT ${COT} ${than} ORDER BY q.created_date DESC LIMIT ${Number(limit) || 20} OFFSET ${Number(offset) || 0}`
        .replace(/\s+/g, ' '), p
    );
    return { items: ds.rows, total: dem.rows[0] ? dem.rows[0].n : 0 };
  } catch (e) {
    console.error('[thong-bao] ✗ đọc danh sách lỗi (kiểm tra migration 085):', e.message);
    return { items: [], total: 0 };
  }
}

// Đếm theo TỪNG LOẠI cho dải chip trên trang thông báo.
// ⚠ Đếm trên tập ĐANG XÉT (đã qua ô tìm + khoảng ngày + "chỉ chưa đọc") nhưng **KHÔNG áp chính
//   `maLoai`** — nếu áp thì chip đang chọn hiện số của nó còn các chip khác về 0, bấm sang không
//   biết bên đó có gì. Cùng quy ước với dải chip loại chuyền ở Test Run / Theo dõi chuyền.
async function demTheoLoai(userId, { loaiBat, chuaDoc = false, timKiem = '', tuNgay = '', denNgay = '' }) {
  if (!loaiBat || !loaiBat.length) return {};
  const dk = [WHERE];
  const p = [userId, loaiBat];
  if (chuaDoc) dk.push('AND dd.user_id IS NULL');
  if (timKiem) {
    p.push(mauTim(timKiem));
    dk.push(`AND (pin.ma_phan ~* $${p.length} OR kh.ten_khach_hang ~* $${p.length}
      OR mh.ma_hang ~* $${p.length} OR dh.ma_don_hang ~* $${p.length} OR pin.mau_vai ~* $${p.length}
      OR q.ly_do ~* $${p.length} OR nd.ho_ten ~* $${p.length})`);
  }
  if (tuNgay) { p.push(tuNgay); dk.push(`AND (q.created_date ${VN})::date >= $${p.length}::date`); }
  if (denNgay) { p.push(denNgay); dk.push(`AND (q.created_date ${VN})::date <= $${p.length}::date`); }
  try {
    const { rows } = await query(
      `SELECT ${CASE_MA_LOAI} AS ma_loai, count(*)::int AS n ${FROM} ${dk.join(' ')} GROUP BY 1`
        .replace(/\s+/g, ' '), p
    );
    // ⚠ Khai TRƯỚC đủ mọi loại = 0: `GROUP BY` bỏ qua loại không có dòng nào, trả thiếu khóa thì
    //   bên gọi phải tự `|| 0` ở mọi chỗ và test rất dễ so nhầm `0 === undefined`.
    const m = { '': 0 };
    Object.keys(LOAI_TB).forEach((k) => { m[k] = 0; });
    rows.forEach((r) => { if (r.ma_loai) { m[r.ma_loai] = r.n; m[''] += r.n; } });
    return m;
  } catch (e) { return {}; }
}

// ─── NGUỒN 2: YÊU CẦU DUYỆT (mig 086) ───────────────────────────────────────
// ⚠⚠ TRẢ RA CÙNG HÌNH DẠNG CỘT với nguồn `qc_tra_ve` (thiếu trường nào thì NULL) để service chỉ
//   việc gộp 2 mảng rồi sắp theo `tg` — FE dựng MỘT bảng, không phải rẽ nhánh theo nguồn.
// ⚠ `nguon` = 'YEU_CAU_DUYET' trong `thong_bao_da_doc` ⇒ id của 2 nguồn không bao giờ đụng nhau
//   (cột đó cố ý KHÔNG có FK — xem DATABASE.md §11.13).
const NGUON_DUYET = 'YEU_CAU_DUYET';

// ⚠⚠ LẤY CODE PHẦN THẬT TỪ QUAN HỆ, KHÔNG lấy `yc.mo_ta`: `mo_ta` là câu ngữ cảnh cho người đọc
//   ("HSKT 2600… · A,B · (2 phần in dùng chung hồ sơ)") — nhét vào ô `ma_phan` thì thông báo hiện
//   một câu dài loằng ngoằng, và cái `?q=` khi bấm vào sẽ tra bằng nguyên câu đó ⇒ không ra gì.
//   JOIN sống qua `hskt_phan_in` cũng luôn đúng hiện tại, kể cả khi phần in được gắn/gỡ về sau.
const LAT_PIN_DUYET = `LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT p.ma_phan, ', ' ORDER BY p.ma_phan) AS ds_ma_phan,
         min(p.ma_phan) AS ma_phan_dau, count(DISTINCT p.id)::int AS so_phan_in
    FROM hskt_phan_in hp JOIN phan_in p ON p.id = hp.phan_in_id AND p.dang_hoat_dong
   WHERE hp.hskt_id = yc.doi_tuong_id AND hp.dang_hoat_dong
) pin ON true`;

const FROM_DUYET = `
  FROM yeu_cau_duyet yc
  LEFT JOIN nguoi_dung nd ON nd.id = yc.nguoi_gui
  LEFT JOIN phong_ban pb ON pb.id = nd.phong_ban_id
  ${LAT_PIN_DUYET}
  LEFT JOIN thong_bao_da_doc dd ON dd.user_id = $1 AND dd.nguon = '${NGUON_DUYET}' AND dd.nguon_id = yc.id`;

// `ma_loai` suy từ TRẠNG THÁI: đang chờ → "có yêu cầu chờ duyệt"; đã chốt → "phương án in đã đổi".
// Loại "kết quả cho người gửi" lọc riêng bằng `nguoi_gui` ở service (cùng dòng dữ liệu).
const CASE_MA_LOAI_DUYET = `CASE WHEN yc.trang_thai = 'CHO' THEN 'DUYET_PA_IN_MOI'
  ELSE 'DUYET_PA_IN_DA_DOI' END`;

// Nhãn phương án in dựng NGAY TRONG SQL để chuông · trang · popup dùng CHUNG một câu.
// ⚠ Nguồn số → chữ phải khớp `utils/hskt.js PHUONG_AN_IN` (0 Chưa xác định · 1 Bàn · 2 Máy · 3 Robot).
const PA_TEN = (col) => `CASE (${col})::int WHEN 1 THEN 'Bàn' WHEN 2 THEN 'Máy' WHEN 3 THEN 'Robot'
  ELSE 'Chưa xác định' END`;
const PA_CU = PA_TEN("COALESCE(yc.gia_tri_cu->>'phuong_an_in','0')");
const PA_MOI = PA_TEN("COALESCE(yc.gia_tri_moi->>'phuong_an_in','0')");

const COT_DUYET = `yc.id, NULL::text AS loai_tra_ve, ${CASE_MA_LOAI_DUYET} AS ma_loai,
  'Đổi phương án in'::text AS ten_tram,
  'Đổi phương án in'::text AS tu_tram, 'người duyệt'::text AS den_tram,
  (CASE WHEN yc.trang_thai = 'CHO' THEN 'Thay đổi phương án in — chờ duyệt'
        WHEN yc.trang_thai = 'DUYET' THEN 'Thay đổi phương án in — đã duyệt'
        WHEN yc.trang_thai = 'TU_CHOI' THEN 'Thay đổi phương án in — bị từ chối'
        ELSE 'Thay đổi phương án in — đã hủy' END)::text AS nhan_luong,
  yc.ly_do, NULL::text AS checklist_list, yc.tg_gui AS tg,
  (yc.trang_thai <> 'CHO') AS da_xu_ly,
  NULL::uuid AS phan_in_id,
  COALESCE(pin.ds_ma_phan, yc.mo_ta) AS ma_phan,
  pin.ma_phan_dau, pin.so_phan_in,
  ${PA_CU} AS pa_cu_ten, ${PA_MOI} AS pa_moi_ten,
  yc.mo_ta AS duyet_mo_ta,
  NULL::text AS mau_vai, NULL::text AS kich_vai, NULL::text AS kich_phim, NULL::text AS tinh_chat_in,
  NULL::int AS so_luong_don_hang, NULL::text AS ma_hang, NULL::text AS ma_don_hang,
  NULL::text AS ten_khach_hang,
  nd.id AS nguoi_id, nd.ho_ten AS nguoi_ho_ten, nd.ten_dang_nhap AS nguoi_username,
  nd.chuc_vu AS nguoi_chuc_vu, nd.email AS nguoi_email, nd.so_dien_thoai AS nguoi_sdt,
  nd.avatar_url AS nguoi_avatar, pb.ten_phong_ban AS nguoi_phong_ban,
  (dd.user_id IS NOT NULL) AS da_doc,
  yc.trang_thai AS duyet_trang_thai, yc.loai AS duyet_loai,
  yc.gia_tri_cu, yc.gia_tri_moi, yc.nguoi_gui AS duyet_nguoi_gui`;

// `loaiBatDuyet` = mảng mã loại thông báo (DUYET_*) mà người này đang BẬT và ĐƯỢC nhận.
// `userId` dùng cho cả cột `da_doc` lẫn điều kiện "yêu cầu của chính tôi".
async function danhSachDuyet(userId, {
  loaiBatDuyet = [], chuaDoc = false, timKiem = '', tuNgay = '', denNgay = '', maLoai = '',
  limit = 20, offset = 0,
}) {
  if (!loaiBatDuyet.length) return { items: [], total: 0 };
  const coMoi = loaiBatDuyet.includes('DUYET_PA_IN_MOI');
  const coDaDoi = loaiBatDuyet.includes('DUYET_PA_IN_DA_DOI');
  const coKetQua = loaiBatDuyet.includes('DUYET_PA_IN_KET_QUA');

  // Mỗi loại đang bật = 1 nhánh điều kiện; OR lại với nhau.
  // ⚠ Nhánh KẾT QUẢ chỉ lấy yêu cầu ĐÃ CHỐT do CHÍNH người này gửi.
  const nhanh = [];
  if (coMoi) nhanh.push("yc.trang_thai = 'CHO'");
  if (coDaDoi) nhanh.push("yc.trang_thai = 'DUYET'");
  if (coKetQua) nhanh.push("(yc.nguoi_gui = $1 AND yc.trang_thai IN ('DUYET','TU_CHOI'))");
  if (!nhanh.length) return { items: [], total: 0 };

  const dk = [`WHERE (${nhanh.join(' OR ')})`];
  const p = [userId];
  if (chuaDoc) dk.push('AND dd.user_id IS NULL');
  if (timKiem) {
    p.push(mauTim(timKiem));
    // ⚠ Quét CẢ danh sách code phần thật (`pin.ds_ma_phan`), không chỉ câu ngữ cảnh `mo_ta` —
    //   người dùng gõ code phần để tìm là chuyện thường nhất.
    dk.push(`AND (yc.mo_ta ~* $${p.length} OR yc.ly_do ~* $${p.length} OR nd.ho_ten ~* $${p.length}
      OR pin.ds_ma_phan ~* $${p.length})`);
  }
  if (tuNgay) { p.push(tuNgay); dk.push(`AND (yc.tg_gui ${VN})::date >= $${p.length}::date`); }
  if (denNgay) { p.push(denNgay); dk.push(`AND (yc.tg_gui ${VN})::date <= $${p.length}::date`); }
  if (maLoai) {
    if (maLoai === 'DUYET_PA_IN_MOI') dk.push("AND yc.trang_thai = 'CHO'");
    else if (maLoai === 'DUYET_PA_IN_DA_DOI') dk.push("AND yc.trang_thai = 'DUYET'");
    else if (maLoai === 'DUYET_PA_IN_KET_QUA') { p.push(userId); dk.push(`AND yc.nguoi_gui = $${p.length}`); }
    else return { items: [], total: 0 }; // chip của nguồn KHÁC ⇒ nguồn này không góp dòng nào
  }

  const than = `${FROM_DUYET} ${dk.join(' ')}`;
  try {
    const dem = await query(`SELECT count(*)::int AS n ${than}`.replace(/\s+/g, ' '), p);
    const ds = await query(
      `SELECT ${COT_DUYET} ${than} ORDER BY yc.tg_gui DESC LIMIT ${Number(limit) || 20} OFFSET ${Number(offset) || 0}`
        .replace(/\s+/g, ' '), p
    );
    return { items: ds.rows, total: dem.rows[0] ? dem.rows[0].n : 0 };
  } catch (e) {
    // ⚠ FAIL-OPEN: chưa chạy mig 086 ⇒ nguồn này góp 0 dòng, chuông/trang vẫn chạy với nguồn cũ.
    return { items: [], total: 0 };
  }
}

// Số chưa đọc của nguồn DUYỆT (query nhẹ riêng — cùng lý do với `demChuaDoc`).
async function demChuaDocDuyet(userId, loaiBatDuyet = []) {
  if (!loaiBatDuyet.length) return 0;
  const r = await danhSachDuyet(userId, { loaiBatDuyet, chuaDoc: true, limit: 1, offset: 0 });
  return r.total;
}

// Số chưa đọc — query RIÊNG, nhẹ (chuông gọi rất thường, đừng kéo cả danh sách về rồi đếm).
async function demChuaDoc(userId, loaiBat) {
  if (!loaiBat || !loaiBat.length) return 0;
  try {
    const { rows } = await query(
      `SELECT count(*)::int AS n ${FROM} ${WHERE} AND dd.user_id IS NULL`.replace(/\s+/g, ' '),
      [userId, loaiBat]
    );
    return rows[0] ? rows[0].n : 0;
  } catch (e) {
    return 0; // thiếu mig 085 → chuông hiện 0 và tự ẩn, KHÔNG 500 (xem chú thích ở `danhSach`)
  }
}

// 1 thông báo (dùng cho push + kiểm tra tồn tại).
async function motCai(userId, id) {
  const { rows } = await query(
    `SELECT ${COT} ${FROM} WHERE q.id = $3`.replace(/\s+/g, ' '),
    [userId, Object.values(LOAI_TB).map((v) => v.loaiTraVe), id]
  );
  return rows[0] || null;
}

// Đánh dấu đã đọc. `ids` rỗng = ĐỌC HẾT (mọi thông báo đang bật của người này).
// ⚠ `ON CONFLICT DO NOTHING` giữ nguyên `tg_doc` lần đầu — đọc lại không làm mới mốc.
async function danhDauDoc(userId, ids, loaiBat) {
  if (Array.isArray(ids) && ids.length) {
    const { rowCount } = await query(
      `INSERT INTO thong_bao_da_doc (user_id, nguon, nguon_id)
       SELECT $1, '${NGUON}', x FROM unnest($2::uuid[]) x
       ON CONFLICT (user_id, nguon, nguon_id) DO NOTHING`.replace(/\s+/g, ' '),
      [userId, ids]
    );
    return rowCount;
  }
  if (!loaiBat || !loaiBat.length) return 0;
  const { rowCount } = await query(
    `INSERT INTO thong_bao_da_doc (user_id, nguon, nguon_id)
     SELECT $1, '${NGUON}', q.id FROM qc_tra_ve q
      WHERE q.phan_in_id IS NOT NULL AND q.loai = ANY($2::text[])
     ON CONFLICT (user_id, nguon, nguon_id) DO NOTHING`.replace(/\s+/g, ' '),
    [userId, loaiBat]
  );
  return rowCount;
}

// Đánh dấu đã đọc cho nguồn DUYỆT.
// ⚠⚠ PHẢI CÓ HÀM RIÊNG: `danhDauDoc` ghi cứng `nguon = 'QC_TRA_VE'`, đưa id của yêu cầu duyệt vào
//   đó sẽ lưu sai nguồn ⇒ dòng đó KHÔNG BAO GIỜ khớp lúc đọc và mãi mãi "chưa đọc".
// ⚠ `EXISTS` để chỉ ghi id có thật ở bảng này — client gửi lẫn id của 2 nguồn là chuyện bình thường
//   (bấm "đánh dấu đã đọc hết" trên danh sách đã gộp).
async function danhDauDocDuyet(userId, ids, loaiBatDuyet) {
  try {
    if (Array.isArray(ids) && ids.length) {
      const { rowCount } = await query(
        `INSERT INTO thong_bao_da_doc (user_id, nguon, nguon_id)
         SELECT $1, '${NGUON_DUYET}', x FROM unnest($2::uuid[]) x
          WHERE EXISTS (SELECT 1 FROM yeu_cau_duyet y WHERE y.id = x)
         ON CONFLICT (user_id, nguon, nguon_id) DO NOTHING`.replace(/\s+/g, ' '),
        [userId, ids]
      );
      return rowCount;
    }
    if (!loaiBatDuyet || !loaiBatDuyet.length) return 0;
    // "Đọc hết": chỉ những dòng người này THẬT SỰ nhìn thấy (cùng 3 nhánh với `danhSachDuyet`).
    const nhanh = [];
    if (loaiBatDuyet.includes('DUYET_PA_IN_MOI')) nhanh.push("y.trang_thai = 'CHO'");
    if (loaiBatDuyet.includes('DUYET_PA_IN_DA_DOI')) nhanh.push("y.trang_thai = 'DUYET'");
    if (loaiBatDuyet.includes('DUYET_PA_IN_KET_QUA')) nhanh.push("(y.nguoi_gui = $1 AND y.trang_thai IN ('DUYET','TU_CHOI'))");
    if (!nhanh.length) return 0;
    const { rowCount } = await query(
      `INSERT INTO thong_bao_da_doc (user_id, nguon, nguon_id)
       SELECT $1, '${NGUON_DUYET}', y.id FROM yeu_cau_duyet y WHERE (${nhanh.join(' OR ')})
       ON CONFLICT (user_id, nguon, nguon_id) DO NOTHING`.replace(/\s+/g, ' '),
      [userId]
    );
    return rowCount;
  } catch (e) { return 0; } // chưa chạy mig 086 ⇒ bỏ qua, không chặn việc đọc nguồn cũ
}

// ─── CẤU HÌNH ────────────────────────────────────────────────────────────────
async function layCaiDatHeThongRaw() {
  const { rows } = await query(
    'SELECT c.ma_loai, c.bat, c.ghi_chu, c.updated_date, nd.ho_ten AS nguoi_sua'
    + ' FROM cai_dat_thong_bao c LEFT JOIN nguoi_dung nd ON nd.id = c.updated_by'
  );
  return rows;
}

async function luuCaiDatHeThong(ma, bat, ghiChu, actorId) {
  await query(
    `INSERT INTO cai_dat_thong_bao (ma_loai, bat, ghi_chu, updated_date, updated_by)
     VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (ma_loai) DO UPDATE SET bat = EXCLUDED.bat, ghi_chu = EXCLUDED.ghi_chu,
       updated_date = now(), updated_by = EXCLUDED.updated_by`.replace(/\s+/g, ' '),
    [ma, !!bat, ghiChu || null, actorId || null]
  );
}

// Cấu hình của 1 người — trả map { ma_loai: bat }. Thiếu khóa = BẬT (bên gọi tự hiểu).
async function layCaiDatNguoi(userId) {
  try {
    const { rows } = await query('SELECT ma_loai, bat FROM thong_bao_nguoi_dung WHERE user_id = $1', [userId]);
    return Object.fromEntries(rows.map((r) => [r.ma_loai, r.bat]));
  } catch (e) { return {}; }
}

async function luuCaiDatNguoi(userId, ma, bat) {
  await query(
    `INSERT INTO thong_bao_nguoi_dung (user_id, ma_loai, bat, updated_date)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (user_id, ma_loai) DO UPDATE SET bat = EXCLUDED.bat, updated_date = now()`
      .replace(/\s+/g, ' '),
    [userId, ma, !!bat]
  );
}

// ─── ĐĂNG KÝ WEB PUSH ────────────────────────────────────────────────────────
// ⚠ Khóa duy nhất là `endpoint` (1 người nhiều thiết bị). Cùng thiết bị đăng nhập tài khoản khác
//   ⇒ endpoint cũ được CHUYỂN sang user mới, không đẻ dòng rác.
async function luuPush(userId, { endpoint, p256dh, auth, userAgent }) {
  await query(
    `INSERT INTO push_dang_ky (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`.replace(/\s+/g, ' '),
    [userId, endpoint, p256dh, auth, userAgent || null]
  );
}

async function xoaPush(endpoint) {
  await query('DELETE FROM push_dang_ky WHERE endpoint = $1', [endpoint]);
}

async function dsPushTheoUser(userIds) {
  if (!userIds || !userIds.length) return [];
  const { rows } = await query(
    'SELECT id, user_id, endpoint, p256dh, auth FROM push_dang_ky WHERE user_id = ANY($1::uuid[])',
    [userIds]
  );
  return rows;
}

async function danhDauPushDaDung(endpoints) {
  if (!endpoints || !endpoints.length) return;
  try {
    await query('UPDATE push_dang_ky SET tg_dung_cuoi = now() WHERE endpoint = ANY($1::text[])', [endpoints]);
  } catch (e) { /* chỉ là dấu vết, hỏng không ảnh hưởng gửi push */ }
}

module.exports = {
  NGUON, NGUON_DUYET, danhSach, danhSachDuyet, demChuaDoc, demChuaDocDuyet, demTheoLoai, motCai,
  danhDauDoc, danhDauDocDuyet,
  layCaiDatHeThongRaw, luuCaiDatHeThong, layCaiDatNguoi, luuCaiDatNguoi,
  luuPush, xoaPush, dsPushTheoUser, danhDauPushDaDung,
};
