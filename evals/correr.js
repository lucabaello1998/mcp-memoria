#!/usr/bin/env node
// Corre la suite de evals contra uno o más modelos y compara.
//
// Dos mediciones distintas, porque son dos problemas distintos:
//
//   1. Recuperación: ¿el fragmento con el dato aparece en el top 5? No usa
//      ningún modelo, así que se puede correr siempre y gratis. Compara BM25
//      contra híbrido.
//   2. Respuesta: dado el contexto, ¿el modelo contesta bien? Se corre con y sin
//      contexto para ver si la memoria aporta algo o si el modelo ya lo sabía.
//
// Uso:
//   node evals/correr.js
//   node evals/correr.js --modelos ollama:qwen3.5:4b,openai:gpt-4o-mini
//   node evals/correr.js --contexto ambos --detalle

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarConfig } from "../src/config.js";
import { abrirBase, estadisticas } from "../src/db.js";
import { buscar, buscarHibrido } from "../src/buscar.js";
import { crearProveedorEmbeddings } from "../src/embeddings.js";
import { crearProveedor, costoEstimado } from "./proveedores.js";
import {
  acertoFuente,
  dijoNoSabe,
  formatearTabla,
  mrr,
  posicionFuente,
  promedio,
  puntuarRespuesta,
} from "./evaluar.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..");

const SISTEMA_CON_CONTEXTO = `Respondés preguntas sobre una persona usando SOLO el contexto entregado.
Reglas: no inventes datos; si el contexto no alcanza respondé exactamente "no tengo información suficiente";
máximo dos frases; citá el archivo entre paréntesis.`;

const SISTEMA_SIN_CONTEXTO = `Respondés preguntas sobre una persona sin contexto adicional: usá solo lo que sabés.
Si no sabés, respondé exactamente "no tengo información suficiente". Máximo dos frases.`;

