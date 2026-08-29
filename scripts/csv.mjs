/**
 * RFC 4180 CSV reader. The FoodData Central exports quote every field and do contain
 * commas, quotes and newlines inside those quotes, so a `split(',')` would silently
 * mis-parse rows.
 */

/**
 * Parse CSV text into rows of strings. The first row is assumed to be the header and is
 * returned as `header`; the rest arrive through `onRow` as an object keyed by header name,
 * so nothing larger than one row is held on top of the input text.
 *
 * @param {string} text
 * @param {(row: Record<string, string>) => void} onRow
 */
export function parseCsv(text, onRow) {
  let header = null;
  let field = '';
  let row = [];
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };

  const endRow = () => {
    endField();
    // A trailing newline produces one empty final row; ignore it.
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    if (header === null) {
      header = row;
    } else {
      const record = {};
      for (let c = 0; c < header.length; c += 1) record[header[c]] = row[c] ?? '';
      onRow(record);
    }
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      endField();
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else if (ch === '\n') {
      endRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  if (field !== '' || row.length > 0) endRow();
}
