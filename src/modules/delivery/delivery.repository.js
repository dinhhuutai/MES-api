'use strict';

const { query } = require('../../config/db');
// Hiển thị theo PHƯƠNG ÁN IN — cấu hình động từng trang (mig 067), mặc định BẬT HẾT = không lọc.
const { dkTrang } = require('../../utils/phuongAnIn');
const { lenhPhanInMatch } = require('../../utils/search');
const { timTem } = require('../../utils/temPrefix');
const { mauTim } = require('../../utils/timKiem');
// Sổ cái tem là NGUỒN LUẬT DUY NHẤT ở `quality.repository` — không chép biểu thức sang đây.
const qaRepo = require('../quality/quality.repository');

const DON_SUB = (col, alias) => `(SELECT string_agg(DISTINCT ${col}, ', ')
    FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    WHERE lsd.lenh_san_xuat_id = ls.id) AS ${alias}`;

// ─── CHỐT CHẶN "BÁN HÀNG TÍCH TEM" (mig 092) ─────────────────────────────────────────────────
// ⚠⚠ DÒ CỘT TRƯỚC KHI DÙNG, KHÔNG try/catch quanh câu SELECT: thiếu mig 092 mà cứ nhét
//   `t.da_tich_giao` vào WHERE là `42703` ⇒ SẬP màn Giao hàng. Dò cột thì màn Giao lùi về hành vi
//   CŨ (OQC đạt hiện thẳng, không có chốt chặn) — đúng tinh thần fail-open, và chạy migration xong
//   là nhận ngay, không cần restart BE. Cache khi ĐÃ có cột (khuôn `temCoCot` mig 066).
let _coCotTich = false;
async function coCotTichGiao() {
  if (_coCotTich) return true;
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='tem' AND column_name='da_tich_giao' LIMIT 1`.replace(/\s+/g, ' ')
  );
  _coCotTich = rows.length > 0;
  return _coCotTich;
}

// Tem còn phần CHỜ GIAO (con_giao = sl_oqc_dat − sl_da_giao > 0) — cho giao TỪNG PHẦN nhiều lần.
// filters: { tem, khach, don, maHang, mauVai, kichVai, kichPhim }; ngayTu/ngayDen lọc KHOẢNG ngày in tem (VN).
//
// ⚠⚠ MỘT CÂU SELECT CHO CẢ 2 MÀN (`cheDo`): **`SAN_SANG`** = màn *Giao hàng* (đã được bán hàng tích)
//   · **`CHO_TICH`** = màn *Tích tem giao hàng* ở Hệ thống (OQC đạt nhưng bán hàng CHƯA tích).
//   Hai màn là 2 đầu của CÙNG một chốt chặn — tách thành 2 hàm là sớm muộn lệch cột/lệch bộ lọc
//   (đúng họ lỗi "2 con số trên cùng dòng chảy đá nhau" đã ghi ở §6).
// ⚠ Cùng áp `dkTrang('GH_TEM')` cho cả 2 chế độ — CỐ Ý: cấu hình *Hiển thị theo phương án in* ẩn
//   nhóm nào thì ẩn ở cả hai, nếu không bán hàng sẽ tích được thứ mà màn Giao không bao giờ hiện.
async function listTemGiao({ cheDo = 'SAN_SANG', search = '', filters = {}, ngayTu = '', ngayDen = '' } = {}) {
  const f = filters || {};
  const params = [];
  // ⚠ LOẠI TEM ĐÃ HỦY (cùng lý do như `quality.repository.listCandByCon`): danh sách lọc theo sổ cái,
  // mà `softDeletePhanInTx` set tem HUY nhưng KHÔNG xóa sổ cái ⇒ tem của phần in đã hủy vẫn chờ giao.
  const dkPain = await dkTrang('GH_TEM', 'phieu', 't.phieu_san_xuat_id');
  const conds = ["t.trang_thai <> 'HUY'", dkPain, '(t.sl_oqc_dat - t.sl_da_giao) > 0'];
  if (await coCotTichGiao()) conds.push(cheDo === 'CHO_TICH' ? 'NOT t.da_tich_giao' : 't.da_tich_giao');
  else if (cheDo === 'CHO_TICH') conds.push('false'); // chưa chạy mig 092 ⇒ màn tích rỗng, không báo lỗi
  if (search) {
    params.push(mauTim(timTem(search))); const i = params.length;
    conds.push(`(t.ma_tem ~* $${i} OR ls.ma_lenh_san_xuat ~* $${i} OR ${lenhPhanInMatch('ls.id', `$${i}`)})`);
  }
  const add = (val, col) => { if (!val) return; params.push(mauTim(val)); conds.push(`${col} ~* $${params.length}`); };
  add(f.tem, 't.ma_tem');
  add(f.khach, 'info.ten_khach_hang');
  add(f.don, 'info.ma_don_hang');
  add(f.maHang, 'info.ma_hang');
  add(f.mauVai, 'info.mau_vai');
  add(f.kichVai, 'info.kich_vai');
  add(f.kichPhim, 'info.kich_phim');
  if (ngayTu) { params.push(ngayTu); conds.push(`(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $${params.length}::date`); }
  if (ngayDen) { params.push(ngayDen); conds.push(`(t.created_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $${params.length}::date`); }
  // Cột "ai tích / lúc nào" chỉ SELECT khi đã có mig 092 — thiếu cột thì 2 khóa này vắng mặt,
  // FE hiện "—" như mọi giá trị rỗng khác.
  const cotTich = (await coCotTichGiao())
    ? 't.tg_tich_giao, ndt.ho_ten AS nguoi_tich_giao,'
    : '';
  const joinTich = (await coCotTichGiao())
    ? 'LEFT JOIN nguoi_dung ndt ON ndt.id = t.nguoi_tich_giao_id'
    : '';
  const sql =
    `SELECT t.id AS tem_id, t.ma_tem, t.so_luong, t.created_date AS ngay_in_tem, (t.sl_oqc_dat - t.sl_da_giao) AS con_giao,
            ${cotTich}
            (t.tem_goc_id IS NOT NULL) AS la_tem_sua,
            GREATEST(0, COALESCE(t.sl_oqc_dat_sua,0) - COALESCE(t.sl_da_giao_sua,0)) AS con_giao_sua,
            GREATEST(0, (COALESCE(t.sl_oqc_dat,0)-COALESCE(t.sl_oqc_dat_sua,0)) - (COALESCE(t.sl_da_giao,0)-COALESCE(t.sl_da_giao_sua,0))) AS con_giao_kcs,
            t.sl_oqc_dat, t.sl_da_giao, ls.ma_lenh_san_xuat,
            (SELECT string_agg(DISTINCT pin.ma_phan, ', ')
               FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id) AS phan_list,
            (SELECT string_agg(DISTINCT dvg.nha_gia_cong, ', ')
               FROM lenh_sx_dot_vai lsg JOIN dot_vai_ve dvg ON dvg.id = lsg.dot_vai_ve_id
              WHERE lsg.lenh_san_xuat_id = ls.id AND dvg.nha_gia_cong IS NOT NULL) AS nha_gia_cong,
            ${DON_SUB('dh.ma_don_hang', 'don_list')},
            ${DON_SUB('kh.ten_khach_hang', 'khach_list')},
            sla.tg_vao, sla.sla_phut, sla.canh_bao_truoc_phut,
            info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim
     FROM tem t
     JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     LEFT JOIN LATERAL (
       SELECT mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim, kh.ten_khach_hang, dh.ma_don_hang
       FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
       JOIN phan_in pin ON pin.id = dv.phan_in_id JOIN ma_hang mh ON mh.id = pin.ma_hang_id
       JOIN don_hang dh ON dh.id = mh.don_hang_id JOIN khach_hang kh ON kh.id = dh.khach_hang_id
       WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY pin.ma_phan, dv.ma_dot_vai LIMIT 1
     ) info ON true
     LEFT JOIN LATERAL (
       SELECT tt.tg_vao, tr.thoi_gian_quy_dinh_phut AS sla_phut, tr.canh_bao_truoc_phut
       FROM lenh_sx_dot_vai lsd JOIN ton_tram tt ON tt.dot_vai_ve_id = lsd.dot_vai_ve_id
       JOIN tram tr ON tr.id = tt.tram_id
       WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY tt.tg_vao LIMIT 1
     ) sla ON true
     ${joinTich}
     WHERE ${conds.join(' AND ')}
     ORDER BY t.created_date`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), params);
  return rows;
}

// 2 lối vào của CÙNG câu trên — xem ghi chú `cheDo` ở `listTemGiao`.
const listTemSanSang = (q = {}) => listTemGiao({ ...q, cheDo: 'SAN_SANG' });
const listTemChoTich = (q = {}) => listTemGiao({ ...q, cheDo: 'CHO_TICH' });

// ─── TÍCH / BỎ TÍCH (mig 092) ────────────────────────────────────────────────────────────────
// Trả DANH SÁCH id THẬT SỰ đổi ⇒ service biết bấm 2 lần thì lần sau không ghi audit rỗng.
// ⚠ Guard nằm NGAY TRONG câu UPDATE (không đọc-rồi-ghi): 2 người cùng tích 1 tem thì người sau
//   `RETURNING` rỗng chứ không ghi đè mốc của người trước.
async function tichTem(client, temIds, actorId) {
  const { rows } = await client.query(
    `UPDATE tem SET da_tich_giao = true, tg_tich_giao = CURRENT_TIMESTAMP, nguoi_tich_giao_id = $2,
        updated_by = $2, updated_date = CURRENT_TIMESTAMP
      WHERE id = ANY($1::uuid[]) AND NOT da_tich_giao AND trang_thai <> 'HUY'
        AND (sl_oqc_dat - sl_da_giao) > 0
      RETURNING id, ma_tem`,
    [temIds, actorId]
  );
  return rows;
}

// ⚠⚠ CHẶN BỎ TÍCH KHI TEM ĐÃ VÀO PHIẾU GIAO: bỏ tích lúc đó chỉ làm tem biến mất khỏi màn Giao
//   trong khi phiếu vẫn còn dòng của nó ⇒ kho không hiểu vì sao. Muốn gỡ thì xử ở phiếu giao.
// ⚠ PHIẾU ĐÃ HỦY thì KHÔNG tính (`gh.trang_thai <> 'HUY'`): hủy phiếu là trả tem về màn Giao, giữ
//   nguyên chặn ở đây thì tem vĩnh viễn không bỏ tích được vì một tờ phiếu không còn hiệu lực.
async function boTichTem(client, temIds, actorId) {
  const { rows } = await client.query(
    `UPDATE tem SET da_tich_giao = false, tg_tich_giao = NULL, nguoi_tich_giao_id = NULL,
        updated_by = $2, updated_date = CURRENT_TIMESTAMP
      WHERE id = ANY($1::uuid[]) AND da_tich_giao
        AND NOT EXISTS (SELECT 1 FROM giao_hang_tem gt JOIN giao_hang gh ON gh.id = gt.giao_hang_id
                         WHERE gt.tem_id = tem.id AND COALESCE(gh.trang_thai,'') <> 'HUY')
      RETURNING id, ma_tem`,
    [temIds, actorId]
  );
  return rows;
}

// Tem nào trong danh sách đang nằm trong phiếu giao CÒN HIỆU LỰC ⇒ service báo rõ lý do thay vì im
// lặng bỏ qua. (Phiếu đã hủy không tính — xem ghi chú ở `boTichTem`.)
async function temDaVaoPhieu(temIds) {
  const { rows } = await query(
    `SELECT DISTINCT t.id, t.ma_tem, string_agg(DISTINCT gh.ma_phieu_giao, ', ') AS phieu
       FROM tem t JOIN giao_hang_tem gt ON gt.tem_id = t.id
       JOIN giao_hang gh ON gh.id = gt.giao_hang_id
      WHERE t.id = ANY($1::uuid[]) AND COALESCE(gh.trang_thai,'') <> 'HUY'
      GROUP BY t.id, t.ma_tem`,
    [temIds]
  );
  return rows;
}

// Ghi vết tích/bỏ tích — 1 dòng `audit_log` cho MỖI tem (`id_ban_ghi = tem.id`) để tra ngược từ tem
// ra được ai tích. ⚠ Đây cũng là chỗ DUY NHẤT còn dấu vết sau khi rollback mig 092 (3 cột bị gỡ).
async function ghiAuditTich(hanhDong, tems, actorId) {
  if (!tems.length) return;
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     SELECT 'tem', x.id, $2, jsonb_build_object('ma_tem', x.ma_tem), $3, CURRENT_TIMESTAMP, $3
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, ma_tem text)`,
    [JSON.stringify(tems.map((t) => ({ id: String(t.id), ma_tem: t.ma_tem }))), hanhDong, actorId]
  );
}

// TRA CỨU 1 MÃ QUÉT — nói rõ VÌ SAO không thấy thay vì để người quét đoán (khuôn `traCuuMaQuet`
// của READY, §6). Nhận mọi nhãn công đoạn: `timTem` bỏ 2 số đầu rồi khớp 10 số cuối.
async function traCuuTemTich(code) {
  const coCot = await coCotTichGiao();
  const { rows } = await query(
    `SELECT t.id, t.ma_tem, t.trang_thai, t.sl_oqc_dat, t.sl_da_giao,
            (t.sl_oqc_dat - t.sl_da_giao) AS con_giao,
            ${coCot ? 't.da_tich_giao, t.tg_tich_giao, ndt.ho_ten AS nguoi_tich_giao' : 'false AS da_tich_giao, NULL::timestamptz AS tg_tich_giao, NULL::text AS nguoi_tich_giao'}
       FROM tem t
       ${coCot ? 'LEFT JOIN nguoi_dung ndt ON ndt.id = t.nguoi_tich_giao_id' : ''}
      WHERE t.ma_tem ~* $1 ORDER BY t.created_date DESC LIMIT 1`.replace(/\s+/g, ' '),
    [mauTim(timTem(code))]
  );
  return rows[0] || null;
}

async function donHangIdsForTems(temIds) {
  const { rows } = await query(
    `SELECT DISTINCT dh.id
     FROM tem t
     JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
     JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
     JOIN phan_in pin ON pin.id = dv.phan_in_id
     JOIN ma_hang mh ON mh.id = pin.ma_hang_id
     JOIN don_hang dh ON dh.id = mh.don_hang_id
     WHERE t.id = ANY($1::uuid[])`,
    [temIds]
  );
  return rows.map((r) => r.id);
}

async function nextMaPhieuGiao() {
  const { rows } = await query(
    `SELECT 'PG' || LPAD((COALESCE(MAX(NULLIF(regexp_replace(ma_phieu_giao,'\\D','','g'),''))::int,0)+1)::text, 4, '0') AS ma
     FROM giao_hang`
  );
  return rows[0].ma;
}

// Mã ERP cấp có thể trùng phiếu đã có (ERP restart / đếm lại) — `ma_phieu_giao` là UNIQUE nên phải
// biết TRƯỚC transaction, không thì INSERT nổ giữa chừng.
async function maPhieuGiaoDaDung(ma) {
  const { rows } = await query('SELECT 1 FROM giao_hang WHERE ma_phieu_giao = $1 LIMIT 1', [ma]);
  return rows.length > 0;
}

// ⚠⚠ DÒ CỘT `giao_hang_tai` TRƯỚC rồi mới dựng câu INSERT (khuôn `temCoCot` mig 066) — cột thêm ở
//   mig 099, SAU khi bảng đã lên production. TUYỆT ĐỐI KHÔNG try/catch quanh INSERT: hàm này chạy
//   TRONG transaction, lỗi `42703` làm ABORT cả transaction ⇒ câu "thử lại" chết tiếp với `25P02`
//   và người dùng mất luôn phiếu giao đang lập.
async function createGiaoHang(client, { maPhieu, donHangId, ngayGiao, ghiChu, giaoHangTai }, actorId) {
  const co = await coCotGiaoHangTai();
  // Dựng cột + tham số SONG SONG để số thứ tự `$n` không lệch giữa 2 nhánh.
  const cot = ['ma_phieu_giao', 'don_hang_id', 'ngay_giao', 'ghi_chu', ...(co ? ['giao_hang_tai'] : []), 'created_by'];
  const val = [maPhieu, donHangId, ngayGiao || null, ghiChu || null, ...(co ? [giaoHangTai || null] : []), actorId];
  const holder = cot.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `INSERT INTO giao_hang (${cot.join(', ')}, trang_thai) VALUES (${holder}, 'TAO') RETURNING id`.replace(/\s+/g, ' '),
    val
  );
  return rows[0].id;
}

