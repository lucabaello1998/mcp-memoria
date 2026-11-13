import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { abrirBase } from "../src/db.js";
import { indexar } from "../src/indice.js";
import { buscar } from "../src/buscar.js";
import { guardarNota } from "../src/notas.js";
import { crearEntorno } from "./helpers.js";

let entorno;
let db;

before(async () => {
  entorno = await crearEntorno();
  db = abrirBase(entorno.config.base);
  await indexar(db, entorno.config);
});

after(async () => {
  db.close();
  await entorno.limpiar();
});

describe("guardarNota", () => {
  test("escribe la nota, la indexa y devuelve la cita", async () => {
    const guardado = await guardarNota(db, entorno.config, {
      texto: "El viernes 12 de noviembre Agus pidió auditar el desafío de CRUX.",
      etiquetas: ["trabajo", "crux"],
    });

    assert.equal(guardado.creado, true);
    assert.ok(guardado.linea > 0);

    const contenido = await readFile(guardado.archivo, "utf8");
    assert.match(contenido, /# Notas/);
    assert.match(contenido, /— trabajo, crux/);
    assert.match(contenido, /desafío de CRUX/);

    const encontrado = buscar(db, "CRUX Agus");
    assert.ok(encontrado.some((r) => r.archivo === guardado.archivo));
  });

  test("no duplica una nota idéntica", async () => {
    const texto = "La prioridad uno es la búsqueda laboral.";
    const primera = await guardarNota(db, entorno.config, { texto });
    const segunda = await guardarNota(db, entorno.config, { texto: `  ${texto}  ` });

    assert.equal(primera.creado, true);
    assert.equal(segunda.creado, false);
    assert.equal(segunda.archivo, primera.archivo);
    assert.equal(segunda.linea, primera.linea);
    assert.match(segunda.mensaje, /ya estaba guardada/);

    const contenido = await readFile(primera.archivo, "utf8");
    assert.equal(contenido.split(texto).length - 1, 1);
  });

  test("rechaza texto vacío y texto gigante", async () => {
    const vacio = await guardarNota(db, entorno.config, { texto: "   " });
    assert.ok(vacio.error);
    const gigante = await guardarNota(db, entorno.config, { texto: "x".repeat(4001) });
    assert.ok(gigante.error);
  });

  test("respeta notas deshabilitadas", async () => {
    const resultado = await guardarNota(db, { ...entorno.config, notas: null }, { texto: "hola" });
    assert.match(resultado.error, /deshabilitadas/);
  });

  test("usa un archivo por mes", async () => {
    await guardarNota(db, entorno.config, { texto: "Nota de fin de mes." });
    const archivos = await readdir(entorno.config.notas);
    assert.ok(archivos.length >= 1);
    for (const archivo of archivos) assert.match(archivo, /^\d{4}-\d{2}\.md$/);
  });
});
