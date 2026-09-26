'use strict';

const repo = require('./siso.repository');
const { MAN, LOAI_NGAY, O_SI_SO } = require('../../utils/siSoTram');
const { BANG_THEO_DOI, DO_SL } = require('../../utils/bangTheoDoi');
const AppError = require('../../utils/AppError');

// Ngày mặc định = HÔM NAY theo giờ VN (server có thể chạy múi giờ khác — đừng dùng new Date() trần).
const homNayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// `den` là ngày CUỐI (bao gồm) ⇒ chặn trên của kỳ = 00:00 ngày KẾ TIẾP.
const ngaySau = (d) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

function chuanHoaKy(q = {}) {
  const tu = /^\d{4}-\d{2}-\d{2}$/.test(q.tu || '') ? q.tu : homNayVN();
  const denNhap = /^\d{4}-\d{2}-\d{2}$/.test(q.den || '') ? q.den : tu;
  const den = denNhap < tu ? tu : denNhap;
  return { tu, den: ngaySau(den), denHienThi: den };
}

const LOC_KEYS = ['timKiem', 'khach', 'don', 'maHang', 'codePhan', 'mauVai', 'kichVai', 'kichPhim',
  'chuyen', 'nhaGiaCong', 'loaiNgay', 'ngayTu', 'ngayDen'];
const layLoc = (q = {}) => LOC_KEYS.reduce((a, k) => (q[k] ? { ...a, [k]: q[k] } : a), {});

// ─── BỘ LỌC CỦA TRANG (dải "Theo dõi" bám ô tìm + panel lọc + dải chip của màn) ──────────────
// Gửi lên với tiền tố `t_` để KHÔNG đụng bộ lọc riêng trong modal (2 tầng AND với nhau — xem
// `dungLocKep` ở repository). Thêm 3 khóa chip mà modal không có: loại chuyền · khu bàn · PA in.
// ⚠ `t_phuongAnIn` phải xét `!== ''` chứ không `if (v)`: **`'0'` = CHƯA XÁC ĐỊNH là chip THẬT**
//   ở màn Release 1, dùng `if (v)` thì chip đó im lặng không lọc gì.
// ⚠ Thêm khóa mới ở ĐÂY thì FE mới gửi lên được — thiếu là backend BỎ QUA IM LẶNG (không lỗi),
//   dải số không nhúc nhích và rất khó đoán ra.
const LOC_TRANG_KEYS = [...LOC_KEYS, 'phuongAnIn', 'loaiChuyen', 'maChuyen',
  // Ô TÍCH của trang (18/08/2026): "Chỉ hiện … bị trả về" · "Đã Ready / Chờ Ready" · ô lọc "Gom set".
  // ⚠ ĐÃ GỠ khóa `choQa` (20/08/2026) cùng ô tích "Chỉ chờ QA" ở màn Test Run - QA — xem
  //   `utils/siSoTram.js` (chỗ `LAT_CHO_QA` cũ) để biết vì sao lọc thêm nó làm hỏng ô "Làm được".
  'biTraVe', 'daReady', 'choReady', 'gomSet'];
const layLocTrang = (q = {}) => LOC_TRANG_KEYS.reduce((a, k) => {
  const v = q[`t_${k}`];
  return v !== undefined && v !== null && v !== '' ? { ...a, [k]: v } : a;
}, {});

// Danh sách đơn vị đếm của 1 màn — FE dựng nút chuyển đổi từ đây (màn 1 đơn vị thì tự ẩn nút).
// ⚠ `la_so_luong` = đơn vị này CỘNG số lượng (pcs) thay vì đếm đối tượng ⇒ FE hiện đơn vị đo
//   sau con số và KHÔNG dùng nó cho câu "N đợt vải".
const dsDonVi = (m) => Object.entries(m.donVis).map(([ma, d]) => ({
  ma, nhan: d.nhan, la_so_luong: !!d.do, don_vi_so: d.donViSo || null,
}));

// Danh mục cho FE dựng UI (tên màn, đơn vị, nhãn 4 ô, danh sách loại ngày phụ).
function danhMuc() {
  return {
    man: Object.entries(MAN).map(([ma, m]) => ({
      ma, ten: m.ten, don_vi: m.donVi, nhan: m.nhan, mac_dinh: m.macDinh, don_vis: dsDonVi(m),
    })),
    o: Object.entries(O_SI_SO).map(([ma, o]) => ({ ma, ten: o.ten })),
    loai_ngay: Object.entries(LOAI_NGAY).map(([ma, l]) => ({ ma, ten: l.ten })),
  };
}

