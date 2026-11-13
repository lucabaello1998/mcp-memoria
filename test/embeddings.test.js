import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aBuffer,
  coseno,
  crearProveedorEmbeddings,
  deBuffer,
  fusionRRF,
  normalizarVetor,
} from "../src/embeddings.js";

describe("normalizarVetor", () => {
  test("deja el vector con norma 1", () => {
    const v = normalizarVetor([3, 4]);
    assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6);
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
  });

  test("un vector nulo no explota", () => {
    const v = normalizarVetor([0, 0, 0]);
    assert.deepEqual([...v], [0, 0, 0]);
  });
});

describe("coseno", () => {
  test("vale 1 para vectores iguales y 0 para ortogonales", () => {
    const a = normalizarVetor([1, 0, 0]);
    const b = normalizarVetor([0, 1, 0]);
    assert.ok(Math.abs(coseno(a, a) - 1) < 1e-6);
    assert.ok(Math.abs(coseno(a, b)) < 1e-6);
  });

  test("vectores de distinta dimensión dan 0", () => {
    assert.equal(coseno(new Float32Array([1, 0]), new Float32Array([1, 0, 0])), 0);
  });
});

describe("serialización", () => {
  test("buffer y deBuffer conservan los valores", () => {
    const original = normalizarVetor([0.3, -0.4, 0.5]);
    const ida = deBuffer(aBuffer(original));
    assert.equal(ida.length, original.length);
    for (let i = 0; i < original.length; i += 1) {
      assert.ok(Math.abs(ida[i] - original[i]) < 1e-6);
    }
  });
});

describe("fusionRRF", () => {
  test("lo que aparece en las dos listas gana", () => {
    const fusion = fusionRRF([[1, 2, 3], [3, 4, 5]], { limite: 3 });
    assert.equal(fusion[0].id, 3);
  });

  test("respeta el límite y ordena por puntaje", () => {
    const fusion = fusionRRF([[1, 2, 3, 4]], { limite: 2 });
    assert.deepEqual(fusion.map((f) => f.id), [1, 2]);
    assert.ok(fusion[0].puntaje > fusion[1].puntaje);
  });

  test("listas vacías devuelven vacío", () => {
    assert.deepEqual(fusionRRF([[], []], { limite: 5 }), []);
  });
});

describe("crearProveedorEmbeddings", () => {
  test("sin configuración no hay proveedor", () => {
    assert.equal(crearProveedorEmbeddings({}), null);
  });

  test("usa los valores por defecto de Ollama", () => {
    const proveedor = crearProveedorEmbeddings({ embeddings: {} });
    assert.equal(proveedor.url, "http://127.0.0.1:11434");
    assert.equal(proveedor.modelo, "nomic-embed-text");
  });

  test("manda lotes y normaliza lo que devuelve", async () => {
    const pedidos = [];
    const fetchFalso = async (url, opciones) => {
      const cuerpo = JSON.parse(opciones.body);
      pedidos.push({ url, modelo: cuerpo.model, cantidad: cuerpo.input.length });
      return {
        ok: true,
        json: async () => ({
          embeddings: cuerpo.input.map(() => [3, 4]),
        }),
      };
    };
    const proveedor = crearProveedorEmbeddings(
      { embeddings: { url: "http://localhost:9999/", modelo: "prueba", lote: 2 } },
      { fetchImpl: fetchFalso }
    );

    const vectores = await proveedor.embed(["a", "b", "c"]);
    assert.equal(vectores.length, 3);
    assert.deepEqual(pedidos, [
      { url: "http://localhost:9999/api/embed", modelo: "prueba", cantidad: 2 },
      { url: "http://localhost:9999/api/embed", modelo: "prueba", cantidad: 1 },
    ]);
    assert.ok(Math.abs(vectores[0][0] - 0.6) < 1e-6);
  });

  test("si el proveedor responde mal, tira error claro", async () => {
    const proveedor = crearProveedorEmbeddings(
      { embeddings: {} },
      { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }
    );
    await assert.rejects(() => proveedor.embed(["a"]), /503/);
  });

  test("si devuelve menos vectores que textos, tira error", async () => {
    const proveedor = crearProveedorEmbeddings(
      { embeddings: {} },
      { fetchImpl: async () => ({ ok: true, json: async () => ({ embeddings: [[1, 0]] }) }) }
    );
    await assert.rejects(() => proveedor.embed(["a", "b"]), /cantidad distinta/);
  });
});
