'use strict';

const repo = require('./thongbao.repository');
const tb = require('../../utils/thongBao');
const webPush = require('../../utils/webPush');
const sockets = require('../../sockets');
const AppError = require('../../utils/AppError');

// ─────────────────────────────────────────────────────────────────────────────
// THÔNG BÁO — nghiệp vụ. Danh mục + luật bật/tắt ở `utils/thongBao.js`.
//
// ⚠⚠ LUẬT BẬT/TẮT ÁP Ở **HAI CHỖ KHÁC NHAU**, đừng nhầm:
//   · `loaiBatCuaNguoi()` lọc DANH SÁCH/CHUÔNG người đó ĐƯỢC XEM (đọc).
//   · `banThongBao()` lọc NGƯỜI NHẬN lúc có sự kiện mới (ghi/đẩy).
//   Cả hai đều: hệ thống TẮT → không ai thấy/nhận; hệ thống BẬT → theo từng người.
// ─────────────────────────────────────────────────────────────────────────────

// Các MÃ LOẠI thông báo mà NGƯỜI NÀY đang bật VÀ được phép nhận.
// ⚠⚠ 3 tầng lọc, thiếu tầng nào cũng sai: (1) hệ thống bật · (2) cá nhân bật · (3) CÓ QUYỀN nhận
//   loại đó. Tầng (3) là tầng MỚI (18/08/2026): trước đây mọi loại đều về Kỹ thuật nên chỉ cần
//   kiểm quyền một lần ở ngoài; nay có loại chỉ dành cho NGƯỜI DUYỆT, thiếu tầng này thì kỹ thuật
//   nhìn thấy cả hàng đợi duyệt của người khác.
async function maLoaiBatCuaNguoi(user) {
  const heThong = await tb.layCaiDatHeThong();
  const cuaNguoi = await repo.layCaiDatNguoi(user.id);
  return Object.keys(tb.LOAI_TB).filter((ma) => heThong[ma] !== false
    && cuaNguoi[ma] !== false
    && tb.coQuyenNhanLoai(user.permissions || [], ma));
}

// Tách theo NGUỒN: nguồn `qc_tra_ve` cần mảng `qc_tra_ve.loai`, nguồn `yeu_cau_duyet` cần mã loại.
const tachNguon = (maLoaiBat) => ({
  loaiBat: maLoaiBat.filter((ma) => tb.LOAI_TB[ma].nguon === 'QC_TRA_VE')
    .map((ma) => tb.LOAI_TB[ma].loaiTraVe),
  loaiBatDuyet: maLoaiBat.filter((ma) => tb.LOAI_TB[ma].nguon === 'YEU_CAU_DUYET'),
});

// Giữ tên cũ cho các chỗ đang gọi (chỉ cần mảng `qc_tra_ve.loai`).
async function loaiBatCuaNguoi(userId) {
  const heThong = await tb.layCaiDatHeThong();
  const cuaNguoi = await repo.layCaiDatNguoi(userId);
  return tb.LOAI_QC
    .filter(([ma]) => heThong[ma] !== false && cuaNguoi[ma] !== false)
    .map(([, v]) => v.loaiTraVe);
}

// Tổng số chưa đọc của CẢ 2 NGUỒN.
async function tongChuaDoc(user, maLoaiBat) {
  const { loaiBat, loaiBatDuyet } = tachNguon(maLoaiBat);
  const [a, b] = await Promise.all([
    repo.demChuaDoc(user.id, loaiBat),
    repo.demChuaDocDuyet(user.id, loaiBatDuyet),
  ]);
  return a + b;
}

// Chuông: chỉ con số (gọi rất thường).
async function demChuaDoc(user) {
  if (!tb.coQuyenNhan(user.permissions)) return { so_chua_doc: 0, co_quyen: false };
  const maLoaiBat = await maLoaiBatCuaNguoi(user);
  return { so_chua_doc: await tongChuaDoc(user, maLoaiBat), co_quyen: true };
}

