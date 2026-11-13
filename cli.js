#!/usr/bin/env node
// CLI de mcp-memoria: lo mismo que expone el servidor MCP, pero a mano.
//
// Sirve para dos cosas: verificar que el índice tiene lo que uno cree antes de
// conectar el agente, y usar la memoria desde una terminal sin MCP de por medio.

import { existsSync } from "node:fs";
import { cargarConfig } from "./src/config.js";
import { abrirBase, estadisticas } from "./src/db.js";
import { indexar } from "./src/indice.js";
import { buscar, buscarHibrido, resumenFuentes } from "./src/buscar.js";
import { crearProveedorEmbeddings } from "./src/embeddings.js";

const AYUDA = `mcp-memoria — memoria portable para agentes

Uso:
  mcp-memoria index              Indexa (o actualiza) las fuentes configuradas
  mcp-memoria search "<texto>"   Busca y muestra citas archivo:línea
  mcp-memoria sources            Lista las fuentes indexadas
  mcp-memoria stats              Resumen del índice
  mcp-memoria serve              Arranca el servidor MCP por stdio (default)

Opciones:
  --config <ruta>   Archivo de configuración (default: ./memoria.config.json)
  --db <ruta>       Base SQLite (pisa la configuración)
  --limite <n>      Resultados en search (default: 5)
  --etiqueta <e>    Filtra search por etiqueta
  --modo <m>        auto | bm25 | hibrido (default: auto)
`;

function leerOpciones(argumentos) {
  const opciones = { resto: [] };
  for (let i = 0; i < argumentos.length; i += 1) {
    const arg = argumentos[i];
    if (arg === "--config" || arg === "--db" || arg === "--limite" || arg === "--etiqueta" || arg === "--modo") {
      opciones[arg.slice(2)] = argumentos[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      opciones.ayuda = true;
    } else {
      opciones.resto.push(arg);
    }
  }
  return opciones;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

async function main() {
  const opciones = leerOpciones(process.argv.slice(2));
  if (opciones.ayuda) {
    console.log(AYUDA);
    return;
  }

  const config = cargarConfig({ ruta: opciones.config });
  if (opciones.db) config.base = opciones.db;

  const comando = opciones.resto[0] ?? "serve";

  if (comando === "serve") {
    const { crearServidor } = await import("./server.js");
    crearServidor({ config });
    console.error(`[mcp-memoria] escuchando por stdio · base: ${config.base}`);
    return;
  }

  const db = abrirBase(config.base);
  const proveedor = crearProveedorEmbeddings(config);

  if (comando === "index") {
    if (!existsSync(config.base)) console.log(`Base nueva en ${config.base}`);
    if (proveedor) console.log(`Embeddings: ${proveedor.modelo} en ${proveedor.url}`);
    const resumen = await indexar(db, config, { log: (m) => console.log(m), proveedor });
    console.log("");
    console.log(`Archivos revisados: ${resumen.archivos}`);
    console.log(`  nuevos: ${resumen.nuevos} · actualizados: ${resumen.actualizados} · sin cambios: ${resumen.iguales}`);
    console.log(`  borrados: ${resumen.borrados} · fragmentos generados: ${resumen.fragmentos}`);
    if (proveedor) console.log(`  vectores calculados: ${resumen.vectores}`);
    if (resumen.errores.length) {
      console.log(`  errores: ${resumen.errores.length}`);
      for (const error of resumen.errores.slice(0, 5)) console.log(`    - ${error.ruta}: ${error.error}`);
    }
    const stats = estadisticas(db);
    console.log(`\nÍndice: ${stats.fuentes} archivos · ${stats.fragmentos} fragmentos · ${kb(stats.bytes)} de texto`);
    if (stats.vectores > 0) console.log(`Vectores: ${stats.vectores} con ${stats.modeloEmbeddings}`);
    return;
  }

  if (comando === "search") {
    const consulta = opciones.resto.slice(1).join(" ").trim();
    if (!consulta) {
      console.error('Falta la consulta. Ejemplo: mcp-memoria search "objetivos laborales"');
      process.exitCode = 2;
      return;
    }
    const limite = Number.parseInt(opciones.limite ?? "5", 10);
    const modo = ["auto", "bm25", "hibrido"].includes(opciones.modo) ? opciones.modo : "auto";
    const opcionesBusqueda = {
      limite: Number.isFinite(limite) ? Math.min(Math.max(limite, 1), 20) : 5,
      etiqueta: opciones.etiqueta ?? null,
    };
    const hayVectores = Boolean(proveedor) && estadisticas(db).vectores > 0;
    const usarHibrido = modo === "hibrido" || (modo === "auto" && hayVectores);
    const resultados = usarHibrido
      ? await buscarHibrido(db, consulta, { ...opcionesBusqueda, proveedor })
      : buscar(db, consulta, opcionesBusqueda);

    if (resultados.length === 0) {
      console.log("Sin resultados. Probá con otras palabras o corré `mcp-memoria index`.");
      return;
    }
    console.log(`modo: ${usarHibrido ? "híbrido" : "bm25"}\n`);
    for (const [i, r] of resultados.entries()) {
      const ruta = r.archivo;
      const corta = ruta.length > 78 ? `…${ruta.slice(-77)}` : ruta;
      const extra = r.similitud !== undefined ? ` · sim ${r.similitud}` : "";
      console.log(`${i + 1}. ${corta}:${r.linea}  [${r.etiqueta}] puntaje ${r.puntaje}${extra}`);
      if (r.titulo || r.encabezado) {
        console.log(`   ${[r.titulo, r.encabezado].filter(Boolean).join(" > ")}`);
      }
      console.log(`   ${r.fragmento}`);
      console.log("");
    }
    return;
  }

  if (comando === "sources") {
    const fuentes = resumenFuentes(db);
    if (fuentes.length === 0) {
      console.log("El índice está vacío. Corré `mcp-memoria index`.");
      return;
    }
    for (const f of fuentes) {
      console.log(`[${f.etiqueta}] ${f.archivo} · ${f.kb} KB · ${f.fragmentos} fragmentos`);
    }
    return;
  }

  if (comando === "stats") {
    const stats = estadisticas(db);
    console.log(`Archivos: ${stats.fuentes}`);
    console.log(`Fragmentos: ${stats.fragmentos}`);
    console.log(`Texto indexado: ${kb(stats.bytes)}`);
    console.log(`Último indexado: ${stats.ultimoIndexado ?? "nunca"}`);
    for (const e of stats.porEtiqueta) console.log(`  [${e.etiqueta}] ${e.archivos} archivos`);
    return;
  }

  console.error(`Comando desconocido: ${comando}\n`);
  console.log(AYUDA);
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
