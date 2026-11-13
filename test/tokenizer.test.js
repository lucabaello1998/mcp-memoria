import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  consultaFts,
  lineasAntes,
  normalizar,
  posicionDeCoincidencia,
  recortar,
  terminosDe,
  tokenizar,
} from "../src/tokenizer.js";

describe("normalizar", () => {
  test("saca acentos y pasa a minúsculas", () => {
    assert.equal(normalizar("Liquidación de SUELDOS"), "liquidacion de sueldos");
    assert.equal(normalizar("Ñandú"), "nandu");
  });

  test("aguanta null y undefined", () => {
    assert.equal(normalizar(null), "");
    assert.equal(normalizar(undefined), "");
  });
});

describe("tokenizar", () => {
  test("separa por cualquier cosa que no sea alfanumérico", () => {
    assert.deepEqual(tokenizar("SAC, vacaciones y aportes."), ["sac", "vacaciones", "aportes"]);
  });

  test("descarta tokens de un carácter", () => {
    assert.deepEqual(tokenizar("a b c de f"), ["de"]);
  });

  test("conserva números", () => {
    assert.deepEqual(tokenizar("Faltan 12 créditos"), ["faltan", "12", "creditos"]);
  });
});

describe("terminosDe", () => {
  test("quita palabras vacías y repetidos", () => {
    assert.deepEqual(terminosDe("el trabajo del trabajo"), ["trabajo"]);
  });

  test("sin términos útiles devuelve vacío", () => {
    assert.deepEqual(terminosDe("de la el"), []);
  });
});

describe("consultaFts", () => {
  test("arma AND con prefijo y comillas", () => {
    assert.equal(consultaFts("sueldos SAC"), '("sueldos"* AND "sac"*)');
  });

  test("arma OR cuando se pide", () => {
    assert.equal(consultaFts("sueldos SAC", { operador: "o" }), '("sueldos"* OR "sac"*)');
  });

  test("un solo término no lleva paréntesis", () => {
    assert.equal(consultaFts("sueldos"), '"sueldos"*');
  });

  test("devuelve null si no hay nada que buscar", () => {
    assert.equal(consultaFts("de la el"), null);
    assert.equal(consultaFts(""), null);
  });

  test("no permite inyectar sintaxis de FTS5", () => {
    const expresion = consultaFts('sueldos" OR "vacaciones NEAR(a b) *');
    // Todo lo que no sea alfanumérico se descarta: las palabras raras quedan
    // como términos entre comillas, nunca como operadores.
    assert.equal(expresion, '("sueldos"* AND "or"* AND "vacaciones"* AND "near"*)');
    assert.equal(expresion.match(/"/g).length % 2, 0);
    assert.ok(!expresion.includes("NEAR("));
  });
});

describe("posicionDeCoincidencia y recortar", () => {
  const texto = "Primera línea sin nada.\nSegunda línea con liquidación de sueldos.\nTercera línea.";

  test("encuentra ignorando acentos y mayúsculas", () => {
    const posicion = posicionDeCoincidencia(texto, "LIQUIDACION");
    assert.ok(posicion > texto.indexOf("Segunda"));
  });

  test("devuelve -1 cuando no está", () => {
    assert.equal(posicionDeCoincidencia(texto, "fletes"), -1);
  });

  test("recorta alrededor de la coincidencia y avisa con puntos suspensivos", () => {
    const recorte = recortar(texto, "sueldos", { antes: 10, despues: 10 });
    assert.match(recorte, /^….*sueldos.*…$/);
    assert.ok(recorte.length < texto.length);
  });

  test("si no hay coincidencia devuelve el principio del texto", () => {
    const recorte = recortar(texto, "inexistente", { antes: 5, despues: 5 });
    assert.ok(recorte.startsWith("Primera"));
  });
});

describe("lineasAntes", () => {
  test("cuenta saltos de línea antes de una posición", () => {
    const texto = "a\nb\nc";
    assert.equal(lineasAntes(texto, 0), 0);
    assert.equal(lineasAntes(texto, 2), 1);
    assert.equal(lineasAntes(texto, 4), 2);
  });
});
