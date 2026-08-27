'use strict';
// Monitor de sistema - recolector + dashboard local.
//
// Tres fuentes de datos, todas de larga vida (no se respawnean por muestra):
//   1. sensores.ps1          -> CPU%, RAM, commit charge, disco, red, top procesos
//   2. nvidia-smi            -> temperatura GPU, watts reales, uso, VRAM, clocks
//   3. LibreHardwareMonitor  -> temp de CPU, RPM de ventiladores, VOLTAJES (+12V)
//
// El (3) es opcional: si LHM no esta corriendo el monitor igual funciona,
// solo que sin temperatura de CPU ni voltajes. Ver README.
//
// Todo se escribe a disco con fsync en cada muestra. Eso es a proposito:
// si la maquina se corta de golpe, las ultimas muestras tienen que estar
// en el disco igual. Sin fsync se pierden en el buffer del sistema operativo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const RAIZ = __dirname;
const LOGS = path.join(RAIZ, 'logs');
const MAX_HISTORIAL = 900; // ~30 min a 2s

// --------------------------------------------------------------- config
// Casi todo se autodetecta (CPU, RAM, modelo y limite de la GPU, rpm de los
// ventiladores). Lo unico que ningun sensor reporta es la potencia de la
// fuente: eso solo esta escrito en la etiqueta del equipo, va en config.json.
const CONFIG_POR_DEFECTO = {
  fuenteW: 750,
  puerto: 7070,
  intervaloMs: 2000,
  lhmUrl: 'http://localhost:8085/data.json',
  // Permite cerrar programas desde el panel. Ponelo en false para que el
  // panel quede de solo lectura.
  permitirCerrarProgramas: true,
  umbrales: {
    cpuTempMax: 92, gpuTempMax: 83, vrmTempMax: 100,
    ramLibreMinMB: 700, commitMaxPct: 88,
  },
};

// Programas que el panel puede cerrar. Es una lista blanca a proposito: nada
// del sistema entra aca, aunque aparezca arriba de todo en la tabla. Cerrar
// svchost, MsMpEng o el propio explorador rompe Windows.
const CERRABLES = new Set([
  'claude', 'comet', 'chrome', 'firefox', 'msedge', 'brave', 'opera', 'vivaldi',
  'Code', 'Discord', 'slack', 'Telegram', 'WhatsApp', 'msedgewebview2',
  'Spotify', 'steam', 'EpicGamesLauncher', 'Notion', 'obsidian', 'Teams',
  'thunderbird', 'zoom', 'Signal', 'GitHubDesktop', 'postman', 'insomnia',
]);

function cargarConfig() {
  const ruta = path.join(RAIZ, 'config.json');
  let cfg = JSON.parse(JSON.stringify(CONFIG_POR_DEFECTO));
  try {
    const propio = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    cfg = Object.assign(cfg, propio);
    cfg.umbrales = Object.assign(CONFIG_POR_DEFECTO.umbrales, propio.umbrales || {});
  } catch (e) {
    if (e.code === 'ENOENT') {
      fs.writeFileSync(ruta, JSON.stringify(CONFIG_POR_DEFECTO, null, 2));
      console.log('  Se creo config.json con valores por defecto.');
      console.log('  Ajusta "fuenteW" con los vatios de TU fuente (etiqueta lateral).\n');
    } else {
      console.error('  config.json tiene un error, se usan los valores por defecto:', e.message);
    }
  }
  return cfg;
}

const CFG = cargarConfig();
const PUERTO = Number(process.env.PUERTO || CFG.puerto);
const INTERVALO = Number(process.env.INTERVALO || CFG.intervaloMs);
const LHM_URL = process.env.LHM_URL || CFG.lhmUrl;

fs.mkdirSync(LOGS, { recursive: true });

