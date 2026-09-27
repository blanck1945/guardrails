# Guardrails — registro de decisiones

Qué decidimos, por qué, y qué descartamos. Complementa a otros documentos:

| Documento | Qué responde |
|---|---|
| `PLAN.md`, `PLAN-DETAILED.md` | Qué queremos construir y en qué fases |
| `guardrails/CHANGELOG.md` | Qué se hizo en cada versión, qué se observó y qué se cambió después |
| `.cursor/handoff/` | El traspaso de cada tarea de Baking (criterios de aceptación) |
| `.cursor/baking/metrics/runs.jsonl` | Ruteo y consumo de cada corrida de Baking |
| **Este archivo** | **Por qué** se tomó cada decisión |

Cómo mantenerlo: cada decisión nueva se agrega al final con el siguiente número `D-NNN`, con fecha, motivo y alternativas descartadas. Una decisión que se revierte no se borra: se marca `Reemplazada por D-NNN` y se agrega la nueva. Estados: **Vigente**, **En curso**, **Planificada**, **Reemplazada**.

---

## Producto y arquitectura

### D-001 — Un servicio externo conectado por webhooks, no algo que corre dentro de GitHub
- **Fecha:** 2026-09-23 · **Estado:** Vigente
- **Decisión:** Guardrails es un servicio que recibe webhooks de una GitHub App, revisa el PR y publica el review por la API. GitHub solo avisa y recibe comentarios.
- **Por qué:** es como funciona Greptile, y permite índice, reglas y aprendizaje compartidos entre PRs.
- **Descartado:** una GitHub Action en el CI del usuario. Más simple de arrancar, pero cada usuario carga su clave del modelo, no hay memoria compartida y se pierde el control del costo. Queda como opción para un piloto.

### D-002 — El núcleo es una librería que no sabe de GitHub
- **Fecha:** 2026-09-23 · **Estado:** Vigente
- **Decisión:** `reviewDiff` y la interfaz `Workspace` no dependen de GitHub. El webhook en la nube y el CLI local son dos envoltorios del mismo núcleo.
- **Por qué:** una sola implementación para la nube, el hook de pre-push y la evaluación. Cualquier mejora del núcleo llega a todos.
- **Consecuencia:** el comando local (`guardrails review`) y el webhook usan exactamente la misma lógica.

### D-003 — Cloud primero, CLI local después; Vercel para el MVP, AWS se decide más adelante
- **Fecha:** 2026-09-23 · **Estado:** Vigente
- **Decisión:** el MVP se despliega en Vercel (decisión del usuario: "vayamos Vercel para MVP y desde ahí vemos").
- **Por qué:** minutos hasta tener una URL, sin armar infraestructura. El núcleo no depende del proveedor, así que migrar a AWS solo cambia el envoltorio.
- **Descartado (por ahora):** AWS/EKS. Da más control y self-hosting, pero son semanas de infraestructura antes de ver un review. Se reevalúa si aparece un cliente que exija self-hosting.

### D-004 — El agente lee un tarball del repo en `/tmp`; no usamos Vercel Sandbox
- **Fecha:** 2026-09-24 · **Estado:** Vigente (v0.6.0)
- **Decisión:** el webhook descarga el repo (base y head) como tarball por la API de GitHub, lo extrae en el disco temporal y corre el agente sobre ese árbol. El `grep` está implementado en JS puro.
- **Por qué:** las funciones de Vercel no traen `git`. Y el agente solo **lee** archivos, no ejecuta código del repo, así que no necesita un sandbox aislado.
- **Alternativas descartadas:** Vercel Sandbox (más infraestructura sin necesidad hoy; se justifica solo si más adelante ejecutamos tests del cliente) y leer archivo por archivo por la API con una sola llamada al modelo (modo `single`, queda como fallback).
- **Límites conocidos:** repos grandes (150 MB extraídos, 20.000 archivos), el tarball se carga en memoria, y no se probó con un fork real.

### D-005 — Reglas en `.guardrails/rules.md`, editables a mano, con estados
- **Fecha:** 2026-09-23 · **Estado:** Vigente
- **Decisión:** un bloque por regla (`## id`, `scope`, `severity`, `type`, `source`, `status`, texto libre). Estados `suggested`, `active`, `disabled`. Solo las `active` se aplican. `guardrails init` nunca pisa lo que escribió el usuario: agrega las nuevas al final como `suggested`.
- **Por qué:** el usuario pidió poder escribir sus reglas, y que el análisis automático no le pise nada. La aprobación explícita evita que una regla mal inferida se aplique sola.

