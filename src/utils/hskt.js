'use strict';

// Quy tắc HSKT dùng chung cho `hskt` + `erpsync`.
//
// PHƯƠNG ÁN IN (ERP `Pain`, cột `ho_so_ky_thuat.phuong_an_in`): 1 Bàn · 2 Máy · 3 Robot.
// ⚠ ERP CÓ gửi `Pain = 0` = CHƯA XÁC ĐỊNH phương án in (chưa gán) — không phải dữ liệu lỗi.
// Khớp hằng FE `frontend/src/components/common/PhuongAnInBadge.js` — đổi thì phải đổi cả 2 nơi.
const PHUONG_AN_IN = { 0: 'Chưa xác định', 1: 'Bàn', 2: 'Máy', 3: 'Robot' };

// SỐ CUỐI của `barcode_hskt` = phương án in (đối chiếu dữ liệu thật ERP: 278/278 dòng đúng, TRONG ĐÓ
// 14 dòng `Pain=0` ↔ barcode kết thúc `0`; barcode luôn 12 chữ số, 11 số đầu duy nhất 1:1 ⇒ 11 số
// đầu là ĐỊNH DANH, số cuối là thuộc tính đổi được).
const BARCODE_RE = /^\d{11}[0-3]$/;

// Giá trị ĐÍCH hợp lệ khi người dùng đổi phương án in bằng tay — CỐ Ý không có `0`: không ai được
// tự đặt HSKT về "chưa xác định", chỉ ERP mới ghi được 0 (qua `erpsync` `erpPain`, không qua đây).
const isValidPain = (pain) => [1, 2, 3].includes(Number(pain));

// Đổi số cuối barcode theo phương án in.
// ⚠ CHỈ đổi khi barcode ĐÚNG định dạng `11 số + số cuối 0..3`. Sai định dạng (NULL, HSKT tạm không
// barcode, hoặc barcode ERP kiểu khác) → GIỮ NGUYÊN, KHÔNG đoán bừa — thà lệch quy tắc còn hơn tự
// bịa ra một mã vạch không tồn tại ngoài thực tế.
function applyPainToBarcode(barcode, pain) {
  const s = String(barcode ?? '').trim();
  if (!s || !isValidPain(pain) || !BARCODE_RE.test(s)) return s || null;
  return s.slice(0, 11) + String(Number(pain));
}

// Barcode có theo được quy tắc số cuối không (để FE/BE biết có nên cảnh báo "mã vạch sẽ đổi").
const canApplyPain = (barcode) => BARCODE_RE.test(String(barcode ?? '').trim());

module.exports = { PHUONG_AN_IN, BARCODE_RE, isValidPain, applyPainToBarcode, canApplyPain };