// Dò 1 lần, CHỈ cache khi ĐÃ CÓ cột ⇒ chạy migration xong nhận ngay, không phải restart BE.
let _coGiaoHangTai = null;
async function coCotGiaoHangTai() {
  if (_coGiaoHangTai) return true;
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'giao_hang' AND column_name = 'giao_hang_tai' LIMIT 1`.replace(/\s+/g, ' ')
  );
  _coGiaoHangTai = rows.length > 0;
  return _coGiaoHangTai;
}

// Thêm tem vào phiếu giao TỪNG PHẦN, TÁCH THEO NGUỒN (KCS 15- / SỬA 17- — như OQC).
// so_luong bị chặn theo SL CÒN GIAO của ĐÚNG nguồn: KCS = (sl_oqc_dat−sl_oqc_dat_sua)−(sl_da_giao−sl_da_giao_sua);
// SỬA = sl_oqc_dat_sua−sl_da_giao_sua. 1 tem có thể vào phiếu 2 dòng (KCS + SỬA) — khớp unique
// constraint `uq_giao_hang_tem_nguon (giao_hang_id, tem_id, nguon)`.
async function addTem(client, giaoHangId, temId, soLuong, nguon, actorId) {
  const src = nguon === 'SUA' ? 'SUA' : 'KCS';
  await client.query(
    `INSERT INTO giao_hang_tem (giao_hang_id, tem_id, nguon, so_luong_giao, created_by)
     SELECT $1, $2, $5, LEAST(COALESCE($4, sc.src_con), sc.src_con), $3
     FROM (SELECT CASE WHEN $5='SUA'
                    THEN GREATEST(0, COALESCE(t.sl_oqc_dat_sua,0)-COALESCE(t.sl_da_giao_sua,0))
                    ELSE GREATEST(0, (COALESCE(t.sl_oqc_dat,0)-COALESCE(t.sl_oqc_dat_sua,0))-(COALESCE(t.sl_da_giao,0)-COALESCE(t.sl_da_giao_sua,0)))
                  END AS src_con
           FROM tem t WHERE t.id = $2) sc
     ON CONFLICT (giao_hang_id, tem_id, nguon) DO UPDATE SET so_luong_giao = EXCLUDED.so_luong_giao`,
    [giaoHangId, temId, actorId, soLuong ?? null, src]
  );
}

// Các cột "thêm về sau" mà ĐƯỜNG IN PHIẾU cần — mỗi cái thuộc một migration khác nhau nên phải dò
// ĐỘC LẬP (bài học mig 077 ↔ 079: gộp 1 cờ thì môi trường chạy lẻ 1 migration sẽ chết nhánh kia).
//   · `giao_hang.giao_hang_tai`   (mig 099)
//   · `khach_hang.dia_chi(_giao)` (mig 099)
//   · `don_hang.bo_phan_bh`       (mig 090)
let _cotThem = null;
async function cotPhieuThem() {
  if (_cotThem && _cotThem.du) return _cotThem;      // chỉ cache khi ĐÃ đủ ⇒ chạy migration xong nhận ngay
  const { rows } = await query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name='giao_hang'  AND column_name='giao_hang_tai')
         OR (table_name='khach_hang' AND column_name IN ('dia_chi','dia_chi_giao'))
         OR (table_name='don_hang'   AND column_name='bo_phan_bh')`.replace(/\s+/g, ' ')
  );
  const co = (t, c) => rows.some((r) => r.table_name === t && r.column_name === c);
  _cotThem = {
    giaoHangTai: co('giao_hang', 'giao_hang_tai'),
    diaChi: co('khach_hang', 'dia_chi') && co('khach_hang', 'dia_chi_giao'),
    boPhanBh: co('don_hang', 'bo_phan_bh'),
  };
  _cotThem.du = _cotThem.giaoHangTai && _cotThem.diaChi && _cotThem.boPhanBh;
  return _cotThem;
}

