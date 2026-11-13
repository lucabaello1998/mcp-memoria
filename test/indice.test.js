import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { writeFile, rm } from "node:fs/promises";
import { abrirBase, estadisticas } from "../src/db.js";
import { indexar, listarArchivos } from "../src/indice.js";
import { crearEntorno } from "./helpers.js";

let entorno;
let db;

before(async () => {
  entorno = await crearEntorno();
  db = abrirBase(entorno.config.base);
});

after(async () => {
  db.close();
  await entorno.limpiar();
});

describe("listarArchivos", () => {
  test("recorre subcarpetas y saltea node_modules", async () => {
    const archivos = await listarArchivos(entorno.config.fuentes[1], entorno.config);
    assert.equal(archivos.length, 1);
    assert.match(archivos[0], /README\.md$/);
  });

  test("saltea test/fixtures para no indexar texto inventado", async () => {
    const archivos = await listarArchivos(entorno.config.fuentes[1], entorno.config);
    assert.ok(!archivos.some((a) => a.includes("fixtures")));
  });

  test("solo toma las extensiones configuradas", async () => {
    await writeFile(entorno.archivo("repos/uno/logo.png"), "no es un png de verdad", "utf8");
    const archivos = await listarArchivos(entorno.config.fuentes[1], entorno.config);
    assert.ok(!archivos.some((a) => a.endsWith(".png")));
    await rm(entorno.archivo("repos/uno/logo.png"));
  });
});

describe("indexar", () => {
  test("indexa las fuentes y cuenta fragmentos", async () => {
    const resumen = await indexar(db, entorno.config);
    assert.equal(resumen.archivos, 3);
    assert.equal(resumen.nuevos, 3);
    assert.ok(resumen.fragmentos > 3);
    const stats = estadisticas(db);
    assert.equal(stats.fuentes, 3);
    assert.ok(stats.ultimoIndexado);
  });

  test("la segunda corrida no toca nada", async () => {
    const resumen = await indexar(db, entorno.config);
    assert.equal(resumen.nuevos, 0);
    assert.equal(resumen.actualizados, 0);
    assert.equal(resumen.iguales, 3);
  });

  test("un archivo modificado se reindexa solo", async () => {
    await entorno.escribir("memoria/proyectos.md", "# Proyectos\n\n## FletAR\n\nCambió el alcance.\n");
    const resumen = await indexar(db, entorno.config);
    assert.equal(resumen.actualizados, 1);
    assert.equal(resumen.iguales, 2);
  });

  test("un archivo borrado sale del índice", async () => {
    await rm(entorno.archivo("repos/uno/README.md"));
    const resumen = await indexar(db, entorno.config);
    assert.equal(resumen.borrados, 1);
    assert.equal(estadisticas(db).fuentes, 2);
  });

  test("ignora archivos binarios aunque tengan extensión de texto", async () => {
    await entorno.escribir("memoria/binario.md", "texto\u0000con\u0000nulos");
    const resumen = await indexar(db, entorno.config);
    assert.equal(resumen.nuevos, 0);
    await rm(entorno.archivo("memoria/binario.md"));
  });

  test("ignora archivos más grandes que maxBytes", async () => {
    const chico = await crearEntorno({ maxBytes: 10 });
    const dbChico = abrirBase(chico.config.base);
    const resumen = await indexar(dbChico, chico.config);
    assert.equal(resumen.nuevos, 0);
    assert.equal(resumen.archivos, 0);
    dbChico.close();
    await chico.limpiar();
  });

  test("actualiza la etiqueta si cambia la configuración", async () => {
    const config = { ...entorno.config, fuentes: [{ ...entorno.config.fuentes[0], etiqueta: "notas" }] };
    await indexar(db, config);
    const filas = db.prepare("SELECT etiqueta FROM fuentes").all();
    assert.deepEqual([...new Set(filas.map((f) => f.etiqueta))], ["notas"]);
  });
});
