'use strict';

// SĨ SỐ CHECKPOINT — đếm 4 ô + liệt kê chi tiết. Luật ở `utils/siSoTram.js`.
// ⚠ SQL gửi GỘP 1 DÒNG (IPS) ⇒ không viết comment `-- …` bên trong chuỗi SQL.

const { query } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { MAN, LOAI_NGAY, O_SI_SO, VN } = require('../../utils/siSoTram');

// ⚠⚠ MỐC KỲ ĐẶT TRONG CTE `ky`, KHÔNG nội suy `$1`/`$2` thẳng vào từng điều kiện.
//   Lý do (lỗi thật đã bắt): ô `ton_dau` chỉ dùng $1, ô `ton_cuoi` chỉ dùng $2 ⇒ tham số còn lại
//   KHÔNG xuất hiện trong SQL và Postgres ném `could not determine data type of parameter $N`.
//   Đưa vào CTE thì cả 2 tham số LUÔN được dùng, mọi ô chạy chung một câu.
const CTE_KY = `ky AS (SELECT (($1::date)::timestamp ${VN}) AS tu, (($2::date)::timestamp ${VN}) AS den)`;
const dkO = (o) => O_SI_SO[o].dk.replace(/\$1/g, '(SELECT tu FROM ky)').replace(/\$2/g, '(SELECT den FROM ky)');

// Điều kiện nền: bỏ mục chưa từng vào trạm, và bỏ dữ liệu bẩn `tg_ra < tg_vao` (nếu lọt thì bất
// biến Tồn đầu + Nhận − Làm được = Tồn cuối sẽ vỡ).
const NEN = 'q.tg_vao IS NOT NULL AND (q.tg_ra IS NULL OR q.tg_ra >= q.tg_vao)';

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

// 4 ô trong 1 LƯỢT QUERY — mạng tới DB là nút cổ chai (~25ms/lượt, DATABASE.md §7) nên đừng bắn 4 lần.
async function demSiSo(maTrang, { tu, den, loc, locTrang }) {
  const m = nguon(maTrang);
  const { dk, params } = dungLocKep(loc, locTrang);
  const dem = Object.keys(O_SI_SO).map((k) => `count(*) FILTER (WHERE ${dkO(k)})::int AS ${k}`).join(', ');
  const sql = `WITH ${CTE_KY}, q AS (${m.sql}) SELECT ${dem} FROM q WHERE ${NEN}${dk}`;
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
async function chiTiet(maTrang, o, { tu, den, loc, locTrang, page = 1, limit = 20 }) {
  const m = nguon(maTrang);
  if (!O_SI_SO[o]) throw Object.assign(new Error(`Ô "${o}" không hợp lệ`), { code: 'O_LA' });
  const { dk, params } = dungLocKep(loc, locTrang);
  const p = [tu, den, ...params];
  const than = `FROM q WHERE ${NEN} AND (${dkO(o)})${dk}`;
  const dau = `WITH ${CTE_KY}, q AS (${m.sql})`;

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

module.exports = { demSiSo, chiTiet, nguon };
