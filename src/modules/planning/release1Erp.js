'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GỬI DỮ LIỆU RELEASE 1 / KẾ HOẠCH LỆNH SANG ERP — POST /gui-erp-release-1 → proc `MES_spr_MES21X0`
// (04/10/2026, người dùng chốt proc + định dạng). Router ERP soạn sẵn: `docs/erp-router/gui-erp-release-1.js`.
//
// GỌI NGẦM sau 3 thao tác tạo/đổi kế hoạch của lệnh (`Nguon` trong body — router ERP bỏ qua, chỉ để đọc Lịch sử):
//   · `RELEASE_1`    — Xác nhận Release 1 (`planning.service.createRelease1`, kể cả chuyền gia công)
//   · `KE_HOACH_TAM` — Xác nhận kế hoạch tạm (cũng đi qua `createRelease1`)
//   · `REPLAN`       — Lập lại kế hoạch (`replan` / `replanBatch`) — gửi lại kế hoạch MỚI của lệnh
//   Đợt chưa Ready rơi vào kế hoạch tạm (chưa có lệnh) ⇒ CHƯA gửi; gửi lúc kế hoạch tạm được xác nhận.
//
// HỢP ĐỒNG PROC (12 tham số):
//   @pIDMES int · @pnhanvien nvarchar(20) · @pbanin nvarchar(20) · @pLoaichuyen nvarchar(20)
//   · @pNgaykehoach / @pTugio / @pDengio datetime · @pInset int · @pBarcodeHKT nvarchar(20) · @pPain int
//   · @pDsRelease nvarchar(4000) · @pNgayca nvarchar(20) (07/10/2026 — body `Ngayca`)
// `Ngayca` = mã ngày ca của KẾ HOẠCH, cùng định dạng tem (`260920C2` · `D2` ca Dài · `HC` hành chính): suy từ
//   GIỜ BẮT ĐẦU kế hoạch theo loại ca của tuần ở *Kế hoạch › Cài đặt* — luật ở `utils/ca.js ngayCaKeHoach`.
// `DsRelease` = các BẢN GHI 12 TRƯỜNG nối tiếp, TẤT CẢ ngăn bằng dấu phẩy (cùng khuôn `DsMaloi`):
//   MaLenh, IDDotNhanvai, DDHID, DDHsubID, BarcodePTHDH, CodePhan, Soluongrelease, Loaikd, Ngaynhanvai,
//   Hangiao, NGC, Duan
//   · 1 bản ghi = 1 (lệnh × đợt vải): Release 1 mỗi đợt ra 1 lệnh; lệnh cũ gom set / Tạo đợt SX có nhiều đợt.
//   · ⚠ BarcodePTHDH có thể là DANH SÁCH (prod 04/10/2026: 1.244 phần in, vd `26029448029,26029450029`) ⇒
//     đổi dấu phẩy giữa các mã thành `;` — để nguyên là LỆCH CỘT mọi bản ghi phía sau. Trường khác lỡ có dấu
//     phẩy ⇒ thay bằng khoảng trắng. Trường trống vẫn GIỮ CHỖ (`,,`) để proc đọc cứ 12 giá trị = 1 bản ghi.
//
// GOM LẦN GỌI — 1 lần gọi = 1 nhóm CÙNG phần đầu (chuyền · ngày · giờ KH · HSKT):
//   · Inset ≠ 0 (gom set — các code phần chung HSKT) ⇒ bản ghi của cả set nối tiếp vào 1 chuỗi.
//   · Inset = 0 ⇒ mỗi lệnh 1 lần gọi.
//   · Chuỗi > 4000 ký tự ⇒ chia nhiều lần gọi (mỗi lần 1 IDMES), cắt đúng ranh giới bản ghi.
// ⚠⚠ GOM THEO CỬA SỔ THỜI GIAN (`xepHang`): màn Kế hoạch tạm xác nhận hàng loạt bằng cách gọi API TỪNG DÒNG
//   một, Lập lại kế hoạch hàng loạt cũng chạy `replan` từng lệnh ⇒ gửi ngay trong mỗi lần gọi thì các phần
//   in inset bị tách thành nhiều lượt. Nên mọi lệnh của CÙNG người · CÙNG thao tác được dồn hàng chờ, đứng yên
//   `CHO_GOM_MS` thì mới đọc dữ liệu + chia nhóm + gửi (tối đa `CHO_TOI_DA_MS` kể từ lệnh đầu).
//   Hệ quả đã biết: BE tắt/khởi động lại đúng trong mấy giây chờ thì lượt đó MẤT (không có dòng Lịch sử).
//
// ⚠ KHÔNG BAO GIỜ NÉM LỖI ở đường ngầm — hỏng chiều đẩy không được chặn thao tác kế hoạch.
// ⚠ Ngày giờ gửi dạng GIỜ VN 'YYYY/MM/DD HH:mm:ss' (không đuôi Z): router `/gui-erp-release-1` tự dựng ngày
//   bằng `Date.UTC` như `/gui-erp-oqc` (chống lệch 7 tiếng — CLAUDE.md §11.4).
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../config/db');
const env = require('../../config/env');
const { apiBat } = require('../../utils/caiDatApi');
const { capIdMes } = require('../../utils/idMes');
const { ngayGioErp } = require('../../utils/erpNgayGio');
const { goiErp, tenDangNhap, catChuoi } = require('../../utils/erpApiChung');
const { ngayCaKeHoach } = require('../../utils/ca');
const { chuanMaChuyen } = require('../../utils/maChuyen');