function leerArgumentos(argv) {
  const opciones = {
    suite: join(AQUI, "suite.json"),
    modelos: ["ollama:qwen3.5:4b"],
    contexto: "ambos",
    limite: 5,
    detalle: false,
    salida: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--suite") opciones.suite = argv[++i];
    else if (arg === "--config") opciones.config = argv[++i];
    else if (arg === "--db") opciones.db = argv[++i];
    else if (arg === "--modelos") opciones.modelos = argv[++i].split(",").map((m) => m.trim()).filter(Boolean);
    else if (arg === "--contexto") opciones.contexto = argv[++i];
    else if (arg === "--limite") opciones.limite = Number.parseInt(argv[++i], 10);
    else if (arg === "--salida") opciones.salida = argv[++i];
    else if (arg === "--detalle") opciones.detalle = true;
    else if (arg === "--help" || arg === "-h") opciones.ayuda = true;
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  return opciones;
}

function armarContexto(resultados, maximo = 3) {
  return resultados
    .slice(0, maximo)
    .map((r, i) => `[${i + 1}] ${r.archivo}:${r.linea}\n${r.fragmento}`)
    .join("\n\n");
}

async function main() {
  const opciones = leerArgumentos(process.argv.slice(2));
  if (opciones.ayuda) {
    console.log(readFileSync(new URL("./correr.js", import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
    return;
  }

  const suite = JSON.parse(readFileSync(opciones.suite, "utf8"));
  const config = cargarConfig({ ruta: opciones.config });
  if (opciones.db) config.base = opciones.db;
  const db = abrirBase(config.base);
  const embeddings = crearProveedorEmbeddings(config);
  const stats = estadisticas(db);

  if (stats.fuentes === 0) {
    throw new Error(`El índice está vacío (${config.base}). Corré antes: node cli.js index`);
  }

  console.log(`Suite: ${suite.preguntas.length} preguntas · índice: ${stats.fuentes} archivos, ${stats.fragmentos} fragmentos`);
  console.log(`Vectores: ${stats.vectores}${stats.modeloEmbeddings ? ` (${stats.modeloEmbeddings})` : ""}\n`);

  // ---------------------------------------------------------------------
  // 1) Recuperación
  // ---------------------------------------------------------------------
  const modos = [{ nombre: "bm25", ejecutar: (pregunta) => buscar(db, pregunta, { limite: opciones.limite }) }];
  if (embeddings && stats.vectores > 0) {
    modos.push({
      nombre: "hibrido",
      ejecutar: (pregunta) => buscarHibrido(db, pregunta, { limite: opciones.limite, proveedor: embeddings }),
    });
  }

  const recuperacion = [];
  for (const modo of modos) {
    const posiciones = [];
    const filas = [];
    for (const item of suite.preguntas) {
      const resultados = await modo.ejecutar(item.pregunta);
      const posicion = posicionFuente(resultados, item.fuentes);
      posiciones.push(posicion);
      filas.push({ id: item.id, posicion, top: resultados.slice(0, 3).map((r) => r.archivo) });
    }
    recuperacion.push({
      modo: modo.nombre,
      aciertos1: filas.filter((f) => f.posicion === 1).length,
      aciertos5: filas.filter((f) => f.posicion !== null && f.posicion <= opciones.limite).length,
      total: suite.preguntas.length,
      mrr: mrr(posiciones),
      detalle: filas,
    });
  }

  console.log("## Recuperación (¿aparece el archivo con el dato?)\n");
  console.log(
    formatearTabla(
      ["modo", `aciertos@1`, `aciertos@${opciones.limite}`, "MRR", "total"],
      recuperacion.map((r) => [r.modo, r.aciertos1, r.aciertos5, r.mrr, r.total])
    )
  );
  if (opciones.detalle) {
    for (const fila of recuperacion) {
      console.log(`\n${fila.modo}:`);
      for (const item of fila.detalle) {
        console.log(`  ${item.posicion ? `#${item.posicion}` : "—"}  ${item.id}`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // 2) Respuestas
  // ---------------------------------------------------------------------
  const conContexto = opciones.contexto === "ambos" || opciones.contexto === "si";
  const sinContexto = opciones.contexto === "ambos" || opciones.contexto === "no";
  const respuestas = [];

  for (const especificacion of opciones.modelos) {
    let proveedor;
    try {
      proveedor = crearProveedor(especificacion);
    } catch (error) {
      console.error(`Salto ${especificacion}: ${error.message}`);
      continue;
    }

    for (const usarContexto of [true, false]) {
      if (usarContexto && !conContexto) continue;
      if (!usarContexto && !sinContexto) continue;

      const filas = [];
      for (const item of suite.preguntas) {
        const resultados = embeddings && stats.vectores > 0
          ? await buscarHibrido(db, item.pregunta, { limite: opciones.limite, proveedor: embeddings })
          : buscar(db, item.pregunta, { limite: opciones.limite });

        const mensajes = usarContexto
          ? [
              { role: "system", content: SISTEMA_CON_CONTEXTO },
              { role: "user", content: `CONTEXTO:\n${armarContexto(resultados)}\n\nPREGUNTA: ${item.pregunta}` },
            ]
          : [
              { role: "system", content: SISTEMA_SIN_CONTEXTO },
              { role: "user", content: item.pregunta },
            ];

        let salida;
        try {
          salida = await proveedor.charlar(mensajes);
        } catch (error) {
          salida = { texto: `ERROR: ${error.message}`, tokensEntrada: 0, tokensSalida: 0, ms: 0 };
        }

        const puntaje = puntuarRespuesta(salida.texto, item.esperado);
        const cita = usarContexto ? acertoFuente(resultados, item.fuentes) : null;
        filas.push({
          id: item.id,
          ok: puntaje.ok,
          faltan: puntaje.faltan,
          dijoNoSabe: dijoNoSabe(salida.texto),
          cita,
          texto: salida.texto.trim().slice(0, 300),
          tokensEntrada: salida.tokensEntrada,
          tokensSalida: salida.tokensSalida,
          ms: salida.ms,
        });
      }

      const tokensEntrada = filas.reduce((t, f) => t + f.tokensEntrada, 0);
      const tokensSalida = filas.reduce((t, f) => t + f.tokensSalida, 0);
      respuestas.push({
        modelo: proveedor.modelo,
        tipo: proveedor.tipo,
        estimado: Boolean(proveedor.estimado),
        contexto: usarContexto,
        aciertos: filas.filter((f) => f.ok).length,
        total: filas.length,
        porcentaje: Number(((filas.filter((f) => f.ok).length / filas.length) * 100).toFixed(0)),
        noSabe: filas.filter((f) => f.dijoNoSabe).length,
        citasBien: usarContexto ? filas.filter((f) => f.cita).length : null,
        latenciaMs: promedio(filas.map((f) => f.ms)),
        tokensEntrada,
        tokensSalida,
        costo: costoEstimado(proveedor.modelo, tokensEntrada, tokensSalida),
        detalle: filas,
      });
    }
  }

  console.log("\n## Respuestas (¿contesta bien?)\n");
  console.log(
    formatearTabla(
      ["modelo", "contexto", "aciertos", "%", "no sabe", "cita", "latencia", "tokens", "costo"],
      respuestas.map((r) => [
        r.modelo,
        r.contexto ? "sí" : "no",
        `${r.aciertos}/${r.total}`,
        `${r.porcentaje}%`,
        r.noSabe,
        r.citasBien === null ? "—" : `${r.citasBien}/${r.total}`,
        `${r.latenciaMs} ms`,
        `${r.estimado ? "~" : ""}${r.tokensEntrada + r.tokensSalida}`,
        r.costo === null ? "s/d" : `US$ ${r.costo.toFixed(4)}`,
      ])
    )
  );

  if (respuestas.some((r) => r.estimado)) {
    console.log("\n~ tokens estimados por caracteres (OpenCode no los informa).");
  }

  if (opciones.detalle) {
    for (const fila of respuestas) {
      console.log(`\n${fila.modelo} (contexto: ${fila.contexto ? "sí" : "no"}):`);
      for (const item of fila.detalle) {
        const marca = item.ok ? "✔" : "✘";
        console.log(`  ${marca} ${item.id}${item.faltan.length ? ` · falta: ${item.faltan.join(", ")}` : ""}`);
        if (!item.ok) console.log(`      "${item.texto.replace(/\s+/g, " ").slice(0, 140)}"`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Guardar
  // ---------------------------------------------------------------------
  const salida = opciones.salida ?? join(AQUI, "resultados", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(salida), { recursive: true });
  writeFileSync(
    salida,
    JSON.stringify(
      {
        fecha: new Date().toISOString(),
        suite: opciones.suite,
        indice: { archivos: stats.fuentes, fragmentos: stats.fragmentos, vectores: stats.vectores, modeloEmbeddings: stats.modeloEmbeddings },
        recuperacion,
        respuestas,
      },
      null,
      2
    )
  );
  console.log(`\nResultados: ${salida}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
