'use strict';

const repo = require('./duyet.repository');
const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');
const sockets = require('../../sockets');
const {
  LOAI_DUYET, laLoaiHopLe, coQuyenDuyet, coQuyenGui, coQuyenXemHangDoi, danhMuc,
} = require('../../utils/duyet');
const hsktService = require('../hskt/hskt.service');
// Nhãn phương án in (0..3 → chữ) — dùng CHUNG với hàng đợi duyệt để 2 nơi không hiện khác chữ.
const nhanPain = (v) => LOAI_DUYET.DOI_PHUONG_AN_IN.nhanGiaTri(v);
const { banThongBaoDuyet } = require('../thongbao/thongbao.service');
// Công tắc bật/tắt tính năng duyệt (mig 087) — TẮT ⇒ ai đổi được thì đổi thẳng, không qua hàng đợi.
const { tinhNangBat } = require('../../utils/caiDatTinhNang');

// Tên tính năng ↔ loại duyệt. Khai ở ĐÂY (không nhét vào `utils/duyet.js`) để `utils/duyet.js` giữ
// nguyên vai trò "danh mục thuần", không phụ thuộc bảng cấu hình.
// ⚠ Thêm loại duyệt mới mà muốn tắt được thì khai thêm 1 dòng ở đây + 1 dòng ở `DANH_MUC_TINH_NANG`.
const TINH_NANG_CUA_LOAI = { DOI_PHUONG_AN_IN: 'DUYET_DOI_PHUONG_AN_IN' };

// `ly_do` NOT NULL (mig 086) mà tắt duyệt thì không bắt nhập lý do nữa ⇒ phải có câu thay thế.
const LY_DO_KHI_TAT_DUYET = '(tính năng duyệt đang tắt — đổi thẳng, không yêu cầu lý do)';

// Loại duyệt này có đang BẮT BUỘC duyệt không. Không khai công tắc ⇒ luôn bắt buộc (an toàn).
async function batBuocDuyet(maLoai) {
  const tn = TINH_NANG_CUA_LOAI[maLoai];
  if (!tn) return true;
  return tinhNangBat(tn);
}

// ─────────────────────────────────────────────────────────────────────────────
// HÀNG ĐỢI DUYỆT (mig 086). Xem `utils/duyet.js` cho danh mục loại + luật quyền.
//
// ⚠⚠ MÔ HÌNH: **chờ duyệt mới đổi**, TRỪ người có quyền duyệt thì áp dụng NGAY (tự duyệt) —
//   vẫn ghi 1 dòng `yeu_cau_duyet` trạng thái `DUYET` để hàng đợi có hồ sơ đầy đủ, không có
//   thay đổi nào "đi cửa sau" mà hàng đợi không biết.
// ─────────────────────────────────────────────────────────────────────────────

const perms = (user) => (user && user.permissions) || [];

