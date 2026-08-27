'use strict';
// analizar.js - lee los logs y arma el informe.
//
//   node analizar.js            -> todo lo que haya
//   node analizar.js 2026-08-28 -> solo ese dia
//
// Lo importante son las SESIONES CORTADAS: cuando un log termina sin registro
// de 'cierre', la maquina se apago de golpe. Ahi se imprimen las ultimas
// muestras antes del corte, que es la evidencia de que paso.

const fs = require('fs');
const path = require('path');

const LOGS = path.join(__dirname, 'logs');
const filtro = process.argv[2] || null;

function leer(archivo) {
  return fs.readFileSync(path.join(LOGS, archivo), 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
}

function hora(ts) {
  return new Date(ts).toLocaleString('es-AR', { hour12: false });
}

function stats(muestras, campo) {
  const v = muestras.map(m => m[campo]).filter(x => x != null && !isNaN(x));
  if (!v.length) return null;
  const suma = v.reduce((a, b) => a + b, 0);
  return {
    min: Math.min.apply(null, v),
    max: Math.max.apply(null, v),
    prom: suma / v.length,
    n: v.length,
  };
}

function fila(etiqueta, s, unidad, decimales) {
  if (!s) return '    ' + etiqueta.padEnd(22) + 'sin datos';
  const d = decimales == null ? 0 : decimales;
  return '    ' + etiqueta.padEnd(22) +
    ('min ' + s.min.toFixed(d)).padEnd(13) +
    ('prom ' + s.prom.toFixed(d)).padEnd(14) +
    ('max ' + s.max.toFixed(d)) + ' ' + unidad;
}

// ---------------------------------------------------------------- main
let archivos;
try {
  archivos = fs.readdirSync(LOGS)
    .filter(f => f.startsWith('muestras-') && f.endsWith('.jsonl'))
    .filter(f => !filtro || f.includes(filtro))
    .sort();
} catch (e) {
  console.error('No hay carpeta logs/. Corre el monitor primero.');
  process.exit(1);
}

if (!archivos.length) {
  console.error('No hay logs' + (filtro ? ' para ' + filtro : '') + '.');
  process.exit(1);
}

console.log('\n' + '='.repeat(72));
console.log('  INFORME DEL MONITOR   ' + archivos.length + ' archivo(s)');
console.log('='.repeat(72));

const cortes = [];
let totalMuestras = 0;

for (const archivo of archivos) {
  const reg = leer(archivo);
  const muestras = reg.filter(r => r.tipo === 'muestra');
  totalMuestras += muestras.length;
  if (!muestras.length) continue;

  // partir en sesiones
  const sesiones = [];
  let actual = null;
  for (const r of reg) {
    if (r.tipo === 'arranque') { actual = { inicio: r.ts, muestras: [], cerrada: false }; sesiones.push(actual); }
    else if (r.tipo === 'cierre' && actual) { actual.cerrada = true; actual.fin = r.ts; }
    else if (r.tipo === 'muestra' && actual) { actual.muestras.push(r); }
  }

  console.log('\n  ' + archivo + '   ' + muestras.length + ' muestras · ' + sesiones.length + ' sesion(es)');
  console.log('  ' + '-'.repeat(68));

  for (const s of sesiones) {
    if (!s.muestras.length) continue;
    const ult = s.muestras[s.muestras.length - 1];
    const estado = s.cerrada ? 'cerrada bien' : '*** CORTADA DE GOLPE ***';
    console.log('\n    ' + hora(s.inicio) + '  ->  ' + hora(ult.ts) + '   [' + estado + ']');

    if (!s.cerrada) cortes.push({ archivo: archivo, sesion: s });

    console.log(fila('CPU', stats(s.muestras, 'cpuPct'), '%'));
    console.log(fila('RAM libre', stats(s.muestras, 'ramLibreMB'), 'MB'));
    console.log(fila('Commit charge', stats(s.muestras, 'commitPct'), '%', 1));
    const t = stats(s.muestras, 'cpuTemp');
    if (t) console.log(fila('Temp CPU', t, 'C'));
    console.log(fila('Temp GPU', stats(s.muestras, 'gpuTemp'), 'C'));
    console.log(fila('Consumo GPU', stats(s.muestras, 'gpuPotW'), 'W'));
    console.log(fila('Consumo total est.', stats(s.muestras, 'potTotalW'), 'W'));
    const v = stats(s.muestras, 'v12');
    if (v) {
      console.log(fila('Riel +12V', v, 'V', 2));
      if (v.min < 11.4) console.log('      >>> El +12V bajo de 11.40 V: FUERA DEL RANGO ATX <<<');
    }
  }
}

// ---------------------------------------------------------------- cortes
if (cortes.length) {
  console.log('\n' + '='.repeat(72));
  console.log('  CORTES DETECTADOS: ' + cortes.length);
  console.log('='.repeat(72));

  for (const c of cortes) {
    const ms = c.sesion.muestras.slice(-12);
    console.log('\n  Corte en ' + c.archivo + ' · ultima muestra ' + hora(ms[ms.length - 1].ts));
    console.log('  Los 12 momentos previos:\n');
    console.log('    hora       CPU%  RAMlib  comm%  Tcpu  Tgpu   GPUw  totW   +12V');
    console.log('    ' + '-'.repeat(64));
    for (const m of ms) {
      const h = new Date(m.ts).toLocaleTimeString('es-AR', { hour12: false });
      const col = (v, d) => (v == null ? '—' : Number(v).toFixed(d == null ? 0 : d));
      console.log('    ' + h + '  ' +
        col(m.cpuPct).padStart(4) + '  ' +
        col(m.ramLibreMB).padStart(6) + '  ' +
        col(m.commitPct, 1).padStart(5) + '  ' +
        col(m.cpuTemp).padStart(4) + '  ' +
        col(m.gpuTemp).padStart(4) + '  ' +
        col(m.gpuPotW).padStart(5) + '  ' +
        col(m.potTotalW).padStart(4) + '  ' +
        col(m.v12, 2).padStart(5));
    }
  }
} else {
  console.log('\n  Sin cortes: todas las sesiones cerraron limpio.');
}

// ---------------------------------------------------------------- eventos
const rutaEv = path.join(LOGS, 'eventos.jsonl');
if (fs.existsSync(rutaEv)) {
  const evs = leer('../logs/eventos.jsonl'.replace('../logs/', ''));
  const porTipo = {};
  for (const e of evs) {
    for (const a of (e.alertas || [])) {
      porTipo[a.msg] = porTipo[a.msg] || { n: 0, peor: a.valor, ultimo: e.ts };
      porTipo[a.msg].n++;
      porTipo[a.msg].ultimo = e.ts;
    }
  }
  const claves = Object.keys(porTipo);
  if (claves.length) {
    console.log('\n' + '='.repeat(72));
    console.log('  INCIDENTES POR TIPO');
    console.log('='.repeat(72) + '\n');
    claves.sort((a, b) => porTipo[b].n - porTipo[a].n).forEach(k => {
      console.log('    ' + String(porTipo[k].n).padStart(5) + 'x  ' + k.padEnd(36) + ' ultimo: ' + hora(porTipo[k].ultimo));
    });
  }
}

console.log('\n  Total: ' + totalMuestras + ' muestras\n');
