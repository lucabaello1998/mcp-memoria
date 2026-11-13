# mcp-memoria

<p>
  <a href="https://github.com/lucabaello1998/mcp-memoria/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/lucabaello1998/mcp-memoria/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/lucabaello1998/mcp-memoria/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/lucabaello1998/mcp-memoria?label=release"></a>
  <img alt="Licencia" src="https://img.shields.io/badge/licencia-MIT-blue">
  <img alt="Node" src="https://img.shields.io/badge/node-22.13%2B-brightgreen">
</p>

Memoria portable para agentes: indexa tus notas, memorias y READMEs en SQLite
FTS5 y los expone por MCP con **citas exactas `archivo:línea`**. Sin
dependencias ni API key; con búsqueda híbrida opcional y evals para comprobarla.

```text
$ mcp-memoria search "liquidacion SAC vacaciones"
1. ...\memory\proyectos.md:118  [memoria] puntaje 32.4085
   sueldos-ar — motor de liquidación + observatorio de sueldos tech
   Motor de liquidación argentino en .NET 8 (SAC, vacaciones, aportes, ...)
```

---

## El problema

Cada agente (Claude Code, Codex, Cursor, OpenCode) arranca en blanco. Vos le
explicás quién sos, en qué andás y qué decidiste la semana pasada; la sesión
termina y se olvida. Guardar todo en un `CLAUDE.md` ayuda hasta que el archivo
pasa los 50 KB y el agente lo lee entero o lo ignora.

Este servidor resuelve la parte aburrida: **buscar**. El agente pregunta por un
tema y recibe tres fragmentos con la ruta y la línea exactas, no un resumen
inventado. Si la cita no le alcanza, pide más líneas con `leer_fragmento`.

## Qué expone

| Herramienta | Para qué |
| --- | --- |
| `buscar_memoria` | Busca por texto libre y devuelve fragmentos con `cita: archivo:línea` (`modo`: auto, bm25 o hibrido) |
| `leer_fragmento` | Lee líneas exactas de un archivo indexado (máx. 200 por pedido) |
| `guardar_nota` | Guarda un dato nuevo, lo indexa y evita duplicados |
| `listar_fuentes` | Muestra qué está indexado y cuándo se actualizó |
| `reindexar` | Actualiza el índice (solo procesa archivos cambiados) |

## Instalación

Necesitás **Node 22.13+**. No hay dependencias: SQLite y FTS5 vienen con Node.

```bash
git clone https://github.com/lucabaello1998/mcp-memoria.git
cd mcp-memoria
node cli.js index          # indexa y muestra qué hizo
node cli.js search "objetivos laborales"
```

### Configuración

Copiá `memoria.config.example.json` a `memoria.config.json`:

```json
{
  "base": "~/.local/share/mcp-memoria/memoria.db",
  "notas": "~/.config/opencode/memory/notas",
  "fuentes": [
    { "ruta": "~/.config/opencode/memory", "etiqueta": "memoria" },
    { "ruta": "~/Documents/repos", "etiqueta": "repos" },
    { "ruta": "~/notas", "etiqueta": "notas", "extensiones": [".md", ".txt"] }
  ],
  "ignorar": ["node_modules", "dist"],
  "maxBytes": 2000000
}
```

Sin archivo de configuración usa `~/.config/opencode/memory` si existe (o el
directorio actual) y guarda la base en el directorio de datos del sistema.
También se puede apuntar todo por entorno: `MEMORIA_CONFIG` y `MEMORIA_DB`.

### Conectarlo a un cliente MCP

```json
{
  "mcpServers": {
    "memoria": {
      "command": "node",
      "args": ["C:/ruta/a/mcp-memoria/server.js"],
      "env": { "MEMORIA_CONFIG": "C:/ruta/a/memoria.config.json" }
    }
  }
}
```

Funciona igual en Claude Code (`~/.claude.json`), Cursor (`mcp.json`), OpenCode
(`opencode.json`) o cualquier cliente que hable MCP por stdio. El servidor no
necesita que el índice exista: si la base está vacía, indexa en la primera
llamada.

## Cómo funciona

```text
fuentes (md/txt) ──► chunker ──► fragmentos ──► SQLite FTS5 (bm25)
                        │                              │
                   encabezado +                    búsqueda
                   líneas exactas                      │
                                                       ▼
                                            resultado + cita
                                            archivo:línea
```

1. **Indexado incremental.** Cada archivo se firma con SHA-256. Si no cambió, no
   se toca. Reindexar 530 archivos tarda **0.31 s**; la primera vez, **3.8 s**.
2. **Fragmentos por encabezado.** Un documento entero como unidad de búsqueda
   obliga al modelo a leer 40 KB para encontrar una frase. Se corta por
   `#`/`##`/`###` (o cada ~1200 caracteres si no hay encabezados) y se guarda el
   rango de líneas real, así la cita es verificable.
