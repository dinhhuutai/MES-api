'use strict';

// SĨ SỐ CHECKPOINT — đếm 4 ô + liệt kê chi tiết. Luật ở `utils/siSoTram.js`.
// ⚠ SQL gửi GỘP 1 DÒNG (IPS) ⇒ không viết comment `-- …` bên trong chuỗi SQL.

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { MAN, LOAI_NGAY, O_SI_SO, VN } = require('../../utils/siSoTram');
const { DO_SL } = require('../../utils/bangTheoDoi');
const { slaReadySql, slaQcReadySql, mocDoReadySql, testRunTruocSxPhut, hanBat, gioSxKhSql } = require('../../utils/slaTheoGio');
const { dotChuaKtDk, hanGiaoReadySql } = require('../../utils/tech');

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
// ⚠⚠ NGHẼN (từ 01/10/2026) = đối tượng quá SLA trong kỳ — gồm "chưa xác nhận" (đang TỒN CUỐI) và
//   "đã xác nhận" (rời trạm trong kỳ sau khi đã quá SLA); xem `NGHEN_*`. Mốc đo là `LEAST(cuối kỳ, bây giờ)`: xem ngày quá
//   khứ thì tính tới cuối ngày đó, xem hôm nay thì tính tới bây giờ — KHÔNG lấy `now()` trần, nếu
//   không mọi thứ tồn từ tháng trước đều "nghẽn" khi soi lại một ngày cũ.
// ⚠ SLA null (trạm chưa cấu hình) ⇒ `false` ⇒ nghẽn = 0, KHÔNG đoán bừa một ngưỡng.
// MỐC BẮT ĐẦU NGHẼN (timestamptz) của 1 phần in ở trạm = mốc vào + SLA — mỗi `slaKieu` một luật
// (`utils/slaTheoGio.js`), gương đúng bản đồ nghẽn `dashboard.flowRows`. `null` ⇒ trạm chưa có SLA.
// Nghẽn ⟺ `LEAST(cuối kỳ, now()) > mốc này` — tương đương từng nhánh công thức "đã ở > SLA" cũ.
// ⚠ Dùng CHUNG cho bảng đếm (`motDongBang`) và danh sách chi tiết (`dsDongBang`, 26/09/2026) ⇒ modal
//   liệt kê ĐÚNG những phần in mà ô "Nghẽn" đang đếm.
function batDauNghenSql(dong, slaPhut) {
  if (slaPhut == null) return null;
  const s = Number(slaPhut);
  const cong = (phutSql) => `(q.tg_vao + (${phutSql}) * interval '1 minute')`;
  // READY KT theo HẠN GIAO (25/09/2026): 00:00 ngày (hạn − 1); thiếu hạn ⇒ theo giờ lên MES.
  // ⚠⚠ GƯƠNG ĐÚNG MÀN READY (sửa 01/10/2026 — người dùng: "bảng nghẽn READY 23, màn READY chỉ 1"):
  //   · Phần in CÒN đợt chờ mà KT chưa xong (`q.kt_cho_vao` — cột phụ `phuNghen`) ⇒ hạn = hạn nhỏ nhất của
  //     CHÍNH các đợt đó, lùi về `hanGiaoReadySql` (y như service: `han[0] || r.han_giao_hang`); mốc giờ
  //     lên MES = đợt về sớm nhất trong số đó.
  //   · Đã hết việc KT (rời trạm) ⇒ hạn của đợt MỚI NHẤT (đợt quyết định `tg_vao`), lùi về hạn cũ.
  //   Bản cũ dùng `q.han_giao_hang` = min MỌI đợt (kể cả đợt đã release từ lâu) ⇒ đợt mới vừa về đã "nghẽn".
  if (dong.slaKieu === 'READY_THEO_GIO') {
    const vao = 'COALESCE(q.kt_cho_vao, q.tg_vao)';
    const han = `(CASE WHEN q.kt_cho_vao IS NOT NULL THEN COALESCE(q.kt_cho_han, q.han_ready)
      ELSE COALESCE(q.han_moi_nhat, q.han_giao_hang) END)`;
    const congV = (phutSql) => `(${vao} + (${phutSql}) * interval '1 minute')`;
    if (!hanBat()) return congV(slaReadySql(vao, s)); // luật hạn giao tắt (mig 109)
    return `(CASE WHEN ${han} IS NULL THEN ${congV(slaReadySql(vao, s))}
      ELSE ${mocDoReadySql(han)} END)`;
  }
  // QC READY: q.tg_vao = lúc Kỹ thuật xác nhận xong ⇒ sau 16:30 thì QC có 16 giờ (KHUNG_SLA_QC).
  if (dong.slaKieu === 'QC_THEO_GIO') return cong(slaQcReadySql('q.tg_vao', s));
  // Test Run theo giờ SX kế hoạch SỚM NHẤT của các lệnh RELEASE_1 của phần in (thiếu ⇒ SLA trạm).
  if (dong.slaKieu === 'TEST_RUN_KE_HOACH') {
    const truoc = testRunTruocSxPhut(); // null = luật tắt (mig 109)
    if (truoc == null) return cong(s);
    const bdKh = `(SELECT min(${gioSxKhSql('lsb.tg_bd_kh', 'lsb.ngay_ke_hoach')}) FROM lenh_sx_dot_vai ldb JOIN dot_vai_ve dvb ON dvb.id = ldb.dot_vai_ve_id
      JOIN lenh_san_xuat lsb ON lsb.id = ldb.lenh_san_xuat_id WHERE dvb.phan_in_id = q.id AND lsb.trang_thai = 'RELEASE_1')`;
    return `(CASE WHEN ${bdKh} IS NULL THEN ${cong(s)}
      ELSE ${bdKh} - interval '${Number(truoc)} minutes' END)`;
  }
  return cong(s);
}
const MOC_DO = 'LEAST((SELECT den FROM ky), now())';

