# Monitor del equipo

Panel en vivo del estado de una PC con Windows, más un registro continuo que
**sobrevive a un apagón**.

Nació de un problema concreto: una máquina que se reiniciaba sola bajo carga
sin dejar rastro en el Visor de eventos de Windows — sin pantalla azul, sin
error WHEA, `bugcheck=0`. Cuando la máquina pierde la alimentación de golpe,
Windows no llega a anotar nada, y sin un registro propio no hay forma de
saber qué estaba pasando en ese instante.

Este monitor escribe una muestra cada 2 segundos **forzando la escritura al
disco** (`fsync`) en cada una. Si el equipo se corta, las últimas muestras
quedan grabadas igual. Al arrancar de nuevo detecta que el registro anterior
terminó sin marca de cierre y guarda los momentos previos como evidencia.

![Captura del panel](docs/captura.png)

## Qué muestra

**Diagnóstico eléctrico y térmico**
Voltaje de las líneas de +12 V, +5 V y +3,3 V con el rango ATX marcado sobre
el medidor · temperatura del procesador · temperatura de los VRM de la placa ·
consumo estimado del equipo contra la potencia de la fuente.

**Carga**
Uso del procesador · memoria RAM en uso y disponible · archivo de paginación
por separado · memoria total comprometida · uso, temperatura y consumo de la
placa de video.

**Detalle**
Todas las temperaturas con nombre real (placa, chipset, VRM, módulos de RAM,
cada disco por su modelo) · vueltas de cada ventilador · memoria privada por
programa · recomendaciones de qué conviene cerrar · registro de incidentes.

Todo con escala de color continua: el número viaja de verde a amarillo a rojo
según cuánto se acerca a su límite, en vez de saltar de golpe al cruzarlo.

## Requisitos

- **Windows 10 u 11**
- **Node.js 18 o superior**
- *Opcional:* placa NVIDIA con los drivers instalados, para temperatura y
  **consumo real en vatios** de la GPU vía `nvidia-smi`
- *Opcional:* [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor),
  para temperatura del procesador, vueltas de los ventiladores y **voltajes de
  la fuente**. Se ofrece descargar en la primera ejecución

## Uso

```
iniciar.cmd
```

Abre el panel en <http://localhost:7070>. El servidor escucha **solo en
`127.0.0.1`**: no queda expuesto a la red.

**Cortalo con `Ctrl+C`**, no cerrando la ventana. El `Ctrl+C` deja la marca de
cierre limpio; si cerrás con la X, el próximo arranque lo va a interpretar como
un corte de energía.

### Leer los registros

```
node analizar.js              # todo lo que haya
node analizar.js 2026-08-28   # un día puntual
```

Imprime por sesión el mínimo, promedio y máximo de cada métrica, y para cada
corte una tabla con los momentos previos:

```
Corte en muestras-2026-08-28.jsonl · última muestra 28/8/2026, 01:12:44

  hora       CPU%  RAMlib  comm%  Tcpu  Tvrm  Tgpu   GPUw  totW    +12V
  01:12:36     94    2210   71.2    88    71    74    198   361  11.902
  01:12:38     97    2088   72.0    89    73    75    201   366  11.884
  01:12:40     96    2143   71.8    89    74    75    199   364  11.421
  01:12:42     98    1998   72.4    90    75    76    203   369  11.208   <-- 
  01:12:44     97    2015   72.1    90    76    76    202   368  11.147   <--
```

Los archivos crudos quedan en `logs/`, un JSON por línea.

## Cerrar programas desde el panel

En la tabla de memoria, cada programa conocido tiene una **✕** al pasar el
mouse por su fila. Pide confirmación y después manda un cierre **amable**
(`taskkill` sin `/F`), así la aplicación puede preguntarte si querés guardar.
Solo si eso no alcanza ofrece forzar, en un segundo paso aparte.

