'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MÃ LÔ của TEM SẢN XUẤT (tem 15 | 16) — sinh thêm mỗi lần IN 1 TEM MỚI (13/10/2026, người dùng chốt; mig 114).
//
//   L<mã ngày ca lúc nhập>-<năm tháng><4 số thứ tự>          vd  L261013C1-26080001
//
//   · <mã ngày ca>  = chuỗi người in nhập ở ô "Ngày ca" của lượt in (`tem.ma_ngay_ca`, vd `261013C1`).
//   · <năm tháng>   = 4 số NĂM-THÁNG NẰM TRONG MÃ TEM ERP (mã tem = `15` + `2608` + 6 số thứ tự; ERP đang ghim
//                     `2608` cho mọi tem từ tháng 8/2026) ⇒ hiện luôn là `2608`. ERP đổi thì mã lô đổi theo.
//   · <4 số>        = bộ đếm RIÊNG của MES (bảng `tem_lo_counter`), mỗi tem +1, ĐẾM LẠI TỪ 0001 MỖI NGÀY — "ngày" là
//                     6 số YYMMDD đầu của mã ngày ca (người dùng: "qua ngày mới là reset 4 số cuối, không phải qua
//                     tháng — vì ngày mới thì trước dấu - số khác rồi"). Đếm CHUNG mọi ca / mọi chuyền của ngày đó
//                     ⇒ 2 tem không bao giờ trùng mã lô.
//
// Hàm THUẦN (không đụng DB) — bên cấp số là `production.repository.capMaLo`. Đổi cấu trúc mã chỉ sửa ở đây.
// ⚠ In lại tem KHÔNG sinh mã mới (cùng dòng `tem`). Tem 17 (sửa đạt) không có mã riêng — nhãn lấy lô của tem gốc.
// ─────────────────────────────────────────────────────────────────────────────

const DAI_NGAY_CA = 20; // = độ dài cột `tem.ma_ngay_ca`
const SO_CHU_SO = 4;

// Mã ngày ca đưa vào mã lô: bỏ khoảng trắng, viết HOA (ô nhập cho gõ tay — `261013 c1` vẫn ra `261013C1`).
const chuanNgayCa = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase().slice(0, DAI_NGAY_CA);

// KHÓA BỘ ĐẾM = "ngày" của mã ngày ca: 6 số YYMMDD đầu; gõ sai định dạng ⇒ cả chuỗi (vẫn không trùng mã lô);
// không nhập ngày ca ⇒ null, câu SQL cấp số tự lấy ngày hôm nay (giờ VN).
function khoaDemLo(maNgayCa) {
  const s = chuanNgayCa(maNgayCa);
  if (!s) return null;
  const m = /^\d{6}/.exec(s);
  return m ? m[0] : s;
}

// 4 số năm-tháng: lấy từ mã tem ERP (12 chữ số). Mã tem MES tự sinh (`TEM00123`, khi API xin số tắt) không có
// phần này ⇒ lùi về YYMM của ngày đang đếm.
function namThangLo(maTem, ymd) {
  const s = String(maTem == null ? '' : maTem).trim();
  if (/^\d{12}$/.test(s)) return s.slice(2, 6);
  const d = /^\d{4}/.exec(String(ymd == null ? '' : ymd));
  return d ? d[0] : '';
}

// `stt` = số bộ đếm vừa cấp · `khoa` = khóa bộ đếm đã dùng · `ymd` = hôm nay YYMMDD (giờ VN, lấy từ SQL).
// Số thứ tự không hợp lệ ⇒ null (bên gọi coi như không có mã lô). Quá 9.999 tem/ngày ⇒ thành 5 chữ số, không cắt.
function dungMaLo({ maNgayCa, maTem, stt, khoa, ymd }) {
  const n = Number(stt);
  if (!Number.isInteger(n) || n < 1) return null;
  const ngayCa = chuanNgayCa(maNgayCa) || String(ymd == null ? '' : ymd);
  const ngayDem = /^\d{6}$/.test(String(khoa == null ? '' : khoa)) ? khoa : ymd;
  return `L${ngayCa}-${namThangLo(maTem, ngayDem)}${String(n).padStart(SO_CHU_SO, '0')}`;
}

module.exports = { khoaDemLo, namThangLo, dungMaLo, chuanNgayCa };