async function danhSach(user, q = {}) {
  if (!tb.coQuyenNhan(user.permissions)) return { items: [], meta: { total: 0 }, so_chua_doc: 0 };
  const maLoaiBat = await maLoaiBatCuaNguoi(user);
  const { loaiBat, loaiBatDuyet } = tachNguon(maLoaiBat);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
  const page = Math.max(1, Number(q.page) || 1);
  // ⚠ Ngày phải đúng dạng `YYYY-MM-DD` mới nhận — chuỗi rác từ client không được rơi vào SQL.
  const ngay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  const loc = {
    chuaDoc: String(q.chuaDoc) === 'true', timKiem: q.timKiem || '',
    tuNgay: ngay(q.tuNgay), denNgay: ngay(q.denNgay),
  };
  const maLoai = q.maLoai || '';

  // ⚠⚠ GỘP 2 NGUỒN Ở TẦNG JS, KHÔNG UNION trong SQL: 2 nguồn có bảng gốc + bộ JOIN hoàn toàn khác
  //   nhau, ép chung 1 câu sẽ ra một khối SQL rất dài (đúng thứ hay bị IPS reset — §9) mà không
  //   nhanh hơn. Đổi lại phải LẤY DƯ `offset + limit` dòng ở MỖI nguồn rồi mới cắt — lấy đúng
  //   `limit` mỗi bên thì trang 2 sẽ bỏ sót dòng của nguồn có nhiều bản ghi hơn.
  const canLay = (page - 1) * limit + limit;
  const [qc, duyet] = await Promise.all([
    repo.danhSach(user.id, { ...loc, loaiBat, maLoai, limit: canLay, offset: 0 }),
    repo.danhSachDuyet(user.id, { ...loc, loaiBatDuyet, maLoai, limit: canLay, offset: 0 }),
  ]);
  const gop = [...qc.items, ...duyet.items]
    .sort((a, b) => new Date(b.tg) - new Date(a.tg))
    .slice((page - 1) * limit, (page - 1) * limit + limit);

  const [soChuaDoc, chipQc] = await Promise.all([
    tongChuaDoc(user, maLoaiBat),
    repo.demTheoLoai(user.id, { ...loc, loaiBat }),
  ]);
  // Chip của nguồn DUYỆT: đếm riêng từng loại (nguồn này nhỏ, đếm bằng `total` là đủ nhẹ).
  const chip = { ...chipQc };
  for (const ma of loaiBatDuyet) {
    // eslint-disable-next-line no-await-in-loop
    const r = await repo.danhSachDuyet(user.id, { ...loc, loaiBatDuyet, maLoai: ma, limit: 1, offset: 0 });
    chip[ma] = r.total;
    chip[''] = (chip[''] || 0) + r.total;
  }

  return {
    items: gop,
    meta: { total: qc.total + duyet.total, page, limit },
    so_chua_doc: soChuaDoc,
    dem_chip: chip,
  };
}

async function danhDauDoc(user, ids) {
  if (!tb.coQuyenNhan(user.permissions)) return { so_dong: 0, so_chua_doc: 0 };
  const maLoaiBat = await maLoaiBatCuaNguoi(user);
  const { loaiBat, loaiBatDuyet } = tachNguon(maLoaiBat);
  const ds = Array.isArray(ids) ? ids : [];
  // ⚠ Đánh dấu ở CẢ 2 NGUỒN: danh sách đã gộp nên `ids` có thể lẫn id của cả hai; "đọc hết" cũng
  //   phải phủ cả hai, nếu không chuông vẫn đỏ vì còn nguồn kia chưa đọc.
  const [a, b] = await Promise.all([
    repo.danhDauDoc(user.id, ds, loaiBat),
    repo.danhDauDocDuyet(user.id, ds, loaiBatDuyet),
  ]);
  return { so_dong: a + b, so_chua_doc: await tongChuaDoc(user, maLoaiBat) };
}

// ─── CẤU HÌNH HỆ THỐNG (trang Hệ thống) ──────────────────────────────────────
async function layCaiDatHeThong() {
  let daLuu = [];
  let thieuBang = false;
  try { daLuu = await repo.layCaiDatHeThongRaw(); } catch (e) { thieuBang = true; }
  const m = Object.fromEntries(daLuu.map((r) => [r.ma_loai, r]));
  const dong = (ma, v, laCo) => ({
    ma_loai: ma, ten: v.ten, mo_ta: v.mo_ta, la_co_he_thong: !!laCo,
    bat: m[ma] ? m[ma].bat : true,
    ghi_chu: m[ma] ? m[ma].ghi_chu : null,
    updated_date: m[ma] ? m[ma].updated_date : null,
    nguoi_sua: m[ma] ? m[ma].nguoi_sua : null,
  });
  return {
    loai: Object.entries(tb.LOAI_TB).map(([ma, v]) => dong(ma, v, false)),
    co_he_thong: Object.entries(tb.CO_HE_THONG).map(([ma, v]) => dong(ma, v, true)),
    // ⚠ Trạng thái Web Push để admin biết vì sao bật `PUSH_NEN` mà vẫn không nhận được khi đóng app
    //   (thiếu VAPID key / chưa cài `web-push`) — thiếu dòng này thì rất khó chẩn đoán.
    push: webPush.trangThai(),
    thieu_bang: thieuBang,
  };
}