3. **Búsqueda léxica con BM25.** FTS5 con `unicode61 remove_diacritics 2`:
   `liquidación` y `liquidacion` son el mismo token. Los pesos son explícitos
   (título 8, encabezado 4, cuerpo 1) más un ajuste por etiqueta y recencia.
4. **Dos pasadas.** Primero busca con todos los términos (preciso); si no hay
   nada, relaja a cualquiera (recall). Una consulta vacía nunca inventa
   resultados: devuelve lista vacía.
5. **Citas que se pueden abrir.** El número de línea sale de la posición real de
   la coincidencia dentro del fragmento, no de una estimación.

### Búsqueda híbrida (opcional)

Si configurás `embeddings`, el índice guarda un vector por fragmento (Ollama +
`nomic-embed-text`, 768 dimensiones) y la búsqueda combina BM25 con coseno
usando **RRF** (Reciprocal Rank Fusion): se fusiona por posición, no por puntaje,
así no hay que calibrar escalas.

```json
"embeddings": { "url": "http://127.0.0.1:11434", "modelo": "nomic-embed-text" }
```

Medido con la suite de evals (12 preguntas reales sobre el corpus):

| modo | aciertos@1 | aciertos@5 | MRR |
| --- | --- | --- | --- |
| BM25 | 2/12 | **11/12** | 0.4306 |
| Híbrido | **3/12** | 10/12 | **0.4681** |

**Conclusión honesta: el híbrido mejora el ranking pero no la cobertura.** Sube
el primer acierto y el MRR (el fragmento correcto queda más arriba), pero pierde
un punto de top-5: cuando BM25 ya tiene la coincidencia exacta, el vector la
empuja hacia abajo. Por eso `modo: auto` usa híbrido solo si hay vectores, y
`modo: bm25` sigue disponible para cobertura máxima. Los números se reproducen
con `node evals/comparar.js`.

Por qué no embeddings siempre: un modelo de embeddings chico en un corpus con
jerga propia (`SAC`, `PostGIS`, `mcp-direcciones-ar`) confunde nombres y siglas;
BM25 no.

## Evals

Una suite de **12 preguntas reales** sobre la memoria, cada una con la respuesta
esperada y el archivo donde está el dato (`evals/suite.json`). Dos mediciones
distintas:

1. **Recuperación**: ¿el archivo con el dato aparece en el top 5? No usa modelo,
   así que corre siempre y gratis.
2. **Respuesta**: dado el contexto, ¿contesta bien? Se corre con y sin contexto.

```bash
node evals/correr.js                                  # modelo local
node evals/correr.js --modelos openai:gpt-4o-mini      # con OPENAI_API_KEY
node evals/comparar.js                                 # variantes de búsqueda
```

Resultado con `qwen3.5:4b` local (13/11/2026, 12 preguntas):

| modelo | contexto | aciertos | no sabe | citas | latencia | tokens | costo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.5:4b | sí | **10/12 (83%)** | 1 | 10/12 | 5,9 s | 5.581 | US$ 0 |
| qwen3.5:4b | no | **0/12 (0%)** | 12 | — | 3,4 s | 1.128 | US$ 0 |

Y con un modelo grande vía OpenCode (`deepseek-v4.1-flash`):

| modelo | contexto | aciertos | no sabe | citas | latencia | tokens | costo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-v4.1-flash | sí | **12/12 (100%)** | 0 | 10/12 | 8,0 s | ~4.745 | s/d |
| deepseek-v4.1-flash | no | 2/12 (17%) | 7 | — | 7,6 s | ~967 | s/d |

**La memoria es la diferencia entre 0% y 83%** en un modelo de 4B. Sin contexto
contesta "no tengo información suficiente" en las 12: no inventa. Con contexto
acierta 10 y cita 10. El modelo grande usa mejor el mismo contexto: 12/12.

Dos advertencias sobre la segunda tabla, para no vender humo:

- El 17% "sin contexto" **no es un baseline limpio**: el agente de OpenCode carga
  las instrucciones del repo (`AGENTS.md`), que ya incluyen parte del perfil. El
  piso real es el 0% del modelo local, que arranca en blanco.
- Con 12/12, las dos citas que fallan son de **recuperación** (`fletar-base` y
  `mcp-direcciones` no entran en el top 5), no de respuesta: el modelo contestó
  bien igual.

Lo que falla y por qué, sin maquillar:

- `timing-attack`: el fragmento traído hablaba de JWT, no del timing attack.
- `opencockpit`: el fragmento era del archivo correcto pero de otra sección; el
  modelo prefirió decir que no sabía antes que inventar.

El primer run dio 58% y estaba mal medido: el scorer castigaba sinónimos
("commits chicos" vs "commits pequeños") y la coma decimal ("0,77" vs "0.77").
Arreglar el medidor —no el modelo— lo llevó a 83%. Los dos fallos que quedan son
reales.

Para sumar modelos pagos alcanza con `OPENAI_API_KEY` y `--modelos
openai:gpt-4o-mini`. La tabla de precios está en `evals/proveedores.js`; un
modelo sin precio se reporta `s/d`, nunca con un número inventado.

