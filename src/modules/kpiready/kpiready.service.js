'use strict';

// KPI READY — 5 chỉ số + bảng theo dõi. Luật cột ở `utils/kpiReady.js`.

const repo = require('./kpiready.repository');
const { COT_KPI, COT_TRAI_OWNER, LOAI_NGAY, NGUONG_DOI_PA } = require('../../utils/kpiReady');

const LOC_KEYS = ['timKiem', 'khach', 'maHang', 'codePhan', 'mauVai', 'loaiNgay', 'ngayTu', 'ngayDen'];
const layLoc = (q = {}) => LOC_KEYS.reduce((a, k) => (q[k] ? { ...a, [k]: q[k] } : a), {});

const laUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
// ⚠⚠ KHỬ TRÙNG là BẮT BUỘC, không phải cho gọn: `luuDonHangChon` dùng `ON CONFLICT DO UPDATE`, mà
//   Postgres ném **`21000 ON CONFLICT DO UPDATE command cannot affect row a second time`** nếu một
//   lượt INSERT có 2 dòng cùng khóa. Client gửi trùng id là chuyện rất dễ xảy ra (bấm nhanh 2 lần,
//   dán danh sách). Lỗi này đã bắt được lúc kiểm thực.
const tachDs = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => String(s).trim()).filter(laUuid))];

// Tỉ lệ %, làm tròn 1 chữ số. Mẫu số 0 ⇒ trả `null` (FE hiện "—"), KHÔNG trả 0: "0% trên 0 mẫu"
// và "0% trên 100 mẫu" là hai chuyện khác hẳn nhau.
const pct = (tu, mau) => (mau > 0 ? Math.round((tu / mau) * 1000) / 10 : null);

// ─── DANH MỤC CỘT + OWNER ────────────────────────────────────────────────────
// Owner của 1 cột lấy từ `tram_owner`/`checkpoint_owner` theo khóa cột khai trong `COT_KPI`.
// ⚠ Ưu tiên `CHIU_TRACH_NHIEM`; không có mới lấy `XU_LY` — dòng 2 của bảng chỉ đủ chỗ cho 1 tên,
//   mà "ai chịu trách nhiệm" mới là thứ quản lý cần khi soi KPI.
function gomOwner(rows) {
  const m = {};
  rows.forEach((o) => {
    if (!o.ten) return;
    const key = `${o.cap}:${o.ma}`;
    const g = (m[key] = m[key] || { chinh: [], xu_ly: [] });
    (o.loai === 'CHIU_TRACH_NHIEM' ? g.chinh : g.xu_ly).push(o.ten);
  });
  return m;
}

// `khoaRows` (tùy chọn) = danh sách trạm/checklist của workflow hiện hành kèm **id** — dùng cho trang
// *Owner checkpoint/checklist* để bấm gán thẳng vào đúng đích. Không truyền ⇒ 2 khóa `*_id` là null,
// endpoint chính (`/kpi-ready`) giữ nguyên hình dạng dữ liệu như trước.
// `ds` = danh mục cột cần dựng: mặc định 23 cột checklist (`COT_KPI`), truyền `COT_TRAI_OWNER` để
// dựng các cột BÊN TRÁI có owner riêng (hiện chỉ "Đợt vải"). Cùng một hàm ⇒ 2 nhóm cột không bao giờ
// lệch luật owner.
function dungCot(ownerRows, khoaRows, ds = COT_KPI) {
  const m = gomOwner(ownerRows);
  const k = {};
  (khoaRows || []).forEach((x) => { k[`${x.cap}:${x.ma}`] = x; });
  return ds.map((c) => {
    const key = c.checkpoint ? `CHECKPOINT:${c.checkpoint}` : (c.tram ? `TRAM:${c.tram}` : null);
    const g = (key && m[key]) || null;
    const dich = (key && k[key]) || null;
    return {
      ma: c.ma,
      ten: c.ten,
      nhom: c.nhom,
      col: c.col || null,
      tuSo: c.tuSo || null,
      mauSo: c.mauSo || null,
      ghi_chu: c.ghiChu || null,
      // Khóa owner để FE chỉ đúng chỗ cần gán khi còn trống.
      owner_key: key,
      owner_tram: c.tram || null,
      owner_checkpoint: c.checkpoint || null,
      // Đích gán THẬT (id + tên) — chỉ có khi bên gọi truyền `khoaRows`.
      // `dich_id` là id của `tram` hay `checkpoint` tùy `owner_checkpoint` có hay không.
      dich_id: dich ? dich.id : null,
      dich_ten: dich ? dich.ten : null,
      // Checklist thuộc trạm nào — trang Owner cần để chọn đúng trạm trước rồi mới tới checklist.
      dich_tram_id: dich ? dich.tram_id : null,
      dich_tram_ten: dich ? dich.tram_ten : null,
      owner: g ? (g.chinh.join(', ') || g.xu_ly.join(', ') || null) : null,
      owner_chinh: g && g.chinh.length ? g.chinh.join(', ') : null,
      owner_xu_ly: g && g.xu_ly.length ? g.xu_ly.join(', ') : null,
    };
  });
}

