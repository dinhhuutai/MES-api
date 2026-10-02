'use strict';

// SĨ SỐ CHECKPOINT — đếm 4 ô + liệt kê chi tiết. Luật ở `utils/siSoTram.js`.
// ⚠ SQL gửi GỘP 1 DÒNG (IPS) ⇒ không viết comment `-- …` bên trong chuỗi SQL.

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { MAN, LOAI_NGAY, O_SI_SO, VN, DV, OPEN_PIN_SQL } = require('../../utils/siSoTram');
const { DO_SL } = require('../../utils/bangTheoDoi');
const { slaReadySql, slaQcReadySql, slaTestRunSql, mocDoReadySql, hanBat, gioSxKhSql } = require('../../utils/slaTheoGio');
const {
  hanGiaoReadySql, mocDotMucSql, qcMoLaiSql, khongReadyTuDongSql, KHUON_OPT_SQL_LIST,
} = require('../../utils/tech');
const { CHO_GN_SQL } = require('../../utils/traVeGn');
const { CHO_KY_THUAT_SQL } = require('../planning/planning.repository');

// ⚠⚠ MỐC KỲ ĐẶT TRONG CTE `ky`, KHÔNG nội suy `$1`/`$2` thẳng vào từng điều kiện.
//   Lý do (lỗi thật đã bắt): ô `ton_dau` chỉ dùng $1, ô `ton_cuoi` chỉ dùng $2 ⇒ tham số còn lại
//   KHÔNG xuất hiện trong SQL và Postgres ném `could not determine data type of parameter $N`.
//   Đưa vào CTE thì cả 2 tham số LUÔN được dùng, mọi ô chạy chung một câu.
const CTE_KY = `ky AS (SELECT (($1::date)::timestamp ${VN}) AS tu, (($2::date)::timestamp ${VN}) AS den)`;
const dkO = (o) => O_SI_SO[o].dk.replace(/\$1/g, '(SELECT tu FROM ky)').replace(/\$2/g, '(SELECT den FROM ky)');

// Điều kiện nền: bỏ mục chưa từng vào trạm, và bỏ dữ liệu bẩn `tg_ra < tg_vao` (nếu lọt thì bất
// biến Tồn đầu + Nhận − Làm được = Tồn cuối sẽ vỡ).
const NEN = 'q.tg_vao IS NOT NULL AND (q.tg_ra IS NULL OR q.tg_ra >= q.tg_vao)';

// ⚠⚠ CTE nguồn `q` PHẢI `MATERIALIZED` (01/10/2026, EXPLAIN ANALYZE prod): `tg_vao`/`tg_ra` của nguồn
//   là biểu thức có SUBQUERY (vd hàng đợi QC `conDotChoQcSql`), mà điều kiện các ô (`dkO` tồn đầu ·
//   nhận · làm được · tồn cuối · nghẽn) nhắc tới `q.tg_vao`/`q.tg_ra` hàng chục lần. Để Postgres NHÚNG
//   CTE thì MỖI lần nhắc là tính lại subquery (thấy rõ cùng 1 nút `loops=5048` lặp 5 lần) ⇒ READY QA
//   3,7 s. Ép vật chất hóa = mỗi dòng tính 1 lần, kết quả Y HỆT (đã so mọi màn × mọi đơn vị trước/sau).
const cteQ = (sql) => `q AS MATERIALIZED (${sql})`;