const MA_API = 'ERP_GUI_RELEASE_1';
const NHAN = 'gui-erp-release-1';
const SO_TRUONG = 12;          // số trường mỗi bản ghi của DsRelease
const DAI_DS = 4000;           // @pDsRelease nvarchar(4000)
const CHO_GOM_MS = 3000;
const CHO_TOI_DA_MS = 15000;

// Loại đợt MES → mã `loaikd` ERP — ĐẢO đúng bảng map của đồng bộ (`erpsync LOAIKD_MAP`), không chép bảng mới.
// `MAU` (không có mã ERP) ⇒ ''. Lazy require: erpsync.service nạp nhiều module.
let _loaiKd = null;
function loaiKd(maLoai) {
  if (!_loaiKd) {
    const map = require('../erpsync/erpsync.service')._erp.LOAIKD_MAP;
    _loaiKd = Object.fromEntries(Object.entries(map).map(([erp, mes]) => [mes, erp]));
  }
  return _loaiKd[maLoai] || '';
}

// 1 dòng / (lệnh × đợt vải), giữ đúng thứ tự lệnh truyền vào. HSKT = hồ sơ ĐANG HOẠT ĐỘNG của phần in
// (cùng nguồn cột "Phương án in" ở Release 1). Lệnh HUY bị loại (bị hủy trong lúc chờ gom thì thôi gửi).
// ⚠ SL của đợt đọc `lenh_sx_dot_vai.so_luong` (DATABASE.md §4) — `so_luong_release` của lệnh chỉ là lối lùi
//   cho junction cũ chưa có SL.
const SQL_DONG = `
  SELECT ls.id::text AS lenh_id, ls.ma_lenh_san_xuat AS ma_lenh,
         ls.chuyen_id::text AS chuyen_id, cs.ma_chuyen, lc.ma_loai AS loai_chuyen,
         to_char(ls.ngay_ke_hoach, 'YYYY/MM/DD') AS ngay_ke_hoach,
         to_char(ls.tg_bd_kh AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY/MM/DD HH24:MI:SS') AS tu_gio,
         to_char(ls.tg_kt_kh AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY/MM/DD HH24:MI:SS') AS den_gio,
         COALESCE(lsd.so_luong, ls.so_luong_release, 0)::int AS sl_release,
         dv.barcode AS id_dot_nhan_vai, dh.ddh_id, pin.ddh_sub_id, pin.barcode AS barcode_phan_in, pin.ma_phan,
         ldv.ma_loai AS ma_loai_dot_vai,
         to_char(dv.ngay_vai_ve, 'YYYY-MM-DD') AS ngay_nhan_vai,
         to_char(dv.han_giao_hang, 'YYYY-MM-DD') AS han_giao,
         dv.nha_gia_cong, dv.du_an,
         hs.hskt_id, hs.barcode_hskt, COALESCE(hs.phuong_an_in, 0)::int AS pain,
         COALESCE(hs.inset, dv.inset, 0)::int AS inset
    FROM lenh_san_xuat ls
    JOIN lenh_sx_dot_vai lsd ON lsd.lenh_san_xuat_id = ls.id
    JOIN dot_vai_ve dv ON dv.id = lsd.dot_vai_ve_id
    JOIN phan_in pin ON pin.id = dv.phan_in_id
    JOIN ma_hang mh ON mh.id = pin.ma_hang_id
    JOIN don_hang dh ON dh.id = mh.don_hang_id
    LEFT JOIN loai_dot_vai ldv ON ldv.id = dv.loai_dot_vai_id
    LEFT JOIN chuyen_san_xuat cs ON cs.id = ls.chuyen_id
    LEFT JOIN loai_chuyen lc ON lc.id = cs.loai_chuyen_id
    LEFT JOIN LATERAL (SELECT h.id::text AS hskt_id, h.barcode_hskt, h.phuong_an_in, h.inset
                         FROM hskt_phan_in hp JOIN ho_so_ky_thuat h ON h.id = hp.hskt_id AND h.dang_hoat_dong
                        WHERE hp.phan_in_id = pin.id AND hp.dang_hoat_dong LIMIT 1) hs ON TRUE
   WHERE ls.id = ANY($1::uuid[]) AND ls.trang_thai <> 'HUY'
   ORDER BY array_position($1::uuid[], ls.id), pin.ma_phan, dv.ma_dot_vai`.replace(/\s+/g, ' ').trim();