### D-006 — Escalera de contexto: automático → aprendido → explícito → ajuste fino
- **Fecha:** 2026-09-23 · **Estado:** Vigente (los dos primeros niveles parciales)
- **Decisión:** cuanto más contexto tenga la herramienta, menos tiene que escribir el usuario. `init` deriva reglas de `CLAUDE.md`, `AGENTS.md`, configs de lint y TypeScript, CI y estructura. Las reglas que el linter o el CI ya hacen cumplir se descartan como redundantes.
- **Pendiente:** el nivel "aprendido" (desde comentarios de PRs pasados y feedback) y el refresh incremental. Ver D-019.

### D-007 — Reglas y configuración se leen del commit BASE del PR
- **Fecha:** 2026-09-23 · **Estado:** Vigente
- **Decisión:** `.guardrails/config.json` y `rules.md` se leen de `pr.base.sha`, nunca del head.
- **Por qué:** si se leyeran del head, un PR podría debilitar sus propias reglas para pasar la revisión. Si el PR modifica esos archivos, el review lo avisa en el resumen.

### D-008 — Permisos mínimos de la GitHub App y acceso restringido
- **Fecha:** 2026-09-24 · **Estado:** Vigente
- **Decisión:** permisos `contents: read`, `pull_requests: write`, `metadata: read`; evento `pull_request` únicamente; instalable **solo en la cuenta del dueño** y instalada solo en `causas-viewer`. Sin permisos de cuenta ni autorización OAuth de usuarios. Un test compara el manifiesto con lo que el código usa.
- **Por qué:** menos permisos significa menos daño si algo se filtra. Con "Any account" cualquiera podría instalarla y gastar la clave del modelo.
- **Consecuencia:** poner `init` a abrir PRs (D-019) exige `contents: write`, un aumento de permisos que hay que decidir explícitamente.

### D-009 — Deployment Protection apagada; el webhook se protege con su firma
- **Fecha:** 2026-09-24 · **Estado:** Vigente
- **Decisión:** se desactivó Vercel Authentication. El webhook rechaza con `401` todo lo que no venga firmado con el secreto compartido, y `/api/health` no expone configuración.
- **Por qué:** con la protección activa, GitHub recibía un `302` hacia el login de Vercel y ningún review corría. El Root Directory del proyecto es `guardrails/`, porque el repo tiene el proyecto en una subcarpeta.

---

## Modelos y costo

### D-010 — Z.ai (GLM) para probar; Claude reservado para las corridas que deciden calidad
- **Fecha:** 2026-09-24 · **Estado:** Vigente
- **Decisión:** desarrollo y revisión con `zai:glm-5.3` (pedido del usuario: "tiene que correr el modelo 5.3"), `glm-5.3-flash` para `init` y pruebas de mecánica. Un resolvedor acepta `zai:`, `deepseek:` o un id del AI Gateway.
- **Por qué:** el usuario prefirió modelos baratos para probar. El AI Gateway de Vercel exigió tarjeta y luego créditos pagos para cualquier modelo Claude (el nivel gratuito no los incluye), y no se llegó a usar.
- **Aviso:** un modelo barato prueba que la mecánica funciona, no mide la calidad del producto. La decisión go/no-go del riesgo R1 (el agente supera al modo simple) se toma con el modelo de producción.

### D-011 — Control de gasto por diseño
- **Fecha:** 2026-09-24 · **Estado:** Vigente (v0.4.0)
- **Decisión:** `CostTracker` con tope en USD, `--budget-usd`, `--dry-run`, negativa a correr algo estimado en más de $1 sin confirmación, tabla de precios que devuelve `null` si no conoce el modelo (nunca un 0 falso), caché de respuestas para no pagar dos veces la misma llamada en pruebas, y un tope de $0.25 por review en el webhook.
- **Límite conocido:** el costo es una **estimación** desde los tokens reportados. GLM reporta `reasoningTokens: 0` aunque razona, así que puede estar subestimado. La verdad está en el panel de Z.ai.

### D-012 — Z.ai: JSON por prompt y razonamiento reducido
- **Fecha:** 2026-09-24 · **Estado:** Vigente
- **Decisión:** no enviar `response_format: json_object` a Z.ai y pedir el JSON por prompt con un ejemplo. `glm-5.3` corre con `reasoning_effort: low`; los otros modelos Z.ai sin razonamiento. `GUARDRAILS_THINKING=1` lo revierte.
- **Por qué:** con el modo JSON, Z.ai **borra el token `json`** de la salida (`seeds.config.json` salía como `seeds.config.`). Y con el razonamiento por defecto, `init` tardaba varios minutos.
- **Costo de la decisión:** puede bajar algo la calidad del review.

---

## Calidad del review

