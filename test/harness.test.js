import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { abrirBase } from "../src/db.js";
import { indexar } from "../src/indice.js";
import { parsearAccion, responder } from "../harness/agente.js";
import { crearEntorno } from "./helpers.js";

/** Modelo de mentira que sigue un guion: cada llamada devuelve el próximo texto. */
function modeloGuion(respuestas) {
  let i = 0;
  return {
    modelo: "guion",
    llamadas: [],
    async charlar(mensajes) {
      this.llamadas.push(mensajes);
      const texto = respuestas[Math.min(i, respuestas.length - 1)];
      i += 1;
      return { texto, tokensEntrada: 10, tokensSalida: 5, ms: 1 };
    },
  };
}

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

describe("parsearAccion", () => {
  test("lee JSON puro", () => {
    assert.deepEqual(parsearAccion('{"accion":"buscar","consulta":"sueldos"}'), {
      accion: "buscar",
      consulta: "sueldos",
    });
  });

  test("tolera texto alrededor", () => {
    const accion = parsearAccion('Claro, voy a buscar: {"accion":"responder","texto":"hola"} listo');
    assert.equal(accion.accion, "responder");
  });

  test("descarta acciones inválidas y basura", () => {
    assert.equal(parsearAccion('{"accion":"borrar_todo"}'), null);
    assert.equal(parsearAccion("no hay json"), null);
    assert.equal(parsearAccion("{roto"), null);
    assert.equal(parsearAccion(null), null);
  });
});

describe("responder", () => {
  test("busca y después responde, acumulando citas", async () => {
    const modelo = modeloGuion([
      '{"accion":"buscar","consulta":"sueldos"}',
      '{"accion":"responder","texto":"Es un motor de liquidación (proyectos.md)."}',
    ]);

    const resultado = await responder("¿qué es sueldos-ar?", { db, modelo });
    assert.equal(resultado.pasos.length, 2);
    assert.deepEqual(resultado.pasos.map((p) => p.accion), ["buscar", "responder"]);
    assert.ok(resultado.citas.length > 0);
    assert.match(resultado.citas[0], /:\d+$/);
    assert.match(resultado.respuesta, /liquidación/);
    assert.equal(resultado.uso.tokensEntrada, 20);
  });

  test("puede leer un archivo indexado", async () => {
    const archivo = entorno.archivo("memoria/objetivos.md");
    const modelo = modeloGuion([
      `{"accion":"leer","archivo":${JSON.stringify(archivo)},"desde":1,"hasta":3}`,
      '{"accion":"responder","texto":"Listo."}',
    ]);
    const resultado = await responder("leé objetivos", { db, modelo });
    assert.ok(resultado.citas.some((c) => c.includes("objetivos.md")));
    // El contenido leído tiene que haber llegado al modelo en el segundo turno.
    const segundoTurno = modelo.llamadas[1].map((m) => m.content).join("\n");
    assert.match(segundoTurno, /# Objetivos/);
  });

  test("no repite la misma búsqueda dos veces", async () => {
    const modelo = modeloGuion([
      '{"accion":"buscar","consulta":"sueldos"}',
      '{"accion":"buscar","consulta":"sueldos"}',
      '{"accion":"responder","texto":"Ya está."}',
    ]);
    await responder("buscá sueldos", { db, modelo });
    const tercerTurno = modelo.llamadas[2].map((m) => m.content).join("\n");
    assert.match(tercerTurno, /ya la hiciste/);
  });

  test("si el modelo no usa el protocolo, devuelve el texto tal cual", async () => {
    const modelo = modeloGuion(["La respuesta directa sin JSON."]);
    const resultado = await responder("hola", { db, modelo });
    assert.equal(resultado.respuesta, "La respuesta directa sin JSON.");
    assert.equal(resultado.pasos[0].accion, "respuesta-libre");
  });

  test("corta al llegar al máximo de pasos", async () => {
    const modelo = modeloGuion(['{"accion":"buscar","consulta":"fletes"}']);
    const resultado = await responder("buscá", { db, modelo, maxPasos: 2 });
    assert.match(resultado.respuesta, /No llegué a una respuesta en 2 pasos/);
    assert.equal(resultado.pasos.length, 2);
  });

  test("una pregunta vacía es un error explícito", async () => {
    await assert.rejects(() => responder("  ", { db, modelo: modeloGuion(["x"]) }), /Falta la pregunta/);
  });
});