async function luuCaiDatHeThong(items, actorId) {
  if (!Array.isArray(items) || !items.length) {
    throw new AppError('Không có cấu hình nào để lưu', { status: 422, errorCode: 'RONG' });
  }
  for (const it of items) {
    if (!tb.laLoaiHopLe(it.ma_loai)) {
      throw new AppError(`Loại thông báo không hợp lệ: ${it.ma_loai}`, { status: 422, errorCode: 'LOAI_LA' });
    }
  }
  for (const it of items) await repo.luuCaiDatHeThong(it.ma_loai, it.bat, it.ghi_chu, actorId);
  tb.xoaCache(); // ⚠ BẮT BUỘC: cache RAM 30s, không xóa thì bấm xong 30s sau mới ăn
  sockets.emit('thong-bao:cai-dat', {});
  return { so_dong: items.length };
}

// ─── CẤU HÌNH CÁ NHÂN (trang Thông tin cá nhân) ──────────────────────────────
// ⚠ Trả CẢ trạng thái hệ thống để FE hiện rõ "đang bị TẮT ở mức hệ thống" thay vì để người dùng
//   bật toggle mà chẳng bao giờ nhận được gì.
async function layCaiDatCuaToi(user) {
  const heThong = await tb.layCaiDatHeThong();
  const cuaNguoi = await repo.layCaiDatNguoi(user.id);
  return {
    co_quyen: tb.coQuyenNhan(user.permissions),
    push_nen_he_thong: heThong.PUSH_NEN !== false,
    // ⚠⚠ CHỈ LIỆT KÊ LOẠI NGƯỜI NÀY THẬT SỰ NHẬN ĐƯỢC (21/08/2026): từ khi chuông hiện ở MỌI tài
    //   khoản, nếu vẫn đổ đủ 6 loại thì người ngoài diện nhận sẽ thấy một loạt toggle bật/tắt mà
    //   bật lên cũng chẳng bao giờ có thông báo nào — đúng kiểu "nút bấm cho vui".
    //   Danh sách rỗng ⇒ FE hiện câu giải thích thay vì bảng toggle trống.
    loai: Object.entries(tb.LOAI_TB)
      .filter(([ma]) => tb.coQuyenNhanLoai(user.permissions || [], ma))
      .map(([ma, v]) => ({
        ma_loai: ma, ten: v.ten, mo_ta: v.mo_ta,
        bat: cuaNguoi[ma] !== false,
        he_thong_bat: heThong[ma] !== false,
      })),
  };
}

async function luuCaiDatCuaToi(user, maLoai, bat) {
  if (!Object.hasOwn(tb.LOAI_TB, maLoai)) {
    throw new AppError('Loại thông báo không hợp lệ', { status: 422, errorCode: 'LOAI_LA' });
  }
  await repo.luuCaiDatNguoi(user.id, maLoai, bat);
  return layCaiDatCuaToi(user);
}

// ─── ĐĂNG KÝ WEB PUSH ────────────────────────────────────────────────────────
async function dangKyPush(user, sub) {
  const endpoint = sub && sub.endpoint;
  const keys = (sub && sub.keys) || {};
  if (!endpoint || !keys.p256dh || !keys.auth) {
    throw new AppError('Thiếu thông tin đăng ký push', { status: 422, errorCode: 'THIEU_SUB' });
  }
  await repo.luuPush(user.id, {
    endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: sub.userAgent,
  });
  return { da_dang_ky: true };
}

async function huyPush(endpoint) {
  if (endpoint) await repo.xoaPush(endpoint);
  return { da_huy: true };
}