// ---------------------------------------------------------------- umbrales
// Lo que dispara un incidente. El de voltaje es el importante para cazar
// el reinicio: ATX permite +-5%, o sea que 12V no deberia bajar de 11.4V.
// 'seguidas' = cuantas muestras consecutivas tiene que estar mal antes de
// avisar. Los sensores de voltaje del chip Super I/O son ruidosos y dan
// picos espurios de una muestra: alertar sobre uno solo es un falso positivo.
const U = CFG.umbrales;
const UMBRALES = {
  ramLibreMB: { limite: U.ramLibreMinMB, cmp: 'menor', seguidas: 3, msg: 'RAM disponible critica' },
  commitPct: { limite: U.commitMaxPct, cmp: 'mayor', seguidas: 3, msg: 'Commit charge alto' },
  cpuPct: { limite: 97, cmp: 'mayor', seguidas: 5, msg: 'CPU saturado' },
  // Los Ryzen modernos bostean hasta ~90C por diseno: ese no es el umbral de
  // falla sino el de operacion normal. Configurable segun el procesador.
  cpuTemp: { limite: U.cpuTempMax, cmp: 'mayor', seguidas: 3, msg: 'CPU muy caliente' },
  gpuTemp: { limite: U.gpuTempMax, cmp: 'mayor', seguidas: 3, msg: 'GPU muy caliente' },
  vrmTemp: { limite: U.vrmTempMax, cmp: 'mayor', seguidas: 3, msg: 'VRM de la placa muy caliente' },
  gpuPotPct: { limite: 98, cmp: 'mayor', seguidas: 5, msg: 'GPU al tope de consumo' },
  // Rango ATX con margen: solo avisa si se sostiene, no por un pico de lectura
  v12: { limite: 11.4, cmp: 'menor', seguidas: 3, msg: 'RIEL +12V FUERA DE RANGO ATX' },
  v12alto: { limite: 12.6, cmp: 'mayor', seguidas: 3, campo: 'v12', msg: 'RIEL +12V POR ENCIMA DE RANGO' },
  // El +5V de esta placa lee 4.74-4.89 en reposo, o sea rozando el piso ATX
  // de 4.75. Los sensores Super I/O tienen +-2-5% de error, asi que un valor
  // asi puede ser un 4.95 real. Se pide una caida sostenida (16 s) antes de
  // avisar: lo que interesa no es el valor absoluto sino que se hunda bajo carga.
  v5: { limite: 4.72, cmp: 'menor', seguidas: 8, msg: 'Riel +5V hundido de forma sostenida' },
  v33: { limite: 3.12, cmp: 'menor', seguidas: 8, msg: 'Riel +3.3V hundido de forma sostenida' },
};
const rachas = {}; // cuenta muestras malas consecutivas por umbral

// ---------------------------------------------------------------- estado
let info = null;            // datos fijos del equipo
let gpu = null;             // ultima lectura de nvidia-smi
let gpuNombre = null;       // modelo de la placa, detectado al arrancar
let lhm = null;             // ultima lectura de LibreHardwareMonitor
let lhmVivo = false;
// Tope de rpm para dibujar los medidores de ventilador. Se aprende solo:
// arranca en un minimo razonable y sube si algun ventilador gira mas rapido.
let rpmMaximo = 1600;
const historial = [];       // ring buffer para el dashboard
const eventos = [];         // incidentes de esta sesion
const clientes = new Set(); // conexiones SSE
let nMuestras = 0;

// ---------------------------------------------------------------- log
function rutaLog() {
  const d = new Date();
  const dia = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  return path.join(LOGS, 'muestras-' + dia + '.jsonl');
}

let fdActual = null;
let rutaActual = null;

function escribir(obj) {
  const r = rutaLog();
  if (r !== rutaActual) {
    if (fdActual !== null) { try { fs.closeSync(fdActual); } catch (e) {} }
    fdActual = fs.openSync(r, 'a');
    rutaActual = r;
  }
  fs.writeSync(fdActual, JSON.stringify(obj) + '\n');
  fs.fsyncSync(fdActual); // clave: sobrevive a un corte de energia
}

