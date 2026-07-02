'use strict';

// =====================================================================
// Bộ tính công thức AN TOÀN cho báo cáo (KHÔNG dùng eval).
// Hỗ trợ: số, + - * /, ngoặc ( ), dấu âm/dương đơn, tham chiếu ô kiểu A1 (chữ cột + số hàng).
// Mã lỗi trả về (chuỗi bắt đầu '#'): #LOI (cú pháp), #CHIA0, #VONG_LAP, #TEXT, #METRIC, #SO.
// =====================================================================

// ---- Tokenizer ----
function tokenize(expr) {
  const tokens = [];
  const s = String(expr || '');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i += 1; continue; }
    if ('+-*/()'.includes(ch)) { tokens.push({ t: ch }); i += 1; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j += 1;
      tokens.push({ t: 'num', v: Number(s.slice(i, j)) });
      i = j; continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      let j = i;
      while (j < s.length && ((s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= 'a' && s[j] <= 'z'))) j += 1;
      const col = s.slice(i, j);
      let k = j;
      while (k < s.length && s[k] >= '0' && s[k] <= '9') k += 1;
      if (k === j) throw new Error('#LOI'); // chữ không kèm số → không phải ô hợp lệ
      tokens.push({ t: 'cell', v: (col + s.slice(j, k)).toUpperCase() });
      i = k; continue;
    }
    throw new Error('#LOI');
  }
  return tokens;
}

// ---- Parser đệ quy (trả về số) ----
// resolve(cellKey) → số, hoặc throw Error('#...') nếu ô lỗi/vòng lặp.
function evalExpr(expr, resolve) {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    let v = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = next().t;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = next().t;
      const r = parseFactor();
      if (op === '*') v *= r;
      else { if (r === 0) throw new Error('#CHIA0'); v /= r; }
    }
    return v;
  }
  function parseFactor() {
    const tk = peek();
    if (!tk) throw new Error('#LOI');
    if (tk.t === '+') { next(); return parseFactor(); }
    if (tk.t === '-') { next(); return -parseFactor(); }
    if (tk.t === 'num') { next(); return tk.v; }
    if (tk.t === 'cell') { next(); return resolve(tk.v); }
    if (tk.t === '(') {
      next();
      const v = parseExpr();
      if (!peek() || peek().t !== ')') throw new Error('#LOI');
      next();
      return v;
    }
    throw new Error('#LOI');
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error('#LOI'); // dư token
  if (!Number.isFinite(result)) throw new Error('#LOI');
  return result;
}

// ---- Tính toàn bộ lưới ----
// cells: { "A1": {loai, ...} }; metricValues: { MA: number }.
// Trả { "A1": { value, kieu:'so'|'text'|'loi', loi? } }.
function evaluateGrid(cells = {}, metricValues = {}) {
  const memo = {}; // key -> { v } | { err }
  const stack = new Set();

  function resolve(key) {
    if (memo[key]) { if (memo[key].err) throw new Error(memo[key].err); return memo[key].v; }
    if (stack.has(key)) { memo[key] = { err: '#VONG_LAP' }; throw new Error('#VONG_LAP'); }
    const c = cells[key];
    try {
      let v;
      if (!c) v = 0;
      else if (c.loai === 'so') { v = Number(c.gia_tri); if (!Number.isFinite(v)) throw new Error('#SO'); }
      else if (c.loai === 'text') throw new Error('#TEXT');
      else if (c.loai === 'metric') {
        const mv = metricValues[c.metric];
        if (mv == null || typeof mv === 'object') throw new Error('#METRIC');
        v = Number(mv); if (!Number.isFinite(v)) throw new Error('#METRIC');
      } else if (c.loai === 'cong_thuc') {
        stack.add(key);
        try { v = evalExpr(c.bieu_thuc, resolve); } finally { stack.delete(key); }
      } else v = 0;
      memo[key] = { v };
      return v;
    } catch (e) {
      const code = e.message && e.message.startsWith('#') ? e.message : '#LOI';
      memo[key] = { err: code };
      throw new Error(code);
    }
  }

  const out = {};
  for (const key of Object.keys(cells)) {
    const c = cells[key];
    if (c.loai === 'text') { out[key] = { value: c.gia_tri ?? '', kieu: 'text' }; continue; }
    try { out[key] = { value: resolve(key), kieu: 'so' }; }
    catch (e) { out[key] = { value: e.message, kieu: 'loi', loi: true }; }
  }
  return out;
}

module.exports = { evaluateGrid, evalExpr, tokenize };
