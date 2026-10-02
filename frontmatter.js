/*
 * Scōp — article frontmatter parser
 * Shared by the browser (article.html) and the Netlify build
 * (scripts/build-articles-index.js), so both read articles the same way.
 *
 * Handles the YAML that Decap CMS writes for flat article fields:
 *   key: plain value            key: "double quoted"      key: 'single ''quoted'''
 *   key: >-  / >  (folded)      key: |- / |  (literal)    plain values wrapped onto
 *   indented continuation lines, numbers, true/false, CRLF line endings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScopFrontmatter = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function unquoteDouble(s) {
    return s.replace(/\\(["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, function (_, e) {
      if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
      return { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
    });
  }

  function scalar(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === '' || v === '~' || v === 'null') return '';
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }

  function split(raw) {
    var text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    var m = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (!m) return { data: {}, body: text };
    return { data: parseYaml(m[1]), body: text.slice(m[0].length) };
  }

  function parseYaml(src) {
    var lines = src.split('\n');
    var data = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      var km = line.match(/^([A-Za-z0-9_-]+)\s*:\s?(.*)$/);
      if (!km) continue;
      var key = km[1];
      var rest = km[2].trim();

      // Block scalar: | |- |+ > >- >+
      var bm = rest.match(/^([|>])([+-]?)\s*$/);
      if (bm) {
        var block = [];
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
          block.push(lines[++i]);
        }
        while (block.length && block[block.length - 1].trim() === '') block.pop();
        var indent = Math.min.apply(null, block.filter(function (l) { return l.trim(); })
          .map(function (l) { return l.match(/^\s*/)[0].length; }).concat([Infinity]));
        if (indent === Infinity) indent = 0;
        block = block.map(function (l) { return l.slice(indent); });
        var val = bm[1] === '|'
          ? block.join('\n')
          : block.join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/\n\n/g, '\n');
        if (bm[2] !== '-') val += '\n';
        data[key] = bm[2] === '-' ? val : val.replace(/\n+$/, bm[2] === '+' ? '\n' : '');
        continue;
      }

      // Quoted scalars (may span lines)
      if (rest[0] === '"' || rest[0] === "'") {
        var q = rest[0], buf = rest.slice(1);
        var closeRe = q === '"' ? /(^|[^\\])(\\\\)*"\s*$/ : /(^|[^'])('')*'\s*$/;
        while (!closeRe.test(buf) && i + 1 < lines.length) buf += ' ' + lines[++i].trim();
        buf = buf.replace(/\s*$/, '').slice(0, -1);
        data[key] = q === '"' ? unquoteDouble(buf) : buf.replace(/''/g, "'");
        continue;
      }

      // Plain scalar with optional indented continuation lines
      var parts = [rest];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      data[key] = scalar(parts.join(' ').replace(/\s+#.*$/, '').trim());
    }
    return data;
  }

  return { split: split, parse: function (raw) { return split(raw).data; } };
});