// ÁP DỤNG thay đổi khi được duyệt — mỗi loại 1 nhánh.
// ⚠⚠ TÁI DÙNG SERVICE ĐANG CHẠY NGOÀI GIAO DIỆN, TUYỆT ĐỐI KHÔNG tự viết UPDATE:
//   `hsktService.changePhuongAnIn` lo cả chuỗi việc mà bản viết tay chắc chắn sẽ thiếu — đặt
//   `pa_in_sua_tay=true` (không có cờ này thì job ERP 5 phút/lần ĐÈ NGƯỢC theo sản lượng), tạo
//   phiên bản HSKT mới, relink `hskt_phan_in`, ghi `lich_su_hskt`, đổi số cuối `barcode_hskt`,
//   chặn trùng mã (409). Cùng nguyên tắc với trang *Quản trị phần in*.
async function apDung(yc, actorId) {
  if (yc.loai === 'DOI_PHUONG_AN_IN') {
    const pa = Number(yc.gia_tri_moi && yc.gia_tri_moi.phuong_an_in);

    // ⚠⚠ HỒ SƠ PHẢI CÒN HIỆU LỰC MỚI ĐƯỢC ÁP DỤNG. Mỗi lần đổi phương án in, `changePhuongAnIn`
    //   sinh PHIÊN BẢN MỚI và tắt bản cũ (`dang_hoat_dong=false`) ⇒ yêu cầu treo lâu có thể trỏ vào
    //   một bản ĐÃ CŨ (ai đó vừa đổi, hoặc job ERP tính lại theo sản lượng).
    //   `hskt.repository.changePhuongAnIn` đọc theo id mà **KHÔNG lọc `dang_hoat_dong`** ⇒ áp dụng
    //   lên bản cũ sẽ RẼ NHÁNH chuỗi phiên bản và có thể đẻ ra 2 HSKT ACTIVE cho cùng 1 phần in —
    //   đúng sự cố đã xảy ra 04/08/2026 (1101 phiên bản rác). Chặn ở đây, báo rõ để gửi lại.
    const { rows } = await query(
      'SELECT dang_hoat_dong, phien_ban FROM ho_so_ky_thuat WHERE id = $1', [yc.doi_tuong_id]
    );
    if (!rows.length) {
      throw new AppError('Hồ sơ kỹ thuật không còn tồn tại — yêu cầu này không áp dụng được',
        { status: 409, errorCode: 'HSKT_MAT' });
    }
    if (rows[0].dang_hoat_dong === false) {
      throw new AppError(
        'Hồ sơ kỹ thuật đã sang phiên bản mới kể từ lúc gửi yêu cầu (ai đó vừa đổi phương án in, '
        + 'hoặc đồng bộ ERP tính lại theo sản lượng). Hãy từ chối yêu cầu này và gửi lại từ màn READY '
        + 'để lấy đúng phiên bản hiện hành.',
        { status: 409, errorCode: 'HSKT_DA_DOI' }
      );
    }
    return hsktService.changePhuongAnIn(yc.doi_tuong_id, pa, actorId);
  }
  throw new AppError('Loại yêu cầu chưa có bước áp dụng', { status: 500, errorCode: 'CHUA_HO_TRO' });
}

// Ngữ cảnh gửi kèm THÔNG BÁO: code phần + "PA cũ → PA mới".
// ⚠ Đọc code phần từ QUAN HỆ (`hskt_phan_in`), KHÔNG bóc tách chuỗi `yc.mo_ta` — `mo_ta` là câu cho
//   người đọc, đổi chữ một cái là parse hỏng ngay. `maPhanDau` dùng làm `?q=` khi bấm thông báo nên
//   phải là MỘT mã sạch.
// ⚠ Không bao giờ ném: đây chỉ là phần trang trí thông báo, hỏng không được chặn việc duyệt.
async function nganCanhTb(yc) {
  const lay = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);
  const paCu = Number(lay(yc.gia_tri_cu, 'phuong_an_in')) || 0;
  const paMoi = Number(lay(yc.gia_tri_moi, 'phuong_an_in')) || 0;
  let ds = [];
  try {
    const { rows } = await query(
      `SELECT p.ma_phan FROM hskt_phan_in hp JOIN phan_in p ON p.id = hp.phan_in_id AND p.dang_hoat_dong
        WHERE hp.hskt_id = $1 AND hp.dang_hoat_dong ORDER BY p.ma_phan`.replace(/\s+/g, ' '),
      [yc.doi_tuong_id]
    );
    ds = rows.map((r) => r.ma_phan).filter(Boolean);
  } catch (e) { ds = []; }
  return {
    dsMaPhan: ds.join(', '),
    maPhanDau: ds[0] || '',
    paCuTen: nhanPain(paCu),
    paMoiTen: nhanPain(paMoi),
  };
}