async function getGiaoHang(giaoHangId) {
  // ⚠ Cột thiếu ⇒ trả NULL có ĐÚNG TÊN thay vì bỏ hẳn: bộ render phiếu chỉ cần khóa tồn tại, ô in ra
  //   để trống. Bỏ hẳn cột thì `renderMauPhieu` không tìm thấy khóa và người dùng tưởng mẫu hỏng.
  const c = await cotPhieuThem();
  const colGht = c.giaoHangTai ? 'gh.giao_hang_tai' : "NULL::text AS giao_hang_tai";
  const colDc = c.diaChi ? 'kh.dia_chi, kh.dia_chi_giao'
    : "NULL::text AS dia_chi, NULL::text AS dia_chi_giao";
  const colBp = c.boPhanBh ? 'dh.bo_phan_bh' : "NULL::text AS bo_phan_bh";
  const { rows } = await query(
    `SELECT gh.id, gh.ma_phieu_giao, gh.ngay_giao, gh.trang_thai, gh.ghi_chu, gh.created_date,
            ${colGht}, ${colDc}, ${colBp},
            dh.ma_don_hang, kh.ten_khach_hang,
            (SELECT count(*) FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id)::int AS so_tem,
            (SELECT COALESCE(SUM(gt.so_luong_giao),0)::int FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id) AS tong_sl
     FROM giao_hang gh
     LEFT JOIN don_hang dh ON dh.id = gh.don_hang_id
     LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
     WHERE gh.id = $1`,
    [giaoHangId]
  );
  return rows[0] || null;
}

