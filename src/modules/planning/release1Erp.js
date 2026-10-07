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
    banin: catChuoi(d.ma_chuyen, 20),
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

/**
 * Đọc dữ liệu các lệnh, chia nhóm rồi gửi. Không ném lỗi. Trả { ok, bo_qua?, ly_do?, luot: [...] }.
 * @param {string[]} lenhIds
 * @param {string|null} actorId
 * @param {'RELEASE_1'|'KE_HOACH_TAM'|'REPLAN'} nguon
 */
async function guiTheoLenh(lenhIds, actorId = null, nguon = 'RELEASE_1') {
  const ids = [...new Set((lenhIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { ok: false, bo_qua: true, ly_do: 'THIEU_DU_LIEU', luot: [] };
  // ⚠ Kiểm bật/tắt TRƯỚC khi cấp IDMES — mỗi lần cấp là tiêu 1 số của dãy dùng chung.
  if (!(await apiBat(MA_API))) {
    console.log(`[${NHAN}] ⏸ ĐANG TẮT (Hệ thống > Cài đặt API) — bỏ qua ${ids.length} lệnh`);
    return { ok: false, bo_qua: true, ly_do: 'API_DANG_TAT', luot: [] };
  }
  const { rows } = await query(SQL_DONG, [ids]);
  if (!rows.length) return { ok: false, bo_qua: true, ly_do: 'KHONG_DU_LIEU', luot: [] };

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
  return { ok: luot.length > 0 && luot.every((k) => k.ok), luot };
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
  // Dòng gửi trước 07/10/2026 chưa có `Ngayca` (proc nay bắt buộc `@pNgayca`) ⇒ suy từ CHÍNH giờ/ngày kế hoạch
  //   trong thân cũ — vẫn là kế hoạch của lượt đó, không đọc lại lệnh.
  if (body.Ngayca == null) {
    body.Ngayca = catChuoi(ngayCaKeHoach(body.Tugio, body.Ngaykehoach, await napLoaiCa(), body.Loaichuyen), 20);
  }
  return goi(body, { idBanGhi, maTem, actorId, moTa: `gửi lại · lệnh ${maTem}` });
}

module.exports = {
  xepHang, xaHet, guiTheoLenh, guiLai, MA_API,
  // export để kiểm thực
  _banGhi: banGhi, _chiaNhom: chiaNhom, _chiaLo: chiaLo, _maLenhTuDs: maLenhTuDs,
};