// Danh sách hàng đợi. Người KHÔNG có quyền duyệt loại nào → chỉ thấy yêu cầu CỦA CHÍNH MÌNH.
async function danhSach(user, q = {}) {
  const p = perms(user);
  if (!coQuyenXemHangDoi(p)) return { items: [], meta: { total: 0, page: 1 }, co_quyen: false, dem_cho: {} };

  const loaiDuyetDuoc = Object.keys(LOAI_DUYET).filter((ma) => coQuyenDuyet(p, ma));
  const chiCuaToi = loaiDuyetDuoc.length === 0;

  const { items, total } = await repo.danhSach({
    loai: q.loai || null,
    trangThai: q.trangThai || null,
    timKiem: q.timKiem || q.search || null,
    chiCuaToi,
    userId: user.id,
    page: Number(q.page) || 1,
    limit: Number(q.limit) || 20,
  });

  // Gắn nhãn giá trị cũ → mới cho người đọc (số 0..3 → "Bàn"/"Máy"…) + cờ mình có duyệt được không.
  const out = items.map((r) => {
    const v = LOAI_DUYET[r.loai];
    const nhan = v && v.nhanGiaTri;
    const lay = (o) => (o && typeof o === 'object' ? Object.values(o)[0] : o);
    return {
      ...r,
      ten_loai: v ? v.ten : r.loai,
      nhan_gia_tri_cu: nhan ? nhan(lay(r.gia_tri_cu)) : null,
      nhan_gia_tri_moi: nhan ? nhan(lay(r.gia_tri_moi)) : null,
      duyet_duoc: coQuyenDuyet(p, r.loai) && r.trang_thai === 'CHO',
      // Người gửi tự rút được yêu cầu của mình khi còn đang chờ.
      huy_duoc: r.trang_thai === 'CHO' && r.nguoi_gui === user.id,
    };
  });

  const demCho = await repo.demCho(loaiDuyetDuoc);
  return {
    items: out,
    meta: { total, page: Number(q.page) || 1, limit: Number(q.limit) || 20 },
    co_quyen: true,
    chi_cua_toi: chiCuaToi,
    dem_cho: demCho,
    ...danhMuc(p),
  };
}

// Số yêu cầu đang chờ MÌNH duyệt → badge trên menu. Không duyệt được loại nào ⇒ 0.
async function demChoDuyet(user) {
  const p = perms(user);
  const loai = Object.keys(LOAI_DUYET).filter((ma) => coQuyenDuyet(p, ma));
  if (!loai.length) return { so: 0, co_quyen: false };
  const m = await repo.demCho(loai);
  return { so: Object.values(m).reduce((a, b) => a + b, 0), co_quyen: true, theo_loai: m };
}

