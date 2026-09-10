'use strict';

// KPI READY — truy vấn. Luật + câu SQL chính nằm ở `utils/kpiReady.js`.
// ⚠ SQL gửi GỘP 1 DÒNG (`.replace(/\s+/g,' ')`, tránh IPS reset) ⇒ KHÔNG viết comment `-- …`
//   bên trong chuỗi SQL.

const { query, withTransaction } = require('../../config/db');
const { mauTim } = require('../../utils/timKiem');
const { CAU_CHINH, LOAI_NGAY, VN } = require('../../utils/kpiReady');

// ─── DÒ BẢNG (mig 093 có thể chưa chạy) ──────────────────────────────────────
// ⚠⚠ DÒ `information_schema` chứ KHÔNG try/catch quanh câu SELECT: nhiều hàm ở đây chạy trong
//   transaction ở nơi khác, mà lỗi `42P01 undefined_table` sẽ ABORT cả transaction (câu "thử lại"
//   chết tiếp với `25P02`). Cùng khuôn `temCoCot` (mig 066) / `coCotTichGiao` (mig 092).
// ⚠ Chỉ cache khi ĐÃ có bảng ⇒ chạy migration xong là nhận ngay, không cần restart BE.
let _coBang = null;
async function coBangKpiDonHang() {
  if (_coBang) return true;
  const { rows } = await query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='kpi_don_hang'"
  );
  if (rows.length) _coBang = true;
  return rows.length > 0;
}

// ─── PHẠM VI: ĐƠN HÀNG ĐƯỢC CHỌN ─────────────────────────────────────────────
async function dsDonHangChon() {
  if (!(await coBangKpiDonHang())) return [];
  const { rows } = await query(
    `SELECT dh.id, dh.ma_don_hang, dh.so_po, dh.ten_don_hang, kh.ten_khach_hang,
            k.created_date AS tg_chon
       FROM kpi_don_hang k
       JOIN don_hang dh ON dh.id = k.don_hang_id
       JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE k.dang_hoat_dong
      ORDER BY kh.ten_khach_hang, dh.ma_don_hang`.replace(/\s+/g, ' ')
  );
  return rows;
}

// Danh sách MỌI đơn hàng + cờ đã chọn — cho trang cấu hình ở Hệ thống.
// ⚠ `so_phan_in` để người chọn biết đơn nào thật sự có hàng; đơn 0 phần in vẫn hiện (có thể vừa tạo).
async function dsDonHangDeChon({ search = '', chiDaChon = false } = {}) {
  const co = await coBangKpiDonHang();
  const daChon = co
    ? 'EXISTS (SELECT 1 FROM kpi_don_hang k WHERE k.don_hang_id = dh.id AND k.dang_hoat_dong)'
    : 'false';
  const { rows } = await query(
    `SELECT dh.id, dh.ma_don_hang, dh.so_po, dh.ten_don_hang, dh.ngay_dat_hang, dh.bo_phan_bh,
            kh.ten_khach_hang, ${daChon} AS da_chon,
            (SELECT count(*) FROM ma_hang mh JOIN phan_in p ON p.ma_hang_id = mh.id
              AND p.dang_hoat_dong WHERE mh.don_hang_id = dh.id)::int AS so_phan_in
       FROM don_hang dh
       JOIN khach_hang kh ON kh.id = dh.khach_hang_id
      WHERE ($1 = '' OR concat_ws(' ', dh.ma_don_hang, dh.so_po, dh.ten_don_hang,
             kh.ten_khach_hang) ~* $1)
        AND ($2::bool = false OR ${daChon})
      ORDER BY dh.created_date DESC NULLS LAST, dh.ma_don_hang`.replace(/\s+/g, ' '),
    [mauTim(search), chiDaChon === true]
  );
  return rows;
}

