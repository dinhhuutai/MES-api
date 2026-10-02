'use strict';

// ─── HÀNH TRÌNH GIA CÔNG của 1 PHẦN IN trong 1 LỆNH gia công (01/10/2026) ───────────────────────
// Hàm THUẦN — dữ liệu thô lấy ở `orders.repository.giaCongHanhTrinhData`, nên thử được bằng dữ liệu thật
// (dán JSON) mà không cần DB.
//
// Các bước: Release 1 · Gửi gia công → Ở nhà gia công → Nhận hàng về (mỗi lượt 1 tem 13) → OQC → Giao.
// Mỗi bước mang `dang_o` = SL CỦA CODE PHẦN NÀY đang nằm ở đó ⇒ trả lời thẳng "hàng đang ở đâu", thay cho
// khuôn chung Sản xuất → Chờ khô → KCS (lệnh gia công không có các bước đó; khuôn chung còn cộng số cả
// lệnh, gom nhiều code phần).
//
// ⚠ Số theo code phần lấy từ `giaCongPhanInRows` (cùng nguồn màn Kế hoạch › Gia công): tem cũ nhận ở mức
//   lệnh (chưa gắn đợt vải) được tính cho phần in ĐẠI DIỆN (`la_dai_dien`). Phần in khác của lệnh chỉ
//   nhận một dòng ghi chú — không đếm 2 lần.
// ⚠ Tem bị OQC trả về / bị hủy ⇒ tem HUY, SL quay lại "còn lại" của lệnh. Khi cờ trả về OQC_GIA_CONG còn
//   sống, phần đó đang ở MES chờ Kế hoạch bấm "Trả lại nhà gia công" ⇒ tách riêng khỏi "Ở nhà gia công".

const so = (v) => Number(v) || 0;
const id = (v) => (v == null ? '' : String(v));

// Nhãn tình trạng 1 tem 13 (đọc sổ cái đã tính sẵn ở SQL).
function tinhTrangTem(t) {
  if (t.trang_thai === 'HUY') return { badge: 'Đã hủy', tone: 'muted' };
  if (so(t.con_oqc) > 0) return { badge: 'Chờ OQC', tone: 'dang' };
  if (so(t.con_giao) > 0) return { badge: t.da_tich_giao ? 'Chờ in phiếu giao' : 'Chờ GN tích', tone: 'dang' };
  if (so(t.sl_da_giao) > 0) return { badge: 'Đã giao', tone: 'ok' };
  return { badge: null, tone: 'muted' };
}