async function siSo(maTrang, q) {
  if (!MAN[maTrang]) throw new AppError('Màn hình không có sĩ số', { status: 404, errorCode: 'MAN_LA' });
  const { tu, den, denHienThi } = chuanHoaKy(q);
  const m = MAN[maTrang];
  // ⚠ Đơn vị đếm do FE gửi (`donVi`); lạ / màn không hỗ trợ ⇒ repo tự lùi về mặc định của màn.
  const dv = repo.chonDonVi(m, q.donVi);
  const so = await repo.demSiSo(maTrang, {
    tu, den, loc: layLoc(q), locTrang: layLocTrang(q), donVi: dv.ma,
  });
  // ⚠ Bất biến PHẢI đúng theo mô hình khoảng [tg_vao, tg_ra). Lệch = có mục `tg_ra < tg_vao`
  //   (dữ liệu bẩn) lọt qua — trả cờ để FE hiện dấu hỏi thay vì im lặng cho số sai.
  const can = so.ton_dau + so.nhan - so.lam_duoc === so.ton_cuoi;
  // ⚠⚠ Nhãn đơn vị PHẢI là `don_vi_nhan`, KHÔNG được đặt tên `nhan` — trùng khóa với số "Nhận trong
  //   kỳ" ở `so.nhan` và sẽ ĐÈ MẤT nó (lỗi thật đã bắt được lúc kiểm: ô Nhận in ra chữ "đợt vải").
  // ⚠ Trả về ĐƠN VỊ ĐÃ CHỌN THẬT (`dv`), không phải mặc định của màn — FE cần biết mình đang xem
  //   theo gì để tô đúng nút toggle (lựa chọn cũ trong localStorage có thể đã bị lùi về mặc định).
  return {
    ...so, can, tu, den: denHienThi, ten_man: m.ten,
    don_vi: dv.ma, don_vi_nhan: dv.nhan, don_vis: dsDonVi(m), don_vi_mac_dinh: m.macDinh,
    la_so_luong: !!dv.do, don_vi_so: dv.donViSo || null,
  };
}

async function chiTiet(maTrang, o, q) {
  if (!MAN[maTrang]) throw new AppError('Màn hình không có sĩ số', { status: 404, errorCode: 'MAN_LA' });
  if (!O_SI_SO[o]) throw new AppError('Ô sĩ số không hợp lệ', { status: 422, errorCode: 'O_LA' });
  const { tu, den } = chuanHoaKy(q);
  // `limit=0` = lấy HẾT (xuất Excel). Trần 500 cho lượt phân trang thường.
  const limit = String(q.limit) === '0' ? 0 : Math.min(500, Math.max(1, Number(q.limit) || 20));
  const dv = repo.chonDonVi(MAN[maTrang], q.donVi);
  const { items, total } = await repo.chiTiet(maTrang, o, {
    tu, den, loc: layLoc(q), locTrang: layLocTrang(q), donVi: dv.ma, page: Number(q.page) || 1, limit,
  });
  return {
    items, meta: { total, page: Number(q.page) || 1, limit }, o, ten_o: O_SI_SO[o].ten,
    don_vi: dv.ma, don_vi_nhan: dv.nhan, la_so_luong: !!dv.do, don_vi_so: dv.donViSo || null,
  };
}