// Lưu danh sách đơn được chọn.
// ⚠⚠ XÓA MỀM (`dang_hoat_dong=false`) chứ KHÔNG DELETE: giữ vết ai bỏ chọn lúc nào, và không cần
//   GRANT DELETE cho `claude_agent_mes` (xem mig 093).
// ⚠ Làm trong MỘT transaction: tắt hết rồi bật lại đúng danh sách ⇒ không có khoảnh khắc nào trang
//   KPI đọc được phạm vi rỗng giữa chừng.
async function luuDonHangChon(ids, actor) {
  if (!(await coBangKpiDonHang())) {
    throw Object.assign(new Error('Chưa chạy migration 093 — bảng kpi_don_hang không tồn tại'),
      { code: 'THIEU_MIGRATION', status: 409 });
  }
  const ds = Array.isArray(ids) ? ids : [];
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE kpi_don_hang SET dang_hoat_dong = false, updated_by = $2::uuid,
              updated_date = CURRENT_TIMESTAMP
        WHERE dang_hoat_dong AND NOT (don_hang_id = ANY($1::uuid[]))`,
      [ds, actor]
    );
    if (ds.length) {
      await client.query(
        // ⚠⚠ `SELECT DISTINCT` là LỚP PHÒNG THỦ THỨ HAI (service đã khử trùng ở `tachDs`):
        //   `ON CONFLICT DO UPDATE` ném `21000` nếu 1 lượt INSERT có 2 dòng cùng `don_hang_id`.
        //   Repository gọi được độc lập nên đừng phó thác cho bên gọi.
        // ⚠ `$2::uuid` phải ép kiểu TƯỜNG MINH: trong danh sách SELECT (nhất là có `DISTINCT`)
        //   tham số KHÔNG có ngữ cảnh cột nên Postgres suy ra `text` ⇒ `42804 column "created_by"
        //   is of type uuid but expression is of type text`. Lỗi này đã bắt được lúc kiểm thực.
        `INSERT INTO kpi_don_hang (don_hang_id, dang_hoat_dong, created_by)
         SELECT DISTINCT x.id, true, $2::uuid FROM unnest($1::uuid[]) AS x(id)
         ON CONFLICT (don_hang_id) DO UPDATE
            SET dang_hoat_dong = true, updated_by = $2::uuid, updated_date = CURRENT_TIMESTAMP`,
        [ds, actor]
      );
    }
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM kpi_don_hang WHERE dang_hoat_dong'
    );
    return { so_don: rows[0] ? rows[0].n : 0 };
  });
}

// ─── DỮ LIỆU CHÍNH ───────────────────────────────────────────────────────────
// 1 dòng / PHẦN IN. FE tự gộp theo ĐƠN cho chế độ tổng hợp (2 chế độ dùng CHUNG một tập dữ liệu
// ⇒ không thể ra 2 con số đá nhau, và bấm toggle không phải gọi lại API).
function dungLoc(loc = {}, bat = 2) {
  const dk = [];
  const params = [];
  const them = (val, col) => {
    if (!val) return;
    params.push(mauTim(val));
    dk.push(`${col} ~* $${bat + params.length - 1}`);
  };
  them(loc.timKiem, `concat_ws(' ', q.ten_khach_hang, q.ma_don_hang, q.so_po, q.ma_hang, q.ma_phan,
    q.mau_vai, q.kich_vai, q.kich_phim)`);
  them(loc.khach, 'q.ten_khach_hang');
  them(loc.maHang, 'q.ma_hang');
  them(loc.codePhan, 'q.ma_phan');
  them(loc.mauVai, 'q.mau_vai');

  const ln = LOAI_NGAY[loc.loaiNgay];
  if (ln && (loc.ngayTu || loc.ngayDen)) {
    const cot = ln.kieu === 'ts' ? `((${ln.col}) ${VN})::date` : `(${ln.col})::date`;
    if (loc.ngayTu) { params.push(loc.ngayTu); dk.push(`${cot} >= $${bat + params.length - 1}::date`); }
    if (loc.ngayDen) { params.push(loc.ngayDen); dk.push(`${cot} <= $${bat + params.length - 1}::date`); }
  }
  return { dk: dk.length ? ` WHERE ${dk.join(' AND ')}` : '', params };
}