// Bộ lọc chữ + lọc ngày phụ.
// ⚠ `bat` = số thứ tự tham số KẾ TIẾP. Kỳ chiếm $1,$2 ⇒ lọc bắt đầu từ **$3** (đặt nhầm thành 4 là
//   lệch chỉ số toàn bộ, Postgres báo "could not determine data type of parameter $3" — đã mắc).
function dungLoc(loc = {}, bat = 3) {
  const dk = [];
  const params = [];
  const them = (val, col) => {
    if (!val) return;
    params.push(mauTim(val));
    dk.push(`${col} ~* $${bat + params.length - 1}`);
  };
  them(loc.timKiem, `concat_ws(' ', q.ten_khach_hang, q.ma_don_hang, q.ma_hang, q.ma_phan, q.mau_vai,
    q.ma_lenh_san_xuat, q.ma_tem, q.ma_dot_vai)`);
  them(loc.khach, 'q.ten_khach_hang');
  them(loc.don, 'q.ma_don_hang');
  them(loc.maHang, 'q.ma_hang');
  them(loc.codePhan, 'q.ma_phan');
  them(loc.mauVai, 'q.mau_vai');
  them(loc.kichVai, 'q.kich_vai');
  them(loc.kichPhim, 'q.kich_phim');
  them(loc.chuyen, 'q.ten_chuyen');
  them(loc.nhaGiaCong, 'q.nha_gia_cong');

  // ─── Dải CHIP của trang (dải "Theo dõi" bám bộ lọc trang) ───────────────────
  // ⚠⚠ KHỚP NGUYÊN TOKEN, KHÔNG dùng `~*` như các ô chữ: `ma_chuyen`/`ma_loai_chuyen` đã được
  //   `string_agg` thành chuỗi "M4A-4B,M10A" (1 phần in có thể trải nhiều lệnh/chuyền) ⇒ so kiểu
  //   "chứa" sẽ khớp nhầm — chip `M1` sẽ ăn cả `M10A`, `M14B`; chip loại `EP` ăn cả `GIA_CONG`
  //   không phải vì trùng chuỗi mà vì cùng lý do lỏng lẻo đó. Cắt chuỗi ra mảng rồi so BẰNG.
  const themToken = (val, col) => {
    const ds = String(val || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ds.length) return;
    params.push(ds);
    dk.push(`EXISTS (SELECT 1 FROM unnest(string_to_array(${col}, ',')) tk(v)
      WHERE btrim(tk.v) = ANY($${bat + params.length - 1}::text[]))`);
  };
  themToken(loc.loaiChuyen, 'q.ma_loai_chuyen'); // chip loại chuyền: MAY · BAN · ROBOT · EP …
  themToken(loc.maChuyen, 'q.ma_chuyen');        // chip khu bàn: FE gửi danh sách mã chuyền của khu

  // ─── Ô TÍCH của trang (dải "Theo dõi" bám luôn ô tích — 18/08/2026) ────────
  // ⚠ 3 khóa dưới đây là BOOLEAN/CHUỖI gửi từ FE, chỉ áp khi trang thật sự bật ô tích đó. Trang
  //   không gửi ⇒ không sinh điều kiện nào, câu SQL y như cũ.
  // ⚠⚠ Ô tích "Chỉ hiện … bị trả về" ở 3 màn nhưng ĐỊNH NGHĨA KHÁC NHAU — đã xử ở tầng nguồn
  //   (`utils/siSoTram.js` hằng `TV`), ở đây chỉ việc so cột `bi_tra_ve`.
  if (loc.biTraVe === '1' || loc.biTraVe === true || loc.biTraVe === 'true') {
    dk.push('q.bi_tra_ve = true');
  }
  // "Đã Ready" / "Chờ Ready" (màn Release 1). Tick CẢ HAI = không lọc (giống hành vi trên màn).
  const daReady = loc.daReady === '1' || loc.daReady === true || loc.daReady === 'true';
  const choReady = loc.choReady === '1' || loc.choReady === true || loc.choReady === 'true';
  if (daReady && !choReady) dk.push('q.qc_done = true');
  if (choReady && !daReady) dk.push('q.qc_done = false');

  them(loc.gomSet, 'q.ma_set'); // ô lọc "Gom set" (màn Kế hoạch tạm)

  // ⚠ ĐÃ GỠ điều kiện `choQa` (20/08/2026) cùng ô tích "Chỉ chờ QA" ở màn Test Run - QA — nó làm
  //   "Làm được trong kỳ" luôn ra 0. Xem ghi chú ở `utils/siSoTram.js` (chỗ `LAT_CHO_QA` cũ).

  // Chip PHƯƠNG ÁN IN (màn Release 1) — số nguyên 0..3, so BẰNG chứ không regex.
  // ⚠ `0` = CHƯA XÁC ĐỊNH là giá trị THẬT ERP gửi ⇒ phải so `!== ''`, đừng dùng `if (val)`
  //   (`'0'` truthy nhưng số 0 thì không — dễ mắc nếu FE gửi kiểu số).
  if (loc.phuongAnIn !== undefined && loc.phuongAnIn !== null && loc.phuongAnIn !== '') {
    params.push(Number(loc.phuongAnIn));
    dk.push(`COALESCE(q.phuong_an_in, 0) = $${bat + params.length - 1}::int`);
  }

  const ln = LOAI_NGAY[loc.loaiNgay];
  if (ln && (loc.ngayTu || loc.ngayDen)) {
    const cot = ln.kieu === 'ts' ? `((${ln.col}) ${VN})::date` : `(${ln.col})::date`;
    if (loc.ngayTu) { params.push(loc.ngayTu); dk.push(`${cot} >= $${bat + params.length - 1}::date`); }
    if (loc.ngayDen) { params.push(loc.ngayDen); dk.push(`${cot} <= $${bat + params.length - 1}::date`); }
  }
  return { dk: dk.length ? ` AND ${dk.join(' AND ')}` : '', params };
}

// ─── HAI TẦNG LỌC: bộ lọc CỦA TRANG + bộ lọc trong MODAL ─────────────────────
// ⚠⚠ CỐ Ý TÁCH 2 TẦNG THAY VÌ TRỘN 1 OBJECT: cả 2 tầng đều có khóa `khach`, `codePhan`… Trộn lại
//   thì tầng này ĐÈ MẤT tầng kia — trang đang lọc khách A, mở modal gõ khách B là mất luôn ràng
//   buộc A và 4 con số không còn khớp bảng bên dưới. Hai tầng nối bằng AND nên vẫn là 1 câu SQL.
// ⚠ Tầng trang chiếm dải tham số NGAY SAU tầng modal — `bat` phải cộng dồn, đặt sai là Postgres
//   ném "could not determine data type of parameter $N" (bẫy đã ghi ngay trên).
function dungLocKep(loc = {}, locTrang = {}) {
  const a = dungLoc(loc, 3);
  const b = dungLoc(locTrang, 3 + a.params.length);
  return { dk: a.dk + b.dk, params: [...a.params, ...b.params] };
}

function nguon(maTrang) {
  const m = MAN[maTrang];
  if (!m) throw Object.assign(new Error(`Màn "${maTrang}" chưa khai trong siSoTram`), { code: 'MAN_LA' });
  return m;
}

// Chọn ĐƠN VỊ ĐẾM (phần in · đợt vải · lệnh SX · tem) — nút toggle trên dải "Theo dõi".
// ⚠ Đơn vị lạ / màn không hỗ trợ ⇒ LÙI VỀ MẶC ĐỊNH của màn, KHÔNG ném lỗi: đây là số liệu phụ,
//   và người dùng có thể còn giữ lựa chọn cũ trong localStorage sau khi ta đổi danh mục đơn vị.
// ⚠ Mọi đơn vị trả CÙNG bộ cột (`COT_DS`) nên phần còn lại của repository không cần biết gì thêm.
function chonDonVi(m, donVi) {
  const ma = m.donVis[donVi] ? donVi : m.macDinh;
  const d = m.donVis[ma];
  return { ma, nhan: d.nhan, sql: d.sql, do: d.do || null, donViSo: d.donViSo || null };
}