// Tóm tắt 1 ô theo NGÀY GIAO — nguồn cho popover khi hover ô "Tồn cuối" (Release 1 / Release 2).
async function tomTatNgayGiao(maTrang, o, q) {
  if (!MAN[maTrang]) throw new AppError('Màn hình không có sĩ số', { status: 404, errorCode: 'MAN_LA' });
  if (!O_SI_SO[o]) throw new AppError('Ô sĩ số không hợp lệ', { status: 422, errorCode: 'O_LA' });
  const { tu, den } = chuanHoaKy(q);
  const dv = repo.chonDonVi(MAN[maTrang], q.donVi);
  const rows = await repo.tomTatTheoNgayGiao(maTrang, o, {
    tu, den, loc: layLoc(q), locTrang: layLocTrang(q), donVi: dv.ma,
  });
  return {
    items: rows, o, ten_o: O_SI_SO[o].ten,
    don_vi: dv.ma, don_vi_nhan: dv.nhan, la_so_luong: !!dv.do, don_vi_so: dv.donViSo || null,
    // Tổng để FE tự đối chiếu với con số trên ô — lệch là biết ngay có gì sai.
    tong: rows.reduce((a, r) => ({
      so_doi_tuong: a.so_doi_tuong + r.so_doi_tuong, sl_vai: a.sl_vai + r.sl_vai, sl_dh: a.sl_dh + r.sl_dh,
    }), { so_doi_tuong: 0, sl_vai: 0, sl_dh: 0 }),
  };
}

// ─── BẢNG THEO DÕI 10 CHECKPOINT (Dashboard → Tổng quan) ─────────────────────
// Luật + danh mục: `utils/bangTheoDoi.js`. Truy vấn: `siso.repository.motDongBang`.
//
// ⚠⚠ CACHE 30s LÀ BẮT BUỘC, KHÔNG PHẢI TỐI ƯU CHO ĐẸP: 10 dòng = 10 query nặng (đo prod 20/09/2026:
//   **2,7 giây** khi chạy SONG SONG, dòng chậm nhất 2,6s). Trang Dashboard tải lại theo socket
//   BROADCAST ⇒ không cache thì mỗi lượt broadcast × N người đăng nhập là N×10 query nặng — đúng
//   cơ chế "càng nhiều người càng chậm" mà `utils/flowCache.js` sinh ra để chặn.
// ⚠ Cache giữ PROMISE (gộp cả những lượt gọi tới lúc query đang chạy) và **XÓA NGAY KHI LỖI** —
//   giữ promise reject lại là mọi lượt trong 30s kế tiếp cùng hỏng theo (bài học `metrics.js`).
// ⚠ Khóa cache gồm kỳ báo cáo: xem ngày khác nhau là 2 tập số khác nhau.
const TTL_BANG_MS = 30000;
const _nhoBang = new Map();

function bangCached(tu, den) {
  const khoa = `${tu}|${den}`;
  const cu = _nhoBang.get(khoa);
  if (cu && Date.now() - cu.at < TTL_BANG_MS) return cu.p;
  const p = tinhBang(tu, den).catch((e) => { _nhoBang.delete(khoa); throw e; });
  _nhoBang.set(khoa, { at: Date.now(), p });
  // Dọn khóa cũ — người dùng đổi ngày nhiều lần thì Map không phình mãi.
  if (_nhoBang.size > 8) {
    [..._nhoBang.entries()].filter(([, v]) => Date.now() - v.at > TTL_BANG_MS)
      .forEach(([k]) => _nhoBang.delete(k));
  }
  return p;
}

const slaCua = (dong, slaRows) => {
  if (!dong.sla) return null;
  const cap = dong.sla.checkpoint ? 'CHECKPOINT' : 'TRAM';
  const ma = dong.sla.checkpoint || dong.sla.tram;
  const r = slaRows.find((x) => x.cap === cap && x.ma === ma);
  return r && r.sla != null ? Number(r.sla) : null;
};

// %: Xong & Tồn cuối chia (Tồn đầu + Nhận) ⇒ 2 số cộng lại = 100%; Nghẽn chia TỒN CUỐI (nghẽn là
// tập con của tồn cuối). Người dùng chốt 20/09/2026. Mẫu số 0 ⇒ `null` (FE hiện "—", KHÔNG hiện 0%).
const pct = (tu, mau) => (mau > 0 ? Math.round((tu / mau) * 1000) / 10 : null);

