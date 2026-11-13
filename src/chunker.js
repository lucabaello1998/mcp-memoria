// División del texto en fragmentos indexables.
//
// Un documento entero como unidad de búsqueda es demasiado grueso: el modelo
// termina leyendo 40 KB para encontrar una frase. Un fragmento por encabezado
// (o por bloque de ~1200 caracteres si no hay encabezados) da precisión y, sobre
// todo, permite citar `archivo:línea` sin adivinar.

const ENCABEZADO = /^(#{1,6})\s+(.*\S)\s*$/;

/** Primer título de nivel 1, para etiquetar el documento. */
export function tituloDelDocumento(texto) {
  for (const linea of String(texto ?? "").split(/\r?\n/)) {
    const m = ENCABEZADO.exec(linea);
    if (m && m[1].length === 1) return m[2].trim();
  }
  return "";
}

/**
 * Divide un texto en fragmentos con su rango de líneas real.
 *
 * Devuelve `{ titulo, encabezado, linea_inicio, linea_fin, texto }`, donde
 * `encabezado` es la ruta de secciones ("Proyectos > FletAR") y las líneas son
 * 1-based sobre el archivo original.
 */
export function dividirEnFragmentos(texto, { maximo = 1200, tituloPorDefecto = "" } = {}) {
  const lineas = String(texto ?? "").split(/\r?\n/);
  const titulo = tituloDelDocumento(texto) || tituloPorDefecto;
  const fragmentos = [];

  let pila = [];
  let buffer = [];

  const volcar = () => {
    let desde = 0;
    let hasta = buffer.length;
    while (desde < hasta && !buffer[desde].texto.trim()) desde += 1;
    while (hasta > desde && !buffer[hasta - 1].texto.trim()) hasta -= 1;
    if (hasta <= desde) {
      buffer = [];
      return;
    }
    const tramo = buffer.slice(desde, hasta);
    // Si el primer nivel repite el título del documento, no se muestra dos veces.
    const ruta = pila.map((p) => p.texto);
    const encabezado = ruta[0] === titulo ? ruta.slice(1).join(" > ") : ruta.join(" > ");
    fragmentos.push({
      titulo,
      encabezado,
      linea_inicio: tramo[0].numero,
      linea_fin: tramo[tramo.length - 1].numero,
      texto: tramo.map((l) => l.texto).join("\n"),
    });
    buffer = [];
  };

  let largo = 0;

  // Una línea puede ser más larga que el máximo (un párrafo sin cortes, JSON
  // minificado). Se parte en trozos de `maximo` sin perder el número de línea.
  const empujarLinea = (textoLinea, numero) => {
    if (textoLinea.length <= maximo) {
      buffer.push({ numero, texto: textoLinea });
      largo += textoLinea.length + 1;
      return;
    }
    let resto = textoLinea;
    while (resto.length > 0) {
      let corte = resto.lastIndexOf(" ", maximo);
      if (corte <= 0) corte = maximo;
      buffer.push({ numero, texto: resto.slice(0, corte) });
      largo += corte + 1;
      resto = resto.slice(corte).trimStart();
      if (largo >= maximo) {
        volcar();
        largo = 0;
      }
    }
  };

  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i];
    const numero = i + 1;
    const m = ENCABEZADO.exec(linea);

    if (m) {
      volcar();
      largo = 0;
      const nivel = m[1].length;
      pila = pila.filter((p) => p.nivel < nivel);
      pila.push({ nivel, texto: m[2].trim() });
      // El encabezado entra en el fragmento: así también se busca por él.
      buffer.push({ numero, texto: linea });
      largo += linea.length + 1;
      continue;
    }

    empujarLinea(linea, numero);
    if (largo >= maximo) {
      volcar();
      largo = 0;
    }
  }
  volcar();

  return fragmentos;
}