const sach = (v) => (v == null ? '' : String(v).replace(/[\r\n]+/g, ' ').replace(/,/g, ' ').trim());
const dsMaVach = (v) => String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean).join(';');

// 1 bản ghi 12 trường — THỨ TỰ LÀ HỢP ĐỒNG với proc, đổi là ERP đọc sai cả chuỗi.
function banGhi(r) {
  return [
    r.ma_lenh,              // MaLenh
    r.id_dot_nhan_vai,      // IDDotNhanvai (IDDotReady)
    r.ddh_id,               // DDHID
    r.ddh_sub_id,           // DDHsubID
    dsMaVach(r.barcode_phan_in), // BarcodePTHDH (danh sách ngăn bằng ;)
    r.ma_phan,              // CodePhan
    r.sl_release,           // Soluongrelease
    loaiKd(r.ma_loai_dot_vai), // Loaikd 3I/5I/6I
    r.ngay_nhan_vai,        // Ngaynhanvai yyyy-MM-dd
    r.han_giao,             // Hangiao yyyy-MM-dd
    r.nha_gia_cong,         // NGC
    r.du_an,                // Duan
  ].map(sach).join(',');
}

function chiaNhom(rows) {
  const nhom = new Map();
  for (const r of rows) {
    const dau = [r.chuyen_id, r.ngay_ke_hoach, r.tu_gio, r.den_gio].join('|');
    const k = `${dau}|${Number(r.inset) !== 0 && r.hskt_id ? `H:${r.hskt_id}` : `L:${r.lenh_id}`}`;
    if (!nhom.has(k)) nhom.set(k, []);
    nhom.get(k).push(r);
  }
  return [...nhom.values()];
}

// Chia bản ghi thành các lô ≤ 4000 ký tự, cắt đúng ranh giới bản ghi (cắt cụt sẽ xé đôi 1 bản ghi).
function chiaLo(dong) {
  const lo = [];
  let cur = [];
  let dai = 0;
  for (const r of dong) {
    const s = banGhi(r);
    if (cur.length && dai + 1 + s.length > DAI_DS) { lo.push(cur); cur = []; dai = 0; }
    dai += (cur.length ? 1 : 0) + s.length;
    cur.push({ r, s });
  }
  if (cur.length) lo.push(cur);
  return lo;
}

const dsMaLenh = (lo) => [...new Set(lo.map((x) => x.r.ma_lenh))].join(', ');

// Loại ca theo tuần (Kế hoạch › Cài đặt). Lỗi đọc ⇒ Map rỗng ⇒ mọi tuần coi là ca Ngắn — không chặn gửi.
async function napLoaiCa() {
  try {
    return await require('./planning.repository').caModeMap();
  } catch (e) { return new Map(); }
}