### D-013 — Un hallazgo que cita una regla activa no se filtra por tipo; un `ruleId` inventado se quita, no se descarta el hallazgo
- **Fecha:** 2026-09-24 · **Estado:** Vigente (v0.4.0)
- **Decisión:** el filtro de tipos (`commentTypes`) solo se aplica a hallazgos sin regla. Si el modelo cita un `ruleId` que no existe, se le quita el id y el hallazgo se conserva.
- **Por qué:** dos fallos reales. Una violación de `english-only` se descartaba por ser tipo `style`, y con `glm-5.3` dos bugs reales se perdían porque el modelo les ponía un `ruleId` inventado. Esto **reemplaza** la decisión inicial del agente de B32, que descartaba el hallazgo entero.

### D-014 — Verificar afirmaciones de ausencia y limitar el ruido
- **Fecha:** 2026-09-24 · **Estado:** Vigente (v0.5.1)
- **Decisión:** si un hallazgo afirma que falta un archivo o test y ese archivo existe, se descarta con el motivo `contradicted-by-repo`. Máximo 2 hallazgos por línea, un tope por review según la severidad configurada (los de reglas `high` no se recortan), y el tipo del hallazgo lo decide la regla.
- **Por qué:** en una prueba, el modelo afirmó que no existía `CaseFilters.test.tsx`, y sí existía. Un solo falso positivo así hace que un equipo deje de confiar.

### D-015 — Más determinismo: chequeos mecánicos, temperatura 0, pasada exhaustiva por regla
- **Fecha:** 2026-09-24 · **Estado:** Vigente (v0.6.1 y v0.7.1, commiteados; sin subir a producción)
- **Decisión:** un campo `check:` por regla (`max-lines`, `colocated-test`, `forbid-import`, `forbid-pattern`) que se comprueba con código, sin modelo; `temperature: 0` por defecto; y una pasada por regla que exige veredicto y todas las ubicaciones.
- **Por qué:** en los 6 PRs de prueba el modelo encontró 6 de 7 problemas sembrados, con 0 falsos positivos. Se le escapó un comentario en español: reportó una ubicación de la regla y se detuvo tras 2 pasos. Reproducido en local con `dropped` vacío: omisión del modelo, no del filtro. Además el código no fijaba la temperatura, por eso había variación entre corridas.
- **Diseño elegido:** los chequeos corren siempre, aunque el modelo falle o se agote el presupuesto, y no se le piden de nuevo al modelo.

### D-016 — Modos de revisión por PR: `basic`, `standard`, `deep`
- **Fecha:** 2026-09-24 · **Estado:** Vigente (v0.7.0, commiteado; sin subir a producción)
- **Decisión (pedido del usuario):** el usuario elige la profundidad por PR. Prioridad: `--mode` del CLI, etiqueta `guardrails:*`, línea `guardrails-mode:` en la descripción, reglas automáticas en la config (por tamaño o rutas), y por último `standard`. Poner o quitar una etiqueta `guardrails:*` re-dispara el review. `prOverride: "none"` en la config impide que el autor del PR relaje su propia revisión.
- **Valores iniciales:** `basic` 4 pasos y $0.05; `standard` 12 pasos y $0.25; `deep` 24 pasos, $0.75, 2 pasadas en paralelo y veredicto por regla obligatorio.
- **Riesgo aceptado:** por defecto las etiquetas valen, así que el autor de un PR puede bajar el modo de su propio PR. Se documenta y se mitiga con `prOverride`.

### D-022 — Un chequeo mecánico parcial no silencia al modelo (cobertura exhaustiva o parcial)
- **Fecha:** 2026-09-25 · **Estado:** Vigente (v0.7.1)
- **Decisión:** los chequeos tienen una cobertura. `max-lines` y `colocated-test` son **exhaustivos**: deciden la regla entera y al modelo se le dice que la salte. `forbid-import` y `forbid-pattern` son **parciales**: al modelo se le muestran las ubicaciones que el chequeo ya encontró, no las repite, y sigue buscando lo que el chequeo no puede ver. Un campo opcional `check-coverage: exhaustive | partial` en `rules.md` permite cambiar el valor por defecto.
- **Por qué:** la v0.6.1 asumió que un chequeo cubre toda su regla. Un patrón de caracteres acentuados no ve el texto en español sin acentos, y `<h2>Recordatorios</h2>` dejó de detectarse en todos los modos (lo encontraba la v0.6.0). Verificado con el modelo real: con el cambio vuelve a detectarse (confianza 0.95), y la rama limpia sigue sin hallazgos.
- **Descartado:** mejorar la expresión regular de acentos (no cubre el español sin acentos en general) y volver a que el modelo revise todas las reglas ignorando los chequeos (pierde el determinismo de D-015).
- **Consecuencia:** las reglas parciales vuelven al prompt del modelo, así que cuestan algo más ($0.018 contra $0.007 a $0.012 en `case-reminders`; dos corridas, no hay tendencia).
- **Decidido por:** el orquestador, tras la medición B45; nació de un error propio del diseño anterior.
### D-025 — Unir los hallazgos de las dos pasadas de `deep` por significado, no por distancia de líneas
- **Fecha:** 2026-09-25 · **Estado:** Vigente (v0.7.2)
- **Decisión:** dos hallazgos de pasadas distintas son el mismo problema si comparten archivo y regla (o, sin regla, un título parecido), sin importar cuántas líneas los separen. Se unen en un solo comentario con la mayor severidad y la mayor confianza (+0.1 si lo vieron ambas), y con una línea "Also at…" con las otras ubicaciones. Solo se une entre pasadas y de a uno.
- **Por qué:** la prueba en producción de `guardrails:deep` dejó 6 comentarios para 3 problemas: las dos pasadas apuntaron al mismo problema con 7 líneas de diferencia y la ventana de 3 líneas no los unió.
- **Descartado:** ensanchar la ventana de líneas (uniría problemas distintos cercanos) y quitar la segunda pasada (pierde el recall que aporta `deep`).
- **Consecuencia:** la unión depende de los identificadores de regla y de los títulos que produzcan las pasadas: un hallazgo sin regla y con títulos muy distintos seguiría duplicado.
- **Decidido por:** el orquestador, a partir de la medición en producción.