// 4 ô trong 1 LƯỢT QUERY — mạng tới DB là nút cổ chai (~25ms/lượt, DATABASE.md §7) nên đừng bắn 4 lần.
// ⚠⚠ ĐƠN VỊ SỐ LƯỢNG (`sl_vai` · `sl_dh`, thêm 04/09/2026): 4 ô **CỘNG một cột** thay vì đếm dòng.
//   Bất biến `Tồn đầu + Nhận − Làm được = Tồn cuối` VẪN ĐÚNG vì mỗi đối tượng góp CÙNG một con số
//   vào mọi ô mà nó thuộc về — y hệt lúc mỗi đối tượng góp 1 đơn vị.
//   `COALESCE(sum(...), 0)`: `sum` trên tập rỗng trả NULL, để nguyên là FE hiện ô trống thay vì 0.
async function demSiSo(maTrang, { tu, den, loc, locTrang, donVi }) {
  const m = nguon(maTrang);
  const dv = chonDonVi(m, donVi);
  const { dk, params } = dungLocKep(loc, locTrang);
  const dem = Object.keys(O_SI_SO).map((k) => (dv.do
    ? `COALESCE(sum(${dv.do}) FILTER (WHERE ${dkO(k)}), 0)::int AS ${k}`
    : `count(*) FILTER (WHERE ${dkO(k)})::int AS ${k}`)).join(', ');
  const sql = `WITH ${CTE_KY}, ${cteQ(dv.sql)} SELECT ${dem} FROM q WHERE ${NEN}${dk}`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tu, den, ...params]);
  const r = rows[0] || {};
  return {
    ton_dau: Number(r.ton_dau) || 0,
    nhan: Number(r.nhan) || 0,
    lam_duoc: Number(r.lam_duoc) || 0,
    ton_cuoi: Number(r.ton_cuoi) || 0,
  };
}

const COT_DS = `q.id, q.ten_khach_hang, q.ma_don_hang, q.ma_hang, q.ma_phan, q.mau_vai, q.kich_vai,
  q.kich_phim, q.tinh_chat_in, q.ten_loai_dot_vai, q.phuong_an_in, q.nha_gia_cong, q.ma_dot_vai,
  q.so_luong_don_hang, q.so_luong_vai_ve, q.han_giao_hang, q.ngay_vai_ve, q.tg_len_mes,
  q.ma_lenh_san_xuat, q.ten_chuyen, q.ngay_ke_hoach, q.ngay_release, q.ma_tem, q.so_phan_in,
  q.tg_vao, q.tg_ra,
  q.ma_chuyen, q.ma_loai_chuyen, q.qc_done, q.bi_tra_ve, q.ma_set`;

// Danh sách chi tiết của MỘT ô. `limit = 0` ⇒ lấy HẾT (dùng cho xuất Excel).
async function chiTiet(maTrang, o, { tu, den, loc, locTrang, donVi, page = 1, limit = 20 }) {
  const m = nguon(maTrang);
  if (!O_SI_SO[o]) throw Object.assign(new Error(`Ô "${o}" không hợp lệ`), { code: 'O_LA' });
  const dv = chonDonVi(m, donVi);
  const { dk, params } = dungLocKep(loc, locTrang);
  const p = [tu, den, ...params];
  const than = `FROM q WHERE ${NEN} AND (${dkO(o)})${dk}`;
  const dau = `WITH ${CTE_KY}, ${cteQ(dv.sql)}`;

  const dem = await query(`${dau} SELECT count(*)::int AS n ${than}`.replace(/\s+/g, ' '), p);
  const total = dem.rows[0] ? dem.rows[0].n : 0;

  const phanTrang = limit > 0
    ? ` LIMIT ${limit} OFFSET ${(Math.max(1, Number(page) || 1) - 1) * limit}`
    : '';
  const ds = await query(
    `${dau} SELECT ${COT_DS} ${than} ORDER BY q.tg_vao DESC NULLS LAST, q.ma_phan${phanTrang}`
      .replace(/\s+/g, ' '),
    p
  );
  return { items: ds.rows, total };
}

// ─── TÓM TẮT MỘT Ô THEO **NGÀY GIAO** (04/09/2026) ───────────────────────────
// Hover vào ô (mặc định: Tồn cuối) ⇒ hiện "ngày giao nào còn bao nhiêu"; bấm 1 dòng ⇒ mở danh sách
// chi tiết đã lọc sẵn theo đúng ngày giao đó (FE truyền `ngayTu`/`ngayDen` = ngày đó, `loaiNgay=HAN_GIAO`).
// ⚠ CÙNG `q` + CÙNG bộ lọc + CÙNG điều kiện ô với `demSiSo` ⇒ Σ các dòng LUÔN bằng đúng con số trên ô
//   (không có chuyện 2 số đá nhau). Chỉ khác: thêm `GROUP BY ngày giao`.
// ⚠ Trả CẢ `so_doi_tuong` (đếm dòng) LẪN 2 cột số lượng ⇒ FE hiện được cả 3 mà không phải gọi lại
//   khi người dùng đổi đơn vị đo. Dòng KHÔNG có hạn giao gom vào `han_giao_hang = NULL`, đứng cuối.
async function tomTatTheoNgayGiao(maTrang, o, { tu, den, loc, locTrang, donVi }) {
  const m = nguon(maTrang);
  if (!O_SI_SO[o]) throw Object.assign(new Error(`Ô "${o}" không hợp lệ`), { code: 'O_LA' });
  const dv = chonDonVi(m, donVi);
  const { dk, params } = dungLocKep(loc, locTrang);
  const sql = `WITH ${CTE_KY}, ${cteQ(dv.sql)}
    SELECT (q.han_giao_hang)::date AS han_giao_hang,
           count(*)::int AS so_doi_tuong,
           COALESCE(sum(COALESCE(q.so_luong_vai_ve,0)),0)::int AS sl_vai,
           COALESCE(sum(COALESCE(q.so_luong_don_hang,0)),0)::int AS sl_dh
      FROM q WHERE ${NEN} AND (${dkO(o)})${dk}
     GROUP BY (q.han_giao_hang)::date
     ORDER BY (q.han_giao_hang)::date NULLS LAST`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tu, den, ...params]);
  return rows;
}