function taoBody(lo, { idMes, nhanvien, nguon, loaiCa }) {
  const d = lo[0].r; // phần đầu chung của cả nhóm (cùng chuyền/ngày/giờ/HSKT — xem `chiaNhom`)
  return {
    IDMES: idMes,
    nhanvien,
    banin: catChuoi(chuanMaChuyen(d.ma_chuyen), 20), // mã ERP (`M1A-1B` → `1A1B`, 09/10/2026)
    Loaichuyen: catChuoi(d.loai_chuyen, 20),
    Ngaykehoach: ngayGioErp(d.ngay_ke_hoach, 'VN'),
    Tugio: ngayGioErp(d.tu_gio, 'VN'),
    Dengio: ngayGioErp(d.den_gio, 'VN'),
    Inset: Number(d.inset) || 0,
    BarcodeHKT: catChuoi(d.barcode_hskt, 20),
    Pain: Number(d.pain) || 0,
    DsRelease: catChuoi(lo.map((x) => x.s).join(','), DAI_DS),
    Ngayca: catChuoi(ngayCaKeHoach(d.tu_gio, d.ngay_ke_hoach, loaiCa, d.loai_chuyen), 20),
    Nguon: nguon,
  };
}

function goi(body, { idBanGhi, maTem, actorId, moTa }) {
  return goiErp(MA_API, {
    nhan: NHAN,
    url: env.erp.guiRelease1Url,
    method: 'POST',
    body,
    timeoutMs: env.erp.guiRelease1TimeoutMs,
    retry: env.erp.guiRelease1Retry,
    idBanGhi,
    maTem,
    moTa,
    actorId,
  });
}

// ─── HỦY KẾ HOẠCH CŨ TRƯỚC KHI LẬP LẠI (18/10/2026, người dùng yêu cầu) ──────
// Lập lại kế hoạch gửi lượt MỚI (IDMES mới) ⇒ trước đó ERP giữ cả kế hoạch cũ. Nay: TRƯỚC khi gửi, gọi
// `/gui-erp-release-1-huy` → proc `MES_spr_MES21X0_Huy(@pIDMES, @pNgayHuy, @pNguoiHuy, @pLydohuy)` cho mọi lượt
// cũ còn hiệu lực bên ERP chứa lệnh được lập lại. Router ERP soạn sẵn: `docs/erp-router/gui-erp-release-1-huy.js`.
//   · "Lượt cũ" = dòng lịch sử gửi THÀNH CÔNG `ERP_GUI_RELEASE_1` (cột `ma_tem` = danh sách mã lệnh của lượt, mỗi
//     IDMES 1 lượt — "Gửi lại" giữ IDMES) mà CHƯA có dòng hủy thành công `ERP_GUI_HUY_RELEASE_1` cùng IDMES.
//   · ⚠ 1 lượt có thể chứa NHIỀU lệnh (inset nối chung) — hủy cả lượt là ERP mất kế hoạch của các lệnh kia ⇒
//     lệnh khác trong lượt bị hủy mà lượt đó đang là lượt MỚI NHẤT của nó thì được GỬI LẠI cùng (kế hoạch hiện tại,
//     lệnh HUY tự bị `SQL_DONG` loại). Lệnh có lượt mới hơn ở nơi khác thì không cần.
//   · Hủy hỏng (ERP lỗi) ⇒ VẪN gửi kế hoạch mới (dòng hủy lỗi có nút "Gửi lại" ở Lịch sử). API hủy tắt ⇒ bỏ qua.
// Trả { themIds: lệnh cần gửi thêm, huy: [{ id_mes, ok, … }] }. Không ném lỗi.
const MA_API_HUY = 'ERP_GUI_HUY_RELEASE_1';
const LY_DO_HUY = 'Lập lại kế hoạch';

const SQL_LUOT = `
  SELECT a.gia_tri_moi->>'id_mes' AS id_mes, max(a.thoi_gian) AS tg,
         (array_agg(a.gia_tri_moi->>'ma_tem' ORDER BY a.thoi_gian DESC))[1] AS ma_tem,
         (array_agg(a.id_ban_ghi ORDER BY a.thoi_gian DESC))[1] AS id_ban_ghi
    FROM audit_log a
   WHERE a.ten_bang = 'lenh_san_xuat' AND a.hanh_dong = $2
     AND string_to_array(replace(COALESCE(a.gia_tri_moi->>'ma_tem', ''), ' ', ''), ',') && $1::text[]
     AND NOT EXISTS (SELECT 1 FROM audit_log h WHERE h.ten_bang = 'lenh_san_xuat' AND h.hanh_dong = $3
                      AND h.gia_tri_moi->>'id_mes' = a.gia_tri_moi->>'id_mes')
   GROUP BY 1`.replace(/\s+/g, ' ').trim();

const tachMa = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