### D-026 — El ancla del comentario respeta los rangos de evidencia del modelo
- **Fecha:** 2026-09-25 · **Estado:** Vigente (v0.7.3)
- **Decisión:** para elegir la línea de un comentario, primero cuentan los rangos de evidencia que el modelo dio para ese archivo. Una coincidencia de texto solo vale dentro de un rango; si el modelo ya dio una línea válida dentro del rango, se conserva; y al unir duplicados se prefiere el ancla que cae dentro de la evidencia. El texto "Also at…" lista como máximo 6 ubicaciones.
- **Por qué:** en la verificación de la v0.7.2, 1 ancla de 6 cayó en la línea 9 (un campo de una interfaz) porque el anclaje por texto coincidió con un fragmento de un identificador e ignoró el rango de evidencia 21 a 33. Con el cambio, 9 de 9 anclas correctas.
- **Descartado:** confiar solo en el número de línea del modelo (era impreciso en producción) y anclar solo por coincidencia de texto (el error que se corrigió).
- **Consecuencia:** si el modelo da un rango equivocado, el ancla lo sigue. Las ubicaciones extra de "Also at" todavía no se validan (anotado para la v0.7.4).
- **Decidido por:** el orquestador, a partir de la verificación de la v0.7.2.
### D-042 — Un hallazgo del modelo de la misma regla y archivo que uno de chequeo se une al del chequeo
- **Fecha:** 2026-09-27 · **Estado:** Vigente (v0.8.1)
- **Decisión:** para una regla que ya tiene un hallazgo de chequeo en un archivo, cualquier hallazgo del modelo de la misma regla y archivo se une a ese comentario como "Also at línea N", sin importar la distancia. El comentario del chequeo no cambia de severidad, confianza ni ancla. Un hallazgo del modelo sin identificador de regla se publica aparte. Extiende D-025 (unión entre pasadas) a la unión entre chequeo y modelo.
- **Por qué:** en producción, el PR de prueba recibió 5 comentarios para 3 problemas: el modelo repitió la violación de arquitectura en la línea 5 y el chequeo la había marcado en la línea 1. El filtro que existía solo cubría 3 líneas de distancia.
- **Descartado:** ensanchar la ventana de líneas (resultado impredecible) y no hacer nada (ruido visible en el PR).
- **Consecuencia (costo aceptado):** si un chequeo y el modelo encuentran dos violaciones distintas de la misma regla en el mismo archivo, la segunda queda reducida a una línea de ubicación, sin su texto. Esto debilita en ese caso lo que D-022 prometía (que el modelo siga reportando lo que un chequeo parcial no ve). Alternativa a evaluar si molesta: unir solo cuando el modelo coincide en el texto o en la línea usada.
- **Decidido por:** el usuario pidió arreglar el duplicado; el diseño lo eligió el orquestador.
### D-043 — Idioma configurable de los comentarios de revisión
- **Fecha:** 2026-09-27 · **Estado:** Vigente (v0.8.2)
- **Decisión:** `language: "en" | "es"` en `.guardrails/config.json` (por defecto inglés, leído de la rama base) y `--language` en el CLI. Los textos que genera el código (chequeos, resumen, cobertura, avisos) se traducen con una plantilla propia por idioma; a Z.ai se le agrega una sola instrucción en el prompt para que el modelo escriba en ese idioma. Código, identificadores, rutas y las palabras `check`/`model` nunca se traducen. En inglés los prompts quedan idénticos byte a byte.
- **Por qué:** el usuario pidió que fuera configurable, no fijo en un idioma.
- **Verificado con modelo real:** el modelo escribió su propio hallazgo en español, citando el código sin traducirlo.
- **Decidido por:** el usuario.

