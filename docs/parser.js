/*
 * Разбор файла расписания (.doc / .docx) в структуру для приложения.
 *
 * Работает и в браузере (window.ScheduleParser), и в Node (module.exports).
 * Зависимости передаются снаружи: CFB (для .doc), JSZip и DOMParser (для .docx).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Общие утилиты
  // ---------------------------------------------------------------------------

  function toU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (Array.isArray(x)) return Uint8Array.from(x);
    return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  }

  function isDocx(u8) { return u8[0] === 0x50 && u8[1] === 0x4b; } // "PK"
  function isDoc(u8) { return u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0; }

  // ---------------------------------------------------------------------------
  // .doc (Word 97–2003, MS-DOC)
  // ---------------------------------------------------------------------------

  // Символы 0x80–0x9F в «сжатых» кусках текста (MS-DOC 2.4.1)
  const CP1252_HI = {
    0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
    0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x91: 0x2018,
    0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9f: 0x0178,
  };

  function streamBytes(CFB, cfb, name) {
    const e = CFB.find(cfb, name);
    return e && e.content ? toU8(e.content) : null;
  }

  function parseGrpprl(b, s, e, dataStream, props) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    props = props || { inTable: false, ttp: false, itap: 0, innerTtp: false, tdef: null, vmerge: [] };
    let p = s;
    while (p + 2 <= e) {
      const sprm = dv.getUint16(p, true);
      p += 2;
      const spra = sprm >> 13;
      let size;
      if (spra === 0 || spra === 1) size = 1;
      else if (spra === 2 || spra === 4 || spra === 5) size = 2;
      else if (spra === 3) size = 4;
      else if (spra === 7) size = 3;
      else if (sprm === 0xd608) size = dv.getUint16(p, true) + 1; // sprmTDefTable
      else if (sprm === 0xc615 && b[p] === 255) break; // sprmPChgTabs (сложный случай) — дальше не читаем
      else size = b[p] + 1;
      if (p + size > e) break;

      switch (sprm) {
        case 0x2416: props.inTable = b[p] !== 0; break; // sprmPFInTable
        case 0x2417: props.ttp = b[p] !== 0; break; // sprmPFTtp
        case 0x244c: props.innerTtp = b[p] !== 0; break; // sprmPFInnerTtp
        case 0x6649: props.itap = dv.getUint32(p, true); break; // sprmPItap
        case 0x6646: { // sprmPHugePapx — свойства лежат в потоке Data
          const off = dv.getUint32(p, true);
          if (dataStream && off + 2 <= dataStream.length) {
            const cb = dataStream[off] | (dataStream[off + 1] << 8);
            parseGrpprl(dataStream, off + 2, Math.min(off + 2 + cb, dataStream.length), null, props);
          }
          break;
        }
        case 0xd62b: props.vmerge.push({ itc: b[p + 1], flags: b[p + 2] }); break; // sprmTVertMerge
        case 0xd608: { // sprmTDefTable
          const cb = dv.getUint16(p, true);
          const end = p + 2 + cb - 1;
          const itcMac = b[p + 2];
          const centers = [];
          let q = p + 3;
          for (let i = 0; i <= itcMac && q + 2 <= end; i++, q += 2) centers.push(dv.getInt16(q, true));
          const tcs = [];
          for (let i = 0; i < itcMac && q + 20 <= end; i++, q += 20) tcs.push(dv.getUint16(q, true));
          props.tdef = { centers, tcs };
          break;
        }
      }
      p += size;
    }
    return props;
  }

  function readPapxRuns(wd, tbl, dataStream, fcPlcf, lcbPlcf) {
    const dvT = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);
    const dvW = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    const n = (lcbPlcf - 4) / 8;
    const runs = [];
    for (let k = 0; k < n; k++) {
      const pn = dvT.getUint32(fcPlcf + (n + 1) * 4 + k * 4, true) & 0x3fffff;
      const page = pn * 512;
      if (page + 512 > wd.length) continue;
      const crun = wd[page + 511];
      for (let i = 0; i < crun; i++) {
        const fcStart = dvW.getUint32(page + i * 4, true);
        const fcEnd = dvW.getUint32(page + (i + 1) * 4, true);
        const bOff = wd[page + (crun + 1) * 4 + i * 13];
        let props = { inTable: false, ttp: false, itap: 0, innerTtp: false, tdef: null, vmerge: [] };
        if (bOff) {
          const pos = page + bOff * 2;
          let cb = wd[pos], start, len;
          if (cb === 0) { len = wd[pos + 1] * 2; start = pos + 2; }
          else { len = cb * 2 - 1; start = pos + 1; }
          props = parseGrpprl(wd, start + 2, start + len, dataStream); // первые 2 байта — istd
        }
        runs.push({ fcStart, fcEnd, props });
      }
    }
    runs.sort((a, b) => a.fcStart - b.fcStart);
    return runs;
  }

  function findRun(runs, fc) {
    let lo = 0, hi = runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = runs[mid];
      if (fc < r.fcStart) hi = mid - 1;
      else if (fc >= r.fcEnd) lo = mid + 1;
      else return r.props;
    }
    return null;
  }

  // Возвращает { paragraphs: [строки вне таблиц], tables: [ [ [ячейка{text,left,right,vcont}] ] ] }
  function readDoc(u8, CFB) {
    if (!CFB) throw new Error('Не загружена библиотека CFB для чтения .doc');
    const cfb = CFB.read(u8, { type: 'array' });
    const wd = streamBytes(CFB, cfb, 'WordDocument');
    if (!wd) throw new Error('Это не документ Word');
    const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (dv.getUint16(0, true) !== 0xa5ec) throw new Error('Неизвестный формат .doc');
    const flags = dv.getUint16(0x0a, true);
    if (flags & 0x0100) throw new Error('Документ зашифрован (защищён паролем)');
    const tbl = streamBytes(CFB, cfb, flags & 0x0200 ? '1Table' : '0Table');
    if (!tbl) throw new Error('В документе нет таблицы свойств');
    const dvT = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);

    const csw = dv.getUint16(32, true);
    const lwOff = 34 + csw * 2 + 2;
    const cslw = dv.getUint16(34 + csw * 2, true);
    const ccpText = dv.getUint32(lwOff + 12, true);
    const fcLcbOff = lwOff + cslw * 4 + 2;
    const fcLcb = (i) => [dv.getUint32(fcLcbOff + i * 8, true), dv.getUint32(fcLcbOff + i * 8 + 4, true)];
    const [fcPlcfBtePapx, lcbPlcfBtePapx] = fcLcb(13);
    const [fcClx] = fcLcb(33);

    // Таблица кусков (piece table)
    let pos = fcClx;
    while (tbl[pos] === 0x01) pos += 3 + dvT.getUint16(pos + 1, true);
    if (tbl[pos] !== 0x02) throw new Error('Повреждённая таблица текста в .doc');
    const lcb = dvT.getUint32(pos + 1, true);
    pos += 5;
    const nPcd = (lcb - 4) / 12;
    const pieces = [];
    for (let i = 0; i < nPcd; i++) {
      const cpStart = dvT.getUint32(pos + i * 4, true);
      const cpEnd = dvT.getUint32(pos + (i + 1) * 4, true);
      const fcRaw = dvT.getUint32(pos + (nPcd + 1) * 4 + i * 8 + 2, true);
      const compressed = (fcRaw & 0x40000000) !== 0;
      const fc = compressed ? (fcRaw & 0x3fffffff) / 2 : fcRaw;
      pieces.push({ cpStart, cpEnd, fc, compressed });
    }

    const runs = readPapxRuns(wd, tbl, streamBytes(CFB, cfb, 'Data'), fcPlcfBtePapx, lcbPlcfBtePapx);

    const paragraphs = [];
    const tables = [];
    let curTable = null;
    let cellCells = []; // накопленные ячейки текущей строки
    let buf = '';
    const fieldStack = []; // true = код поля (пропускаем), false = результат

    function finishTable() {
      if (curTable && curTable.length) tables.push(curTable);
      curTable = null;
    }

    for (const pc of pieces) {
      const end = Math.min(pc.cpEnd, ccpText);
      for (let cp = pc.cpStart; cp < end; cp++) {
        let code, fc;
        if (pc.compressed) {
          fc = pc.fc + (cp - pc.cpStart);
          code = wd[fc];
          if (CP1252_HI[code]) code = CP1252_HI[code];
        } else {
          fc = pc.fc + (cp - pc.cpStart) * 2;
          code = dv.getUint16(fc, true);
        }

        if (code === 0x13) { fieldStack.push(true); continue; }
        if (code === 0x14) { if (fieldStack.length) fieldStack[fieldStack.length - 1] = false; continue; }
        if (code === 0x15) { fieldStack.pop(); continue; }
        if (fieldStack.some(Boolean)) continue;

        if (code === 0x07 || code === 0x0d) {
          const props = findRun(runs, fc) || {};
          const inTable = props.inTable || props.itap > 0 || props.ttp;
          if (code === 0x07 && (props.ttp || (props.itap === 1 && props.innerTtp))) {
            // конец строки таблицы
            const td = props.tdef;
            const row = cellCells.map((text, i) => {
              let left = i, right = i + 1, vcont = false;
              if (td && td.centers.length === cellCells.length + 1) {
                left = td.centers[i]; right = td.centers[i + 1];
              }
              if (td && td.tcs[i] !== undefined) {
                const f = td.tcs[i];
                vcont = (f & 0x20) !== 0 && (f & 0x40) === 0; // fVertMerge без fVertRestart
              }
              for (const vm of props.vmerge) if (vm.itc === i) vcont = vm.flags === 1;
              return { text, left, right, vcont };
            });
            row.byIndex = !(td && td.centers.length === cellCells.length + 1);
            if (!curTable) curTable = [];
            curTable.push(row);
            cellCells = [];
            buf = '';
          } else if (code === 0x07) {
            cellCells.push(buf.replace(/\n+$/, ''));
            buf = '';
          } else if (inTable) {
            buf += '\n';
          } else {
            finishTable();
            if (buf.trim()) paragraphs.push(buf.trim());
            buf = '';
          }
          continue;
        }

        if (code === 0x0b || code === 0x0c) { buf += '\n'; continue; }
        if (code === 0x09 || code === 0xa0) { buf += ' '; continue; }
        if (code === 0x1e) { buf += '-'; continue; }
        if (code < 0x20 || code === 0x1f) continue; // картинки, сноски, мягкий перенос
        buf += String.fromCharCode(code);
      }
    }
    finishTable();
    if (buf.trim()) paragraphs.push(buf.trim());

    return { paragraphs, tables: tables.map(tableToGridFromDoc) };
  }

  // Приводим строки .doc к единой сетке колонок по X-координатам ячеек
  function tableToGridFromDoc(rows) {
    const useX = rows.every((r) => !r.byIndex);
    let edges = [];
    if (useX) {
      const all = [];
      rows.forEach((r) => r.forEach((c) => all.push(c.left)));
      all.sort((a, b) => a - b);
      for (const x of all) if (!edges.length || x - edges[edges.length - 1] > 40) edges.push(x);
    }
    const colOf = (c, i) => {
      if (!useX) return i;
      let best = 0;
      for (let k = 0; k < edges.length; k++) if (Math.abs(edges[k] - c.left) < Math.abs(edges[best] - c.left)) best = k;
      return best;
    };
    const ncols = useX ? edges.length : Math.max(...rows.map((r) => r.length));
    const grid = [];
    rows.forEach((r) => {
      const g = new Array(ncols).fill('');
      const cont = new Array(ncols).fill(false);
      r.forEach((c, i) => {
        const col = colOf(c, i);
        g[col] = c.text;
        cont[col] = c.vcont;
      });
      const prev = grid[grid.length - 1];
      if (prev) for (let k = 0; k < ncols; k++) if (cont[k]) g[k] = prev[k];
      grid.push(g);
    });
    return grid;
  }

  // ---------------------------------------------------------------------------
  // .docx (Office Open XML)
  // ---------------------------------------------------------------------------

  function kids(el, name) {
    const out = [];
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === name) out.push(n);
    return out;
  }
  function kid(el, name) { return kids(el, name)[0] || null; }
  function wAttr(el, name) {
    if (!el) return null;
    return el.getAttribute('w:' + name) || el.getAttribute(name);
  }

  function runText(el) {
    let s = '';
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      const ln = n.localName;
      if (ln === 't') s += n.textContent;
      else if (ln === 'tab') s += ' ';
      else if (ln === 'br' || ln === 'cr') s += '\n';
      else if (ln === 'noBreakHyphen') s += '-';
      else if (ln === 'instrText' || ln === 'delText' || ln === 'tbl') continue;
      else s += runText(n);
    }
    return s;
  }

  function readDocxXml(xml, DOMParserCtor) {
    const doc = new DOMParserCtor().parseFromString(xml, 'application/xml');
    const body = doc.getElementsByTagName('w:body')[0] || doc.documentElement;
    const paragraphs = [];
    const tables = [];
    for (let n = body.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1) continue;
      if (n.localName === 'p') {
        const t = runText(n).trim();
        if (t) paragraphs.push(t);
      } else if (n.localName === 'tbl') {
        const grid = [];
        for (const tr of kids(n, 'tr')) {
          const row = [];
          const cont = [];
          const trPr = kid(tr, 'trPr');
          const gb = trPr && kid(trPr, 'gridBefore');
          for (let i = 0; i < (gb ? +wAttr(gb, 'val') : 0); i++) { row.push(''); cont.push(false); }
          for (const tc of kids(tr, 'tc')) {
            const tcPr = kid(tc, 'tcPr');
            const span = tcPr && kid(tcPr, 'gridSpan') ? +wAttr(kid(tcPr, 'gridSpan'), 'val') || 1 : 1;
            const vm = tcPr && kid(tcPr, 'vMerge');
            const isCont = !!vm && wAttr(vm, 'val') !== 'restart';
            const text = kids(tc, 'p').map((p) => runText(p).replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
            row.push(text); cont.push(isCont);
            for (let k = 1; k < span; k++) { row.push(''); cont.push(false); }
          }
          const prev = grid[grid.length - 1];
          if (prev) for (let k = 0; k < row.length; k++) if (cont[k]) row[k] = prev[k] || '';
          grid.push(row);
        }
        tables.push(grid);
      }
    }
    return { paragraphs, tables };
  }

  async function readDocx(u8, JSZip, DOMParserCtor) {
    if (!JSZip) throw new Error('Не загружена библиотека JSZip для чтения .docx');
    const zip = await JSZip.loadAsync(u8);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('В .docx нет основного документа');
    return readDocxXml(await f.async('string'), DOMParserCtor);
  }

  // ---------------------------------------------------------------------------
  // Из сетки таблицы — в расписание
  // ---------------------------------------------------------------------------

  const DAYS = [
    ['ПОНЕДЕЛЬНИК', 1], ['ВТОРНИК', 2], ['СРЕДА', 3], ['ЧЕТВЕРГ', 4],
    ['ПЯТНИЦА', 5], ['СУББОТА', 6], ['ВОСКРЕСЕНЬЕ', 7],
  ];
  const TIME_RE = /(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})/;
  const WEEK_RE = /\(?\s*(не)?ч[её]тн\S*\s+недел\S*\s*\)?/i;
  const RANGE_RE = /\(?\s*с\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*(?:г\.?)?\s*(?:по|-|–|—)\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*(?:г\.?)?\s*\)?/i;
  const PERSON_RE = /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ]\.\s?[А-ЯЁ]?$/;

  function dayOf(text) {
    const t = (text || '').toUpperCase().replace(/[^А-ЯЁ]/g, '');
    if (t.length < 4) return 0;
    for (const [name, n] of DAYS) if (t.startsWith(name.slice(0, 5)) || name.startsWith(t)) return n;
    return 0;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function isoDate(d, m, y) {
    y = +y;
    if (y < 100) y += 2000;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  const stripDots = (p) => p.trim().replace(/[.\s]+$/, '');

  function isTeacherLine(line) {
    const parts = line.split(',').map(stripDots).filter(Boolean);
    return parts.length > 0 && parts.every((p) => /^ВАКАНСИЯ$/i.test(p) || PERSON_RE.test(p));
  }

  function cleanLines(text) {
    return (text || '')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l && !/^[.\s/\\,;-]*$/.test(l));
  }

  // Строки одной ячейки -> набор вариантов (разные недели / периоды / предметы)
  function splitVariants(lines) {
    // 1) Разбиваем по диапазонам дат «(с 01.10.26 по 18.11.26)» — диапазон закрывает группу строк над ним
    let segments = [];
    let cur = [];
    let hasRange = false;
    for (const line of lines) {
      const m = line.match(RANGE_RE);
      if (m) {
        hasRange = true;
        const rest = line.replace(RANGE_RE, '').trim();
        if (rest) cur.push(rest);
        segments.push({ lines: cur, from: isoDate(m[1], m[2], m[3]), to: isoDate(m[4], m[5], m[6]) });
        cur = [];
      } else cur.push(line);
    }
    if (!hasRange) segments = [{ lines: cur, from: null, to: null }];
    else if (cur.length) {
      // Хвост без диапазона: если это просто примечание — приклеиваем к последнему варианту
      segments.push({ lines: cur, from: null, to: null });
    }

    // 2) Внутри группы — разбиваем, если в ней есть и «четная», и «нечетная» неделя
    const variants = [];
    for (const seg of segments) {
      const idx = [];
      seg.lines.forEach((l, i) => { if (WEEK_RE.test(l)) idx.push(i); });
      if (idx.length < 2) { variants.push(seg); continue; }
      const cuts = [0];
      for (let k = 1; k < idx.length; k++) {
        let b = idx[k] - 1;
        while (b > cuts[cuts.length - 1] + 1 && /^\(/.test(seg.lines[b])) b--;
        if (b <= idx[k - 1]) b = idx[k - 1] + 1;
        // Если перед меткой стоит фамилия преподавателя — новый вариант начинается с самой метки
        if (isTeacherLine(seg.lines[b]) && b !== idx[k]) b = idx[k];
        cuts.push(b);
      }
      cuts.push(seg.lines.length);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const part = seg.lines.slice(cuts[k], cuts[k + 1]);
        if (part.length) variants.push({ lines: part, from: seg.from, to: seg.to });
      }
    }
    return variants;
  }

  function parseVariant(v) {
    const out = { subject: '', teachers: [], notes: [], week: null, from: v.from, to: v.to };
    for (let line of v.lines) {
      const wm = line.match(WEEK_RE);
      if (wm) {
        out.week = wm[1] ? 'odd' : 'even';
        line = line.replace(WEEK_RE, '').trim();
        if (!line) continue;
      }
      if (isTeacherLine(line)) {
        line.split(',').forEach((t) => {
          t = stripDots(t).replace(/([А-ЯЁ]\.)\s+(?=[А-ЯЁ])/g, '$1');
          if (t && !/^ВАКАНСИЯ$/i.test(t)) t += '.';
          if (t && !out.teachers.includes(t)) out.teachers.push(t);
        });
      } else if (/^\(/.test(line)) {
        out.notes.push(line.replace(/^\(\s*/, '').replace(/\s*\)?$/, ''));
      } else if (!out.subject) {
        out.subject = line;
      } else {
        out.subject += ' ' + line;
      }
    }
    return out;
  }

  function parseCell(text, roomText) {
    const lines = cleanLines(text);
    if (!lines.length) return [];
    const variants = splitVariants(lines).map(parseVariant);

    // Вариант без предмета (только преподаватель/период) наследует предмет от предыдущего
    for (let i = 0; i < variants.length; i++) {
      if (!variants[i].subject && i > 0) {
        variants[i].subject = variants[i - 1].subject;
        if (!variants[i].week) {
          // примечания вроде «(согласно учебному плану)» тоже наследуем
          variants[i].notes = [...new Set([...variants[i - 1].notes, ...variants[i].notes])];
        }
      }
    }
    // Хвост без предмета и без собственного смысла — это примечание ко всем вариантам
    const filtered = [];
    for (const v of variants) {
      if (!v.subject && !v.teachers.length) {
        if (filtered.length) filtered.forEach((f) => f.notes.push(...v.notes));
        continue;
      }
      filtered.push(v);
    }
    if (!filtered.length) return [];

    const rooms = cleanLines((roomText || '').replace(/\/+/g, '\n'));
    filtered.forEach((v, i) => {
      if (filtered.length > 1 && rooms.length === filtered.length) v.room = rooms[i];
      else v.room = rooms.join(', ');
      if (!v.subject) v.subject = 'Занятие';
    });
    return filtered;
  }

  function buildSchedule(docData, fileName) {
    // Ищем таблицу со строкой-заголовком «N курс»
    let grid = null, headerRow = -1;
    for (const t of docData.tables) {
      for (let r = 0; r < Math.min(t.length, 5); r++) {
        if (t[r].some((c) => /\d\s*курс/i.test(c))) { grid = t; headerRow = r; break; }
      }
      if (grid) break;
    }
    if (!grid) throw new Error('Не нашёл в файле таблицу с колонками «N курс»');

    const header = grid[headerRow];
    const courses = [];
    header.forEach((c, i) => {
      const m = c.match(/(\d)\s*курс/i);
      if (!m) return;
      const label = c.replace(/\s+/g, ' ').trim();
      const kind = label.replace(/^\d\s*курс\s*/i, '').trim();
      const roomCol = header[i + 1] !== undefined && /ауд/i.test(header[i + 1]) ? i + 1 : null;
      courses.push({ id: `${m[1]}-${i}`, num: +m[1], label: `${m[1]} курс`, kind: kind.toLowerCase(), col: i, roomCol, entries: [] });
    });
    const firstCourseCol = Math.min(...courses.map((c) => c.col));

    let day = 0;
    for (let r = headerRow + 1; r < grid.length; r++) {
      const row = grid[r];
      let time = null;
      let dayHere = 0;
      for (let k = 0; k < firstCourseCol; k++) {
        const m = (row[k] || '').match(TIME_RE);
        if (m && !time) time = { start: `${pad(m[1])}:${m[2]}`, end: `${pad(m[3])}:${m[4]}` };
        else if (!dayHere) dayHere = dayOf(row[k]);
      }
      if (dayHere) day = dayHere;
      if (!time || !day) continue;
      for (const c of courses) {
        const lessons = parseCell(row[c.col], c.roomCol !== null ? row[c.roomCol] : '');
        if (lessons.length) c.entries.push({ day, start: time.start, end: time.end, lessons });
      }
    }

    // Заголовок из текста над таблицей
    const paras = docData.paragraphs;
    const iTitle = paras.findIndex((p) => /РАСПИСАНИЕ/i.test(p));
    let title = 'Расписание';
    let subtitle = '';
    if (iTitle >= 0) {
      title = paras[iTitle].replace(/\s+/g, ' ').trim();
      const next = paras[iTitle + 1] || '';
      if (/полугод|семестр|учебн/i.test(next)) subtitle = next.replace(/\s+/g, ' ').trim();
    }
    const tc = (s) => s.charAt(0) + s.slice(1).toLowerCase();

    return {
      version: 1,
      title: tc(title),
      subtitle: subtitle ? tc(subtitle).replace(/(\d{4})\/(\d{4}) учебного года/, '$1/$2 учебного года') : '',
      fileName: fileName || '',
      importedAt: new Date().toISOString(),
      courses: courses.map(({ col, roomCol, ...c }) => c),
    };
  }

  // ---------------------------------------------------------------------------
  // Публичный API
  // ---------------------------------------------------------------------------

  async function parseFile(data, fileName, deps) {
    deps = deps || {};
    const CFB = deps.CFB || root.CFB;
    const JSZip = deps.JSZip || root.JSZip;
    const DOMParserCtor = deps.DOMParser || root.DOMParser;
    const u8 = toU8(data);
    let docData;
    if (isDocx(u8)) docData = await readDocx(u8, JSZip, DOMParserCtor);
    else if (isDoc(u8)) docData = readDoc(u8, CFB);
    else throw new Error('Поддерживаются только файлы Word: .doc и .docx');
    return buildSchedule(docData, fileName);
  }

  const api = { parseFile, parseCell, readDoc, readDocxXml, buildSchedule };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScheduleParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