async function luotChuaHuy(dsMa) {
  if (!dsMa.length) return [];
  const { rows } = await query(SQL_LUOT, [dsMa, MA_API, MA_API_HUY]);
  return rows.filter((r) => /^\d+$/.test(String(r.id_mes || ''))).map((r) => ({ ...r, ds: tachMa(r.ma_tem) }));
}

// Lượt MỚI NHẤT (chưa hủy) chứa từng mã lệnh.
function luotMoiNhat(luot) {
  const m = new Map();
  for (const l of luot) {
    for (const ma of l.ds) {
      const cu = m.get(ma);
      if (!cu || new Date(l.tg) > new Date(cu.tg)) m.set(ma, l);
    }
  }
  return m;
}

// `opts.lyDo` / `opts.nguon` — mặc định cho Lập lại kế hoạch; Hủy lệnh SX truyền lý do người hủy + `HUY_LENH`.
async function huyKeHoachCu(ids, actorId = null, { lyDo = LY_DO_HUY, nguon = 'REPLAN' } = {}) {
  try {
    const { rows: lenh } = await query(
      'SELECT id::text AS id, ma_lenh_san_xuat AS ma FROM lenh_san_xuat WHERE id = ANY($1::uuid[])', [ids]);
    const dsMa = lenh.map((l) => l.ma).filter(Boolean);
    const luot = await luotChuaHuy(dsMa);
    if (!luot.length) return { themIds: [], huy: [] };

    // Lệnh KHÁC nằm chung lượt bị hủy: gửi lại nếu lượt bị hủy đang là lượt mới nhất của nó.
    const idmesHuy = new Set(luot.map((l) => l.id_mes));
    const maKhac = [...new Set(luot.flatMap((l) => l.ds))].filter((ma) => !dsMa.includes(ma));
    let themMa = [];
    if (maKhac.length) {
      const moiNhat = luotMoiNhat(await luotChuaHuy(maKhac));
      themMa = maKhac.filter((ma) => moiNhat.has(ma) && idmesHuy.has(moiNhat.get(ma).id_mes));
    }
    let themIds = [];
    if (themMa.length) {
      const { rows } = await query(
        `SELECT id::text AS id FROM lenh_san_xuat WHERE ma_lenh_san_xuat = ANY($1::text[]) AND trang_thai <> 'HUY'`, [themMa]);
      themIds = rows.map((r) => r.id);
    }

    const erpHuy = require('../../utils/erpHuy');
    const NguoiHuy = await tenDangNhap(actorId);
    const NgayHuy = new Date();
    const huy = [];
    for (const l of luot.sort((a, b) => new Date(a.tg) - new Date(b.tg))) {
      // eslint-disable-next-line no-await-in-loop
      const kq = await erpHuy.guiHuyIdMes(
        { IDMES: Number(l.id_mes), NgayHuy, NguoiHuy, Lydohuy: String(lyDo || '').trim() || LY_DO_HUY, Nguon: nguon },
        { idBanGhi: l.id_ban_ghi && l.id_ban_ghi !== '-' ? l.id_ban_ghi : null, maHien: l.ma_tem, actorId, maApi: MA_API_HUY });
      huy.push({ ...kq, id_mes: Number(l.id_mes), ma_lenh: l.ma_tem });
      if (kq.bo_qua) break; // API hủy đang tắt — các lượt sau cũng vậy
    }
    // API hủy TẮT ⇒ không hủy gì ⇒ không cần gửi kèm lệnh khác (kế hoạch cũ của chúng vẫn nguyên bên ERP).
    if (huy.some((k) => k.bo_qua)) return { themIds: [], huy };
    return { themIds, huy };
  } catch (e) {
    console.error(`[${NHAN}] ✗ Không hủy được kế hoạch cũ bên ERP: ${e.message}`);
    return { themIds: [], huy: [], error: e.message };
  }
}