// ─── BẢNG THEO DÕI 10 CHECKPOINT (Dashboard → Tổng quan, 20/09/2026) ─────────
// Luật + danh mục dòng + biểu thức SL: `utils/bangTheoDoi.js`.

// SLA của workflow HIỆN HÀNH (trạm + checklist) — 1 lượt query cho cả bảng.
// ⚠ Gương y hệt `thoigiantram.repository.dsSla()`: 2 trang phải nói CÙNG một con số "nghẽn".
async function dsSlaHienHanh() {
  const { rows } = await query(
    `SELECT 'TRAM' AS cap, t.ma_tram AS ma, t.thoi_gian_quy_dinh_phut AS sla
       FROM tram t JOIN workflow_version v ON v.id = t.workflow_version_id AND v.la_hien_hanh
     UNION ALL
     SELECT 'CHECKPOINT', cp.ma_checkpoint, cp.thoi_gian_quy_dinh_phut
       FROM checkpoint cp JOIN tram t ON t.id = cp.tram_id
       JOIN workflow_version v ON v.id = t.workflow_version_id AND v.la_hien_hanh
      WHERE cp.dang_hoat_dong`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Một dòng của bảng: 5 cụm × (Phần + SL) trong MỘT lượt query.
// ⚠⚠ NGHẼN (từ 01/10/2026) = phần in quá SLA trong kỳ — gồm "chưa xác nhận" (đang TỒN CUỐI) và
//   "đã xác nhận" (rời trạm trong kỳ sau khi đã quá SLA). Mốc đo là `LEAST(cuối kỳ, bây giờ)`: xem ngày quá
//   khứ thì tính tới cuối ngày đó, xem hôm nay thì tính tới bây giờ — KHÔNG lấy `now()` trần, nếu
//   không mọi thứ tồn từ tháng trước đều "nghẽn" khi soi lại một ngày cũ.
// ⚠ SLA null (trạm chưa cấu hình) ⇒ nghẽn = 0, KHÔNG đoán bừa một ngưỡng.
//
// ⚠⚠⚠ NGHẼN ĐO TRÊN TỪNG ĐƠN VỊ CON, KHÔNG trên dòng phần in (02/10/2026 — người dùng: "hệ thống theo ĐỢT VẢI,
//   đừng lấy đợt vải nghẽn của lần trước cho lần này, mặc dù báo cáo theo phần in"; ca thật: READY QA báo
//   nghẽn trong khi màn QC không đỏ dòng nào).
//   Lý do: `gomTheo` gộp MỌI đợt/lệnh/tem của phần in thành MỘT khoảng với `tg_vao = min(...)` ⇒ đơn vị ĐÃ
//   XONG từ chu kỳ trước kéo mốc vào lùi về quá khứ ⇒ đơn vị MỚI vừa tới đã "nghẽn". 4 ô Tồn đầu/Nhận/Xong/
//   Tồn cuối GIỮ NGUYÊN engine sĩ số; riêng Nghẽn đo trên đúng đơn vị mà màn của trạm tô đỏ:
//     READY KT · READY QA · RELEASE 1 → ĐỢT VẢI · TEST RUN · RELEASE 2 · IN → (LỆNH × đợt) · KIỂM · SỬA · OQC · GIAO → (TEM × đợt)
//   mỗi đơn vị một mốc vào + một MỐC BẮT ĐẦU NGHẼN `bd` (= vào + SLA, luật SLA THEO GIỜ của `utils/slaTheoGio.js`
//   ưu tiên khi đang BẬT — cấu hình mig 109). Phần in NGHẼN ⟺ có ≥1 đơn vị con nghẽn.
// Mỗi nguồn con trả `phan_in_id, tg_vao, tg_ra, bd, chan`: `bd` NULL ⇒ không thuộc diện đo nghẽn;
//   `chan` = đơn vị đang KHÔNG được tính "chưa xác nhận" lúc này (màn của trạm cũng không đỏ/không hiện nó —
//   vd phần in đang chờ GN sửa thông tin, lệnh đang chờ kỹ thuật làm lại).
// ⚠ Dùng CHUNG cho bảng đếm (`motDongBang`) và danh sách chi tiết (`dsDongBang`) ⇒ modal liệt kê ĐÚNG
//   những phần in mà ô "Nghẽn" đang đếm.
const MOC_DO = 'LEAST((SELECT den FROM ky), now())';
const phut = (bieuThuc) => `((${bieuThuc}) * interval '1 minute')`;

// READY theo ĐỢT VẢI — 1 dòng / đợt đã lên READY: mốc KT xong / QC xong của CHÍNH đợt (`tech.mocDotMucSql`,
// cùng 2 nhánh "đợt đã xác nhận" của màn READY) + mốc rời READY vì đã release.
// ⚠ `moc_rel` KHÔNG tính lệnh RELEASE_1 chưa phiếu: đó là ca "Test Run không đạt → trả về KT" (lệnh được GIỮ,
//   QC bị hủy) — đợt vẫn đang ở READY làm lại (nhánh OR 3 của `technical.listCandidates`).
// ⚠ Lọc trước đợt ĐÃ RỜI READY TRƯỚC KỲ (release chắc chắn trước `tu`) ⇒ chỉ tính mốc cho số đợt liên quan
//   (prod phần lớn đợt đã release từ lâu).
// ⚠ Loại phần in do HỆ THỐNG tự xác nhận READY (ERP `KTCankiemtra=0`) — y như `siSoTram DV.READY_*`.
const REL_CHAC = (dot) => `(SELECT min(zrl.created_date) FROM lenh_sx_dot_vai zrd JOIN lenh_san_xuat zrl ON zrl.id = zrd.lenh_san_xuat_id
   WHERE zrd.dot_vai_ve_id = ${dot}.id AND zrl.trang_thai <> 'HUY'
     AND (zrl.trang_thai <> 'RELEASE_1' OR EXISTS (SELECT 1 FROM phieu_san_xuat zrp WHERE zrp.lenh_san_xuat_id = zrl.id)))`;
const READY_DOT = `SELECT d.phan_in_id, d.tg_chuyen_ready AS vao_ready, d.han_giao_hang AS han_dot,
    CASE WHEN kh.ten_khach_hang IN (${KHUON_OPT_SQL_LIST}) THEN m.muc
         WHEN m.khuon IS NOT NULL AND m.muc IS NOT NULL THEN GREATEST(m.khuon, m.muc) END AS kt_xong,
    m.qc AS qc_xong, ${REL_CHAC('d')} AS moc_rel, ${CHO_GN_SQL('pin.id')} AS chan
  FROM dot_vai_ve d
  JOIN phan_in pin ON pin.id = d.phan_in_id AND pin.dang_hoat_dong
  JOIN ma_hang mh ON mh.id = pin.ma_hang_id JOIN don_hang dh ON dh.id = mh.don_hang_id
  JOIN khach_hang kh ON kh.id = dh.khach_hang_id
  CROSS JOIN LATERAL (SELECT ${mocDotMucSql('d', 'd.phan_in_id', 'KHUON')} AS khuon,
    ${mocDotMucSql('d', 'd.phan_in_id', 'MUC')} AS muc, ${mocDotMucSql('d', 'd.phan_in_id', 'QC_XAC_NHAN')} AS qc) m
  WHERE d.trang_thai NOT IN ('DA_GOP','DA_HUY') AND d.tg_chuyen_ready IS NOT NULL
    AND d.tg_chuyen_ready < (SELECT den FROM ky)
    AND NOT EXISTS (SELECT 1 FROM lenh_sx_dot_vai zrd0 JOIN lenh_san_xuat zrl0 ON zrl0.id = zrd0.lenh_san_xuat_id
       WHERE zrd0.dot_vai_ve_id = d.id AND zrl0.trang_thai <> 'HUY' AND zrl0.created_date < (SELECT tu FROM ky)
         AND (zrl0.trang_thai <> 'RELEASE_1' OR EXISTS (SELECT 1 FROM phieu_san_xuat zrp0 WHERE zrp0.lenh_san_xuat_id = zrl0.id)))
    AND ${khongReadyTuDongSql('pin.id')}`;

// READY KT — gương màn READY (Kỹ thuật): vào = đợt lên READY; rời = KT đủ mục / QC / release. SLA theo HẠN GIAO
// của chính đợt (thiếu ⇒ hạn mức phần in `tech.hanGiaoReadySql`, y như `han[0] || r.han_giao_hang` của service),
// thiếu hạn / luật hạn tắt ⇒ theo giờ lên MES (`slaReadySql`, fallback SLA trạm READY).
function nghenReadyKt(s) {
  const vao = 'r.vao_ready';
  const theoGio = `(${vao} + ${phut(slaReadySql(vao, s))})`;
  const bd = hanBat()
    ? `(CASE WHEN r.han IS NULL THEN ${theoGio} ELSE GREATEST(${vao} + interval '1 minute', ${mocDoReadySql('r.han')}) END)`
    : theoGio;
  return `SELECT r.phan_in_id, r.vao_ready AS tg_vao,
      CASE WHEN r.ra0 IS NULL THEN NULL ELSE GREATEST(r.vao_ready, r.ra0) END AS tg_ra, ${bd} AS bd, r.chan, NULL::text AS ly_do
    FROM (SELECT x.*, LEAST(x.kt_xong, x.qc_xong, x.moc_rel) AS ra0,
            COALESCE(x.han_dot, ${hanGiaoReadySql('x.phan_in_id')}) AS han
          FROM (${READY_DOT}) x OFFSET 0) r`;
}

// READY QA — gương màn QC READY: chỉ đợt KT ĐÃ xong; vào = GREATEST(KT xong của đợt, mốc QC mở lại
// `tech.qcMoLaiSql` — phần in bị trả về READY được tính lại SLA); rời = QC của đợt / release.
// SLA `slaQcReadySql` (KT xong 16:30–24:00 ⇒ 16 giờ…), ngoài khung ⇒ SLA checklist QC_XAC_NHAN.
// ⚠ Mốc mở lại chỉ áp khi nó NẰM TRƯỚC lúc đợt rời hàng đợi (đợt cũ đã QC xong không bị kéo theo).
function nghenReadyQa(s) {
  return `SELECT r.phan_in_id, r.vao AS tg_vao,
      CASE WHEN r.ra0 IS NULL THEN NULL ELSE GREATEST(r.vao, r.ra0) END AS tg_ra,
      (r.vao + ${phut(slaQcReadySql('r.vao', s))}) AS bd, r.chan, NULL::text AS ly_do
    FROM (SELECT y.*, GREATEST(y.kt_xong, CASE WHEN y.mo_lai IS NOT NULL AND (y.ra0 IS NULL OR y.mo_lai <= y.ra0)
                                              THEN y.mo_lai END) AS vao
          FROM (SELECT x.*, LEAST(x.qc_xong, x.moc_rel) AS ra0, ${qcMoLaiSql('x.phan_in_id')} AS mo_lai
                FROM (${READY_DOT}) x WHERE x.kt_xong IS NOT NULL OFFSET 0) y
          WHERE y.ra0 IS NULL OR y.kt_xong <= y.ra0 OFFSET 0) r`;
}

// Nguồn con lấy THẲNG từ `siSoTram.DV` (đã là 1 dòng / đợt · lệnh×đợt · tem×đợt) ⇒ mốc vào/ra y hệt 4 ô
// sĩ số. Lọc trước đơn vị đã rời TRƯỚC kỳ / chưa vào tới cuối kỳ (không ảnh hưởng nghẽn của kỳ).
const tuDv = (dvSql, bd, chan = 'false') => `SELECT x.phan_in_id, x.tg_vao, x.tg_ra, ${bd} AS bd, ${chan} AS chan, NULL::text AS ly_do
  FROM (SELECT * FROM (${dvSql}) x0 WHERE x0.tg_vao IS NOT NULL AND x0.phan_in_id IS NOT NULL
          AND x0.tg_vao < (SELECT den FROM ky) AND (x0.tg_ra IS NULL OR x0.tg_ra >= (SELECT tu FROM ky)) OFFSET 0) x`;
const LENH_X = 'zl.ma_lenh_san_xuat = x.ma_lenh_san_xuat';

// OPEN (02/10/2026, người dùng chốt) — 2 loại lỗi đầu vào, mỗi lượt là 1 đơn vị con:
//   · READY Kỹ thuật đánh dấu BẤT THƯỜNG (`phan_in_ghi_chu` loai BAT_THUONG): nghẽn NGAY từ lúc đánh dấu (không
//     có SLA để chờ) tới lúc gỡ dấu (xóa mềm ⇒ `updated_date`).
//   · TRẢ VỀ GN (`qc_tra_ve` loai TRA_VE_GN): GN phải "Xác nhận lại" trong SLA trạm OPEN (`s`); quá ⇒ nghẽn tới lúc
//     xác nhận lại (`da_xu_ly` ⇒ `updated_date`, cùng mốc `tech.qcMoLaiSql` dùng).
const NGHEN_OPEN = (s) => `SELECT g.phan_in_id, g.created_date AS tg_vao,
    CASE WHEN g.dang_hoat_dong THEN NULL ELSE GREATEST(g.created_date, g.updated_date) END AS tg_ra,
    g.created_date AS bd, false AS chan, 'Bất thường (READY KT)'::text AS ly_do
  FROM phan_in_ghi_chu g WHERE g.loai = 'BAT_THUONG' AND g.created_date < (SELECT den FROM ky)
  UNION ALL
  SELECT r.phan_in_id, r.created_date, CASE WHEN r.da_xu_ly THEN GREATEST(r.created_date, r.updated_date) END,
    (r.created_date + ${phut(s)}), false, 'GN xác nhận lại quá hạn'::text
  FROM qc_tra_ve r WHERE r.loai = 'TRA_VE_GN' AND r.phan_in_id IS NOT NULL AND r.created_date < (SELECT den FROM ky)`;

// `s` = SLA trạm/checklist (phút, số nguyên do server đọc từ workflow). Khóa = `BANG_THEO_DOI[].ma`.
const NGHEN_CON = {
  OPEN: NGHEN_OPEN,
  READY_KT: nghenReadyKt,
  READY_QA: nghenReadyQa,
  // Release 1 — gương bản đồ nghẽn (`flowRows` trạm RELEASE_1): đồng hồ chạy từ lúc QC xác nhận CHÍNH đợt đó
  //   (đợt chưa QC thì chưa vào Release 1 theo nghĩa nghẽn — đang là việc của READY).
  RELEASE_1: (s) => tuDv(DV.RELEASE_1, `((SELECT ${mocDotMucSql('zr', 'zr.phan_in_id', 'QC_XAC_NHAN')}
      FROM dot_vai_ve zr WHERE zr.ma_dot_vai = x.ma_dot_vai) + ${phut(s)})`),
  // Test Run — theo giờ SX kế hoạch của CHÍNH lệnh (`slaTestRunSql`, luật tắt ⇒ SLA trạm); lệnh đang chờ kỹ
  //   thuật làm lại (`planning.CHO_KY_THUAT_SQL`, QA không test được) không tính "chưa xác nhận".
  TEST_RUN: (s) => tuDv(DV.TEST_RUN,
    `(SELECT x.tg_vao + ${phut(slaTestRunSql('x.tg_vao', gioSxKhSql('zl.tg_bd_kh', 'zl.ngay_ke_hoach'), s))}
      FROM lenh_san_xuat zl WHERE ${LENH_X})`,
    `COALESCE((SELECT zl.trang_thai = 'RELEASE_1' AND NOT EXISTS (SELECT 1 FROM phieu_san_xuat zp WHERE zp.lenh_san_xuat_id = zl.id)
      AND ${CHO_KY_THUAT_SQL('zl.id')} FROM lenh_san_xuat zl WHERE ${LENH_X}), false)`),
  RELEASE_2: (s) => tuDv(DV.RELEASE_2, `(x.tg_vao + ${phut(s)})`),
  // IN (chờ chạy + đang chạy): đang chạy ⇒ đồng hồ từ lúc bắt đầu chạy phiếu đầu; chờ chạy ⇒ từ lúc duyệt Release 2.
  IN: (s) => tuDv(DV.SAN_XUAT, `(COALESCE((SELECT min(zp.tg_bd) FROM phieu_san_xuat zp JOIN lenh_san_xuat zl ON zl.id = zp.lenh_san_xuat_id
      WHERE ${LENH_X} AND zp.trang_thai <> 'HUY'), x.tg_vao) + ${phut(s)})`),
  KIEM: (s) => tuDv(DV.KIEM, `(x.tg_vao + ${phut(s)})`),
  SUA: (s) => tuDv(DV.SUA, `(x.tg_vao + ${phut(s)})`),
  // Hàng GIA CÔNG ở OQC không tính SLA (màn OQC cũng đặt SLA 0 cho chuyền gia công).
  OQC: (s) => tuDv(DV.OQC, `(CASE WHEN x.ma_loai_chuyen = 'GIA_CONG' THEN NULL ELSE x.tg_vao + ${phut(s)} END)`),
  GIAO: (s) => tuDv(DV.GIAO, `(x.tg_vao + ${phut(s)})`),
};

// Điều kiện trên 1 ĐƠN VỊ CON `n`:
//   · CHƯA xác nhận = còn ở trạm lúc cuối kỳ và mốc đo đã qua `bd` (+ không bị `chan`).
//   · ĐÃ xác nhận   = rời trạm TRONG kỳ và lúc rời đã quá `bd`.
const CON_CHUA = `(n.tg_vao < (SELECT den FROM ky) AND (n.tg_ra IS NULL OR n.tg_ra >= (SELECT den FROM ky))
  AND NOT n.chan AND ${MOC_DO} > n.bd)`;
const CON_XONG = `(n.tg_ra IS NOT NULL AND n.tg_ra >= (SELECT tu FROM ky) AND n.tg_ra < (SELECT den FROM ky) AND n.tg_ra > n.bd)`;

// CTE: `q0` = dòng phần in của engine sĩ số · `nc` = đơn vị con + `bd` · `ng` = gộp nghẽn về phần in ·
// `q` = q0 + cột nghẽn. Đơn vị nghẽn ĐẠI DIỆN của phần in (để modal hiện "nghẽn từ / bao lâu") = đơn vị CHƯA
// xác nhận trước, rồi `bd` sớm nhất. Giờ nghẽn của phần in = đơn vị vượt SLA LÂU NHẤT (không cộng dồn các
// đơn vị song song — cùng 1 phần in không bị tính 2 lần thời gian).
// ⚠ Cả 4 tầng `MATERIALIZED` (DATABASE.md §15): `nc`/`ng` nhắc cột nhiều lần, để nhúng là subquery bị tính lại.
const voiNghen = (sqlPin, conSql) => `q0 AS MATERIALIZED (${sqlPin}),
  nc AS MATERIALIZED (${conSql}),
  ng AS MATERIALIZED (SELECT n.phan_in_id,
      bool_or(${CON_CHUA}) AS chua, bool_or(${CON_XONG}) AS xong_mot,
      (array_agg(n.bd ORDER BY ${CON_CHUA} DESC, n.bd) FILTER (WHERE ${CON_CHUA} OR ${CON_XONG}))[1] AS bd_nghen,
      (array_agg(n.tg_vao ORDER BY ${CON_CHUA} DESC, n.bd) FILTER (WHERE ${CON_CHUA} OR ${CON_XONG}))[1] AS vao_nghen,
      (array_agg(n.tg_ra ORDER BY ${CON_CHUA} DESC, n.bd) FILTER (WHERE ${CON_CHUA} OR ${CON_XONG}))[1] AS ra_nghen,
      max(EXTRACT(EPOCH FROM ((CASE WHEN ${CON_CHUA} THEN ${MOC_DO} ELSE n.tg_ra END) - n.bd)))
        FILTER (WHERE ${CON_CHUA} OR ${CON_XONG}) / 3600.0 AS gio,
      string_agg(DISTINCT n.ly_do, ' · ') FILTER (WHERE ${CON_CHUA} OR ${CON_XONG}) AS ly_do_nghen
    FROM nc n WHERE n.bd IS NOT NULL GROUP BY n.phan_in_id),
  q AS MATERIALIZED (SELECT q.*, COALESCE(ng.chua, false) AS ng_chua, COALESCE(ng.xong_mot, false) AS ng_xong,
      ng.bd_nghen, ng.vao_nghen, ng.ra_nghen, COALESCE(ng.gio, 0) AS ng_gio, ng.ly_do_nghen
    FROM q0 q LEFT JOIN ng ON ng.phan_in_id = q.id)`;

// NGHẼN mức PHẦN IN = HIỆN TRẠNG + KẾT QUẢ XỬ LÝ (01/10/2026, theo tờ giấy xưởng):
//   · CHƯA xác nhận = phần in đang TỒN CUỐI và có đơn vị con còn ở trạm đã quá SLA.
//   · ĐÃ xác nhận   = không thuộc "chưa", và có đơn vị con RỜI trạm trong kỳ lúc đã quá SLA.
//   · Phần nghẽn   = ĐÃ + CHƯA (rời nhau theo định nghĩa). Giờ nghẽn = Σ giờ vượt SLA (mỗi phần in 1 lần).
// Dòng `nghenMoi` (OPEN): lỗi phát sinh SAU khi đợt đã qua trạm ⇒ KHÔNG gác "chưa xác nhận" trong Tồn cuối.
const NGHEN_CHUA = (dong) => (dong && dong.nghenMoi ? 'q.ng_chua' : `((${dkO('ton_cuoi')}) AND q.ng_chua)`);
const NGHEN_XONG = (dong) => `(NOT (${NGHEN_CHUA(dong)}) AND q.ng_xong)`;
const NGHEN = (dong) => `((${NGHEN_CHUA(dong)}) OR (${NGHEN_XONG(dong)}))`;

// Nguồn PHẦN IN của 1 dòng: cột "Phần" LUÔN đếm theo PHẦN IN. OPEN không có màn ⇒ nguồn riêng.
const pinSqlCuaDong = (dong) => (dong.nguonPin === 'OPEN' ? OPEN_PIN_SQL : nguon(dong.man).donVis.pin.sql);

const conCuaDong = (dong, slaPhut) => (slaPhut == null || !NGHEN_CON[dong.ma]
  ? 'SELECT NULL::uuid AS phan_in_id, NULL::timestamptz AS tg_vao, NULL::timestamptz AS tg_ra, NULL::timestamptz AS bd, false AS chan, NULL::text AS ly_do WHERE false'
  : NGHEN_CON[dong.ma](Number(slaPhut)));

async function motDongBang(dong, slaPhut, { tu, den }) {
  const sqlPin = pinSqlCuaDong(dong);
  const slSql = DO_SL[dong.sl].sql;
  const cum = (ten, dk) => `count(*) FILTER (WHERE ${dk})::int AS ${ten}_phan,
    COALESCE(sum(${slSql}) FILTER (WHERE ${dk}), 0)::int AS ${ten}_sl`;
  const sql = `WITH ${CTE_KY}, ${voiNghen(sqlPin, conCuaDong(dong, slaPhut))} SELECT
      ${cum('ton_dau', dkO('ton_dau'))}, ${cum('nhan', dkO('nhan'))},
      ${cum('xong', dkO('lam_duoc'))}, ${cum('ton_cuoi', dkO('ton_cuoi'))},
      ${cum('nghen', NGHEN(dong))},
      count(*) FILTER (WHERE ${NGHEN_XONG(dong)})::int AS nghen_xong_phan,
      count(*) FILTER (WHERE ${NGHEN_CHUA(dong)})::int AS nghen_chua_phan,
      COALESCE(sum(q.ng_gio) FILTER (WHERE ${NGHEN(dong)}), 0)::float8 AS nghen_gio
    FROM q WHERE ${NEN}`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tu, den]);
  return rows[0] || {};
}