// Cột chung của MỌI danh sách phiếu giao (danh sách · lịch sử · đã hoàn thành · hủy phiếu) — khai 1
// chỗ để 4 màn không lệch nhau khi thêm cột.
const PHIEU_COT = `gh.id, gh.ma_phieu_giao, gh.ngay_giao, gh.trang_thai, gh.ghi_chu, gh.created_date,
    dh.ma_don_hang, kh.ten_khach_hang,
    (SELECT count(*) FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id)::int AS so_tem,
    (SELECT COALESCE(SUM(gt.so_luong_giao),0)::int FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id) AS tong_sl,
    ndt.ho_ten AS nguoi_tao, ndu.ho_ten AS nguoi_cap_nhat`;
const PHIEU_FROM = `FROM giao_hang gh
    LEFT JOIN don_hang dh ON dh.id = gh.don_hang_id
    LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
    LEFT JOIN nguoi_dung ndt ON ndt.id = gh.created_by
    LEFT JOIN nguoi_dung ndu ON ndu.id = gh.updated_by`;
// Ô tìm 1-ô: mã phiếu · khách · và code phần / mã hàng của bất kỳ tem nào trong phiếu.
const PHIEU_TIM = (n) => `(${n} = '' OR gh.ma_phieu_giao ~* ${n} OR kh.ten_khach_hang ~* ${n}
    OR dh.ma_don_hang ~* ${n}
    OR EXISTS (SELECT 1 FROM giao_hang_tem gt_s JOIN tem t_s ON t_s.id = gt_s.tem_id
               JOIN phieu_san_xuat ps_s ON ps_s.id = t_s.phieu_san_xuat_id
                WHERE gt_s.giao_hang_id = gh.id
                  AND (t_s.ma_tem ~* ${n} OR ${lenhPhanInMatch('ps_s.lenh_san_xuat_id', n)})))`;