// ─── Tạo yêu cầu ĐỔI PHƯƠNG ÁN IN ───────────────────────────────────────────
// Trả `{ da_ap_dung: true, ... }` khi người gửi có quyền duyệt (áp dụng ngay),
//      `{ da_ap_dung: false, yeu_cau }` khi phải chờ duyệt.
async function guiYeuCauDoiPain(user, { hsktId, phuongAnIn, lyDo }) {
  const LOAI = 'DOI_PHUONG_AN_IN';
  const p = perms(user);
  if (!coQuyenGui(p, LOAI)) {
    throw new AppError('Bạn không có quyền đổi phương án in', { status: 403, errorCode: 'NO_PERM' });
  }
  const pa = Number(phuongAnIn);
  if (![1, 2, 3].includes(pa)) {
    throw new AppError('Phương án in không hợp lệ (1 Bàn / 2 Máy / 3 Robot)', { status: 422, errorCode: 'INVALID' });
  }
  // ⚠⚠ LÝ DO BẮT BUỘC — NHƯNG CHỈ KHI TÍNH NĂNG DUYỆT ĐANG BẬT (mig 087, chốt 19/08/2026).
  //   Tắt duyệt = "bấm là đổi" (người dùng chọn) ⇒ bắt nhập lý do nữa thì tắt cũng như không.
  //   ⚠ Vẫn kiểm ở SERVICE chứ không tin FE: FE có thể cầm cờ cũ (cache 60s) và gửi lý do rỗng khi
  //   luật vẫn đang bật — lúc đó phải chặn thật.
  const batBuoc = await batBuocDuyet(LOAI);
  const lyDoSach = String(lyDo || '').trim();
  if (batBuoc && !lyDoSach) {
    throw new AppError('Nhập lý do đổi phương án in', { status: 422, errorCode: 'NO_LY_DO' });
  }

  // ⚠ `hsktService.detail` trả `{ hskt, phan_in, lich_su }` (KHÔNG phẳng) và tự NÉM 404 nếu không
  //   thấy — đừng kiểm `if (!hskt)` rồi tưởng đã xử lý xong ca không tồn tại.
  const ct = await hsktService.detail(hsktId);
  const hskt = ct.hskt;
  const paCu = Number(hskt.phuong_an_in) || 0;
  if (paCu === pa) {
    throw new AppError('Phương án in đang là giá trị này rồi', { status: 422, errorCode: 'KHONG_DOI' });
  }

  // Chặn gửi trùng (DB cũng có partial UNIQUE `ux_yeu_cau_duyet_cho` làm chốt cuối).
  const dangCho = await repo.timDangCho(LOAI, 'ho_so_ky_thuat', hsktId);
  if (dangCho) {
    throw new AppError(
      `Hồ sơ này đã có yêu cầu đổi phương án in đang chờ duyệt (gửi bởi ${dangCho.ten_nguoi_gui || '—'})`,
      { status: 409, errorCode: 'DANG_CHO_DUYET' }
    );
  }

  // Ngữ cảnh hiện trên hàng đợi — lưu SẴN để không phải JOIN ngược (phần in có thể bị xóa mềm sau).
  const dsPhan = (ct.phan_in || []).map((x) => x.ma_phan).filter(Boolean);
  // Ngữ cảnh cho THÔNG BÁO: nói rõ đổi CODE PHẦN NÀO và TỪ đâu SANG đâu (yêu cầu 18/08/2026).
  // ⚠ `maPhanDau` dùng làm `?q=` khi bấm vào thông báo ⇒ phải là MỘT mã sạch, không phải cả câu.
  const ttb = {
    dsMaPhan: dsPhan.join(', '),
    maPhanDau: dsPhan[0] || '',
    paCuTen: nhanPain(paCu),
    paMoiTen: nhanPain(pa),
  };
  // ⚠⚠ CHỈ CODE PHẦN, KHÔNG ghi mã vạch HSKT (người dùng chốt 18/08/2026). Mã vạch HSKT là mã nội
  //   bộ của hồ sơ, người đọc thông báo / người duyệt không dùng nó để nhận ra hàng — họ nhận ra
  //   bằng CODE PHẦN. Trước đây `mo_ta` mở đầu bằng "HSKT 2600…" nên chuông · push · cột "Đối tượng"
  //   ở hàng đợi đều hiện mã đó trước cả code phần, rất khó đọc.
  // ⚠ GIỮ chú thích "(N phần in dùng chung hồ sơ)" — đó KHÔNG phải mã HSKT mà là cảnh báo phạm vi:
  //   duyệt 1 yêu cầu là đổi cho CẢ NHÓM, người duyệt phải thấy trước khi bấm.
  // ⚠ `mo_ta` là nguồn cho: chuông/trang thông báo (khi LATERAL code phần rỗng) · nội dung Web Push
  //   · cột "Đối tượng" + tiêu đề SidePanel ở trang Duyệt yêu cầu ⇒ sửa ở đây là đủ cả 4 chỗ.
  const moTa = [
    dsPhan.length ? dsPhan.join(', ') : null,
    dsPhan.length > 1 ? `(${dsPhan.length} phần in dùng chung hồ sơ)` : null,
  ].filter(Boolean).join(' · ');

  // ⚠⚠ TẮT TÍNH NĂNG DUYỆT ⇒ MỌI NGƯỜI GỬI ĐƯỢC ĐỀU ÁP DỤNG NGAY (không chỉ người có quyền duyệt).
  //   Vẫn đi qua CHÍNH luồng này để hàng đợi có hồ sơ đầy đủ (1 dòng `DUYET`) — không có thay đổi
  //   nào "đi cửa sau", và bật lại tính năng thì lịch sử vẫn liền mạch.
  const tuDuyet = coQuyenDuyet(p, LOAI) || !batBuoc;
  const chung = {
    loai: LOAI,
    bang: 'ho_so_ky_thuat',
    doiTuongId: hsktId,
    moTa,
    giaTriCu: { phuong_an_in: paCu },
    giaTriMoi: { phuong_an_in: pa },
    // ⚠⚠ `yeu_cau_duyet.ly_do` là **NOT NULL** (mig 086) ⇒ TUYỆT ĐỐI không ghi `null` khi tính năng
    //   duyệt đang tắt (23502 not_null_violation ⇒ đổi phương án in hỏng hoàn toàn). Ghi câu giải
    //   thích thay vì nới cột: người mở lịch sử sau này hiểu ngay vì sao dòng đó không có lý do, và
    //   KHÔNG phải đụng schema đã lên production.
    lyDo: lyDoSach || LY_DO_KHI_TAT_DUYET,
    nguoiGui: user.id,
  };

  if (tuDuyet) {
    // ⚠ ÁP DỤNG TRƯỚC RỒI MỚI GHI HỒ SƠ: `changePhuongAnIn` có thể ném 409 BARCODE_TRUNG — ghi
    //   trước thì hàng đợi có dòng "đã duyệt" trong khi thực tế KHÔNG đổi được gì.
    const kq = await apDung({ loai: LOAI, doi_tuong_id: hsktId, gia_tri_moi: { phuong_an_in: pa } }, user.id);
    const id = await repo.taoYeuCau({
      ...chung, trangThai: 'DUYET', nguoiDuyet: user.id, tgDuyet: new Date(),
      ghiChuDuyet: batBuoc
        ? 'Người gửi có quyền duyệt — áp dụng ngay'
        : 'Tính năng duyệt đang TẮT — áp dụng ngay',
    });
    // ⚠ Không `await`: gửi thông báo/push có thể mất vài giây × nhiều thiết bị, mà thay đổi đã xong.
    banThongBaoDuyet({ loai: LOAI, yeuCauId: id, su_kien: 'DA_DUYET', nguoiGui: user.id, moTa, ...ttb });
    return { da_ap_dung: true, yeu_cau_id: id, hskt: kq };
  }

  const id = await repo.taoYeuCau(chung);
  sockets.emit('duyet:updated', { loai: LOAI, trangThai: 'CHO' });
  banThongBaoDuyet({ loai: LOAI, yeuCauId: id, su_kien: 'MOI', nguoiGui: user.id, moTa, ...ttb });
  return { da_ap_dung: false, yeu_cau_id: id, yeu_cau: await repo.timTheoId(id) };
}