async function tinhBang(tu, den) {
  const slaRows = await repo.dsSlaHienHanh();
  // ⚠ 10 dòng ĐỘC LẬP ⇒ chạy SONG SONG (mạng tới DB ~25ms/lượt là nút cổ chai — CLAUDE.md §11.5).
  const so = await Promise.all(BANG_THEO_DOI.map((d) => repo.motDongBang(d, slaCua(d, slaRows), { tu, den })));
  const rows = BANG_THEO_DOI.map((d, i) => {
    const r = so[i];
    const n = (k) => Number(r[k]) || 0;
    const vao = n('ton_dau_phan') + n('nhan_phan');
    const vaoSl = n('ton_dau_sl') + n('nhan_sl');
    return {
      ma: d.ma,
      ten: d.ten,
      ghi_chu: d.ghiChu,
      sla_phut: slaCua(d, slaRows),
      don_vi_sl: DO_SL[d.sl].nhan,
      ton_dau: { phan: n('ton_dau_phan'), sl: n('ton_dau_sl') },
      nhan: { phan: n('nhan_phan'), sl: n('nhan_sl') },
      xong: { phan: n('xong_phan'), sl: n('xong_sl'), pt: pct(n('xong_phan'), vao), pt_sl: pct(n('xong_sl'), vaoSl) },
      ton_cuoi: {
        phan: n('ton_cuoi_phan'), sl: n('ton_cuoi_sl'),
        pt: pct(n('ton_cuoi_phan'), vao), pt_sl: pct(n('ton_cuoi_sl'), vaoSl),
      },
      nghen: {
        phan: n('nghen_phan'), sl: n('nghen_sl'),
        pt: pct(n('nghen_phan'), n('ton_cuoi_phan')), pt_sl: pct(n('nghen_sl'), n('ton_cuoi_sl')),
      },
      // ⚠ Trả cờ cân để FE hiện ⚠ thay vì im lặng cho số sai (khuôn của `siSo()` ở trên).
      can: n('ton_dau_phan') + n('nhan_phan') - n('xong_phan') === n('ton_cuoi_phan'),
    };
  });
  return rows;
}

async function bangTheoDoi(q = {}) {
  const { tu, den, denHienThi } = chuanHoaKy(q);
  return { rows: await bangCached(tu, den), tu, den: denHienThi, ttl_ms: TTL_BANG_MS };
}

// DANH SÁCH PHẦN IN của 1 dòng bảng theo dõi (26/09/2026 — Dashboard bấm vào dòng ⇒ modal có toggle
// Tồn đầu · Nhận · Xong · Tồn cuối · Nghẽn). Kèm owner của trạm + SLA + mốc bắt đầu nghẽn từng phần in.
// ⚠ Không cache: chỉ gọi khi người dùng BẤM (1 query), khác bảng tổng tải lại theo socket broadcast.
async function bangTheoDoiChiTiet(ma, q = {}) {
  const dong = BANG_THEO_DOI.find((d) => d.ma === ma);
  if (!dong) throw new AppError('Dòng bảng theo dõi không hợp lệ', { status: 404, errorCode: 'NOT_FOUND' });
  const { tu, den, denHienThi } = chuanHoaKy(q);
  const slaRows = await repo.dsSlaHienHanh();
  const sla = slaCua(dong, slaRows);
  const [rows, owner] = await Promise.all([repo.dsDongBang(dong, sla, { tu, den }), repo.ownerCuaDong(dong)]);
  const phut = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);
  const items = rows.map((r) => {
    const tgRaHayMoc = r.tg_ra && new Date(r.tg_ra) < new Date(r.moc_do) ? r.tg_ra : r.moc_do;
    return {
      ...r,
      // Đã ở trạm (phút): tới lúc rời, hoặc tới mốc đo (cuối kỳ / bây giờ) nếu còn ở.
      phut_da_o: phut(r.tg_vao, tgRaHayMoc),
      // SLA thực của phần in này (luật theo giờ có thể khác SLA trạm) = mốc bắt đầu nghẽn − mốc vào.
      sla_phut: phut(r.tg_vao, r.tg_bat_dau_nghen),
      // Nghẽn bao lâu = từ mốc bắt đầu nghẽn tới mốc đo (chỉ khi đang nghẽn).
      phut_nghen: r.o_nghen ? phut(r.tg_bat_dau_nghen, r.moc_do) : null,
    };
  });
  return {
    ma: dong.ma, ten: dong.ten, man: dong.man, ghi_chu: dong.ghiChu, sla_phut: sla,
    don_vi_sl: DO_SL[dong.sl].nhan, owner, tu, den: denHienThi, items,
  };
}

module.exports = { siSo, chiTiet, danhMuc, tomTatNgayGiao, bangTheoDoi, bangTheoDoiChiTiet };