async function layRows(donIds, loc = {}) {
  if (!donIds || !donIds.length) return [];
  const { dk, params } = dungLoc(loc, 2);
  const sql = `SELECT * FROM (${CAU_CHINH}) q${dk} ORDER BY q.ten_khach_hang, q.ma_don_hang,
    q.ma_hang, q.ma_phan`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [donIds, ...params]);
  return rows;
}

// ─── ĐỢT VẢI CỦA TỪNG PHẦN IN (chế độ Chi tiết tách dòng theo đợt) ───────────
// 1 dòng / ĐỢT VẢI. Service gom thành `dot_vai_list` gắn vào từng phần in.
//
// ⚠⚠ CỐ Ý LÀ QUERY RIÊNG, KHÔNG nhét thêm CTE vào `CAU_CHINH`: câu đó đã 9 CTE và được gửi GỘP 1
//   DÒNG để tránh IPS reset (§9) — phình thêm là rước rủi ro cho đường chính, trong khi đây chỉ là
//   dữ liệu phụ của một chế độ xem. Đổi lại tốn 1 round-trip (~25ms).
//
// ⚠⚠ MỐC Release 1 / Test run / Release 2 tính THEO ĐÚNG ĐỢT NÀY (qua `lenh_sx_dot_vai`), KHÔNG lấy
//   mốc mức phần in: cả điểm của việc tách dòng là thấy đợt nào release trước, đợt nào còn chờ.
//   Biểu thức `moc_release_2` gương y hệt CTE `LENH` trong `utils/kpiReady.js` — sửa một bên thì
//   soát lại bên kia, nếu không 2 chế độ xem ra 2 mốc khác nhau cho cùng một phần in.
//
// ⚠ `ngay_ke_hoach` = ngày SX kế hoạch của LỆNH gắn đợt này. Đợt release nhiều lần ⇒ nhiều lệnh ⇒ lấy
//   `min` (ngày dự kiến lên chuyền SỚM NHẤT). Đợt chưa release ⇒ NULL ⇒ bảng hiện "—", không bịa ngày.
async function dsDotVai(phanInIds) {
  if (!phanInIds || !phanInIds.length) return [];
  const sql =
    `SELECT dv.phan_in_id, dv.id AS dot_vai_ve_id, dv.ma_dot_vai,
            COALESCE(dv.so_luong_vai_ve, 0)::int AS so_luong_vai_ve,
            dv.ngay_vai_ve, dv.han_giao_hang, dv.created_date AS moc_vai,
            l.moc_release_1, l.moc_test_run, l.moc_release_2, l.ngay_ke_hoach,
            COALESCE(l.so_lenh, 0)::int AS so_lenh
       FROM dot_vai_ve dv
       LEFT JOIN LATERAL (
         SELECT min(ls.created_date) AS moc_release_1,
                max(tq.moc_qa)       AS moc_test_run,
                min(CASE WHEN ls.trang_thai <> 'RELEASE_1' THEN COALESCE(
                      (SELECT max(a.thoi_gian) FROM audit_log a
                        WHERE a.ten_bang = 'lenh_san_xuat' AND a.id_ban_ghi = ls.id::text
                          AND a.hanh_dong = 'RELEASE_2'),
                      GREATEST(tq.moc_qa, ls.created_date)) END) AS moc_release_2,
                min(ls.ngay_ke_hoach) AS ngay_ke_hoach,
                count(DISTINCT ls.id)::int AS so_lenh
           FROM lenh_sx_dot_vai lsd
           JOIN lenh_san_xuat ls ON ls.id = lsd.lenh_san_xuat_id AND ls.trang_thai <> 'HUY'
           LEFT JOIN LATERAL (SELECT max(k.tg_xac_nhan) AS moc_qa
               FROM ket_qua_checkpoint k JOIN checkpoint c ON c.id = k.checkpoint_id
              WHERE k.lenh_san_xuat_id = ls.id AND k.trang_thai = 'DAT'
                AND c.ma_checkpoint = 'TEST_QA') tq ON true
          WHERE lsd.dot_vai_ve_id = dv.id
       ) l ON true
      WHERE dv.phan_in_id = ANY($1::uuid[])
        AND dv.trang_thai NOT IN ('DA_GOP','DA_HUY')
      ORDER BY dv.phan_in_id, dv.created_date, dv.ma_dot_vai`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [phanInIds]);
  return rows;
}