// DANH SÁCH PHẦN IN của 1 dòng bảng theo dõi (26/09/2026) — Dashboard bấm vào dòng ⇒ modal.
// Mọi phần in thuộc ÍT NHẤT 1 trong 4 ô + cờ từng ô + nghẽn + mốc của ĐƠN VỊ CON nghẽn + SL theo đơn vị dòng.
// ⚠ Cùng `q`, cùng `dkO`, cùng `voiNghen` với `motDongBang` ⇒ đếm cờ ở FE ra ĐÚNG số trên bảng.
// `vao_nghen`/`ra_nghen` = mốc vào/rời của đơn vị con nghẽn — service tính "SLA thực" + "nghẽn bao lâu" từ đó
//   (mốc vào của DÒNG phần in là `min` mọi chu kỳ, dùng nó là ra số phút của đợt/lệnh cũ).
async function dsDongBang(dong, slaPhut, { tu, den }) {
  const sql = `WITH ${CTE_KY}, ${voiNghen(pinSqlCuaDong(dong), conCuaDong(dong, slaPhut))} SELECT ${COT_DS},
      (${dkO('ton_dau')}) AS o_ton_dau, (${dkO('nhan')}) AS o_nhan,
      (${dkO('lam_duoc')}) AS o_xong, (${dkO('ton_cuoi')}) AS o_ton_cuoi,
      q.bd_nghen AS tg_bat_dau_nghen, q.vao_nghen, q.ra_nghen, q.ly_do_nghen,
      COALESCE(${NGHEN(dong)}, false) AS o_nghen,
      COALESCE(${NGHEN_XONG(dong)}, false) AS o_nghen_xong,
      COALESCE(${NGHEN_CHUA(dong)}, false) AS o_nghen_chua,
      ${DO_SL[dong.sl].sql} AS sl_dong,
      ${MOC_DO} AS moc_do
    FROM q WHERE ${NEN} AND ((${dkO('ton_dau')}) OR (${dkO('nhan')}) OR (${dkO('lam_duoc')}) OR (${dkO('ton_cuoi')})
      OR (${NGHEN(dong)}))
    ORDER BY q.tg_vao DESC NULLS LAST, q.ma_phan LIMIT 5000`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tu, den]);
  return rows;
}