// ─── HỦY LỆNH SẢN XUẤT ⇒ BÁO ERP HỦY KẾ HOẠCH (18/10/2026, người dùng yêu cầu) ─────────────────────
// Gọi SAU khi lệnh đã `HUY` (transaction đã commit): `rollbackLenh` (tab *Hủy lệnh xác nhận › Hủy lệnh sản xuất*, cả
// hủy tùy chọn — và mọi đường gọi lại nó: Quản trị phần in · Trả về KT ở Sản xuất · GN "Hủy vải không in") + Test Run
// "Đổi phương án in". Hủy mọi lượt kế hoạch còn hiệu lực bên ERP chứa lệnh (cùng luật `huyKeHoachCu`), rồi GỬI LẠI
// kế hoạch hiện tại của các lệnh KHÁC nằm chung lượt bị hủy (inset) — `Nguon` `GUI_LAI_SAU_HUY`.
// Lệnh chưa từng gửi ERP thành công ⇒ không gọi gì. CHẠY NGẦM, KHÔNG NÉM LỖI — hủy ở MES đã xong.
// `Lydohuy` = lý do người hủy (router cắt 20 ký tự), trống ⇒ "Hủy lệnh sản xuất".
async function baoHuyLenh(lenhIds, actorId = null, lyDo = '') {
  const ids = [...new Set((lenhIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { themIds: [], huy: [] };
  const kq = await huyKeHoachCu(ids, actorId, { lyDo: String(lyDo || '').trim() || 'Hủy lệnh sản xuất', nguon: 'HUY_LENH' });
  if (kq.themIds.length) kq.gui_lai = await guiTheoLenh(kq.themIds, actorId, 'GUI_LAI_SAU_HUY');
  return kq;
}
function baoHuyLenhNgam(lenhIds, actorId = null, lyDo = '') {
  baoHuyLenh(lenhIds, actorId, lyDo).catch((e) => console.error(`[${NHAN}-huy] ✗ Báo ERP hủy kế hoạch lệnh lỗi: ${e.message}`));
}

/**
 * Đọc dữ liệu các lệnh, chia nhóm rồi gửi. Không ném lỗi. Trả { ok, bo_qua?, ly_do?, luot: [...] }.
 * @param {string[]} lenhIds
 * @param {string|null} actorId
 * @param {'RELEASE_1'|'KE_HOACH_TAM'|'REPLAN'} nguon
 */
async function guiTheoLenh(lenhIds, actorId = null, nguon = 'RELEASE_1') {
  let ids = [...new Set((lenhIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { ok: false, bo_qua: true, ly_do: 'THIEU_DU_LIEU', luot: [] };
  // ⚠ Kiểm bật/tắt TRƯỚC khi cấp IDMES — mỗi lần cấp là tiêu 1 số của dãy dùng chung.
  if (!(await apiBat(MA_API))) {
    console.log(`[${NHAN}] ⏸ ĐANG TẮT (Hệ thống > Cài đặt API) — bỏ qua ${ids.length} lệnh`);
    return { ok: false, bo_qua: true, ly_do: 'API_DANG_TAT', luot: [] };
  }
  // Lập lại kế hoạch ⇒ HỦY kế hoạch cũ bên ERP TRƯỚC (xem `huyKeHoachCu`), gửi kèm lệnh chung lượt bị hủy.
  let huy = null;
  if (nguon === 'REPLAN') {
    huy = await huyKeHoachCu(ids, actorId);
    if (huy.themIds.length) ids = [...new Set([...ids, ...huy.themIds])];
  }
  const { rows } = await query(SQL_DONG, [ids]);
  if (!rows.length) return { ok: false, bo_qua: true, ly_do: 'KHONG_DU_LIEU', luot: [], huy };

  const [nhanvien, loaiCa] = await Promise.all([tenDangNhap(actorId), napLoaiCa()]);
  const luot = [];
  for (const nhom of chiaNhom(rows)) {
    for (const lo of chiaLo(nhom)) {
      // eslint-disable-next-line no-await-in-loop
      const idMes = await capIdMes(NHAN);
      const maTem = dsMaLenh(lo);
      if (idMes == null) {
        console.error(`[${NHAN}] ✗ Không cấp được IDMES — bỏ qua lệnh ${maTem}`);
        luot.push({ ok: false, error: 'Không cấp được IDMES', ma_lenh: maTem });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const kq = await goi(taoBody(lo, { idMes, nhanvien, nguon, loaiCa }), {
        idBanGhi: lo[0].r.lenh_id, maTem, actorId, moTa: `${nguon} · lệnh ${maTem}`,
      });
      luot.push({ ...kq, ma_lenh: maTem, id_mes: idMes, so_ban_ghi: lo.length });
    }
  }
  return { ok: luot.length > 0 && luot.every((k) => k.ok), luot, huy };
}

// ─── HÀNG CHỜ GOM (xem ghi chú đầu file) ─────────────────────────────────────
const hangCho = new Map(); // `${actorId}|${nguon}` → { ids:Set, actorId, nguon, tgDau, timer }

function xa(k) {
  const h = hangCho.get(k);
  if (!h) return Promise.resolve(null);
  hangCho.delete(k);
  if (h.timer) clearTimeout(h.timer);
  return guiTheoLenh([...h.ids], h.actorId, h.nguon).catch((e) => {
    console.error(`[${NHAN}] ✗ Lỗi ngoài dự kiến (${h.nguon}, ${h.ids.size} lệnh): ${e.message}`);
    return null;
  });
}

// Bên gọi KHÔNG await — gọi SAU khi transaction tạo/đổi lệnh đã commit.
function xepHang(lenhIds, actorId, nguon = 'RELEASE_1') {
  try {
    const ids = (lenhIds || []).filter(Boolean).map(String);
    if (!ids.length) return;
    const k = `${actorId || '-'}|${nguon}`;
    let h = hangCho.get(k);
    if (!h) {
      h = { ids: new Set(), actorId: actorId || null, nguon, tgDau: Date.now(), timer: null };
      hangCho.set(k, h);
    }
    ids.forEach((id) => h.ids.add(id));
    if (h.timer) clearTimeout(h.timer);
    const cho = Math.max(0, Math.min(CHO_GOM_MS, h.tgDau + CHO_TOI_DA_MS - Date.now()));
    h.timer = setTimeout(() => { xa(k); }, cho);
  } catch (e) {
    console.error(`[${NHAN}] ✗ Không xếp được hàng chờ gửi ERP: ${e.message}`);
  }
}

// Gửi ngay mọi lượt đang chờ (kiểm thực / tắt máy có kiểm soát). Trả kết quả từng nhóm.
function xaHet() {
  return Promise.all([...hangCho.keys()].map((k) => xa(k)));
}

// ─── GỬI LẠI (Cài đặt API › Lịch sử) ─────────────────────────────────────────
// Gửi lại ĐÚNG thân đã gửi (giữ IDMES cũ + chuỗi DsRelease cũ) — KHÔNG dựng lại từ dữ liệu hiện tại: lệnh
// lập lại kế hoạch sau đó đã có lượt REPLAN riêng (IDMES mới); dựng lại bằng IDMES cũ là ghi đè chứng từ cũ
// bằng kế hoạch mới bên ERP.
function maLenhTuDs(ds) {
  const p = String(ds || '').split(',');
  const out = [];
  for (let i = 0; i < p.length; i += SO_TRUONG) if (p[i] && p[i].trim()) out.push(p[i].trim());
  return [...new Set(out)].join(', ');
}

async function guiLai(gui, { idBanGhi = null, actorId = null } = {}) {
  if (!gui || typeof gui !== 'object' || !gui.DsRelease) {
    return { ok: false, bo_qua: true, ly_do: 'THIEU_DU_LIEU' };
  }
  const maTem = maLenhTuDs(gui.DsRelease);
  const body = { ...gui };
  // Thân gửi trước 15:04 ngày 09/10/2026 mang mã chuyền MES (`M12B`, `M4A-4B`, `MRB1`…) ⇒ gửi lại đổi sang mã ERP
  //   (idempotent — mã đã chuẩn giữ nguyên). Chỉ đổi cách ghi mã, không đổi chuyền của lượt.
  body.banin = catChuoi(chuanMaChuyen(body.banin), 20);
  // Dòng gửi trước 07/10/2026 chưa có `Ngayca` (proc nay bắt buộc `@pNgayca`) ⇒ suy từ CHÍNH giờ/ngày kế hoạch
  //   trong thân cũ — vẫn là kế hoạch của lượt đó, không đọc lại lệnh.
  if (body.Ngayca == null) {
    body.Ngayca = catChuoi(ngayCaKeHoach(body.Tugio, body.Ngaykehoach, await napLoaiCa(), body.Loaichuyen), 20);
  }
  return goi(body, { idBanGhi, maTem, actorId, moTa: `gửi lại · lệnh ${maTem}` });
}

module.exports = {
  xepHang, xaHet, guiTheoLenh, guiLai, huyKeHoachCu, baoHuyLenh, baoHuyLenhNgam, MA_API, MA_API_HUY,
  // export để kiểm thực
  _banGhi: banGhi, _chiaNhom: chiaNhom, _chiaLo: chiaLo, _maLenhTuDs: maLenhTuDs,
};
