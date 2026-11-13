import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dividirEnFragmentos, tituloDelDocumento } from "../src/chunker.js";

const DOC = `# Objetivos

## Búsqueda laboral

Diez postulaciones por semana.

## Título UNAHUR

Faltan doce créditos ACA.

### Materias

Matemática 2.
`;

describe("tituloDelDocumento", () => {
  test("toma el primer encabezado de nivel 1", () => {
    assert.equal(tituloDelDocumento(DOC), "Objetivos");
  });

  test("sin h1 devuelve vacío", () => {
    assert.equal(tituloDelDocumento("## Solo h2\ntexto"), "");
  });
});

describe("dividirEnFragmentos", () => {
  test("separa por encabezado y arma la ruta de secciones", () => {
    const fragmentos = dividirEnFragmentos(DOC);
    const rutas = fragmentos.map((f) => f.encabezado);
    assert.ok(rutas.includes("Búsqueda laboral"));
    assert.ok(rutas.includes("Título UNAHUR"));
    assert.ok(rutas.includes("Título UNAHUR > Materias"));
  });

  test("las líneas citadas existen y contienen el texto del fragmento", () => {
    const lineas = DOC.split("\n");
    for (const fragmento of dividirEnFragmentos(DOC)) {
      const tramo = lineas.slice(fragmento.linea_inicio - 1, fragmento.linea_fin);
      assert.equal(tramo.join("\n"), fragmento.texto);
      assert.ok(fragmento.linea_fin >= fragmento.linea_inicio);
    }
  });

  test("el título del documento se propaga a todos los fragmentos", () => {
    for (const fragmento of dividirEnFragmentos(DOC)) {
      assert.equal(fragmento.titulo, "Objetivos");
    }
  });

  test("respeta el máximo y parte bloques largos", () => {
    const largo = `# Doc\n\n${"palabra ".repeat(300)}`;
    const fragmentos = dividirEnFragmentos(largo, { maximo: 200 });
    assert.ok(fragmentos.length > 1);
    for (const fragmento of fragmentos) {
      assert.ok(fragmento.texto.length < 400, `fragmento de ${fragmento.texto.length} caracteres`);
    }
  });

  test("un archivo sin encabezados igual produce un fragmento", () => {
    const fragmentos = dividirEnFragmentos("solo texto plano\nsin encabezados", {
      tituloPorDefecto: "README.md",
    });
    assert.equal(fragmentos.length, 1);
    assert.equal(fragmentos[0].titulo, "README.md");
    assert.equal(fragmentos[0].encabezado, "");
    assert.equal(fragmentos[0].linea_inicio, 1);
    assert.equal(fragmentos[0].linea_fin, 2);
  });

  test("ignora líneas vacías al principio y al final", () => {
    const fragmentos = dividirEnFragmentos("\n\n# T\n\ntexto\n\n\n");
    assert.equal(fragmentos.length, 1);
    assert.equal(fragmentos[0].texto, "# T\n\ntexto");
    assert.equal(fragmentos[0].linea_inicio, 3);
    assert.equal(fragmentos[0].linea_fin, 5);
  });

  test("un texto vacío no genera fragmentos", () => {
    assert.deepEqual(dividirEnFragmentos(""), []);
    assert.deepEqual(dividirEnFragmentos("   \n\n  "), []);
  });
});
