'use strict';
// Minimaler JSON-Store mit verzögertem Schreiben
const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults };
    this._timer = null;
    try {
      if (fs.existsSync(file)) {
        // BOM entfernen (sonst scheitert JSON.parse und alles fiele auf Defaults zurück)
        let raw = fs.readFileSync(file, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // BOM strippen
        raw = raw.trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') this.data = { ...defaults, ...parsed };
        }
      }
    } catch (err) {
      console.error('[store] read failed', file, err.message);
      // Defekte Datei sichern statt zu überschreiben, damit nichts verloren geht
      try { fs.copyFileSync(file, file + '.bak'); } catch {}
    }
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  merge(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[store] write failed', this.file, err.message);
    }
  }
}

module.exports = { JsonStore };