También se puede medir con los modelos que ya tenés configurados en OpenCode,
sin otra API key:

```bash
node evals/correr.js --modelos opencode:opencode-go/deepseek-v4.1-flash
```

Usa el CLI con el agente `eval` (sin herramientas) y `--standalone`: el modelo
responde solo con el contexto y no se pone a leer archivos, que arruinaría la
medición. Los tokens se estiman por caracteres porque el CLI no los informa.

El agente se declara una vez en la configuración de OpenCode:

```json
"agent": {
  "eval": {
    "mode": "primary",
    "steps": 1,
    "tools": { "read": false, "bash": false, "grep": false, "glob": false }
  }
}
```

## Harness

Un agente mínimo que usa la memoria: modelo + dos herramientas + tope de pasos.
El modelo responde JSON (`buscar`, `leer`, `responder`) y el bucle ejecuta la
acción y le devuelve el resultado. Es el mismo ciclo que hace un agente grande,
sin framework.

```bash
node harness/chat.js "¿cuál es la prioridad número uno?"
node harness/chat.js --verbose "¿qué pasó con el timing attack?"
```

Devuelve la respuesta, las citas que tocó y cuántos pasos usó. Los tests cubren
el bucle con un modelo de guion: buscar → responder, leer un archivo, no repetir
búsquedas, cortar al llegar al máximo y no romperse si el modelo ignora el
protocolo.

## Decisiones y por qué

**Léxico antes que embeddings.** Para un corpus personal con jerga propia
(`SAC`, `FletAR`, `PostGIS`), BM25 es un baseline fuerte y no requiere GPU, API
key ni un modelo de 500 MB. Además es **explicable**: puedo decir por qué un
fragmento salió primero. El híbrido está implementado y medido (ver arriba): no
le gana en cobertura a este corpus, así que no es el modo por defecto.

**`node:sqlite` en vez de `better-sqlite3`.** Cero dependencias, cero binarios
nativos, cero problemas al instalar en Windows. El costo es exigir Node 22.13+.

**Sin servidor HTTP.** MCP por stdio es lo que esperan los clientes y evita
abrir un puerto. El proceso muere con el cliente.

**Guardar notas con deduplicación.** Si el agente guarda la misma cosa diez
veces, el índice se llena de ruido. El texto se normaliza y se compara por hash:
la segunda vez devuelve la cita original.

## Límites honestos

- **Léxico, con un híbrido opcional.** BM25 no entiende sinónimos: "plata" no
  encuentra "sueldo". El modo híbrido ayuda con frases semánticas, pero medido en
  este corpus empata o pierde cobertura. No hay comprensión del lenguaje, hay
  coincidencia de tokens y, si está configurado, de vectores.
- **Los embeddings necesitan Ollama.** Sin él todo funciona igual en BM25; el
  modo híbrido queda deshabilitado solo.
- **Las evals son 12 preguntas.** Es una muestra para comparar cambios, no un
  benchmark: no sirve para afirmar calidad absoluta de un modelo.
- **El índice es local a la máquina.** No hay sincronización entre dispositivos.
- **No lee PDFs ni imágenes.** Solo texto plano con extensión conocida.
- **Un proceso por cliente.** Cada cliente MCP levanta su propio proceso; la
  base SQLite soporta lecturas concurrentes sin problema.

## Tests

```bash
npm test
```

**132 tests** con `node --test`, sin frameworks ni mocks de red:

- tokenización, acentos, stopwords y saneo de la consulta FTS5;
- chunker: rangos de línea verificados contra el archivo real;
- indexado: incremental, archivos borrados, binarios, gigantes y `test/fixtures`;
- búsqueda: **cada cita se abre y se comprueba que la línea contiene el término**;
- híbrido: fusión RRF, vectores por fragmento, caída limpia a BM25 si el
  proveedor falla y proveedor falso para no depender de la red;
- evals: scoring con sinónimos y decimales, MRR, proveedores (ollama/openai) y
  costo `s/d` cuando no hay precio;
- harness: bucle con modelo de guion, lectura de fragmentos, no repetir
  búsquedas y corte por máximo de pasos;
- protocolo MCP por stdio: handshake, `tools/list`, errores `-32601`/`-32700`,
  notificaciones y bloqueo de rutas fuera del índice;
- CLI: `index`, `search`, `stats`, códigos de salida.

## Roadmap

Esta es la base de una app que crece con los otros ejercicios:

1. **RAG híbrido** (BM25 + vectores) — hecho y medido, ver arriba.
2. **Evals** en tres modelos con tabla de aciertos y costo — hecho para el local;
   falta correr los pagos con `OPENAI_API_KEY`.
3. **Harness** propio con herramientas y modelo — hecho (`harness/chat.js`).
4. **MCP de pedidos**: el mismo patrón aplicado a un dominio de negocio.

## Licencia

MIT. Ver [LICENSE](LICENSE).