// ─── Duyệt / Từ chối / Hủy ───────────────────────────────────────────────────
async function duyet(user, id, { ghiChu } = {}) {
  const yc = await repo.timTheoId(id);
  if (!yc) throw new AppError('Yêu cầu không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (!laLoaiHopLe(yc.loai)) throw new AppError('Loại yêu cầu không hợp lệ', { status: 422, errorCode: 'LOAI_LA' });
  if (!coQuyenDuyet(perms(user), yc.loai)) {
    throw new AppError('Bạn không có quyền duyệt loại yêu cầu này', { status: 403, errorCode: 'NO_PERM' });
  }
  if (yc.trang_thai !== 'CHO') {
    throw new AppError(`Yêu cầu đã được xử lý (${yc.trang_thai})`, { status: 409, errorCode: 'DA_XU_LY' });
  }

  // ⚠⚠ CHỐT TRẠNG THÁI TRƯỚC (UPDATE … WHERE trang_thai='CHO') rồi mới áp dụng: 2 người bấm duyệt
  //   cùng lúc thì chỉ 1 lượt ghi được, lượt kia dừng ngay — nếu áp dụng trước thì thay đổi bị
  //   thực hiện 2 lần (2 phiên bản HSKT thừa).
  const chot = await repo.chotYeuCau(id, { trangThai: 'DUYET', nguoiDuyet: user.id, ghiChu });
  if (!chot) throw new AppError('Yêu cầu vừa được người khác xử lý', { status: 409, errorCode: 'DA_XU_LY' });

  try {
    const kq = await apDung(yc, user.id);
    sockets.emit('duyet:updated', { loai: yc.loai, trangThai: 'DUYET' });
    banThongBaoDuyet({
      loai: yc.loai, yeuCauId: id, su_kien: 'DA_DUYET',
      nguoiGui: yc.nguoi_gui, nguoiDuyet: user.id, moTa: yc.mo_ta, ...(await nganCanhTb(yc)),
    });
    return { ...(await repo.timTheoId(id)), ket_qua: kq };
  } catch (e) {
    // ⚠ Áp dụng THẤT BẠI (vd 409 BARCODE_TRUNG) ⇒ TRẢ YÊU CẦU VỀ 'CHO' để người duyệt thử lại,
    //   không để trạng thái nói "đã duyệt" trong khi dữ liệu không hề đổi.
    await repo.moLaiCho(id);
    throw e;
  }
}

// ─── TẮT TÍNH NĂNG DUYỆT ⇒ DUYỆT SẠCH HÀNG ĐỢI (mig 087, người dùng chốt 19/08/2026) ────────────
// Gọi từ `caidattinhnang.service` NGAY SAU khi lưu công tắc sang TẮT.
//
// ⚠⚠ KHÔNG KIỂM `coQuyenDuyet` — CỐ Ý: người bấm tắt có `WORKFLOW_MANAGE` (quyền cấu hình hệ thống)
//   nhưng thường KHÔNG có `PA_IN_APPROVE`. Bản thân hành động tắt tính năng đã là quyết định "không
//   cần duyệt nữa", nên đòi thêm quyền duyệt ở đây sẽ khiến thao tác tắt thất bại một nửa: công tắc
//   đã tắt mà hàng đợi vẫn treo.
//
// ⚠⚠ GIỮ NGUYÊN KHUÔN AN TOÀN của `duyet()`: **chốt trạng thái TRƯỚC rồi mới áp dụng** (2 người bấm
//   cùng lúc chỉ 1 lượt ăn), áp dụng lỗi thì `moLaiCho` để yêu cầu không kẹt ở "đã duyệt" trong khi
//   dữ liệu không đổi.
//
// ⚠⚠ TUẦN TỰ, KHÔNG `Promise.all`: mỗi lần áp dụng tạo một PHIÊN BẢN HSKT mới và tắt bản cũ — chạy
//   song song trên các yêu cầu cùng hồ sơ sẽ rẽ nhánh chuỗi phiên bản (đúng sự cố 04/08/2026).
//
// ⚠ LỖI TỪNG YÊU CẦU KHÔNG ĐƯỢC LÀM HỎNG CẢ THAO TÁC LƯU: gom vào `loi[]` trả cho FE hiện, công tắc
//   vẫn tắt. Thường gặp nhất là `HSKT_DA_DOI` (hồ sơ đã sang phiên bản mới kể từ lúc gửi).
async function duyetHetKhiTat(maLoai, actorId) {
  const ds = await repo.dsDangCho(maLoai);
  const kq = { tong: ds.length, da_duyet: 0, loi: [] };
  for (const yc of ds) {
    const chot = await repo.chotYeuCau(yc.id, {
      trangThai: 'DUYET', nguoiDuyet: actorId,
      ghiChu: 'Tự động duyệt do TẮT tính năng duyệt đổi phương án in',
    });
    if (!chot) continue; // người khác vừa xử lý xong yêu cầu này
    try {
      await apDung(yc, actorId);
      kq.da_duyet += 1;
      // Không `await`: người gửi + kỹ thuật vẫn nhận thông báo như khi được duyệt tay.
      banThongBaoDuyet({
        loai: yc.loai, yeuCauId: yc.id, su_kien: 'DA_DUYET',
        nguoiGui: yc.nguoi_gui, nguoiDuyet: actorId, moTa: yc.mo_ta, ...(await nganCanhTb(yc)),
      });
    } catch (e) {
      await repo.moLaiCho(yc.id);
      kq.loi.push({ id: yc.id, mo_ta: yc.mo_ta, thong_diep: e.message });
    }
  }
  if (kq.da_duyet) sockets.emit('duyet:updated', { loai: maLoai, trangThai: 'DUYET' });
  return kq;
}

async function tuChoi(user, id, { lyDo } = {}) {
  const yc = await repo.timTheoId(id);
  if (!yc) throw new AppError('Yêu cầu không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (!coQuyenDuyet(perms(user), yc.loai)) {
    throw new AppError('Bạn không có quyền duyệt loại yêu cầu này', { status: 403, errorCode: 'NO_PERM' });
  }
  // ⚠ LÝ DO TỪ CHỐI BẮT BUỘC: người gửi phải biết vì sao bị bác mới sửa được cho đúng.
  const sach = String(lyDo || '').trim();
  if (!sach) throw new AppError('Nhập lý do từ chối', { status: 422, errorCode: 'NO_LY_DO' });

  const ok = await repo.chotYeuCau(id, { trangThai: 'TU_CHOI', nguoiDuyet: user.id, ghiChu: sach });
  if (!ok) throw new AppError('Yêu cầu đã được xử lý', { status: 409, errorCode: 'DA_XU_LY' });
  sockets.emit('duyet:updated', { loai: yc.loai, trangThai: 'TU_CHOI' });
  banThongBaoDuyet({
    loai: yc.loai, yeuCauId: id, su_kien: 'TU_CHOI',
    nguoiGui: yc.nguoi_gui, nguoiDuyet: user.id, moTa: yc.mo_ta, ...(await nganCanhTb(yc)),
  });
  return repo.timTheoId(id);
}

// Người GỬI tự rút yêu cầu của mình (bấm nhầm) — không cần quyền duyệt.
async function huy(user, id) {
  const yc = await repo.timTheoId(id);
  if (!yc) throw new AppError('Yêu cầu không tồn tại', { status: 404, errorCode: 'NOT_FOUND' });
  if (yc.nguoi_gui !== user.id && !coQuyenDuyet(perms(user), yc.loai)) {
    throw new AppError('Chỉ người gửi (hoặc người duyệt) mới hủy được yêu cầu này',
      { status: 403, errorCode: 'NO_PERM' });
  }
  const ok = await repo.chotYeuCau(id, { trangThai: 'HUY', nguoiDuyet: user.id, ghiChu: 'Người gửi tự hủy' });
  if (!ok) throw new AppError('Yêu cầu đã được xử lý', { status: 409, errorCode: 'DA_XU_LY' });
  sockets.emit('duyet:updated', { loai: yc.loai, trangThai: 'HUY' });
  return repo.timTheoId(id);
}

module.exports = {
  danhSach, demChoDuyet, guiYeuCauDoiPain, duyet, tuChoi, huy,
  // Gọi từ trang Cài đặt tính năng khi TẮT công tắc duyệt (mig 087).
  duyetHetKhiTat, TINH_NANG_CUA_LOAI,
  // Dùng ở màn READY / QC READY để gắn badge "đang chờ duyệt" cho ô Phương án in.
  mapDangCho: repo.mapDangCho,
};