// ─── OWNER TỪNG CỘT ──────────────────────────────────────────────────────────
// ⚠⚠ DÙNG LẠI `tram_owner` / `checkpoint_owner` của workflow ĐANG HIỆN HÀNH — chính là thứ trang
//   *Hệ thống → Owner checkpoint/checklist* đang ghi. Đừng thêm bảng owner riêng cho trang này.
// ⚠ Gộp 2 nguồn trong 1 lượt query (mạng tới DB là nút cổ chai — DATABASE.md §7).
async function dsOwner() {
  const { rows } = await query(
    `SELECT 'TRAM' AS cap, tr.ma_tram AS ma, o.loai,
            COALESCE(u.ho_ten, r.ten_role, pb.ten_phong_ban) AS ten
       FROM tram_owner o
       JOIN tram tr ON tr.id = o.tram_id
       JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true
       LEFT JOIN nguoi_dung u ON u.id = o.user_id
       LEFT JOIN vai_tro r ON r.id = o.role_id
       LEFT JOIN phong_ban pb ON pb.id = o.phong_ban_id
      UNION ALL
     SELECT 'CHECKPOINT', cp.ma_checkpoint, o.loai,
            COALESCE(u.ho_ten, r.ten_role, pb.ten_phong_ban)
       FROM checkpoint_owner o
       JOIN checkpoint cp ON cp.id = o.checkpoint_id
       JOIN tram tr ON tr.id = cp.tram_id
       JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true
       LEFT JOIN nguoi_dung u ON u.id = o.user_id
       LEFT JOIN vai_tro r ON r.id = o.role_id
       LEFT JOIN phong_ban pb ON pb.id = o.phong_ban_id`.replace(/\s+/g, ' ')
  );
  return rows;
}

// ─── KHÓA OWNER → ID THẬT ────────────────────────────────────────────────────
// Trang *Hệ thống → Owner checkpoint/checklist* cần **id** của trạm/checklist để gán owner, trong khi
// `COT_KPI` chỉ khai MÃ (`ma_tram`/`ma_checkpoint`). Trả thêm id ở đây để trang Owner bấm "+ Gán" là
// mở đúng đích, khỏi bắt người dùng tự dò xem cột "SL kiểm" ăn theo trạm nào.
// ⚠ Chỉ lấy workflow ĐANG HIỆN HÀNH — cùng phạm vi với `dsOwner()`, nếu không sẽ trả id của phiên bản
//   cũ và gán owner vào chỗ không ai đọc.
async function dsKhoaOwner() {
  const { rows } = await query(
    `SELECT 'TRAM' AS cap, tr.ma_tram AS ma, tr.id::text AS id, tr.ten_tram AS ten,
            NULL::text AS tram_id, NULL::text AS tram_ten
       FROM tram tr
       JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true
      UNION ALL
     SELECT 'CHECKPOINT', cp.ma_checkpoint, cp.id::text, cp.ten_checkpoint,
            tr.id::text, tr.ten_tram
       FROM checkpoint cp
       JOIN tram tr ON tr.id = cp.tram_id
       JOIN workflow_version wv ON wv.id = tr.workflow_version_id AND wv.la_hien_hanh = true`
      .replace(/\s+/g, ' ')
  );
  return rows;
}

module.exports = {
  coBangKpiDonHang, dsDonHangChon, dsDonHangDeChon, luuDonHangChon, layRows, dsOwner, dsKhoaOwner,
  dsDotVai,
};