### D-044 — Títulos de chequeo con acción concreta
- **Fecha:** 2026-09-27 · **Estado:** Vigente (v0.8.2)
- **Decisión:** cada título de chequeo dice qué está mal en palabras simples ("Missing test file: …", "Forbidden import: …") y el cuerpo termina con la acción a tomar ("Add …", "Remove or replace this import", "Split the file"). Antes eran frases nominales con jerga interna ("No colocated test for …").
- **Por qué:** el usuario señaló que el título viejo era poco claro. Le gustó la redacción nueva.
- **Decidido por:** el usuario.
---

## Validación y proceso

### D-017 — Validar con PRs reales de una app de prueba, con clave de respuestas oculta
- **Fecha:** 2026-09-24 · **Estado:** Vigente
- **Decisión:** una app de prueba (`causas`, React + TypeScript, gestión de causas de un estudio jurídico) con 7 reglas en `CLAUDE.md`, y 6 PRs: 2 limpios, 2 con violaciones escondidas, 1 con un bug de lógica y 1 grande con un archivo de más de 150 líneas. La clave de respuestas vive fuera del repo y se comparó **después** de leer los reviews.
- **Regla de idioma del repo de prueba:** el código va en inglés y los textos de interfaz en español, centralizados en `src/i18n/es.ts`. Es una prueba deliberada de que distinga español permitido de español prohibido.
- **Resultado:** 6 de 7 encontrados, 0 falsos positivos. Una sola corrida por PR: no es una tasa de precisión.

### D-018 — Baking es obligatorio en este repo; hay una bitácora de versiones y este registro
- **Fecha:** 2026-09-24 · **Estado:** Vigente
- **Decisión:** `baking require on` (marca en `.cursor/baking/required.json`). Toda implementación pasa por Baking con handoff y cierre con métricas; las preguntas no. Cada lote de cambios actualiza `CHANGELOG.md` con la cadena *qué hicimos → qué observamos → siguiente*, y cada decisión se registra aquí.
- **Reconocido:** hasta esta fecha los agentes se usaron directamente, sin handoff ni métricas, y no se cumplía el cierre del skill. Corrección: registro retroactivo y ciclo completo de ahora en adelante.
- **Decisión relacionada:** las tareas con decisiones de diseño reales empiezan con `planner-hyper`. El resto va directo al `executor`.

### D-021 — Proponer el registro de decisiones como artefacto propio de Baking
- **Fecha:** 2026-09-24 · **Estado:** Planificada (propuesta escrita, no implementada en Baking)
- **Decisión (pedido del usuario):** documentar cómo y por qué se armó este archivo, para incorporarlo a Baking con este repo como ejemplo. La guía está en `docs/decision-log-for-baking.md`.
- **Por qué:** Baking guarda handoffs (qué hacer), métricas (ruteo y costo) y una memoria global suelta, pero nada guarda el porqué de una decisión. Un planner nuevo termina reabriendo decisiones ya cerradas.
- **Descartado:** dejarlo solo en la memoria global de Baking (`baking memory`), que es texto suelto sin estado ni referencias cruzadas.
- **Decidido por:** el usuario pidió el documento; el diseño del formato lo propuso el orquestador.
- **Debilidades reconocidas del ejemplo:** se escribió de forma retroactiva, con algunos motivos inferidos; la numeración sigue temas y no el tiempo; y no hay un chequeo automático (ya se coló un error de referencia cruzada, D-018 en vez de D-019).