// ─── BẮN THÔNG BÁO KHI CÓ PHẦN IN BỊ TRẢ VỀ ──────────────────────────────────
// Gọi SAU khi nghiệp vụ trả về đã ghi `qc_tra_ve` xong.
//
// ⚠⚠ KHÔNG BAO GIỜ NÉM LỖI: bên gọi (`traVeKyThuat`, `returnTestRunToReady`, `returnToTech`) đã
//   commit thay đổi nghiệp vụ rồi. Thông báo hỏng KHÔNG được phép làm hỏng thao tác trả về.
// ⚠ KHÔNG `await` ở bên gọi — Web Push có thể mất vài giây × nhiều thiết bị.
// ⚠ Vẫn nhận `actorId` từ 3 nơi gọi nhưng KHÔNG dùng nữa (xem chú thích ở bước 2) — giữ trong chữ ký
//   để nếu sau này muốn phân biệt "việc mình làm" thì có sẵn, khỏi sửa lại cả 3 call-site.
async function banThongBao({ loaiTraVe, phanInId }) {
  try {
    const maLoai = tb.LOAI_TRA_VE_TO_TB[loaiTraVe];
    if (!maLoai || !phanInId) return;

    // (1) Hệ thống tắt loại này → im lặng hoàn toàn.
    if (!(await tb.heThongBat(maLoai))) return;

    // (2) Ai được nhận (đã trừ người TẮT ở trang cá nhân).
    // ⚠⚠ KHÔNG loại người bấm trả về nữa — xem chú thích dài ở `utils/thongBao.nguoiNhan`.
    //   Tập này phải TRÙNG KHỚP với tập mà `danhSach` trả về, nếu không thì số trên chuông chỉ nhảy
    //   sau khi F5 (đúng lỗi người dùng báo 18/08/2026).
    const userIds = await tb.nguoiNhan(maLoai);
    if (!userIds.length) return;

    // (3) Socket cho các máy ĐANG MỞ app. Broadcast rồi client tự lọc theo quyền + cấu hình của nó
    //     (giống mọi event khác trong hệ — sockets/index.js không có room theo user).
    //     ⚠ Kèm `user_ids` để client biết event có dành cho mình không, đỡ gọi API vô ích.
    sockets.emit('thong-bao:moi', { ma_loai: maLoai, phan_in_id: phanInId, user_ids: userIds });

    // (4) Web Push cho máy ĐÃ ĐÓNG app — CHỈ khi cờ hệ thống `PUSH_NEN` bật.
    if (!(await tb.heThongBat('PUSH_NEN')) || !webPush.dungDuoc()) return;
    const subs = await repo.dsPushTheoUser(userIds);
    if (!subs.length) return;

    // Lấy nội dung từ chính bản ghi vừa ghi (dùng userId bất kỳ — cột `da_doc` không dùng ở đây).
    const ds = await repo.danhSach(userIds[0], {
      loaiBat: [loaiTraVe], limit: 1, offset: 0,
    });
    const tin = ds.items.find((x) => x.phan_in_id === phanInId) || ds.items[0];
    if (!tin) return;

    const kq = await webPush.guiNhieu(subs, {
      tieu_de: 'Phần in bị trả về',
      than: `${tin.ma_phan} · ${tin.ten_tram}${tin.checklist_list ? ` — ${tin.checklist_list}` : ''}`
        + `\n${tin.ly_do || ''}`.trimEnd(),
      duong_dan: `/ky-thuat/ready?q=${encodeURIComponent(tin.ma_phan || '')}`,
      the: `tra-ve-${tin.id}`,
    });
    if (kq.endpoint_chet.length) {
      // ⚠ Dọn NGAY endpoint chết — giữ lại là mỗi lượt gửi sau đều thất bại.
      await Promise.all(kq.endpoint_chet.map((e) => repo.xoaPush(e).catch(() => {})));
    }
    await repo.danhDauPushDaDung(subs.map((s) => s.endpoint).filter((e) => !kq.endpoint_chet.includes(e)));
  } catch (e) {
    console.error('[thong-bao] ✗ bắn thông báo lỗi (không ảnh hưởng thao tác trả về):', e.message);
  }
}

