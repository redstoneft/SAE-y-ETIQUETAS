/**
 * Impresión por RED directo a la Zebra.
 * Las impresoras Zebra de red escuchan ZPL crudo en el puerto 9100 (RAW/JetDirect).
 * El backend abre un socket TCP a la IP de la impresora y le manda el ZPL.
 * No requiere ningún programa local ni driver: es TCP puro.
 */

const net = require("net");

const PRINTER_PORT = 9100; // puerto RAW estándar de Zebra (JetDirect)

/**
 * Manda un bloque de ZPL a la impresora de red.
 * @param {string} zpl   El ZPL a imprimir (una o varias etiquetas).
 * @param {string} ip    IP de la Zebra en la red (ej. "192.168.1.50").
 * @param {number} port  Puerto (default 9100).
 * @param {number} timeoutMs  Tiempo máximo de espera.
 */
function imprimirEnRed(zpl, ip, port = PRINTER_PORT, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let resuelto = false;

    socket.setTimeout(timeoutMs);

    socket.connect(port, ip, () => {
      socket.write(zpl, "utf8", () => {
        // damos un instante para que la impresora reciba antes de cerrar
        socket.end();
      });
    });

    socket.on("close", () => {
      if (!resuelto) {
        resuelto = true;
        resolve({ ok: true, ip, port, bytes: Buffer.byteLength(zpl) });
      }
    });

    socket.on("timeout", () => {
      if (!resuelto) {
        resuelto = true;
        socket.destroy();
        reject(new Error(`Timeout: la impresora ${ip}:${port} no respondió`));
      }
    });

    socket.on("error", (err) => {
      if (!resuelto) {
        resuelto = true;
        reject(new Error(`No se pudo imprimir en ${ip}:${port}: ${err.message}`));
      }
    });
  });
}

/**
 * Imprime varias etiquetas en secuencia a la misma impresora.
 * Las concatena en un solo envío (más rápido y ordenado).
 */
async function imprimirLote(zpls, ip, port = PRINTER_PORT) {
  const bloque = zpls.join("\n");
  return imprimirEnRed(bloque, ip, port);
}

/**
 * Verifica que la impresora esté accesible (abre y cierra el socket).
 */
function probarImpresora(ip, port = PRINTER_PORT, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.connect(port, ip, () => {
      socket.end();
      resolve({ ok: true, ip, port });
    });
    socket.on("timeout", () => { socket.destroy(); resolve({ ok: false, ip, port, error: "timeout" }); });
    socket.on("error", (e) => resolve({ ok: false, ip, port, error: e.message }));
  });
}

module.exports = { imprimirEnRed, imprimirLote, probarImpresora, PRINTER_PORT };