### D-023 — No se sube a producción una versión cuya corrección no se verificó con un modelo real
- **Fecha:** 2026-09-25 · **Estado:** Vigente
- **Decisión:** puerta de publicación. Antes de subir a `master` (Vercel redeploya solo), toda versión con cambios de comportamiento pasa: `pnpm check` y `pnpm build` verdes, escaneo de secretos, y una verificación real con tope de gasto sobre casos conocidos (uno con el problema y uno limpio). Si esa verificación no puede correr, se documenta y se decide explícitamente; no se sube por omisión.
- **Por qué:** la v0.7.0 tenía una regresión (D-022) que solo apareció al medir con el modelo real. Con la puerta, no llegó a producción.
- **Descartado:** commitear y subir la corrección sin la prueba real y anotarla como pendiente.
- **Nota sobre permisos:** el clasificador de permisos de Claude Code bloqueó dos veces a un subagente al clonar y correr el CLI sobre un repo externo. No se rodeó el bloqueo: el usuario autorizó la ejecución de forma explícita y quedó registrado.
- **Decidido por:** propuesta del planner de Baking, aceptada por el usuario al pedir que se hiciera la verificación.
### D-024 — Baking para todo el trabajo de implementación, en este repo y en los demás
- **Fecha:** 2026-09-25 · **Estado:** Vigente
- **Decisión (pedido del usuario: "quiero baking para todo"):** además de `baking require on` en este repo (D-018), se activó `baking auto-route on`, el comportamiento por defecto en todos los repos. Toda implementación, incluida la de documentos, se clasifica y pasa por Baking. Solo las preguntas, explicaciones y revisiones sin cambio de código salen del flujo (gate-out).
- **Por qué:** el protocolo se siguió a medias mientras no era obligatorio, y la corrida más cara (B42 a B45, unos 304 mil tokens) fue justo la que arrancó sin handoff. Con el modo obligatorio, las tareas con handoff previo fueron más acotadas.
- **Sin cambios:** la configuración de consumo se mantiene: handoff obligatorio, máximo 2 subagentes en paralelo, y las tareas triviales de 12 palabras o menos se resuelven sin planner.
- **Reversible:** `baking auto-route off` desactiva el modo global sin tocar el modo obligatorio de cada repo.
- **Pendiente:** el aviso de Baking indica que la regla del router de Cursor (`~/.cursor/rules/baking-router.mdc`) puede requerir `baking install` para actualizarse. No se ejecutó, porque sobrescribe skills y agentes globales.
- **Decidido por:** el usuario.
---

## Planificadas

### D-019 — `init` al instalar la App, refresh incremental y aprendizaje desde feedback (B37 a B39)
- **Estado:** Reemplazada en parte por D-032, D-037, D-038 y D-039. Antes: requiere plan previo con `planner-hyper`
- **Ideas acordadas:** `init` corre una sola vez por repo (es lento y caro). Después, un refresh incremental que solo procesa las fuentes que cambiaron (con un archivo de hashes) y propone reglas nuevas como `suggested`, sin tocar lo que el usuario escribió. Más adelante, reglas propuestas desde el historial de reviews (aceptados y rechazados).
- **Decisiones abiertas:** dónde guardar el estado (archivo en el repo o base de datos); si `init` abre un PR (exige `contents: write`, ver D-008) o comenta las reglas propuestas en un issue; qué hacer con reglas obsoletas cuando se borra su fuente.

### D-020 — Eficiencia del consumo
- **Estado:** Reemplazada en parte por D-033. Antes: pedido del usuario ("el consumo de Z es grande")
- **Ideas:** modelo más barato por modo (`glm-5.3-flash` para `basic`), re-revisión incremental en cada push, menos contexto por llamada y prefijo de prompt ordenado para aprovechar la caché, saltar diffs triviales, tope de gasto diario y costo visible por review.
- **Prerrequisito:** los números reales del panel de Z.ai, para calibrar cuánto se subestima el costo.

### D-027 — Cobertura visible en cada revisión
- **Fecha:** 2026-09-26 · **Estado:** Planificada (v0.8.0)
- **Decisión:** cada revisión muestra una línea de cobertura (máximo 220 caracteres) y un bloque plegado con el detalle: archivos revisados, omitidos o demasiado grandes; reglas en alcance, verificadas por código o por el modelo; y por qué una revisión quedó incompleta. Lo que garantiza un chequeo y lo que solo afirma el modelo se rotulan por separado.
- **Por qué:** el usuario preguntó si se puede ver el nivel de cobertura. Los datos ya existen dentro del sistema (por ejemplo `ruleChecks` de `deep`) y hoy no se muestran. La cobertura mide qué se miró, no si se miró bien.
- **Decidido por:** el usuario (Q1: sí).

### D-028 — El presupuesto de diff del modelo empaqueta archivos completos y declara los que no entran
- **Fecha:** 2026-09-26 · **Estado:** Planificada (v0.8.0)
- **Decisión:** en vez de cortar el diff a los 200.000 caracteres a mitad de un archivo, se incluyen archivos completos, se declaran los que no entran y los chequeos mecánicos corren sobre el diff completo.
- **Por qué:** verificado en `review-pr.ts`: el modelo recibe el diff cortado sin aviso, mientras los chequeos ven el completo, y el aviso de "diff demasiado grande" nunca se dispara. Sin esto, cualquier afirmación de cobertura sería falsa.
- **Decidido por:** el orquestador, a partir del plan.

### D-029 — Registro de cada revisión: marcador oculto y firmado en el resumen del PR
- **Fecha:** 2026-09-26 · **Estado:** Planificada (v0.9.0)
- **Decisión:** cada revisión termina con un registro (solo metadatos) en un marcador oculto y firmado dentro del comentario resumen. El propio PR es el primer almacén, y el mismo registro sirve de estado para la revisión incremental. La firma usa `GUARDRAILS_RECORD_KEY` y `GITHUB_APP_SLUG=guardrails-boogiepop`, a cargar en Vercel y en `.env.local`.
- **Por qué:** cero infraestructura y neutral respecto del proveedor; permite entregar valor antes de tener base de datos.
- **Decidido por:** el usuario (Q6: sí).