// ─── 5 KPI ───────────────────────────────────────────────────────────────────
// ⚠⚠ Tính trên ĐÚNG tập dòng đang hiển thị (sau bộ lọc) ⇒ đổi bộ lọc là KPI đổi theo, không bao
//   giờ có chuyện "ô KPI nói một đằng, bảng bên dưới một nẻo".
function tinhKpi(rows) {
  const tong = rows.length;

  // 1) % READY đủ TRƯỚC Release — mẫu số CỐ Ý là "phần in ĐÃ release", không phải tổng phần in:
  //    phần in chưa release thì chưa có gì để so, tính vào là dìm tỉ lệ xuống một cách vô nghĩa.
  const daRelease = rows.filter((r) => r.moc_release_1);
  const readyTruoc = daRelease.filter((r) => r.moc_qa_ready
    && new Date(r.moc_qa_ready) <= new Date(r.moc_release_1));

  // 2) Số lần THIẾU sau Release = đã release mà QA chưa xác nhận READY, hoặc xác nhận SAU khi release.
  const thieuSau = daRelease.length - readyTruoc.length;

  // 3) Số lần quay lại / rework = Σ số lượt trả về (READY · Release 1 · Test Run · OQC · gia công).
  const rework = rows.reduce((s, r) => s + (Number(r.so_lan_tra_ve) || 0), 0);
  const pinCoRework = rows.filter((r) => Number(r.so_lan_tra_ve) > 0).length;

  // 4) Lead time đến READY = từ lúc phần in lên MES (có vải) tới lúc IQC/QA xác nhận READY.
  // ⚠⚠ LỌC NULL **TRƯỚC** KHI `Number()`: `Number(null)` = **0** và `Number.isFinite(0)` = true
  //   ⇒ phần in CHƯA có mốc READY bị tính thành "0 phút" và kéo tụt trung bình. Lỗi này đã lọt
  //   qua lần viết đầu, test bắt được (182 mẫu thay vì 178). Đừng rút gọn lại thành một `.map`.
  const lead = rows.map((r) => r.lead_time_phut)
    .filter((v) => v !== null && v !== undefined)
    .map(Number).filter(Number.isFinite);
  const leadTong = lead.reduce((s, v) => s + v, 0);

  // 5) % bất thường (người dùng chốt 07/09/2026):
  //      tử số = số PHẦN IN bị đổi phương án in TRÊN 2 LẦN
  //      mẫu số = TỔNG phần in trong phạm vi (đơn hàng đã chọn + bộ lọc)
  //    ⚠ Chỉ đếm lần đổi DO NGƯỜI — xem `utils/kpiReady.js` khối `DOI_PA` (5.523/5.795 dòng
  //      `DOI_PHUONG_AN_IN` trên prod là do hệ thống tự đổi theo luật sản lượng).
  const batThuong = rows.filter((r) => Number(r.so_lan_doi_pa) > NGUONG_DOI_PA).length;

  return {
    ready_truoc_release: {
      pt: pct(readyTruoc.length, daRelease.length),
      tu_so: readyTruoc.length,
      mau_so: daRelease.length,
    },
    thieu_sau_release: { so_lan: thieuSau, mau_so: daRelease.length },
    rework: { so_lan: rework, so_phan_in: pinCoRework },
    lead_time: {
      tong_phut: leadTong,
      tb_phut: lead.length ? Math.round(leadTong / lead.length) : null,
      so_phan_in: lead.length,
    },
    bat_thuong: {
      pt: pct(batThuong, tong),
      tu_so: batThuong,
      mau_so: tong,
      nguong: NGUONG_DOI_PA,
    },
    tong_phan_in: tong,
  };
}