// Danh sách phiếu giao. `trangThai`: '' = tất cả · 'TAO'/'DA_GIAO'/'HUY'.
// `ngayTu`/`ngayDen` lọc theo NGÀY LẬP phiếu (giờ VN).
async function listGiaoHang({ search = '', trangThai = '', ngayTu = '', ngayDen = '' } = {}) {
  const p = [mauTim(search)];
  const dk = [PHIEU_TIM('$1')];
  if (trangThai) { p.push(trangThai); dk.push(`COALESCE(gh.trang_thai,'TAO') = $${p.length}`); }
  const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
  if (ngayTu) { p.push(ngayTu); dk.push(`((gh.created_date ${VN})::date) >= $${p.length}::date`); }
  if (ngayDen) { p.push(ngayDen); dk.push(`((gh.created_date ${VN})::date) <= $${p.length}::date`); }
  const { rows } = await query(
    `SELECT ${PHIEU_COT} ${PHIEU_FROM} WHERE ${dk.join(' AND ')} ORDER BY gh.created_date DESC`
      .replace(/\s+/g, ' '),
    p
  );
  return rows;
}

// ─── SIDEBAR "LỊCH SỬ" + "ĐÃ HOÀN THÀNH" (khuôn chung của các màn xác nhận) ───────────────────
// Lịch sử = mọi lượt thao tác phiếu giao trong NGÀY, gộp 3 nguồn:
//   · TẠO phiếu     ← chính `giao_hang.created_date` (không có audit riêng cho bước tạo)
//   · XÁC NHẬN GIAO ← `audit_log` `XAC_NHAN_GIAO`
//   · HỦY PHIẾU     ← `audit_log` `HUY_PHIEU_GIAO`
// ⚠ `id_ban_ghi` của `audit_log` là VARCHAR ⇒ so `gh.id::text`.
async function historyGiaoByDate(date) {
  const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
  const sql =
    `SELECT * FROM (
       SELECT gh.id, gh.created_date AS tg, nd.ho_ten AS nguoi, 'Tạo phiếu giao' AS hanh_dong,
              gh.ma_phieu_giao AS doi_tuong,
              concat_ws(' · ', kh.ten_khach_hang, dh.ma_don_hang,
                (SELECT count(*)::text || ' tem' FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id)) AS chi_tiet
         FROM giao_hang gh
         LEFT JOIN don_hang dh ON dh.id = gh.don_hang_id
         LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
         LEFT JOIN nguoi_dung nd ON nd.id = gh.created_by
        WHERE ((gh.created_date ${VN})::date) = $1::date
       UNION ALL
       SELECT gh.id, a.thoi_gian, nd.ho_ten,
              CASE a.hanh_dong WHEN 'XAC_NHAN_GIAO' THEN 'Xác nhận giao' ELSE 'Hủy phiếu giao' END,
              gh.ma_phieu_giao,
              COALESCE(a.gia_tri_moi->>'ly_do',
                       concat_ws(' · ', 'SL ' || COALESCE(a.gia_tri_moi->>'tong_sl',''),
                                 COALESCE(a.gia_tri_moi->>'so_tem','') || ' tem'))
         FROM audit_log a
         JOIN giao_hang gh ON gh.id::text = a.id_ban_ghi
         LEFT JOIN nguoi_dung nd ON nd.id = a.nguoi_thuc_hien_id
        WHERE a.ten_bang = 'giao_hang' AND a.hanh_dong IN ('XAC_NHAN_GIAO','HUY_PHIEU_GIAO')
          AND ((a.thoi_gian ${VN})::date) = $1::date
     ) z ORDER BY z.tg DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [date]);
  return rows;
}

// Đã hoàn thành = phiếu ĐÃ XÁC NHẬN GIAO trong ngày. 1 dòng = 1 PHIẾU (đơn vị điều hành của màn này).
// ⚠ Mốc `tg` ưu tiên audit `XAC_NHAN_GIAO`; phiếu cũ chưa có audit thì lùi về `updated_date`.
// ⚠ `ma` = mã phiếu (DonePanel dùng khóa `ma` làm cột mã + ô tìm kiếm).
async function doneGiaoByDate(date) {
  const VN = "AT TIME ZONE 'Asia/Ho_Chi_Minh'";
  const sql =
    `SELECT gh.id, gh.ma_phieu_giao AS ma, gh.ma_phieu_giao, gh.ngay_giao, gh.ghi_chu,
            dh.ma_don_hang, kh.ten_khach_hang,
            (SELECT count(*) FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id)::int AS so_tem,
            (SELECT COALESCE(SUM(gt.so_luong_giao),0)::int FROM giao_hang_tem gt WHERE gt.giao_hang_id = gh.id) AS so_luong,
            COALESCE(a.thoi_gian, gh.updated_date, gh.created_date) AS tg,
            COALESCE(nda.ho_ten, ndu.ho_ten) AS nguoi
       FROM giao_hang gh
       LEFT JOIN don_hang dh ON dh.id = gh.don_hang_id
       LEFT JOIN khach_hang kh ON kh.id = dh.khach_hang_id
       LEFT JOIN nguoi_dung ndu ON ndu.id = gh.updated_by
       LEFT JOIN LATERAL (SELECT a2.thoi_gian, a2.nguoi_thuc_hien_id FROM audit_log a2
            WHERE a2.ten_bang = 'giao_hang' AND a2.id_ban_ghi = gh.id::text
              AND a2.hanh_dong = 'XAC_NHAN_GIAO' ORDER BY a2.thoi_gian DESC LIMIT 1) a ON true
       LEFT JOIN nguoi_dung nda ON nda.id = a.nguoi_thuc_hien_id
      WHERE gh.trang_thai = 'DA_GIAO'
        AND ((COALESCE(a.thoi_gian, gh.updated_date, gh.created_date) ${VN})::date) = $1::date
      ORDER BY tg DESC`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [date]);
  return rows;
}

// ─── HỦY PHIẾU GIAO (tab ở *Hệ thống → Hủy lệnh xác nhận*) ────────────────────────────────────
// Phiếu hủy được = chưa bị hủy. Bao gồm cả phiếu ĐÃ GIAO — hủy nó là ĐẢO sổ cái, tem quay lại màn
// *Danh sách tem giao*.
async function listPhieuGiaoCancelable({ search = '' } = {}) {
  const { rows } = await query(
    `SELECT ${PHIEU_COT} ${PHIEU_FROM}
      WHERE COALESCE(gh.trang_thai,'TAO') <> 'HUY' AND ${PHIEU_TIM('$1')}
      ORDER BY gh.created_date DESC LIMIT 500`.replace(/\s+/g, ' '),
    [mauTim(search)]
  );
  return rows;
}

// Tem của phiếu mà sổ cái KHÔNG đủ để trừ ngược (đã bị đường khác trừ mất) — chặn TRƯỚC khi ghi,
// nếu không sổ cái sẽ âm/lệch mà không ai biết.
async function temThieuSoDeHuy(giaoHangId) {
  const { rows } = await query(
    `SELECT t.ma_tem, t.sl_da_giao, t.sl_da_giao_sua, gt.so_luong_giao, gt.nguon
       FROM giao_hang_tem gt JOIN tem t ON t.id = gt.tem_id
      WHERE gt.giao_hang_id = $1
        AND (COALESCE(t.sl_da_giao,0) < COALESCE(gt.so_luong_giao,0)
          OR (gt.nguon = 'SUA' AND COALESCE(t.sl_da_giao_sua,0) < COALESCE(gt.so_luong_giao,0)))`,
    [giaoHangId]
  );
  return rows;
}

// ĐẢO sổ cái đã giao của 1 phiếu + tính lại trạng thái dominant của từng tem.
// ⚠⚠ Gương ĐỐI XỨNG với `applyGiaoLedger` (cộng ↔ trừ) — sửa một bên thì soát lại bên kia, lệch là
//   sổ cái số lượng sai vĩnh viễn (DATABASE.md §11.4).
// ⚠ `GREATEST(0, …)` là lưới an toàn cuối, KHÔNG thay cho guard `temThieuSoDeHuy`: kẹp về 0 âm thầm
//   là giấu mất một sự cố dữ liệu.
async function revertGiaoLedger(client, giaoHangId, actorId) {
  const { rows } = await client.query(
    'SELECT tem_id, so_luong_giao, nguon FROM giao_hang_tem WHERE giao_hang_id=$1', [giaoHangId]
  );
  for (const r of rows) {
    await client.query(
      `UPDATE tem SET sl_da_giao = GREATEST(0, COALESCE(sl_da_giao,0) - COALESCE($2,0)),
          sl_da_giao_sua = GREATEST(0, COALESCE(sl_da_giao_sua,0)
            - CASE WHEN $4='SUA' THEN COALESCE($2,0) ELSE 0 END),
          updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
      [r.tem_id, r.so_luong_giao, actorId, r.nguon]
    );
    await qaRepo.recomputeTemStageMany(client, [r.tem_id], actorId);
  }
  return rows.map((r) => r.tem_id);
}