### D-030 — Solo se guardan metadatos: nunca código, diffs, títulos, cuerpos ni usuarios
- **Fecha:** 2026-09-26 · **Estado:** Planificada (v0.9.0)
- **Decisión:** el registro guarda rutas de archivos e identificadores de reglas, nunca contenido.
- **Por qué:** privacidad (PLAN-DETAILED §8); el contenido se queda en GitHub.
- **Decidido por:** el usuario (Q3: sí).

### D-031 — Informe consolidado: primero un comando de línea, en Markdown y CSV, para el dueño del repo
- **Fecha:** 2026-09-26 · **Estado:** Planificada (v0.9.0)
- **Decisión:** `guardrails report` genera un Markdown y un CSV a partir de los registros y de las reacciones y hilos leídos en vivo. Es solo para el dueño del repo por ahora y puede usar su token de lectura de GitHub (`gh auth token`), solo lectura. Un panel con historial va después.
- **Por qué:** valor antes de tener base de datos, hosting o permisos nuevos.
- **Decidido por:** el usuario (Q4 y Q5: sí).

### D-032 — Revisión incremental desde el último marcador de confianza
- **Fecha:** 2026-09-26 · **Estado:** Planificada (v0.10.0)
- **Decisión:** en cada push solo se revisa lo nuevo desde el último marcador confiable. Se hace revisión completa ante force-push, cambio de base, de reglas o de modo, y siempre en `deep`.
- **Por qué:** ahorra consumo y resuelve la pregunta de dónde vive el estado incremental sin base de datos.
- **Decidido por:** el orquestador, a partir del plan; el usuario no tenía preferencia y aceptó el valor por defecto.

### D-033 — Orden de las mejoras de eficiencia; el gasto se mide con el saldo prepago
- **Fecha:** 2026-09-26 · **Estado:** Planificada (v0.9.0 a v0.10.0)
- **Decisión:** saltar el modelo en diffs triviales, `glm-5.3-flash` para `basic`, costo visible por defecto, revisión incremental, orden del prefijo del prompt, y el tope diario recién cuando exista base de datos. El gasto se calibra leyendo el saldo prepago de Z.ai antes y después de cada tanda de pruebas.
- **Por qué:** mayor ahorro por esfuerzo primero; nuestro costo es una estimación (D-011).
- **Pendiente:** el valor del tope diario (Q10) se define cuando se sepa cómo se cobra el producto.
- **Decidido por:** el usuario aceptó leer el saldo (Q11).

### D-034 — GitLab queda aplazado: por ahora solo GitHub
- **Fecha:** 2026-09-26 · **Estado:** Aplazada
- **Decisión (usuario):** de momento solo soporte para GitHub. El diseño por adaptadores del plan (webhook, discusiones y archivo de la API de GitLab, token con alcance `api` y rol Reporter) se conserva como referencia, sin fecha.
- **Por qué:** el núcleo es independiente del proveedor (D-002), así que agregarlo después es un adaptador y no obliga a decidir ahora.
- **Decidido por:** el usuario (Q7).

### D-035 — `TarballWorkspace` recibe una función de descarga en vez de un cliente de Octokit
- **Fecha:** 2026-09-26 · **Estado:** Planificada
- **Decisión:** el espacio de trabajo del núcleo deja de depender de Octokit.
- **Por qué:** corrige una fuga de GitHub dentro del núcleo (D-002). Deja de ser urgente con GitLab aplazado, pero sigue siendo higiene de diseño.
- **Decidido por:** el orquestador.

### D-036 — Base de datos diferida hasta que haya un disparador; candidato preferido: Turso
- **Fecha:** 2026-09-26 · **Estado:** Planificada
- **Decisión:** no se agrega base de datos hasta que ocurra un disparador: un segundo repo, el tope diario de gasto, aprender del feedback o un informe que tarde más de 60 segundos. Cuando llegue, el usuario prefiere **Turso** (SQLite en la nube, libSQL) frente a Neon con Postgres.
- **Por qué:** nada de lo planificado hasta la v0.10.0 la necesita, y Turso es más liviana. Reemplaza en parte lo de `PLAN-DETAILED.md` §2, que asumía Neon con `pgvector`.
- **A verificar al momento de usarla:** soporte de Drizzle con libSQL en las funciones de Vercel, y búsqueda vectorial de Turso si se retoma el filtro por embeddings del feedback.
- **Decidido por:** el usuario (Q9: propuso Turso; queda como candidata).