// Owner (Chịu trách nhiệm / Xử lý) của trạm hoặc checklist của dòng — cùng nguồn `tram_owner` /
// `checkpoint_owner` mà trang *Owner checkpoint/checklist* ghi (khuôn `kpiready.repository.dsOwner`).
async function ownerCuaDong(dong) {
  const rong = { chiu_trach_nhiem: [], xu_ly: [] };
  if (!dong.sla) return rong;
  const laCp = !!dong.sla.checkpoint;
  const sql = laCp
    ? `SELECT o.loai, COALESCE(u.ho_ten, r.ten_role, pb.ten_phong_ban) AS ten FROM checkpoint_owner o JOIN checkpoint cp ON cp.id = o.checkpoint_id JOIN tram tr ON tr.id = cp.tram_id JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true LEFT JOIN nguoi_dung u ON u.id = o.user_id LEFT JOIN vai_tro r ON r.id = o.role_id LEFT JOIN phong_ban pb ON pb.id = o.phong_ban_id WHERE cp.ma_checkpoint = $1`
    : `SELECT o.loai, COALESCE(u.ho_ten, r.ten_role, pb.ten_phong_ban) AS ten FROM tram_owner o JOIN tram tr ON tr.id = o.tram_id JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true LEFT JOIN nguoi_dung u ON u.id = o.user_id LEFT JOIN vai_tro r ON r.id = o.role_id LEFT JOIN phong_ban pb ON pb.id = o.phong_ban_id WHERE tr.ma_tram = $1`;
  try {
    const { rows } = await query(sql, [laCp ? dong.sla.checkpoint : dong.sla.tram]);
    return {
      chiu_trach_nhiem: rows.filter((r) => r.loai !== 'XU_LY' && r.ten).map((r) => r.ten),
      xu_ly: rows.filter((r) => r.loai === 'XU_LY' && r.ten).map((r) => r.ten),
    };
  } catch (e) { return rong; }
}

module.exports = {
  demSiSo, chiTiet, nguon, chonDonVi, tomTatTheoNgayGiao, dsSlaHienHanh, motDongBang, dsDongBang, ownerCuaDong,
};