// NGHẼN = HIỆN TRẠNG + KẾT QUẢ XỬ LÝ (01/10/2026, người dùng chốt theo tờ giấy xưởng):
//   · CHƯA xác nhận = đang TỒN CUỐI và mốc đo đã qua mốc bắt đầu nghẽn (= định nghĩa "Nghẽn" cũ).
//   · ĐÃ xác nhận   = RỜI trạm trong kỳ (`lam_duoc`) và lúc rời ĐÃ quá SLA (`tg_ra > bd_nghen`).
//   · Phần nghẽn   = ĐÃ + CHƯA (2 tập rời nhau: `lam_duoc` đòi tg_ra < cuối kỳ, `ton_cuoi` đòi ≥).
//   · Giờ nghẽn    = Σ giờ VƯỢT SLA: đã xác nhận tính tới lúc rời, chưa xác nhận tính tới mốc đo.
// ⚠ Dựa trên cột `q.bd_nghen` (mốc bắt đầu nghẽn tính SẴN 1 lần/dòng — xem `voiBdNghen`), đừng chèn
//   lại `batDauNghenSql` ở từng chỗ: nhánh Test Run là subquery, chèn 4 lần là chạy 4 lần.
// `q.nghen_duoc` = phần in còn thuộc DIỆN tính nghẽn ở trạm này (READY KT: còn đợt chờ mà KT chưa xong —
//   KT đã xong, chỉ chờ QC thì là việc của dòng READY QA, màn READY cũng "đủ mục KT ⇒ ngừng đỏ").
const NGHEN_CHUA = () => `(${dkO('ton_cuoi')}) AND q.nghen_duoc AND q.bd_nghen IS NOT NULL AND ${MOC_DO} > q.bd_nghen`;
const NGHEN_XONG = () => `(${dkO('lam_duoc')}) AND q.bd_nghen IS NOT NULL AND q.tg_ra > q.bd_nghen`;
const NGHEN = () => `((${NGHEN_CHUA()}) OR (${NGHEN_XONG()}))`;
const GIO_NGHEN = () => `EXTRACT(EPOCH FROM ((CASE WHEN ${NGHEN_CHUA()} THEN ${MOC_DO} ELSE q.tg_ra END) - q.bd_nghen)) / 3600.0`;

// CTE `q` có thêm cột `bd_nghen`. ⚠ CTE thường (không RECURSIVE) không nhìn thấy chính tên nó trong thân
//   ⇒ `FROM q0 q` đặt alias `q` cho nguồn để `batDauNghenSql` (viết theo `q.`) chạy nguyên văn.
// ⚠ Cả 2 tầng `MATERIALIZED` (xem `cteQ`): `q0` để `tg_vao`/`tg_ra` tính 1 lần/dòng, `q` để mốc
//   `bd_nghen` (nhánh Test Run là subquery) cũng chỉ tính 1 lần dù `NGHEN_*` nhắc nó nhiều lần.
// Cột PHỤ để tính nghẽn của riêng 1 dòng (01/10/2026) — hiện chỉ READY KT cần (xem `batDauNghenSql`):
//   `kt_cho_han`/`kt_cho_vao` = hạn nhỏ nhất / mốc lên READY sớm nhất của các đợt ĐANG CHỜ mà KT CHƯA xong
//   (`tech.dotChuaKtDk` — cùng luật với màn READY); `han_ready` = hạn mức phần in của màn READY
//   (`tech.hanGiaoReadySql`); `han_moi_nhat` = hạn của đợt lên READY mới nhất (đợt quyết định `tg_vao`).
// Dòng khác ⇒ null (không thêm tầng, không tốn gì).
function phuNghen(dong) {
  if (dong.slaKieu !== 'READY_THEO_GIO') return null;
  return {
    cot: 'ktc.kt_cho_han, ktc.kt_cho_vao, hk.han_ready, hk.han_moi_nhat',
    join: `LEFT JOIN LATERAL (SELECT min(zkc.han_giao_hang) AS kt_cho_han, min(zkc.tg_chuyen_ready) AS kt_cho_vao
        FROM dot_vai_ve zkc WHERE ${dotChuaKtDk('zkc', 'q.id', 'q.ten_khach_hang')}) ktc ON true
      LEFT JOIN LATERAL (SELECT ${hanGiaoReadySql('q.id')} AS han_ready,
        (SELECT min(zmn.han_giao_hang) FROM dot_vai_ve zmn WHERE zmn.phan_in_id = q.id
           AND zmn.trang_thai NOT IN ('DA_GOP','DA_HUY') AND zmn.tg_chuyen_ready = q.tg_vao) AS han_moi_nhat) hk ON true`,
    duoc: 'q.kt_cho_vao IS NOT NULL',
  };
}