async function markGiaoHuy(client, giaoHangId, actorId) {
  await client.query(
    `UPDATE giao_hang SET trang_thai='HUY', updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [giaoHangId, actorId]
  );
}

async function insertHuyPhieuAudit(giaoHangId, gh, lyDo, actorId) {
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('giao_hang', $1, 'HUY_PHIEU_GIAO', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(giaoHangId), JSON.stringify({
      ma_phieu_giao: gh.ma_phieu_giao, trang_thai_cu: gh.trang_thai,
      so_tem: gh.so_tem, tong_sl: gh.tong_sl, ly_do: lyDo,
    }), actorId]
  );
}

// Dòng tem của 1 phiếu giao. Trả ĐỦ thông tin để IN PHIẾU (code phần · mã hàng · màu · kích) — bản
// cũ chỉ có mã tem + mã lệnh nên phiếu in ra không đọc được là hàng gì.
// ⚠ `tem` KHÔNG lưu phần in (giới hạn đã biết, DATABASE.md §4) ⇒ phải đi vòng qua LỆNH:
//   `phan_list` gộp MỌI code phần của lệnh (lệnh gom set có nhiều), còn mã hàng/màu/kích lấy dòng
//   ĐẠI DIỆN như `listTemSanSang`. Kiểu in GỘP nhóm theo chính `phan_list` nên vẫn nhất quán.
// ⚠ KHÔNG đặt comment `--` trong chuỗi SQL: nó bị `.replace(/\s+/g,' ')` gộp 1 dòng (§9).
async function getGiaoHangTems(giaoHangId) {
  const sql =
    // ⚠ `gt.ghi_chu` + SL OQC đạt phục vụ 2 cột tùy chọn của mẫu phiếu (xem `TRUONG_DONG_PHIEU`).
    //   Trả CẢ `sl_oqc_dat_sua` để FE lấy đúng số theo NGUỒN của dòng: nguồn SỬA thì SL đạt là
    //   `sl_oqc_dat_sua`, nguồn KCS là phần còn lại — lấy nhầm là in ra số lớn hơn thực tế.
    `SELECT gt.id, gt.tem_id, gt.so_luong_giao, gt.nguon, gt.ghi_chu, t.ma_tem, t.trang_thai,
            COALESCE(t.sl_oqc_dat,0) AS sl_oqc_dat, COALESCE(t.sl_oqc_dat_sua,0) AS sl_oqc_dat_sua,
            (t.tem_goc_id IS NOT NULL) AS la_tem_sua,
            ls.ma_lenh_san_xuat,
            (SELECT string_agg(DISTINCT pin.ma_phan, ', ')
               FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
               JOIN phan_in pin ON pin.id = dv.phan_in_id WHERE lsd.lenh_san_xuat_id = ls.id) AS phan_list,
            info.ma_hang, info.mau_vai, info.kich_vai, info.kich_phim,
            info.ten_khach_hang, info.ma_don_hang
     FROM giao_hang_tem gt
     JOIN tem t ON t.id = gt.tem_id
     LEFT JOIN phieu_san_xuat ps ON ps.id = t.phieu_san_xuat_id
     LEFT JOIN lenh_san_xuat ls ON ls.id = ps.lenh_san_xuat_id
     LEFT JOIN LATERAL (
       SELECT mh.ma_hang, pin.mau_vai, pin.kich_vai, pin.kich_phim, kh.ten_khach_hang, dh.ma_don_hang
       FROM lenh_sx_dot_vai lsd JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
       JOIN phan_in pin ON pin.id = dv.phan_in_id JOIN ma_hang mh ON mh.id = pin.ma_hang_id
       JOIN don_hang dh ON dh.id = mh.don_hang_id JOIN khach_hang kh ON kh.id = dh.khach_hang_id
       WHERE lsd.lenh_san_xuat_id = ls.id ORDER BY pin.ma_phan, dv.ma_dot_vai LIMIT 1
     ) info ON true
     WHERE gt.giao_hang_id = $1
     ORDER BY t.ma_tem`;
  const { rows } = await query(sql.replace(/\s+/g, ' '), [giaoHangId]);
  return rows;
}

// Xác nhận giao: đóng phiếu. (Sổ cái sl_da_giao + recompute trạng thái tem xử lý ở service theo từng tem.)
async function markGiaoDone(client, giaoHangId, actorId) {
  await client.query(
    `UPDATE giao_hang SET trang_thai='DA_GIAO', ngay_giao=COALESCE(ngay_giao, CURRENT_DATE),
       updated_by=$2, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
    [giaoHangId, actorId]
  );
}

