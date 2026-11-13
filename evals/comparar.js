#!/usr/bin/env node
// Compara variantes de búsqueda sobre la suite de evals, sin usar ningún modelo.
//
//   node evals/comparar.js
//
// Sirve para decidir con datos: si el híbrido no le gana al léxico, se deja el
// léxico. Cada fila es una configuración distinta de la misma consulta.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarConfig } from "../src/config.js";
import { abrirBase } from "../src/db.js";
import { buscar, buscarHibrido } from "../src/buscar.js";
import { crearProveedorEmbeddings } from "../src/embeddings.js";
import { mrr, posicionFuente } from "./evaluar.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const config = cargarConfig({ ruta: process.argv[2] });
const db = abrirBase(config.base);
const embeddings = crearProveedorEmbeddings(config);
const suite = JSON.parse(readFileSync(join(AQUI, "suite.json"), "utf8"));
const limite = 5;

const variantes = [
  { nombre: "bm25", ejecutar: (q) => buscar(db, q, { limite }) },
  { nombre: "rrf-1", ejecutar: (q) => buscarHibrido(db, q, { limite, proveedor: embeddings, pesoLexico: 1 }) },
  { nombre: "rrf-2", ejecutar: (q) => buscarHibrido(db, q, { limite, proveedor: embeddings, pesoLexico: 2 }) },
  { nombre: "rrf-3", ejecutar: (q) => buscarHibrido(db, q, { limite, proveedor: embeddings, pesoLexico: 3 }) },
  { nombre: "respaldo", ejecutar: (q) => buscarHibrido(db, q, { limite, proveedor: embeddings, estrategia: "respaldo" }) },
  { nombre: "umbral-55", ejecutar: (q) => buscarHibrido(db, q, { limite, proveedor: embeddings, pesoLexico: 2, similitudMinima: 0.55 }) },
  { nombre: "umbral-60", ejecutar: (q) => buscarHibrido(db, q, { limite, proveedor: embeddings, pesoLexico: 2, similitudMinima: 0.6 }) },
  { nombre: "umbral-65", ejecutar: (q) => buscarHibrido(db, q, { limite, proveedor: embeddings, pesoLexico: 2, similitudMinima: 0.65 }) },
];

for (const variante of variantes) {
  const posiciones = [];
  const detalle = [];
  for (const item of suite.preguntas) {
    const resultados = await variante.ejecutar(item.pregunta);
    const posicion = posicionFuente(resultados, item.fuentes);
    posiciones.push(posicion);
    detalle.push(`${item.id}:${posicion ?? "—"}`);
  }
  const a1 = posiciones.filter((p) => p === 1).length;
  const a5 = posiciones.filter((p) => p !== null && p <= limite).length;
  console.log(`${variante.nombre.padEnd(10)} @1=${a1}/${posiciones.length}  @5=${a5}/${posiciones.length}  MRR=${mrr(posiciones)}`);
  console.log(`   ${detalle.join("  ")}\n`);
}