**No se confía en el código de salida de `taskkill`.** Sin `/F` devuelve 0 en
cuanto logra *enviar* la señal de cierre, no cuando el proceso muere. Muchas
aplicaciones (Telegram, Discord, Slack) responden a `WM_CLOSE` minimizándose a
la bandeja y siguen corriendo. Por eso se cuentan los procesos antes y después
con `tasklist`, y el resultado dice cuántos cerraron de verdad:

```json
{"ok": false, "antes": 1, "despues": 1, "cerrados": 0}
```

Cómo está protegido, porque esto apaga procesos:

- El servidor escucha **solo en `127.0.0.1`**
- Hay un **token aleatorio por arranque** que viaja únicamente por el stream
  SSE, del mismo origen: una página de otro sitio no puede conocerlo
- Se valida la cabecera `Origin`
- **Lista blanca**: solo programas de usuario. Un proceso del sistema se
  rechaza aunque el token sea válido

```
$ curl -X POST .../api/cerrar -d '{"token":"<válido>","nombre":"svchost"}'
{"error":"Ese programa no se puede cerrar desde el panel"}
```

Para dejar el panel de solo lectura: `"permitirCerrarProgramas": false` en
`config.json`.

## Configuración

Casi todo se detecta solo: procesador, núcleos, hilos, memoria instalada,
modelo y límite de consumo de la placa de video, y el tope de vueltas de los
ventiladores (se aprende del más rápido que haya visto).

Lo único que **ningún sensor puede reportar es la potencia de la fuente** —
está escrita en la etiqueta lateral de la fuente y nada más. Va en
`config.json`, que se crea solo en el primer arranque:

```json
{
  "fuenteW": 750,
  "puerto": 7070,
  "intervaloMs": 2000,
  "umbrales": {
    "cpuTempMax": 92,
    "gpuTempMax": 83,
    "vrmTempMax": 100,
    "ramLibreMinMB": 700,
    "commitMaxPct": 88
  }
}
```

`cpuTempMax` según tu procesador: los Ryzen modernos bostean hasta ~90 °C **por
diseño**, así que ese no es el umbral de falla sino el de operación normal.

## Cómo interpretar un corte

| Si antes del corte se ve… | Entonces |
|---|---|
| **+12 V por debajo de 11,40 V** | Es la fuente: rango ATX violado |
| Temperatura del CPU en su tope | Térmico o disipación |
| VRM por encima de 95 °C | La placa no banca al procesador sostenido |
| Consumo cerca del límite de la fuente | Estás rozando su techo |
| **Todo normal y corta igual** | Es externo: tensión de red. Ahí va un estabilizador o una UPS |

## Detalles de implementación

**Los contadores de rendimiento de WMI no se usan.** Las clases
`Win32_PerfFormattedData_*` y `Win32_PerfRawData_*` faltan o devuelven cero en
muchas instalaciones de Windows. En su lugar: el uso de CPU se calcula con
`os.cpus()` de Node (diferencia de tiempos acumulados del kernel), la memoria
sale de `Win32_OperatingSystem`, el disco de los contadores de E/S de
`Win32_Process`, y la red de `Get-NetAdapterStatistics`.

**Tres procesos de larga vida, no uno por muestra.** `sensores.ps1` corre en
bucle y emite JSON por línea; `nvidia-smi` corre con `-lms`; a
LibreHardwareMonitor se le consulta su endpoint JSON. Nada se relanza en cada
muestra.

**Las alertas piden una racha.** Los sensores de voltaje de los chips Super I/O
son ruidosos y dan picos espurios de una sola lectura. Un incidente se anota
solo si la condición se sostiene varias muestras seguidas, y después se repite
espaciado para no inundar el registro.

**Se filtran los sensores que no son mediciones.** LibreHardwareMonitor expone
cosas como `Warning Temperature` y `Critical Temperature`, que son los límites
configurados en el firmware de un disco, no su temperatura. Si no se filtran
aparecen como lecturas reales.

## Licencia

MIT — ver [LICENSE](LICENSE).

LibreHardwareMonitor es un proyecto aparte, bajo MPL-2.0. Este repositorio no
incluye su binario: lo descarga de su release oficial.
