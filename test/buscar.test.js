import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { abrirBase } from "../src/db.js";
import { indexar } from "../src/indice.js";
import { buscar, fuenteDe, leerFragmento, resumenFuentes } from "../src/buscar.js";
import { normalizar, terminosDe } from "../src/tokenizer.js";
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

describe("buscar", () => {
  test("encuentra por palabra suelta", () => {
    const resultados = buscar(db, "sueldos");
    assert.ok(resultados.length > 0);
    assert.ok(resultados.every((r) => typeof r.archivo === "string" && r.linea >= 1));
  });

  test("cada cita apunta a una línea que contiene lo buscado", async () => {
    const consultas = ["sueldos", "FletAR", "UNAHUR", "créditos ACA"];

    for (const consulta of consultas) {
      const terminos = terminosDe(consulta);
      const resultados = buscar(db, consulta, { limite: 5 });
      assert.ok(resultados.length > 0, `sin resultados para "${consulta}"`);

      for (const resultado of resultados) {
        const lineas = (await readFile(resultado.archivo, "utf8")).split(/\r?\n/);
        const tramo = normalizar(lineas.slice(resultado.linea - 1, resultado.linea + 2).join("\n"));
        assert.ok(
          terminos.some((termino) => tramo.includes(termino)),
          `la cita ${resultado.archivo}:${resultado.linea} no contiene "${consulta}"`
        );
      }
    }
  });

  test("ignora acentos en la consulta y en el texto", () => {
    const conAcento = buscar(db, "título");
    const sinAcento = buscar(db, "titulo");
    assert.ok(conAcento.length > 0);
    assert.deepEqual(
      conAcento.map((r) => `${r.archivo}:${r.linea}`),
      sinAcento.map((r) => `${r.archivo}:${r.linea}`)
    );
  });

  test("filtra por etiqueta", () => {
    const resultados = buscar(db, "sueldos", { etiqueta: "repos" });
    assert.ok(resultados.length > 0);
    assert.ok(resultados.every((r) => r.etiqueta === "repos"));
  });

  test("si no hay coincidencias devuelve lista vacía", () => {
    assert.deepEqual(buscar(db, "ornitorrinco azul"), []);
    assert.deepEqual(buscar(db, ""), []);
    assert.deepEqual(buscar(db, "de la el"), []);
  });

  test("no devuelve más de dos fragmentos por archivo", () => {
    const resultados = buscar(db, "proyectos", { limite: 10 });
    const cuenta = new Map();
    for (const r of resultados) cuenta.set(r.archivo, (cuenta.get(r.archivo) ?? 0) + 1);
    for (const [archivo, n] of cuenta) assert.ok(n <= 2, `${archivo} apareció ${n} veces`);
  });

  test("respeta el límite pedido", () => {
    assert.ok(buscar(db, "proyectos", { limite: 1 }).length <= 1);
  });

  test("una consulta con sintaxis rara no rompe", () => {
    assert.doesNotThrow(() => buscar(db, 'sueldos" OR * NEAR('));
  });
});

describe("leerFragmento", () => {
  test("devuelve las líneas exactas del archivo", async () => {
    const archivo = entorno.archivo("memoria/objetivos.md");
    const leido = await leerFragmento(db, archivo, { desde: 1, hasta: 3 });
    const esperado = (await readFile(archivo, "utf8")).split(/\r?\n/).slice(0, 3).join("\n");
    assert.equal(leido.texto, esperado);
    assert.equal(leido.desde, 1);
    assert.equal(leido.hasta, 3);
  });

  test("recorta el pedido a 200 líneas", async () => {
    const leido = await leerFragmento(db, entorno.archivo("memoria/objetivos.md"), { desde: 1, hasta: 5000 });
    assert.ok(leido.hasta - leido.desde <= 200);
  });

  test("no deja leer archivos fuera del índice", async () => {
    assert.equal(await leerFragmento(db, "C:\\Windows\\win.ini"), null);
    assert.equal(await leerFragmento(db, "../../../../etc/passwd"), null);
    assert.equal(await leerFragmento(db, entorno.archivo("repos/uno/node_modules/paquete/README.md")), null);
  });

  test("fuenteDe resuelve con otra capitalización", () => {
    const ruta = entorno.archivo("memoria/objetivos.md");
    assert.ok(fuenteDe(db, ruta.toUpperCase()) !== null);
  });
});

describe("resumenFuentes", () => {
  test("lista cada archivo con etiqueta y fragmentos", () => {
    const fuentes = resumenFuentes(db);
    assert.equal(fuentes.length, 3);
    assert.ok(fuentes.every((f) => f.etiqueta && f.fragmentos > 0 && f.kb > 0));
  });
});
