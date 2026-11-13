import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { abrirBase, estadisticas } from "../src/db.js";
import { indexar } from "../src/indice.js";
import { buscar, buscarHibrido } from "../src/buscar.js";
import { normalizarVetor } from "../src/embeddings.js";
import { normalizar } from "../src/tokenizer.js";
import { crearEntorno } from "./helpers.js";

// Proveedor controlado: tres "temas" en un espacio de 3 dimensiones. Sirve para
// comprobar que el híbrido encuentra lo que BM25 no, sin depender de un modelo
// real ni de la red.
const proveedor = {
  modelo: "falso-3d",
  async embed(textos) {
    return textos.map((texto) => {
      const n = normalizar(texto);
      const vector = [0, 0, 0];
      if (/sueldo|liquidacion|plata|salario|sac/.test(n)) vector[0] = 1;
      if (/flete|carga|camion|envio/.test(n)) vector[1] = 1;
      if (/memoria|agente|cita/.test(n)) vector[2] = 1;
      return normalizarVetor(vector);
    });
  },
};

let entorno;
let db;

before(async () => {
  entorno = await crearEntorno();
  db = abrirBase(entorno.config.base);
  await indexar(db, entorno.config, { proveedor });
});

after(async () => {
  db.close();
  await entorno.limpiar();
});

describe("indexado con embeddings", () => {
  test("guarda un vector por fragmento", () => {
    const stats = estadisticas(db);
    assert.equal(stats.vectores, stats.fragmentos);
    assert.equal(stats.modeloEmbeddings, "falso-3d");
  });

  test("reindexar sin proveedor borra los vectores del archivo tocado", async () => {
    await entorno.escribir("memoria/proyectos.md", "# Proyectos\n\n## FletAR\n\nTexto nuevo sobre fletes.\n");
    await indexar(db, entorno.config);
    const stats = estadisticas(db);
    assert.ok(stats.vectores < stats.fragmentos);
  });
});

describe("buscarHibrido", () => {
  test("encuentra por significado lo que BM25 no encuentra", async () => {
    // "plata" no aparece en ningún documento: BM25 devuelve vacío.
    assert.deepEqual(buscar(db, "plata"), []);

    // El vector sí: los fragmentos de sueldos caen en la misma dirección.
    const resultados = await buscarHibrido(db, "plata", { proveedor, limite: 3 });
    assert.ok(resultados.length > 0);
    assert.ok(resultados.some((r) => /sueldo|liquidaci/i.test(r.fragmento)));
    assert.ok(resultados.every((r) => typeof r.similitud === "number"));
  });

  test("sigue devolviendo citas válidas", async () => {
    const resultados = await buscarHibrido(db, "sueldos", { proveedor, limite: 3 });
    assert.ok(resultados.length > 0);
    for (const r of resultados) {
      assert.ok(r.linea >= 1);
      assert.ok(r.archivo.endsWith(".md"));
    }
  });

  test("respeta el filtro por etiqueta", async () => {
    const resultados = await buscarHibrido(db, "plata", { proveedor, etiqueta: "repos" });
    assert.ok(resultados.every((r) => r.etiqueta === "repos"));
  });

  test("si el proveedor falla, cae a BM25 sin romper", async () => {
    const roto = {
      modelo: "falso-3d",
      async embed() {
        throw new Error("sin red");
      },
    };
    const resultados = await buscarHibrido(db, "sueldos", { proveedor: roto, limite: 3 });
    assert.deepEqual(
      resultados.map((r) => `${r.archivo}:${r.linea}`),
      buscar(db, "sueldos", { limite: 3 }).map((r) => `${r.archivo}:${r.linea}`)
    );
  });

  test("sin proveedor se comporta como BM25", async () => {
    const resultados = await buscarHibrido(db, "sueldos", { limite: 3 });
    assert.deepEqual(
      resultados.map((r) => r.puntaje),
      buscar(db, "sueldos", { limite: 3 }).map((r) => r.puntaje)
    );
  });

  test("no devuelve más de dos fragmentos por archivo", async () => {
    const resultados = await buscarHibrido(db, "sueldo flete memoria", { proveedor, limite: 10 });
    const cuenta = new Map();
    for (const r of resultados) cuenta.set(r.archivo, (cuenta.get(r.archivo) ?? 0) + 1);
    for (const [archivo, n] of cuenta) assert.ok(n <= 2, `${archivo} apareció ${n} veces`);
  });
});