// Ghi audit_log khi xác nhận giao: ai giao, lúc nào, SL bao nhiêu (chi tiết từng tem).
async function insertGiaoAudit(giaoHangId, maPhieu, tems, actorId) {
  const tongSl = tems.reduce((s, t) => s + (Number(t.so_luong_giao) || 0), 0);
  const chiTiet = {
    ma_phieu_giao: maPhieu, so_tem: tems.length, tong_sl: tongSl,
    tems: tems.map((t) => ({ ma_tem: t.ma_tem, so_luong_giao: Number(t.so_luong_giao) || 0 })),
  };
  await query(
    `INSERT INTO audit_log (ten_bang, id_ban_ghi, hanh_dong, gia_tri_moi, nguoi_thuc_hien_id, thoi_gian, created_by)
     VALUES ('giao_hang', $1, 'XAC_NHAN_GIAO', $2::jsonb, $3, CURRENT_TIMESTAMP, $3)`,
    [String(giaoHangId), JSON.stringify(chiTiet), actorId]
  );
}

// Cộng dồn đã giao cho tem + cập nhật trạng thái dominant (chỉ DA_GIAO khi đã giao đủ).
async function applyGiaoLedger(client, giaoHangId, actorId) {
  const { rows } = await client.query('SELECT tem_id, so_luong_giao, nguon FROM giao_hang_tem WHERE giao_hang_id=$1', [giaoHangId]);
  for (const r of rows) {
    await client.query(
      `UPDATE tem SET sl_da_giao = sl_da_giao + COALESCE($2,0),
          sl_da_giao_sua = COALESCE(sl_da_giao_sua,0) + CASE WHEN $4='SUA' THEN COALESCE($2,0) ELSE 0 END,
          updated_by=$3, updated_date=CURRENT_TIMESTAMP WHERE id=$1`,
      [r.tem_id, r.so_luong_giao, actorId, r.nguon]
    );
    // ⚠⚠ DÙNG CHUNG `recomputeTemStageMany` của quality.repository, KHÔNG chép lại biểu thức.
    //   Bản chép tay ở đây từng là BẢN SAO THỨ HAI của cùng một luật ⇒ mig 091 thêm `sl_sua_tach`
    //   vào nhánh `CHO_OQC` mà quên chỗ này là tem gốc kẹt trạng thái `CHO_OQC` sau khi giao xong.
    await qaRepo.recomputeTemStageMany(client, [r.tem_id], actorId);
  }
  return rows.map((r) => r.tem_id);
}

module.exports = {
  listTemSanSang, listTemChoTich, donHangIdsForTems, nextMaPhieuGiao, maPhieuGiaoDaDung, createGiaoHang, addTem,
  getGiaoHang, listGiaoHang, getGiaoHangTems, markGiaoDone, applyGiaoLedger, insertGiaoAudit,
  coCotTichGiao, coCotGiaoHangTai, cotPhieuThem, tichTem, boTichTem, temDaVaoPhieu, traCuuTemTich, ghiAuditTich,
  historyGiaoByDate, doneGiaoByDate,
  listPhieuGiaoCancelable, temThieuSoDeHuy, revertGiaoLedger, markGiaoHuy, insertHuyPhieuAudit,
};