// ─── ĐỢT VẢI GẮN VÀO TỪNG PHẦN IN ────────────────────────────────────────────
// Chế độ *Chi tiết* tách 1 dòng / ĐỢT VẢI (người dùng chốt 08/09/2026): các ô mức phần in hợp nhất
// bằng rowSpan, còn SLNV + 4 mốc theo đợt (Vải · Release 1 · Test run · Release 2) tách theo từng đợt.
//
// ⚠⚠ CHỈ GẮN, KHÔNG ĐỔI SỐ Ở DÒNG PHẦN IN: mọi tổng/KPI vẫn tính trên `rows` (1 dòng/phần in) nên
//   tách dòng KHÔNG BAO GIỜ làm cộng đôi — đúng bẫy "lệnh gom set nhân số" đã ghi ở §6.
// ⚠ Phần in không có đợt vải nào ⇒ `dot_vai_list = []`, FE vẽ đúng 1 dòng như cũ.
async function ganDotVai(rows) {
  if (!rows || !rows.length) return rows;
  const ds = await repo.dsDotVai(rows.map((r) => r.phan_in_id));
  const m = new Map();
  ds.forEach((d) => {
    const a = m.get(d.phan_in_id) || [];
    a.push(d);
    m.set(d.phan_in_id, a);
  });
  rows.forEach((r) => { r.dot_vai_list = m.get(r.phan_in_id) || []; });
  return rows;
}

// ─── ENDPOINT CHÍNH ──────────────────────────────────────────────────────────
async function duLieu(q = {}) {
  const [donChon, ownerRows, coBang] = await Promise.all([
    repo.dsDonHangChon(), repo.dsOwner(), repo.coBangKpiDonHang(),
  ]);

  // Ô lọc "theo đơn" chỉ được THU HẸP trong phạm vi đã chọn — gửi id lạ thì bỏ qua, không mở rộng
  // phạm vi ra ngoài cấu hình.
  const idsChon = donChon.map((d) => d.id);
  const yeuCau = tachDs(q.donHangIds);
  const ids = yeuCau.length ? idsChon.filter((id) => yeuCau.includes(id)) : idsChon;

  const rows = ids.length ? await repo.layRows(ids, layLoc(q)) : [];
  await ganDotVai(rows);
  return {
    co_bang: coBang,
    don_hang: donChon,
    don_hang_dang_loc: yeuCau.length ? ids : [],
    cot: dungCot(ownerRows),
    // ⚠ TÁCH RIÊNG khỏi `cot`: bảng KPI vẽ `cot` thành khối 23 cột bên PHẢI — nhét cột trái vào đó
    //   là hiện sai chỗ. FE chỉ dùng mảng này để lấy owner cho cột trái tương ứng.
    cot_trai: dungCot(ownerRows, null, COT_TRAI_OWNER),
    loai_ngay: Object.entries(LOAI_NGAY).map(([ma, v]) => ({ ma, ten: v.ten })),
    kpi: tinhKpi(rows),
    rows,
  };
}

// ─── DANH MỤC CỘT (cho trang Owner checkpoint/checklist) ─────────────────────
// Trả 23 cột + owner hiện tại + ĐÍCH GÁN (id trạm/checklist). Cố ý TÁCH khỏi `duLieu()`: trang Owner
// chỉ cần danh mục, không việc gì phải chạy cả câu KPI nặng (9 CTE) chỉ để lấy tên owner.
// ⚠ `cot_trai` = cột bên trái có owner riêng (hiện chỉ "Đợt vải") — trang Owner phải bày CẢ hai
//   nhóm, nếu không người dùng không thấy chỗ nào để gán cột đó (đúng lỗi người dùng báo 10/09/2026).
async function danhMucCot() {
  const [ownerRows, khoaRows] = await Promise.all([repo.dsOwner(), repo.dsKhoaOwner()]);
  return {
    cot: dungCot(ownerRows, khoaRows),
    cot_trai: dungCot(ownerRows, khoaRows, COT_TRAI_OWNER),
  };
}

// ─── TRANG CẤU HÌNH (Hệ thống) ───────────────────────────────────────────────
const dsDonHangDeChon = (q = {}) => repo.dsDonHangDeChon({
  search: q.search || '',
  chiDaChon: q.chiDaChon === '1' || q.chiDaChon === 'true' || q.chiDaChon === true,
});

async function luuDonHangChon(body = {}, actor) {
  const ids = tachDs(body.ids);
  const kq = await repo.luuDonHangChon(ids, actor);
  return { ...kq, ids };
}

// `_tinhKpi` export ra CHỈ để kiểm thực gọi được đúng hàm đang chạy thật (đừng dùng ở nơi khác).
module.exports = { duLieu, danhMucCot, dsDonHangDeChon, luuDonHangChon, _tinhKpi: tinhKpi };