function escribirEvento(ev) {
  const fd = fs.openSync(path.join(LOGS, 'eventos.jsonl'), 'a');
  fs.writeSync(fd, JSON.stringify(ev) + '\n');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

// ------------------------------------------------ deteccion de corte previo
// Si el ultimo log NO termina con un registro 'cierre', la sesion anterior
// se corto de golpe. Eso es exactamente lo que estamos cazando.
function revisarSesionAnterior() {
  let archivos;
  try {
    archivos = fs.readdirSync(LOGS)
      .filter(f => f.startsWith('muestras-') && f.endsWith('.jsonl'))
      .sort();
  } catch (e) { return null; }
  if (!archivos.length) return null;

  const ultimo = path.join(LOGS, archivos[archivos.length - 1]);
  const lineas = fs.readFileSync(ultimo, 'utf8').trim().split('\n').filter(Boolean);
  if (!lineas.length) return null;

  let fin = null;
  try { fin = JSON.parse(lineas[lineas.length - 1]); } catch (e) { return null; }
  if (fin.tipo === 'cierre') return null; // se cerro bien, no hubo corte

  // Se corto: juntamos las ultimas 20 muestras como evidencia
  const previas = [];
  for (let i = lineas.length - 1; i >= 0 && previas.length < 20; i--) {
    try {
      const m = JSON.parse(lineas[i]);
      if (m.tipo === 'muestra') previas.unshift(m);
    } catch (e) {}
  }
  return {
    archivo: path.basename(ultimo),
    ultimaMuestra: fin.ts || null,
    previas: previas,
  };
}

// ---------------------------------------------------------------- nvidia-smi
// El modelo de la placa se consulta una sola vez al arrancar: no cambia,
// y asi el dashboard puede decir "Uso de la <tu placa>" sin cablearlo.
function detectarGPU() {
  const p = spawn('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true });
  let salida = '';
  p.stdout.on('data', b => { salida += b.toString(); });
  p.on('error', () => {});
  p.on('close', () => {
    const n = salida.trim().split('\n')[0];
    if (n) gpuNombre = n.trim();
  });
}

function arrancarGPU() {
  const campos = 'temperature.gpu,power.draw,power.limit,utilization.gpu,' +
    'memory.used,memory.total,clocks.sm,fan.speed';
  const p = spawn('nvidia-smi', [
    '--query-gpu=' + campos,
    '--format=csv,noheader,nounits',
    '-lms', String(INTERVALO),
  ], { windowsHide: true });

  let resto = '';
  p.stdout.on('data', buf => {
    resto += buf.toString();
    const lineas = resto.split('\n');
    resto = lineas.pop();
    for (const l of lineas) {
      const c = l.split(',').map(s => s.trim());
      if (c.length < 7) continue;
      const num = v => (v === '[N/A]' || v === 'N/A' || v === '' ? null : Number(v));
      gpu = {
        temp: num(c[0]),
        potW: num(c[1]),
        potMaxW: num(c[2]),
        usoPct: num(c[3]),
        vramMB: num(c[4]),
        vramTotMB: num(c[5]),
        clockMHz: num(c[6]),
        fanPct: num(c[7]),
      };
      if (gpu.potW != null && gpu.potMaxW) {
        gpu.potPct = Math.round((gpu.potW / gpu.potMaxW) * 100);
      }
    }
  });
  p.on('error', e => console.error('[gpu] no arranco nvidia-smi:', e.message));
  p.on('exit', c => {
    console.error('[gpu] nvidia-smi termino (' + c + '), reintento en 5s');
    gpu = null;
    setTimeout(arrancarGPU, 5000);
  });
}

// -------------------------------------------------- LibreHardwareMonitor
// LHM expone un arbol anidado en /data.json. Lo aplanamos y nos quedamos
// con temperaturas, ventiladores, voltajes, potencia y clocks.
function aplanarLHM(nodo, ruta, salida) {
  ruta = ruta || [];
  salida = salida || [];
  const nombre = nodo.Text || '';
  const nuevaRuta = nombre ? ruta.concat(nombre) : ruta;

  if (nodo.Value && nodo.Value !== '' && nodo.Type) {
    const n = parseFloat(String(nodo.Value).replace(',', '.'));
    if (!isNaN(n)) {
      // La ruta real de LHM es: ["Sensor", <nombre del equipo>, <hardware>,
      // <categoria>, <sensor>]. El hardware util esta en el indice 2.
      salida.push({
        tipo: nodo.Type,
        nombre: nombre,
        hardware: nuevaRuta[2] || nuevaRuta[1] || nuevaRuta[0] || '',
        ruta: nuevaRuta.join(' / '),
        valor: n,
        max: nodo.Max ? parseFloat(String(nodo.Max).replace(',', '.')) : null,
      });
    }
  }
  if (Array.isArray(nodo.Children)) {
    for (const h of nodo.Children) aplanarLHM(h, nuevaRuta, salida);
  }
  return salida;
}

function leerLHM() {
  const req = http.get(LHM_URL, { timeout: 1500 }, res => {
    let cuerpo = '';
    res.on('data', c => { cuerpo += c; });
    res.on('end', () => {
      try {
        const arbol = JSON.parse(cuerpo);
        const s = aplanarLHM(arbol);
        lhm = interpretarLHM(s);
        lhmVivo = true;
      } catch (e) { lhmVivo = false; }
    });
  });
  req.on('error', () => { lhmVivo = false; });
  req.on('timeout', () => { req.destroy(); lhmVivo = false; });
}

// Sensores que LHM expone pero NO son mediciones: son limites configurados
// del firmware del disco o metadatos del sensor. Si no se filtran aparecen
// como si fueran temperaturas reales (de ahi salian los "74C" y "79C" que
// en realidad son el Warning/Critical del NVMe, no su temperatura).
const NO_ES_MEDICION = /Warning Temperature|Critical Temperature|Thermal Sensor|Sensor Resolution|Low Limit|High Limit|Critical Limit/i;

// Nombres lindos para lo que reporta la placa
const NOMBRES = [
  [/^Core \(Tctl\/Tdie\)$/i, 'CPU (Tctl/Tdie)'],
  [/^CCD1? \(Tdie\)$/i, 'CPU núcleo (CCD1)'],
  [/^CPU$/i, 'CPU (socket)'],
  [/^VRM MOS$/i, 'VRM de la placa'],
  [/^VSoC MOS$/i, 'VRM del SoC'],
  [/^Chipset$/i, 'Chipset'],
  [/^System$/i, 'Interior del gabinete'],
  [/^DIMM #?(\d+)$/i, 'Memoria RAM #$1'],
  [/^GPU Core$/i, 'GPU (núcleo)'],
  [/^GPU Hot Spot$/i, 'GPU (punto caliente)'],
  [/^Composite Temperature$/i, 'SSD NVMe'],
  [/^Temperature$/i, 'Disco'],
];
function nombreLindo(n) {
  for (const [re, lindo] of NOMBRES) if (re.test(n)) return n.replace(re, lindo);
  return n;
}

function interpretarLHM(sensores) {
  const buscar = (tipo, re) => {
    const m = sensores.filter(s => s.tipo === tipo && re.test(s.nombre));
    return m.length ? m[0].valor : null;
  };
  const r = {
    // Temperatura de CPU: en Ryzen el sensor bueno es Tctl/Tdie
    cpuTemp: buscar('Temperature', /^Core \(Tctl|Tdie|CPU Package/i),
    cpuVcore: buscar('Voltage', /^Vcore$/i),
    cpuPotW: buscar('Power', /CPU Package|^Package$/i),
    cpuClockMHz: buscar('Clock', /^Core #1$/i),
    // Voltajes de la fuente: lo que decide si el reinicio es electrico.
    // Anclados al nombre exacto para no agarrar "+3V Standby" ni "CMOS Battery".
    v12: buscar('Voltage', /^\+12V$/i),
    v5: buscar('Voltage', /^\+5V$/i),
    v33: buscar('Voltage', /^\+3\.3V$/i),
    // Placa
    mbTemp: buscar('Temperature', /^System$/i),
    vrmTemp: buscar('Temperature', /^VRM MOS$/i),
    vsocTemp: buscar('Temperature', /^VSoC MOS$/i),
    chipsetTemp: buscar('Temperature', /^Chipset$/i),
    gpuHotspot: buscar('Temperature', /Hot Spot/i),
    // Ventiladores. Ojo: 0 rpm no siempre es falla — muchas placas de video
    // tienen modo cero-rpm en reposo, y las curvas PWM de la placa madre
    // tambien los frenan cuando la temperatura es baja.
    ventiladores: sensores
      .filter(s => s.tipo === 'Fan' && s.valor >= 0)
      .map(s => ({
        nombre: s.nombre,
        rpm: Math.round(s.valor),
        esGpu: /GPU/i.test(s.nombre),
      })),
    // Todas las temperaturas REALES, ya sin los limites de firmware.
    // Los discos reportan su sensor como "Temperature" a secas, asi que ahi
    // se usa el modelo del disco para poder distinguir uno de otro.
    temps: sensores
      .filter(s => s.tipo === 'Temperature' && !NO_ES_MEDICION.test(s.nombre) && s.valor > 0)
      .map(s => ({
        n: /^Temperature$|^Composite Temperature$/i.test(s.nombre) && s.hardware
             ? s.hardware
             : nombreLindo(s.nombre),
        t: Math.round(s.valor * 10) / 10,
      })),
  };
  r.nSensores = sensores.length;
  return r;
}

// ---------------------------------------------------------------- sensores
function arrancarSensores() {
  const p = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(RAIZ, 'sensores.ps1'),
    '-IntervaloMs', String(INTERVALO),
  ], { windowsHide: true });

  let resto = '';
  p.stdout.on('data', buf => {
    resto += buf.toString();
    const lineas = resto.split('\n');
    resto = lineas.pop();
    for (const l of lineas) {
      const t = l.trim();
      if (!t) continue;
      let d;
      try { d = JSON.parse(t); } catch (e) { continue; }
      if (d.tipo === 'inicio') {
        // se le suma lo que no sabe PowerShell: modelo de GPU y la config
        info = Object.assign(d, { gpuNombre: gpuNombre, cfg: CFG });
        continue;
      }
      if (d.tipo === 'muestra') procesarMuestra(d);
    }
  });
  p.stderr.on('data', b => {
    const s = b.toString().trim();
    if (s) console.error('[ps]', s.slice(0, 200));
  });
  p.on('exit', c => {
    console.error('[ps] sensores.ps1 termino (' + c + '), reintento en 5s');
    setTimeout(arrancarSensores, 5000);
  });
}

// ------------------------------------------------------------------- CPU
// Los contadores de rendimiento de WMI estan rotos en esta maquina, asi que
// el % de CPU se calcula con os.cpus(), que son los tiempos acumulados del
// kernel: la diferencia entre dos lecturas da el uso real del intervalo.
let cpuPrevio = null;
function calcularCpuPct() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  if (!cpuPrevio) { cpuPrevio = { idle: idle, total: total }; return null; }
  const dIdle = idle - cpuPrevio.idle;
  const dTotal = total - cpuPrevio.total;
  cpuPrevio = { idle: idle, total: total };
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal))));
}