### D-037 — `init` corre en la primera revisión de un repo sin reglas y publica una propuesta plegada
- **Fecha:** 2026-09-26 · **Estado:** Planificada
- **Decisión:** no se ejecuta al instalar la App: en la primera revisión de un repo sin `rules.md`, se publica la propuesta de reglas como un bloque plegado en el resumen. Sin permisos nuevos.
- **Por qué:** al instalar no hay dónde comentar sin el permiso `issues: write`. Reemplaza en parte a D-019.
- **Decidido por:** el usuario aceptó "comentar, sin aumentar permisos".

### D-038 — Las reglas se actualizan por hashes de sus fuentes, guardados en el preámbulo de `rules.md`
- **Fecha:** 2026-09-26 · **Estado:** Planificada
- **Decisión:** solo hay propuestas en los PRs que cambian las fuentes; las reglas obsoletas se marcan y nunca se borran.
- **Por qué:** sin permiso de escritura, sin llamar al modelo si nada cambió y respetando D-005.
- **Decidido por:** el orquestador, a partir del plan.

### D-039 — Aprender del feedback con sugerencias a nivel de regla, nunca automáticas
- **Fecha:** 2026-09-26 · **Estado:** Planificada (con la base de datos)
- **Decisión:** una sugerencia aparece con umbrales explícitos (por ejemplo, al menos 3 rechazos en al menos 2 PRs y 90 días). El filtro por embeddings del feedback queda para más adelante.
- **Por qué:** es explicable y seguro.
- **Decidido por:** el orquestador, a partir del plan.

### D-040 — Modelos: GLM-5.3 para pruebas; el techo para producción es de clase Sonnet
- **Fecha:** 2026-09-26 · **Estado:** Vigente
- **Decisión (usuario):** de momento se sigue con `glm-5.3`, solo para pruebas; para producción no usaría un modelo por encima de la clase Sonnet. `glm-5.3-flash` se acepta para el modo `basic` si encuentra los mismos problemas sembrados.
- **Por qué:** costo. Con los precios verificados el 2026-09-24, Sonnet 5 cuesta $2 de entrada y $10 de salida por millón de tokens, contra $1.40 y $4.40 de `glm-5.3`: la diferencia es de 1,4 a 2,3 veces, no de un orden de magnitud.
- **Consecuencia:** la decisión formal de si el agente supera al modo simple (riesgo R1) queda para cuando se pruebe con un modelo de clase Sonnet.
- **Decidido por:** el usuario (Q12).

### D-041 — Los hallazgos de baja confianza de `deep` van a una sección plegada, no como comentarios en línea
- **Fecha:** 2026-09-26 · **Estado:** Planificada (v0.8.0)
- **Decisión:** en `deep`, un hallazgo de confianza menor a 0.6 sin regla asociada se muestra en el bloque plegado de detalle y no como comentario en el código. El umbral de recolección de `deep` se mantiene en 0.4.
- **Por qué:** los dos hallazgos extra del caso del CSV ("la exportación ignora los filtros activos", confianza 0.6, y "serializa el estado en inglés con encabezados en español", 0.4) son observaciones razonables pero no violan una regla ni son bugs claros. Como comentario en línea serían ruido; en un bloque plegado conservan el recall de `deep` sin ensuciar el PR.
- **Decidido por:** el orquestador (el usuario delegó la decisión, Q2).

---

## Apéndice: consumo de los agentes de Baking en esta sesión

Tokens totales que reportó cada subagente (no incluyen lo que gasta el modelo de la propia herramienta, que se paga en Z.ai).

| Tarea | Agente | Tokens | Duración |
|---|---|---|---|
| Plan detallado | planner-hyper | 119.850 | 13 min |
| B01–B02 git y vitest | executor-mecanic | 45.712 | 4 min |
| B03, B04, B05, B08 | executor | 74.692 | 5 min |
| B06, B09 | executor | 63.964 | 6 min |
| B07, B10 | executor | 130.442 | 11 min |
| B12, B13 | executor | 129.566 | 14 min |
| B30–B32 reglas, init, review | executor | 118.038 | 10 min |
| B33 modelos y gasto | executor | 139.061 | 15 min |
| B34–B36 CLI, App, deploy | executor | 177.134 | 19 min |
| F1–F3 arreglos | executor | 151.384 | 32 min |
| B40 ruido y grounding | executor | 102.928 | 10 min |
| B41 agente en la nube | executor | 151.719 | 15 min |
| **Total** | | **~1,40 M** | |

Observación: el límite de sesión que cortó la tarea B42 fue de **Anthropic** (los subagentes), no de Z.ai. El gasto de los subagentes es la parte grande del consumo de esta sesión. La eficiencia de D-020 aborda el gasto de Z.ai; el de los subagentes se reduce con handoffs claros y menos tareas largas.
