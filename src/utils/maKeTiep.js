'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SQL CẤP MÃ TĂNG DẦN DẠNG `<tiền tố><số>` (LSX0001, PSX0001, PG0001, SET0001, BC0001, U0001, TEM00001).
// NGUỒN DUY NHẤT — đừng viết lại câu cấp mã ở repository.
//
// ⚠⚠ SỰ CỐ 21/10/2026: các câu cũ dạng `'LSX' || LPAD((MAX(…)+1)::text, 4, '0')` có 2 lỗi:
//   1. `LPAD(chuỗi, 4)` CẮT chuỗi dài hơn 4 ⇒ qua LSX9999 thì số kế tiếp 10000 thành `LSX1000` — mã đã có ⇒ MỌI lần
//      tạo lệnh báo "Dữ liệu đã tồn tại (trùng khóa)" (Release 1, Kế hoạch tạm, Gom đợt vải, gia công…; prod
//      21/10 từ 13:54, ngay sau LSX9999). ⇒ Độ rộng = MAX(số chữ số tối thiểu, độ dài thật của số).
//   2. Bản `MAX(regexp_replace(cột,'\D','','g'))::int` lấy MAX trên CHUỖI ('9999' > '10000') và gom chữ số của MỌI
//      dạng mã (vd mã phiếu giao ERP `SQ026LA-009650`, mã tem ERP 12 số ⇒ tràn `int`). ⇒ Chỉ tính mã ĐÚNG dạng
//      `^<tiền tố>[0-9]+$`, ép `bigint` TRƯỚC khi MAX.
// `bang`/`cot`/`tienTo` là HẰNG trong code (không nhận từ người dùng) nên ghép thẳng vào SQL được.
// ─────────────────────────────────────────────────────────────────────────────

function maKeTiepSql(bang, cot, tienTo, soChuSo = 4) {
  return `SELECT '${tienTo}' || LPAD(n::text, GREATEST(${soChuSo}, length(n::text)), '0') AS ma, n
    FROM (SELECT COALESCE(MAX(substring(${cot} FROM ${tienTo.length + 1})::bigint)
                   FILTER (WHERE ${cot} ~ '^${tienTo}[0-9]+$'), 0) + 1 AS n
            FROM ${bang}) x`.replace(/\s+/g, ' ');
}

module.exports = { maKeTiepSql };