// ---------------------------------------------------------------- muestra
function procesarMuestra(m) {
  const c = calcularCpuPct();
  if (c != null) m.cpuPct = c;

  if (gpu) {
    m.gpuTemp = gpu.temp;
    m.gpuPotW = gpu.potW;
    m.gpuPotMaxW = gpu.potMaxW;
    m.gpuPotPct = gpu.potPct;
    m.gpuUsoPct = gpu.usoPct;
    m.gpuVramMB = gpu.vramMB;
    m.gpuVramTotMB = gpu.vramTotMB;
    m.gpuClockMHz = gpu.clockMHz;
    m.gpuFanPct = gpu.fanPct;
  }
  if (lhm && lhmVivo) {
    m.cpuTemp = lhm.cpuTemp;
    m.cpuVcore = lhm.cpuVcore;
    m.cpuPotW = lhm.cpuPotW;
    m.cpuClockMHz = lhm.cpuClockMHz;
    m.v12 = lhm.v12;
    m.v5 = lhm.v5;
    m.v33 = lhm.v33;
    m.mbTemp = lhm.mbTemp;
    m.vrmTemp = lhm.vrmTemp;
    m.vsocTemp = lhm.vsocTemp;
    m.chipsetTemp = lhm.chipsetTemp;
    m.gpuHotspot = lhm.gpuHotspot;
    m.ventiladores = lhm.ventiladores;
    m.temps = lhm.temps;
    // el tope de los medidores se ajusta al ventilador mas rapido visto
    for (const v of lhm.ventiladores) {
      if (v.rpm > rpmMaximo) rpmMaximo = Math.ceil(v.rpm / 200) * 200;
    }
    m.rpmMaximo = rpmMaximo;
  }
  m.lhm = lhmVivo;

  // Consumo total estimado del equipo (para correlacionar con la fuente).
  // Los 70 W fijos son placa, discos, RAM y ventiladores: no hay sensor que
  // los reporte, es una estimacion conservadora de un equipo de escritorio.
  if (m.gpuPotW != null || m.cpuPotW != null) {
    m.potTotalW = Math.round((m.gpuPotW || 0) + (m.cpuPotW || 0) + 70);
  }

  // incidentes, con racha: solo avisa si la condicion se sostiene N muestras
  const disparados = [];
  for (const clave of Object.keys(UMBRALES)) {
    const u = UMBRALES[clave];
    const campo = u.campo || clave;
    const v = m[campo];
    if (v == null) { rachas[clave] = 0; continue; }

    const mal = u.cmp === 'mayor' ? v > u.limite : v < u.limite;
    if (!mal) { rachas[clave] = 0; continue; }

    rachas[clave] = (rachas[clave] || 0) + 1;
    // avisa al llegar a la racha, y despues cada 30 muestras para no inundar
    const n = u.seguidas || 1;
    if (rachas[clave] === n || (rachas[clave] > n && (rachas[clave] - n) % 30 === 0)) {
      disparados.push({ campo: campo, valor: v, limite: u.limite, msg: u.msg, seguidas: rachas[clave] });
    }
  }

  if (disparados.length) {
    const ev = { ts: m.ts, alertas: disparados, muestra: m };
    eventos.push(ev);
    if (eventos.length > 200) eventos.shift();
    escribirEvento(ev);
    m.alerta = disparados.map(d => d.msg);
  }

  historial.push(m);
  if (historial.length > MAX_HISTORIAL) historial.shift();

  escribir(m);
  nMuestras++;

  // el modelo de GPU puede llegar despues del primer 'inicio'
  if (info && gpuNombre && !info.gpuNombre) info.gpuNombre = gpuNombre;

  const payload = 'data: ' + JSON.stringify({ muestra: m, info: info }) + '\n\n';
  for (const c of clientes) { try { c.write(payload); } catch (e) {} }
}

