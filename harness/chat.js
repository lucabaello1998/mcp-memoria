#!/usr/bin/env node
// CLI del harness: pregunta -> búsqueda en memoria -> respuesta con citas.
//
//   node harness/chat.js "¿cuál es la prioridad número uno?"
//   node harness/chat.js --modelo ollama:qwen3.5:4b --pasos 3 "..."
//
// Es el mismo bucle que usa un agente grande, reducido a lo mínimo: modelo,
// dos herramientas y un tope de pasos.

import { cargarConfig } from "../src/config.js";
import { abrirBase } from "../src/db.js";
import { crearProveedorEmbeddings } from "../src/embeddings.js";
import { crearProveedor } from "../evals/proveedores.js";
import { responder } from "./agente.js";

const AYUDA = `Uso: node harness/chat.js [opciones] "pregunta"

Opciones:
  --modelo <tipo:modelo>   default: ollama:qwen3.5:4b
  --config <ruta>          configuración de memoria (default: ./memoria.config.json)
  --db <ruta>              base SQLite
  --pasos <n>              máximo de acciones antes de responder (default: 4)
  --limite <n>             fragmentos por búsqueda (default: 4)
  --verbose                muestra cada paso del bucle
`;

function leerArgumentos(argv) {
  const opciones = { modelo: "ollama:qwen3.5:4b", pasos: 4, limite: 4, resto: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--modelo") opciones.modelo = argv[++i];
    else if (arg === "--config") opciones.config = argv[++i];
    else if (arg === "--db") opciones.db = argv[++i];
    else if (arg === "--pasos") opciones.pasos = Number.parseInt(argv[++i], 10);
    else if (arg === "--limite") opciones.limite = Number.parseInt(argv[++i], 10);
    else if (arg === "--verbose" || arg === "-v") opciones.verbose = true;
    else if (arg === "--help" || arg === "-h") opciones.ayuda = true;
    else opciones.resto.push(arg);
  }
  return opciones;
}

async function main() {
  const opciones = leerArgumentos(process.argv.slice(2));
  if (opciones.ayuda) {
    console.log(AYUDA);
    return;
  }

  const pregunta = opciones.resto.join(" ").trim();
  if (!pregunta) {
    console.error(`Falta la pregunta.\n\n${AYUDA}`);
    process.exitCode = 2;
    return;
  }

  const config = cargarConfig({ ruta: opciones.config });
  if (opciones.db) config.base = opciones.db;
  const db = abrirBase(config.base);
  const embeddings = crearProveedorEmbeddings(config);
  const modelo = crearProveedor(opciones.modelo);

  const inicio = Date.now();
  const resultado = await responder(pregunta, {
    db,
    modelo,
    embeddings,
    maxPasos: opciones.pasos,
    limite: opciones.limite,
    log: opciones.verbose ? (mensaje) => console.error(`· ${mensaje}`) : () => {},
  });

  console.log(`\n${resultado.respuesta}\n`);
  if (resultado.citas.length > 0) {
    console.log("Citas:");
    for (const cita of resultado.citas) console.log(`  - ${cita}`);
  }
  const pasos = resultado.pasos.map((p) => p.accion).join(" → ");
  console.log(
    `\n${resultado.pasos.length} paso(s): ${pasos} · ${Date.now() - inicio} ms · ` +
      `${resultado.uso.tokensEntrada + resultado.uso.tokensSalida} tokens`
  );
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
