// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader, MIT, derived
// from d3-dsv 3.0.2 and papaparse 5.7.1): same answers on every input, same
// {columns, rows, errors} shape, same error codes, lines and rows, in the same
// order. Written from the reference's written policy (RULES.txt) and checked
// against the reference itself; no upstream parser is used.
//
// Speed comes from scanning with native indexOf instead of reading one
// character at a time: an unquoted field is one slice up to the next comma or
// line break (a stray CR is the only slow path), and a quoted field is one
// slice up to the next quote (doubled quotes and embedded line breaks are the
// only slow paths). No string is ever built a character at a time, and no
// object is allocated per field: one field's value, end and kept-character
// count live in scratch variables the readers share.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a U+FEFF at the very start is dropped
  let line = 1; // the line the next character to read is on

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters were
  // kept onto it after it started (a quoted field's junk count, for quote_junk).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // The field value being built: one string, or chunks to join when it comes in pieces.
  let acc = '';
  let accParts = null;

  // Append chunk `s` to the field value being built.
  function accAppend(s) {
    if (accParts) {
      accParts.push(s);
    } else if (acc === '') {
      acc = s;
    } else {
      accParts = [acc, s];
    }
  }

  // The field value being built, as one string.
  function accValue() {
    return accParts ? accParts.join('') : acc;
  }

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR
  // not followed by LF is dropped (stray_cr). Leaves the field in fValue/fEnded/fAdded.
  function readUnquoted(init) {
    acc = init;
    accParts = null;
    let added = 0;
    for (;;) {
      const iC = text.indexOf(',', pos);
      const iN = text.indexOf('\n', pos);
      let end;
      let kind;
      if (iC === -1 && iN === -1) {
        end = n;
        kind = END;
      } else if (iN === -1 || (iC !== -1 && iC < iN)) {
        end = iC;
        kind = COMMA;
      } else {
        end = iN;
        kind = LINE_BREAK;
      }
      const iR = text.indexOf('\r', pos);
      if (iR === -1 || iR >= end) {
        // No CR in this chunk: it is one slice.
        if (end > pos) {
          added += end - pos;
          accAppend(text.slice(pos, end));
        }
        if (kind === COMMA) {
          pos = end + 1;
        } else if (kind === LINE_BREAK) {
          pos = end + 1;
          line += 1;
        } else {
          pos = n;
        }
        fValue = accValue();
        fEnded = kind;
        fAdded = added;
        return;
      }
      // A CR sits before the next comma or line break.
      if (text.charCodeAt(iR + 1) === 10) {
        // CRLF ends the field here; the CR is not part of it.
        if (iR > pos) {
          added += iR - pos;
          accAppend(text.slice(pos, iR));
        }
        pos = iR + 2;
        line += 1;
        fValue = accValue();
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      // A lone CR: dropped, and the field goes on after it.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (iR > pos) {
        added += iR - pos;
        accAppend(text.slice(pos, iR));
      }
      pos = iR + 1;
    }
  }

  // Appends the quoted segment [a, b) to the field value being built, turning
  // each CRLF and lone CR in it into one LF and counting each as a line. The
  // segment holds at least one CR or LF.
  function appendQuotedSegment(a, b) {
    let p = a;
    for (;;) {
      const r = text.indexOf('\r', p);
      const l = text.indexOf('\n', p);
      let m = -1;
      let isCR = false;
      if (r !== -1 && r < b && (l === -1 || l >= b || r < l)) {
        m = r;
        isCR = true;
      } else if (l !== -1 && l < b) {
        m = l;
      }
      if (m === -1) {
        if (b > p) accAppend(text.slice(p, b));
        return;
      }
      if (m > p) accAppend(text.slice(p, m));
      accAppend('\n');
      line += 1;
      p = isCR && text.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Leaves the field in fValue/fEnded/fAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    acc = '';
    accParts = null;
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      const r = text.indexOf('\r', pos);
      const l = text.indexOf('\n', pos);
      if ((r === -1 || r >= q) && (l === -1 || l >= q)) {
        if (q > pos) accAppend(text.slice(pos, q));
      } else {
        appendQuotedSegment(pos, q);
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote, and the field goes on.
        accAppend('"');
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      fValue = accValue();
      fEnded = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = accValue();
      fEnded = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = accValue();
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = accValue();
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    readUnquoted(accValue());
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