function dungHanhTrinhGiaCong({ phanInId, lenh, data, mocGui }) {
  const pinCuaLenh = (data.pinRows || []).filter((r) => id(r.lenh_id) === id(lenh.id));
  const p = pinCuaLenh.find((r) => id(r.phan_in_id) === id(phanInId));
  if (!p) return null;
  const daiDien = pinCuaLenh.find((r) => r.la_dai_dien) || null;

  const temLenh = (data.tems || []).filter((t) => id(t.lenh_id) === id(lenh.id));
  // Tem của code phần này: gắn đúng đợt vải của nó, hoặc tem mồ côi khi nó là phần in đại diện.
  const laCuaToi = (t) => (t.phan_in_id ? id(t.phan_in_id) === id(phanInId) : !!p.la_dai_dien);
  const tems = temLenh.filter(laCuaToi);
  const temSong = tems.filter((t) => t.trang_thai !== 'HUY');
  const temById = new Map(tems.map((t) => [id(t.id), t]));
  const maTemCuaToi = new Set(tems.map((t) => t.ma_tem));
  const moCoiNguoiKhac = p.la_dai_dien ? [] : temLenh.filter((t) => !t.phan_in_id && t.trang_thai !== 'HUY');

  const auditLenh = (data.audits || []).filter((a) => a.ten_bang === 'lenh_san_xuat' && a.id_ban_ghi === id(lenh.id));
  const traLaiEv = auditLenh.filter((a) => a.hanh_dong === 'GIA_CONG_TRA_LAI');
  const oqcTraVeEv = auditLenh.filter((a) => a.hanh_dong === 'OQC_TRA_VE_GIA_CONG'
    && maTemCuaToi.has(a.gia_tri_moi?.ma_tem));
  const huyTemEv = (data.audits || []).filter((a) => a.ten_bang === 'tem' && temById.has(a.id_ban_ghi));
  const lyDoHuy = new Map();
  huyTemEv.forEach((a) => lyDoHuy.set(a.id_ban_ghi, `Hủy tem: ${a.gia_tri_moi?.ly_do || '—'}`));
  oqcTraVeEv.forEach((a) => {
    const t = temLenh.find((x) => x.ma_tem === a.gia_tri_moi?.ma_tem);
    if (t) lyDoHuy.set(id(t.id), `OQC trả về: ${a.gia_tri_moi?.ly_do || '—'}`);
  });

  // ── Số lượng của code phần này ──
  const gui = so(p.sl_release_phan);
  const daNhan = so(p.da_chuyen_phan); // đạt + hủy, tem sống
  const huy = so(p.da_huy_phan);
  const conLai = so(p.con_lai_phan);
  const traVeSong = data.traVe ? data.traVe[lenh.id] || data.traVe[id(lenh.id)] : null;
  let choTraLai = 0;
  if (traVeSong) {
    const mocTraLai = traLaiEv.length ? new Date(traLaiEv[traLaiEv.length - 1].tg).getTime() : -Infinity;
    choTraLai = oqcTraVeEv
      .filter((a) => new Date(a.tg).getTime() > mocTraLai)
      .reduce((s, a) => s + so(a.gia_tri_moi?.so_luong), 0);
    choTraLai = Math.min(choTraLai, conLai);
  }
  const oNhaGc = Math.max(0, conLai - choTraLai);
  const choOqc = temSong.reduce((s, t) => s + so(t.con_oqc), 0);
  const choTich = temSong.filter((t) => !t.da_tich_giao).reduce((s, t) => s + so(t.con_giao), 0);
  const choIn = temSong.filter((t) => t.da_tich_giao).reduce((s, t) => s + so(t.con_giao), 0);
  const daGiao = temSong.reduce((s, t) => s + so(t.sl_da_giao), 0);

  const nhaGc = [lenh.ma_chuyen, lenh.ten_chuyen && lenh.ten_chuyen !== lenh.ma_chuyen ? lenh.ten_chuyen : null]
    .filter(Boolean).join(' — ');
  const canhBaoChung = [];
  const tongNhanLenh = pinCuaLenh.reduce((s, r) => s + so(r.da_chuyen_phan), 0);
  if (tongNhanLenh > so(lenh.so_luong_release)) {
    canhBaoChung.push(`Lệnh ${lenh.ma_lenh_san_xuat} đã nhận về ${tongNhanLenh} pcs, nhiều hơn SL gửi `
      + `${so(lenh.so_luong_release)} pcs (dư ${tongNhanLenh - so(lenh.so_luong_release)}) — kiểm lại các lượt nhận.`);
  }
  // Màn OQC/Giao đang ẩn tem này? (`hien_*` = kết quả CHÍNH `dkTrang` của màn đó trên từng tem.)
  const anOqc = temSong.some((t) => so(t.con_oqc) > 0 && t.hien_oqc === false);
  const anGiao = temSong.some((t) => so(t.con_giao) > 0 && t.hien_giao === false);
  const CAU_HINH = 'Hệ thống › Hiển thị theo phương án in';
  if (anOqc) canhBaoChung.push(`Màn OQC đang ẨN hàng này (cấu hình ${CAU_HINH}, dòng "OQC") — OQC sẽ không thấy tem để kiểm.`);
  if (anGiao) canhBaoChung.push(`Màn Giao hàng đang ẨN hàng này (cấu hình ${CAU_HINH}, dòng "Phiếu giao — tem chờ giao").`);

  // Khung 1 bước — giữ đủ khóa của bước hành trình chung (`checklists`/`moc`/`qty`) để FE cũ vẫn vẽ được;
  // khóa mới: `dong` (dòng sự kiện), `canh_bao`, `dang_o` (SL đang nằm ở bước), `trang_thai`
  // ('xong'|'dang'|'chua'), `an_tren_man` (màn thao tác của bước đang ẩn hàng này).
  const node = (ma, ten, extra) => ({
    ma_tram: ma, ten_tram: ten, checklists: [], moc: null, qty: [], dong: [], canh_bao: [],
    dang_o: 0, trang_thai: 'chua', an_tren_man: null, ...extra,
  });

  // 1. Release 1 · Gửi gia công
  const nGui = node('RELEASE_1', 'Release 1 · Gửi gia công', {
    trang_thai: 'xong', moc: mocGui || null,
    qty: [{ label: 'SL gửi (code phần này)', value: gui }],
    dong: [
      { text: `Nhà gia công: ${nhaGc || '—'}${p.nha_gia_cong && p.nha_gia_cong !== lenh.ma_chuyen ? ` · ERP: ${p.nha_gia_cong}` : ''}` },
      ...(pinCuaLenh.length > 1 ? [{ text: `Lệnh ${lenh.ma_lenh_san_xuat} gửi chung ${pinCuaLenh.length} code phần · ${so(lenh.so_luong_release)} pcs`, tone: 'muted' }] : []),
    ],
  });

  // 2. Ở nhà gia công
  const nGc = node('GIA_CONG', 'Ở nhà gia công', {
    dang_o: oNhaGc + choTraLai,
    qty: [{ label: 'Đã gửi', value: gui }, { label: 'Đã nhận về', value: daNhan }, { label: 'Còn ở nhà GC', value: oNhaGc }],
    dong: traLaiEv.map((a) => ({
      tg: a.tg, nguoi: a.nguoi,
      text: `Kế hoạch trả hàng lại nhà gia công${a.gia_tri_moi?.ghi_chu ? ` — ${a.gia_tri_moi.ghi_chu}` : ''}`,
    })),
    canh_bao: [
      ...(choTraLai > 0 ? [`OQC trả về ${choTraLai} pcs — đang ở MES, chờ Kế hoạch bấm "Trả lại nhà gia công"`
        + `${traVeSong?.ly_do ? ` (lý do: ${traVeSong.ly_do})` : ''}.`] : []),
      // Lệnh đã đủ SL cả lệnh (rời màn Gia công) mà code phần này vẫn còn "ở nhà GC": thường do lượt nhận
      // cũ ở MỨC LỆNH (tem chung) đã gồm hàng của nó nhưng không ghi được code phần nào.
      ...(lenh.trang_thai === 'HOAN_TAT' && oNhaGc > 0 ? [`Lệnh đã đóng nhận hàng (đủ SL cả lệnh, đã rời màn `
        + `Gia công) nhưng code phần này chưa có lượt nhận riêng — hàng có thể đã về trong tem nhận chung.`] : []),
    ],
  });
  nGc.trang_thai = nGc.dang_o > 0 ? 'dang' : 'xong';

  // 3. Nhận hàng về — mỗi lượt 1 tem 13 (kể cả tem đã hủy, để thấy vì sao SL quay lại).
  const nNhan = node('NHAN_HANG', 'Nhận hàng về (tem 13)', {
    trang_thai: temSong.length ? 'xong' : 'chua',
    qty: [
      { label: 'Lượt nhận', value: temSong.length },
      { label: 'Đạt', value: temSong.reduce((s, t) => s + so(t.sl_kcs_dat), 0) },
      { label: 'Hủy', value: huy },
    ],
    dong: tems.map((t) => {
      const tt = tinhTrangTem(t);
      const huyTem = t.trang_thai === 'HUY';
      const sl = huyTem ? `${so(t.so_luong)} pcs`
        : `đạt ${so(t.sl_kcs_dat)}${so(t.sl_kcs_huy) ? ` · hủy ${so(t.sl_kcs_huy)}` : ''}`;
      return {
        tg: t.tg, nguoi: t.nguoi, tone: huyTem ? 'muted' : tt.tone, badge: tt.badge,
        text: `Tem ${t.ma_tem} · ${sl}${!t.phan_in_id ? ' · nhận chung cả lệnh' : ''}`
          + `${huyTem && lyDoHuy.get(id(t.id)) ? ` — ${lyDoHuy.get(id(t.id))}` : ''}`,
      };
    }),
    canh_bao: moCoiNguoiKhac.length ? [`Lệnh có ${moCoiNguoiKhac.length} tem nhận chung chưa tách code phần `
      + `(${moCoiNguoiKhac.map((t) => `${t.ma_tem} · ${so(t.so_luong)} pcs`).join(', ')}) — số đó đang tính cho `
      + `code phần ${daiDien?.ma_phan || '—'}.`] : [],
  });

  // 4. OQC
  const oqcCuaToi = (data.oqcs || []).filter((o) => temById.has(id(o.tem_id)));
  const nOqc = node('OQC', 'OQC', {
    dang_o: choOqc,
    qty: [{ label: 'Chờ OQC', value: choOqc }, { label: 'Đạt qua giao', value: oqcCuaToi.reduce((s, o) => s + so(o.sl_qua_giao), 0) }],
    dong: [
      ...oqcCuaToi.map((o) => {
        const t = temById.get(id(o.tem_id));
        const dat = o.ket_qua === 'DAT';
        return {
          tg: o.tg, nguoi: o.nguoi, tone: dat ? 'ok' : 'warn',
          badge: dat ? 'Đạt' : (o.cho_giao ? 'Không đạt · cho giao' : 'Không đạt'),
          text: `Tem ${t?.ma_tem || '—'} · bốc mẫu ${so(o.so_luong_kiem)}, đạt ${so(o.so_luong_dat)}`
            + `${dat || o.cho_giao ? ` · ${so(o.sl_qua_giao)} pcs qua giao` : ''}`
            + `${o.cho_giao && o.ly_do_cho_giao ? ` — ${o.ly_do_cho_giao}` : ''}`,
        };
      }),
      ...oqcTraVeEv.map((a) => ({
        tg: a.tg, nguoi: a.nguoi, tone: 'warn', badge: 'Trả về Kế hoạch',
        text: `Tem ${a.gia_tri_moi?.ma_tem || '—'} · ${so(a.gia_tri_moi?.so_luong)} pcs — ${a.gia_tri_moi?.ly_do || '—'}`,
      })),
      // `tg` = lúc nhận hàng = lúc bắt đầu chờ OQC.
      ...temSong.filter((t) => so(t.con_oqc) > 0).map((t) => ({
        tg: t.tg, tone: 'dang', badge: 'Đang chờ', text: `Tem ${t.ma_tem} · ${so(t.con_oqc)} pcs chờ OQC kiểm (từ lúc nhận hàng)`,
      })),
    ],
    an_tren_man: anOqc ? 'Màn OQC đang ẩn tem này' : null,
  });
  nOqc.trang_thai = choOqc > 0 ? 'dang' : (oqcCuaToi.length || oqcTraVeEv.length ? 'xong' : 'chua');

  // 5. Giao hàng
  const giaoCuaToi = (data.giaos || []).filter((g) => temById.has(id(g.tem_id)));
  const nGiao = node('DONE_DELIVERY', 'Giao hàng', {
    dang_o: choTich + choIn,
    qty: [{ label: 'Chờ GN tích', value: choTich }, { label: 'Chờ in phiếu', value: choIn }, { label: 'Đã giao', value: daGiao }],
    dong: [
      ...temSong.filter((t) => so(t.con_giao) > 0).map((t) => (t.da_tich_giao
        ? { tg: t.tg_tich_giao, nguoi: t.nguoi_tich, tone: 'dang', badge: 'Chờ in phiếu', text: `Tem ${t.ma_tem} · ${so(t.con_giao)} pcs — bán hàng đã tích, chờ in phiếu giao` }
        : { tone: 'dang', badge: 'Chờ GN tích', text: `Tem ${t.ma_tem} · ${so(t.con_giao)} pcs — chờ bán hàng tích tem (Chờ GN tích)` })),
      ...giaoCuaToi.map((g) => ({
        tg: g.tg, nguoi: g.nguoi, tone: g.trang_thai === 'DA_GIAO' ? 'ok' : 'muted',
        badge: g.trang_thai === 'DA_GIAO' ? 'Đã giao' : 'Đã tạo phiếu',
        text: `Phiếu ${g.ma_phieu_giao} · tem ${temById.get(id(g.tem_id))?.ma_tem || '—'} · ${so(g.so_luong_giao)} pcs`,
      })),
    ],
    an_tren_man: anGiao ? 'Màn Giao hàng đang ẩn tem này' : null,
  });
  nGiao.trang_thai = nGiao.dang_o > 0 ? 'dang' : (daGiao > 0 ? 'xong' : 'chua');

  const trams = [nGui, nGc, nNhan, nOqc, nGiao].map((t, i) => ({ ...t, thu_tu: i + 1 }));

  // ── Tóm tắt "đang ở đâu" (đầu khối hành trình) ──
  const doan = [
    { key: 'GIA_CONG', label: 'Ở nhà gia công', value: oNhaGc },
    { key: 'CHO_TRA_LAI', label: 'Chờ trả lại nhà GC', value: choTraLai, an_khi_0: true },
    { key: 'OQC', label: 'Chờ OQC', value: choOqc },
    { key: 'CHO_TICH', label: 'Chờ GN tích', value: choTich },
    { key: 'CHO_IN', label: 'Chờ in phiếu giao', value: choIn },
    { key: 'DA_GIAO', label: 'Đã giao', value: daGiao, xong: true },
    { key: 'HUY', label: 'Hủy (nhà GC trả hỏng)', value: huy, an_khi_0: true, phu: true },
  ].filter((d) => !(d.an_khi_0 && !d.value));
  const dangCho = doan.filter((d) => !d.xong && !d.phu && d.value > 0);
  let dangOText;
  if (dangCho.length) dangOText = dangCho.map((d) => `${d.label} ${d.value} pcs`).join(' · ');
  else if (daGiao > 0) dangOText = 'Đã giao xong';
  else dangOText = 'Chưa có hàng ở bước nào';

  return {
    gia_cong: {
      ma_lenh: lenh.ma_lenh_san_xuat, trang_thai_lenh: lenh.trang_thai, nha_gia_cong: nhaGc,
      sl_gui: gui, doan, dang_o_text: dangOText, canh_bao: canhBaoChung,
    },
    trams,
  };
}

module.exports = { dungHanhTrinhGiaCong, tinhTrangTem };