// ─── Bắn thông báo cho luồng DUYỆT (mig 086) ────────────────────────────────
// `su_kien`: 'MOI' (có yêu cầu chờ duyệt) · 'DA_DUYET' · 'TU_CHOI'.
// ⚠⚠ KHÔNG BAO GIỜ NÉM LỖI và bên gọi KHÔNG `await` — lúc gọi thì việc duyệt đã commit xong; push
//   có thể mất vài giây × nhiều thiết bị. Hỏng thông báo không được làm hỏng thao tác duyệt.
async function banThongBaoDuyet({
  loai, yeuCauId, su_kien: suKien, nguoiGui, nguoiDuyet, moTa,
  dsMaPhan, maPhanDau, paCuTen, paMoiTen,
}) {
  try {
    if (!yeuCauId) return;
    // Câu "Bàn → Máy" dùng chung cho mọi đích nhận.
    const nhanDoiPa = paCuTen && paMoiTen ? `Phương án in: ${paCuTen} → ${paMoiTen}` : '';
    const dsMaPhanDau = maPhanDau || '';
    // 1 sự kiện có thể bắn NHIỀU loại thông báo tới NHIỀU nhóm người khác nhau.
    const dich = [];
    if (suKien === 'MOI') {
      dich.push({ maLoai: 'DUYET_PA_IN_MOI', tieuDe: 'Có yêu cầu đổi phương án in chờ duyệt' });
    } else if (suKien === 'DA_DUYET' || suKien === 'TU_CHOI') {
      // Báo kết quả cho ĐÍCH DANH người gửi…
      dich.push({
        maLoai: 'DUYET_PA_IN_KET_QUA',
        userIds: [nguoiGui].filter(Boolean),
        tieuDe: suKien === 'DA_DUYET' ? 'Yêu cầu đổi phương án in đã được duyệt' : 'Yêu cầu đổi phương án in bị từ chối',
      });
      // …và báo KỸ THUẬT khi phương án in thật sự đổi (đổi luôn số cuối mã vạch HSKT).
      if (suKien === 'DA_DUYET') {
        dich.push({ maLoai: 'DUYET_PA_IN_DA_DOI', tieuDe: 'Phương án in đã được đổi' });
      }
    }

    for (const d of dich) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await tb.heThongBat(d.maLoai))) continue; // hệ thống tắt loại này → im lặng
      // eslint-disable-next-line no-await-in-loop
      const userIds = await tb.nguoiNhan(d.maLoai, d.userIds ? { userIds: d.userIds } : {});
      if (!userIds.length) continue;

      sockets.emit('thong-bao:moi', { ma_loai: d.maLoai, yeu_cau_id: yeuCauId, user_ids: userIds });

      // eslint-disable-next-line no-await-in-loop
      if (!(await tb.heThongBat('PUSH_NEN')) || !webPush.dungDuoc()) continue;
      // eslint-disable-next-line no-await-in-loop
      const subs = await repo.dsPushTheoUser(userIds);
      if (!subs.length) continue;
      // ⚠ Nội dung push phải nói RÕ: đổi CODE PHẦN NÀO, TỪ phương án in nào SANG cái nào — người
      //   nhận đọc trên màn khóa điện thoại, không có chỗ bấm vào xem thêm.
      // eslint-disable-next-line no-await-in-loop
      const kq = await webPush.guiNhieu(subs, {
        tieu_de: d.tieuDe,
        than: [dsMaPhan || moTa, nhanDoiPa].filter(Boolean).join('\n'),
        // Bấm vào → màn "Danh sách phần in vải về", chip "Tất cả", tìm sẵn code phần đó.
        duong_dan: tb.duongDanDoiPa(dsMaPhanDau),
        the: `duyet-${yeuCauId}-${d.maLoai}`,
      });
      if (kq.endpoint_chet.length) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(kq.endpoint_chet.map((e) => repo.xoaPush(e).catch(() => {})));
      }
      // eslint-disable-next-line no-await-in-loop
      await repo.danhDauPushDaDung(subs.map((s) => s.endpoint).filter((e) => !kq.endpoint_chet.includes(e)));
    }
  } catch (e) {
    console.error('[thong-bao] ✗ bắn thông báo duyệt lỗi (không ảnh hưởng thao tác duyệt):', e.message);
  }
}

module.exports = {
  danhSach, demChuaDoc, danhDauDoc,
  layCaiDatHeThong, luuCaiDatHeThong, layCaiDatCuaToi, luuCaiDatCuaToi,
  dangKyPush, huyPush, banThongBao, banThongBaoDuyet,
  khoaCongKhaiPush: () => ({ khoa: webPush.khoaCongKhai(), ...webPush.trangThai() }),
};
