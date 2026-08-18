'use strict';
// Baut die Adblock-Engine in einem Worker-Thread.
// Das Herunterladen + Parsen der Filterlisten (mehrere MB Text) ist CPU-schwer und hat im
// Haupt-Thread das ganze Fenster eingefroren („Keine Rückmeldung"). Hier läuft es isoliert;
// zurück geht nur die fertig serialisierte Engine, die der Hauptprozess in Millisekunden lädt.
const { parentPort, workerData } = require('node:worker_threads');

(async () => {
  try {
    const { FiltersEngine } = require('@ghostery/adblocker');
    const engine = await FiltersEngine.fromLists(fetch, workerData.urls || [], workerData.config || {});
    const data = engine.serialize();   // Uint8Array
    parentPort.postMessage({ ok: true, data }, [data.buffer]);
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
})();
