// MÃ VẠCH PHẦN IN (ERP `BarcodePTHDH` → `phan_in.barcode`) — **CÓ THỂ LÀ DANH SÁCH**.
//
// ⚠⚠ ERP gửi NHIỀU mã cho cùng một phần in theo HAI cách khác nhau — phải chịu được cả hai:
//   (1) NHIỀU MÃ TRONG CÙNG 1 DÒNG, ngăn bằng dấu phẩy: `"26021555120,26022218120,26024144120"`
//       (đo prod 20/08/2026: 46 dòng raw · 32 phần in đang lưu kiểu này · tối đa 3 mã · 0 khoảng trắng).
//   (2) MỖI LẦN SYNC MỘT MÃ ĐƠN KHÁC NHAU cho cùng `code_part` (45 code phần kiểu này; vd
//       `SL-2607-010-A08-F05-C01` nhận 3 mã khác nhau vào 06/08 · 12/08 · 18/08).
//   ⇒ `upsertPhanIn` **GỘP DỒN** (hợp danh sách cũ với danh sách mới, khử trùng) chứ KHÔNG ghi đè,
//     nếu không thì phiếu giấy in mã CŨ quét không ra (đúng cách hỏng của cách (2)).
//
// ⚠ Bất biến vẫn giữ sau khi có danh sách (đo prod: 1648/1648 mã): **mỗi mã đúng 11 chữ số** và
//   **3 số cuối = `phan_in.ddh_sub_id`** ⇒ mig 088 và `npm run lay:subid` không phải đổi luật, chỉ
//   phải xét TỪNG MÃ trong danh sách thay vì cả chuỗi.
//
// ⚠⚠ MỌI CHỖ SO MÃ QUÉT PHẢI DÙNG `sqlKhopMa()` / `khopMa()`, TUYỆT ĐỐI KHÔNG `pin.barcode = $1`:
//   so nguyên chuỗi thì phần in có danh sách sẽ **quét không bao giờ ra** (đúng lỗi người dùng báo
//   20/08/2026). Gương ở FE: `frontend/src/utils/maPhanIn.js` — sửa luật phải sửa CẢ HAI.

const NGAN_CACH = ',';
// Độ dài 1 mã + dấu ngăn — dùng để suy "chứa được bao nhiêu mã" từ độ dài cột (xem `soMaVuaCot`).
const DAI_MA = 11;

// Tách chuỗi thành DANH SÁCH mã: cắt khoảng trắng, bỏ phần tử rỗng, KHỬ TRÙNG nhưng GIỮ THỨ TỰ
// (mã cũ đứng trước — thứ tự là dấu vết ERP gửi lúc nào, hữu ích khi đối chiếu).
function tachDsMa(s) {
  if (s == null) return [];
  const ra = [];
  for (const p of String(s).split(NGAN_CACH)) {
    const v = p.trim();
    if (v && !ra.includes(v)) ra.push(v);
  }
  return ra;
}

// Chuẩn hóa để LƯU: danh sách sạch, nối bằng dấu phẩy KHÔNG khoảng trắng. Rỗng → null (cột nullable,
// và `upsertPhanIn` dựa vào NULL để biết "ERP không gửi" mà giữ giá trị cũ).
function chuanHoaDsMa(s) {
  const ds = tachDsMa(s);
  return ds.length ? ds.join(NGAN_CACH) : null;
}

// GỘP DỒN danh sách cũ + mới (khử trùng, cũ trước mới sau). Dùng cho đường ghi ở JS; đường ERP sync
// gộp thẳng trong SQL để giữ nguyên tử — 2 chỗ phải cho ra CÙNG kết quả.
function gopDsMa(cu, moi) {
  const ds = tachDsMa(cu);
  for (const v of tachDsMa(moi)) if (!ds.includes(v)) ds.push(v);
  return ds.length ? ds.join(NGAN_CACH) : null;
}

// Một mã quét có nằm trong danh sách không (dùng ở JS; SQL thì dùng `sqlKhopMa`).
function khopMa(dsChuoi, ma) {
  const m = String(ma == null ? '' : ma).trim();
  return !!m && tachDsMa(dsChuoi).includes(m);
}

// Số mã tối đa nhét vừa cột `VARCHAR(n)`: mỗi mã 11 số + 1 dấu phẩy, mã cuối không có dấu phẩy.
// ⚠ Lưới an toàn cho môi trường CHƯA chạy mig 089 (cột còn VARCHAR(60) ⇒ 5 mã): tràn cột sẽ ném
//   `22001` và **làm hỏng cả lượt sync của dòng đó**, nên thà cắt bớt còn hơn để sync chết.
function soMaVuaCot(doDaiCot) {
  const n = Number(doDaiCot);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.floor((n + 1) / (DAI_MA + 1)));
}

// Mảnh SQL khớp MỘT mã quét với danh sách trong cột. `thamSo` có thể là `$1` hoặc một cột khác.
// ⚠ Có `btrim` để chịu được dữ liệu cũ lỡ có khoảng trắng (đo prod hiện 0 dòng, nhưng đường sửa tay
//   ở *Quản trị phần in* thì người dùng gõ được `"a, b"`).
// ⚠ KHÔNG viết comment `--` trong chuỗi này: nhiều repo gộp SQL 1 dòng (CLAUDE.md §9).
function sqlKhopMa(cot, thamSo) {
  return `EXISTS (SELECT 1 FROM unnest(string_to_array(${cot}, '${NGAN_CACH}')) mv(v) WHERE btrim(mv.v) = ${thamSo})`;
}

module.exports = { NGAN_CACH, DAI_MA, tachDsMa, chuanHoaDsMa, gopDsMa, khopMa, soMaVuaCot, sqlKhopMa };