const voiBdNghen = (sqlPin, batDau, phu = null) => `q0 AS MATERIALIZED (${sqlPin}),
  ${phu ? `q1 AS MATERIALIZED (SELECT q.*, ${phu.cot} FROM q0 q ${phu.join}),` : ''}
  q AS MATERIALIZED (SELECT q.*, ${batDau == null ? 'NULL::timestamptz' : batDau} AS bd_nghen,
    ${phu ? phu.duoc : 'true'} AS nghen_duoc FROM ${phu ? 'q1' : 'q0'} q)`;

async function motDongBang(dong, slaPhut, { tu, den }) {
  const m = nguon(dong.man);
  const sqlPin = m.donVis.pin.sql;             // cột "Phần" LUÔN đếm theo PHẦN IN ở cả 10 dòng
  const slSql = DO_SL[dong.sl].sql;
  const batDau = batDauNghenSql(dong, slaPhut);
  const cum = (ten, dk) => `count(*) FILTER (WHERE ${dk})::int AS ${ten}_phan,
    COALESCE(sum(${slSql}) FILTER (WHERE ${dk}), 0)::int AS ${ten}_sl`;
  const sql = `WITH ${CTE_KY}, ${voiBdNghen(sqlPin, batDau, phuNghen(dong))} SELECT
      ${cum('ton_dau', dkO('ton_dau'))}, ${cum('nhan', dkO('nhan'))},
      ${cum('xong', dkO('lam_duoc'))}, ${cum('ton_cuoi', dkO('ton_cuoi'))},
      ${cum('nghen', NGHEN())},
      count(*) FILTER (WHERE ${NGHEN_XONG()})::int AS nghen_xong_phan,
      count(*) FILTER (WHERE ${NGHEN_CHUA()})::int AS nghen_chua_phan,
      COALESCE(sum(${GIO_NGHEN()}) FILTER (WHERE ${NGHEN()}), 0)::float8 AS nghen_gio
    FROM q WHERE ${NEN}`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [tu, den]);
  return rows[0] || {};
}

// DANH SÁCH PHẦN IN của 1 dòng bảng theo dõi (26/09/2026) — Dashboard bấm vào dòng ⇒ modal.
// Mọi phần in thuộc ÍT NHẤT 1 trong 4 ô + cờ từng ô + nghẽn + mốc bắt đầu nghẽn + SL theo đơn vị dòng.
// ⚠ Cùng `q`, cùng `dkO`, cùng `batDauNghenSql` với `motDongBang` ⇒ đếm cờ ở FE ra ĐÚNG số trên bảng.
async function dsDongBang(dong, slaPhut, { tu, den }) {
  const m = nguon(dong.man);
  const batDau = batDauNghenSql(dong, slaPhut);
  const sql = `WITH ${CTE_KY}, ${voiBdNghen(m.donVis.pin.sql, batDau, phuNghen(dong))} SELECT ${COT_DS},
      (${dkO('ton_dau')}) AS o_ton_dau, (${dkO('nhan')}) AS o_nhan,
      (${dkO('lam_duoc')}) AS o_xong, (${dkO('ton_cuoi')}) AS o_ton_cuoi,
      q.bd_nghen AS tg_bat_dau_nghen,
      COALESCE(${NGHEN()}, false) AS o_nghen,
      COALESCE(${NGHEN_XONG()}, false) AS o_nghen_xong,
      COALESCE(${NGHEN_CHUA()}, false) AS o_nghen_chua,
      ${DO_SL[dong.sl].sql} AS sl_dong,
      ${MOC_DO} AS moc_do
    FROM q WHERE ${NEN} AND ((${dkO('ton_dau')}) OR (${dkO('nhan')}) OR (${dkO('lam_duoc')}) OR (${dkO('ton_cuoi')}))
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
