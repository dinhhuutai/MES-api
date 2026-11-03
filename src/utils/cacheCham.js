'use strict';

// CACHE CHO SỐ TỔNG HỢP NẶNG, CHẤP NHẬN CŨ MỘT CHÚT (03/11/2026 — sự cố prod: 19 câu dải "Theo dõi" chạy cùng lúc, mỗi câu
// 15–28 giây, gần đầy pool 25 kết nối, CPU 90–100%).
// `cacheDoc.nhoDoc` hết hiệu lực sau MỌI thao tác ghi của bất kỳ ai; câu chạy lâu hơn khoảng cách giữa 2 lần ghi thì không
// bao giờ dùng lại được ⇒ càng đông càng chậm. Ở đây:
//   · Có số trong `ttlMs` ⇒ trả ngay, KHÔNG xét thao tác ghi. Hết hạn ⇒ vẫn trả số cũ ngay, tính lại ở nền.
//   · Mỗi khóa chỉ 1 lượt tính; toàn bộ tối đa `TOI_DA_SONG_SONG` lượt, còn lại xếp hàng ⇒ không chiếm hết pool và CPU.
// ⚠ CHỈ dùng cho số mà chậm tối đa ~1 phút vẫn chấp nhận được. Danh sách để thao tác phải dùng `nhoDoc`.
// ⚠ Kết quả dùng chung ⇒ nơi gọi không được sửa (mutate) object trả về.
const { khoaOn } = require('./cacheDoc');

const TOI_DA_SONG_SONG = 2;
const TTL_MAC_DINH = 60000;
const TOI_DA_MUC = 300;

const _nho = new Map(); // khoa → { at, co, gt, dang }
const _hang = [];
let _dangChay = 0;

function chayTiep() {
  while (_dangChay < TOI_DA_SONG_SONG && _hang.length) {
    const { tinh, xong, loi } = _hang.shift();
    _dangChay += 1;
    Promise.resolve().then(tinh).then(xong, loi).finally(() => { _dangChay -= 1; chayTiep(); });
  }
}
const xepHang = (tinh) => new Promise((xong, loi) => { _hang.push({ tinh, xong, loi }); chayTiep(); });

function nhoCham(nhom, thamSo, tinh, ttlMs = TTL_MAC_DINH) {
  const khoa = `${nhom}|${khoaOn(thamSo)}`;
  let m = _nho.get(khoa);
  if (!m) {
    if (_nho.size >= TOI_DA_MUC) {
      for (const [k, v] of _nho) { if (!v.dang) { _nho.delete(k); break; } }
    }
    m = { at: 0, co: false, gt: undefined, dang: null };
    _nho.set(khoa, m);
  }
  const tinhLai = () => {
    if (!m.dang) {
      m.dang = xepHang(tinh)
        .then((v) => { m.gt = v; m.co = true; m.at = Date.now(); return v; })
        .finally(() => { m.dang = null; });
    }
    return m.dang;
  };
  if (!m.co) return tinhLai();
  // Lỗi lúc tính nền thì giữ số cũ, lượt sau hết hạn sẽ thử lại.
  if (Date.now() - m.at >= ttlMs) tinhLai().catch(() => {});
  return Promise.resolve(m.gt);
}

module.exports = { nhoCham, TOI_DA_SONG_SONG };