// ------------------------------------------------------- cerrar programas
// Ficha de seguridad, porque esto apaga procesos del usuario:
//  - el servidor escucha SOLO en 127.0.0.1
//  - hay un token aleatorio por arranque, que solo viaja por el stream SSE
//    (mismo origen), asi que una pagina de otro sitio no puede conocerlo
//  - se valida la cabecera Origin
//  - solo se aceptan nombres de la lista blanca CERRABLES
//  - por defecto se pide el cierre amable (sin /F) para que la aplicacion
//    pueda preguntar si guardar; forzar es un segundo paso explicito
const TOKEN = require('crypto').randomBytes(24).toString('hex');

function origenValido(req) {
  const o = req.headers.origin;
  if (!o) return true; // fetch same-origin puede no mandarlo
  try {
    const u = new URL(o);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch (e) { return false; }
}

// Cuenta cuantos procesos vivos hay con ese nombre.
function contarProcesos(nombre, listo) {
  const p = spawn('tasklist', ['/FI', 'IMAGENAME eq ' + nombre + '.exe', '/NH', '/FO', 'CSV'], { windowsHide: true });
  let salida = '';
  p.stdout.on('data', b => { salida += b.toString(); });
  p.on('error', () => listo(0));
  p.on('close', () => {
    // sin coincidencias tasklist imprime un texto suelto, no filas CSV
    const filas = salida.split('\n').filter(l => l.trim().startsWith('"'));
    listo(filas.length);
  });
}

// OJO con el codigo de salida de taskkill: sin /F devuelve 0 en cuanto LOGRA
// ENVIAR la senal de cierre, no cuando el proceso muere. Muchas aplicaciones
// (Telegram, Discord, Slack) responden a WM_CLOSE minimizandose a la bandeja
// y siguen vivas. Por eso hay que contar los procesos despues, y no confiar
// en el codigo de retorno.
function cerrarPrograma(nombre, forzar, listo) {
  contarProcesos(nombre, antes => {
    if (antes === 0) return listo({ ok: true, antes: 0, despues: 0, detalle: 'No estaba corriendo.' });

    const args = ['/IM', nombre + '.exe', '/T'];
    if (forzar) args.push('/F');
    const p = spawn('taskkill', args, { windowsHide: true });
    let salida = '';
    p.stdout.on('data', b => { salida += b.toString(); });
    p.stderr.on('data', b => { salida += b.toString(); });
    p.on('error', e => listo({ ok: false, antes: antes, despues: antes, detalle: e.message }));
    p.on('close', () => {
      // se le da tiempo a cerrar: las aplicaciones grandes tardan un poco
      setTimeout(() => {
        contarProcesos(nombre, despues => {
          listo({
            ok: despues === 0,
            antes: antes,
            despues: despues,
            cerrados: antes - despues,
            detalle: salida.trim(),
          });
        });
      }, forzar ? 900 : 2600);
    });
  });
}

// ---------------------------------------------------------------- servidor
const corteAnterior = revisarSesionAnterior();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PUERTO);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // el token viaja solo por aca: mismo origen, no queda en el HTML estatico
    res.write('data: ' + JSON.stringify({
      info: info,
      historial: historial,
      eventos: eventos.slice(-30),
      corteAnterior: corteAnterior,
      token: CFG.permitirCerrarProgramas ? TOKEN : null,
      cerrables: CFG.permitirCerrarProgramas ? Array.from(CERRABLES) : [],
    }) + '\n\n');
    clientes.add(res);
    req.on('close', () => clientes.delete(res));
    return;
  }

  if (url.pathname === '/api/cerrar' && req.method === 'POST') {
    const responder = (estado, cuerpo) => {
      res.writeHead(estado, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cuerpo));
    };
    if (!CFG.permitirCerrarProgramas) return responder(403, { error: 'Deshabilitado en config.json' });
    if (!origenValido(req)) return responder(403, { error: 'Origen no permitido' });

    let cuerpo = '';
    req.on('data', c => {
      cuerpo += c;
      if (cuerpo.length > 4096) req.destroy();
    });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(cuerpo); } catch (e) { return responder(400, { error: 'JSON invalido' }); }
      if (d.token !== TOKEN) return responder(403, { error: 'Token invalido' });
      if (!CERRABLES.has(d.nombre)) return responder(403, { error: 'Ese programa no se puede cerrar desde el panel' });

      cerrarPrograma(d.nombre, !!d.forzar, r => {
        console.log(`  [cerrar] ${d.nombre}${d.forzar ? ' forzado' : ''}: ` +
          `${r.antes} -> ${r.despues} procesos ${r.ok ? '(cerrado)' : '(sigue vivo)'}`);
        responder(200, r);
      });
    });
    return;
  }

  if (url.pathname === '/api/estado') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      info: info, historial: historial, eventos: eventos,
      corteAnterior: corteAnterior, nMuestras: nMuestras, lhm: lhmVivo,
    }));
    return;
  }

  const archivo = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const base = path.join(RAIZ, 'public');
  const ruta = path.join(base, archivo);
  if (!ruta.startsWith(base)) { res.writeHead(403); res.end(); return; }
  fs.readFile(ruta, (err, data) => {
    if (err) { res.writeHead(404); res.end('no encontrado'); return; }
    const tipos = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': tipos[path.extname(ruta)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- arranque
escribir({
  tipo: 'arranque',
  ts: new Date().toISOString(),
  corteAnterior: corteAnterior ? corteAnterior.ultimaMuestra : null,
});

if (corteAnterior) {
  escribirEvento({ ts: new Date().toISOString(), tipo: 'CORTE_DETECTADO', detalle: corteAnterior });
  console.log('\n  *** La sesion anterior se corto sin cierre limpio ***');
  console.log('      ultima muestra: ' + corteAnterior.ultimaMuestra);
  console.log('      quedaron ' + corteAnterior.previas.length + ' muestras previas como evidencia\n');
}

arrancarSensores();
detectarGPU();
arrancarGPU();
leerLHM();
setInterval(leerLHM, INTERVALO);

server.listen(PUERTO, '127.0.0.1', () => {
  console.log('\n  Monitor corriendo:  http://localhost:' + PUERTO);
  console.log('  Logs en:            ' + LOGS);
  console.log('  Muestreo cada:      ' + INTERVALO + ' ms');
  setTimeout(() => {
    console.log('  LibreHardwareMonitor: ' + (lhmVivo
      ? 'conectado (temp CPU, ventiladores y voltajes activos)'
      : 'NO detectado - sin temp de CPU ni voltajes, ver README'));
    console.log('\n  Ctrl+C para cortar (deja marca de cierre limpio)\n');
  }, 3000);
});

function cerrar() {
  try { escribir({ tipo: 'cierre', ts: new Date().toISOString(), muestras: nMuestras }); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
