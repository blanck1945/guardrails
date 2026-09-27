# Guardrails — tablero de resultados

Qué salió bien y qué salió mal en **todas** las mediciones hechas hasta la v0.7.1, en un solo lugar. Es un resumen: el detalle de cada versión está en `guardrails/CHANGELOG.md` (sección *What we observed*), y el porqué de cada decisión en `DECISIONS.md`.

Actualizado: 2026-09-27 (producción en la v0.8.0).

---

## 1. Veredicto en una tabla

| Dimensión | Estado | Evidencia resumida |
|---|---|---|
| Detectar violaciones de reglas claras | ✅ Bien | 6 de 6 en los escenarios locales; 6 de 7 ubicaciones en la nube (v0.6.0); 3 de 3 en la última prueba en producción |
| Detectar un bug de lógica sin regla | ✅ Bien, pero con **un solo caso** | El comparador que ordena mal las causas sin plazo: 4 de 4 corridas lo encontraron |
| No inventar problemas en PRs limpios | ✅ Bien | 0 hallazgos en 9 corridas sobre PRs limpios |
| Ruido en PRs con problemas | ✅ Mejoró | Un falso positivo real (corregido) y los **duplicados de `deep` resueltos en la v0.7.2** (3 comentarios para 3 problemas, antes 6). Sin juzgar: hallazgos extra de baja confianza de `deep` en corridas anteriores |
| Precisión de la línea del comentario | ✅ Bien, con un caso a dos líneas | 9 de 9 anclas en la v0.7.3; en la v0.7.4, 5 de 6 en `deep` (una quedó dos líneas arriba porque el modelo dio un rango equivocado) y 2 de 2 en CSV |
| Repetibilidad (mismo resultado dos veces) | ⚠️ Parcial | Los chequeos mecánicos son idénticos entre corridas; los hallazgos del modelo cambian de línea, severidad y confianza |
| Costo | ✅ Bajo, con dudas | Unos $0.004 a $0.018 por review estándar, $0.03 a $0.05 en `deep`. **Son estimaciones**, no lo que factura Z.ai |
| Velocidad | ✅ Aceptable | 13 a 63 s por review; 50 s de la etiqueta a la revisión en producción |
| Robustez operativa | ✅ Con incidentes resueltos | Ver sección 4 |
| Calidad con un modelo de producción real (Claude) | ❓ **Sin medir** | Todo se midió con GLM |
| Bugs reales de repos reales | ❓ **Sin medir** | La Fase 0 con casos reales (B11 a B17) sigue pendiente |

---

## 2. Cada medición

### M1 — Escenarios locales, 7 cambios de una línea (v0.4.x, después v0.5.1)
Repo de prueba de gestión de causas. Una rama por escenario.

| Escenario | Esperado | Resultado |
|---|---|---|
| Renombrar una constante | 0 hallazgos | ✅ 0 |
| Comentario en español en el código | marcarlo | ✅ |
| Texto de interfaz escrito directo en un componente | marcarlo | ✅ |
| Texto nuevo en español dentro de `es.ts` | **no** marcarlo | ✅ 0 |
| Un componente usa `localStorage` | marcarlo | ✅, pero **4 hallazgos y 1 falso positivo** (dijo que faltaba un test que sí existía) |
| Lógica de días hábiles dentro de un hook | marcarlo | ✅ (más 1 hallazgo genérico extra) |
| Componente nuevo sin test | marcarlo | ✅ |

Tras la versión 0.5.1: el caso del `localStorage` bajó de 4 a 1 hallazgo, el falso positivo desapareció y el tipo del hallazgo pasó a ser coherente con la regla. Costo de toda la ronda: unos $0.036.

### M2 — La nube, 6 PRs sembrados (v0.6.0, una corrida cada uno)
| PR | Contenido | Resultado |
|---|---|---|
| Clientes | limpio | ✅ 0 hallazgos |
| Plazos próximos | limpio | ✅ 0 hallazgos |
| Exportar CSV | 2 problemas | ✅ 2 de 2 |
| Recordatorios | 3 ubicaciones de 2 problemas | ⚠️ **2 de 3**: no vio el comentario en español |
| Ordenar por plazo | 1 bug de lógica | ✅ encontrado y explicado |
| Notas y checklist | 1 archivo de 156 líneas | ✅ encontrado |

Total: **6 de 7 ubicaciones sembradas, 0 falsos positivos, 0 hallazgos extra.** El fallo fue una omisión del modelo (`dropped` vacío al reproducirlo), no de nuestro filtro.

### M3 — Re-medición local de la v0.7.0 (15 corridas, $0.275)
- **Limpios** (modos `basic` y `standard`): 0 hallazgos en las 4 corridas ✅
- **Comentario en español:** detectado por el chequeo mecánico en todas las corridas ✅, siempre idéntico entre corridas
- **Bug del comparador:** detectado en `standard` (2 de 2) y en `deep` ✅
- ❌ **Regresión:** el encabezado en español sin acentos (`Recordatorios`) dejó de detectarse **en todos los modos**. La causa fue una decisión de diseño propia: se asumió que un chequeo cubre toda su regla.
- ⚠️ `deep` costó 3 a 4 veces más que `standard` y agregó 5 hallazgos de baja confianza que no se juzgaron.

### M4 — Verificación de la corrección v0.7.1 (local, $0.029)
- `case-reminders`: **3 hallazgos**, incluido el encabezado `Recordatorios` ✅ (lo reporta el modelo; el comentario, el chequeo)
- `clients-page` (limpio): **0 hallazgos** ✅

### M5 — Producción v0.7.1, modo `deep` por etiqueta (PR de recordatorios)
- ✅ La etiqueta `guardrails:deep` disparó una revisión nueva en 50 s, y el resumen indicó el modo y su origen
- ✅ Encontró los 3 problemas sembrados (todos por el modelo, porque el `rules.md` de producción no tiene líneas `check:`)
- ❌ **6 comentarios para 3 problemas:** dos problemas salieron duplicados, porque las dos pasadas de `deep` apuntaron a líneas distintas (7 de diferencia) y el filtro de duplicados solo mira 3
- ⚠️ Ningún ancla cayó en la línea real
- ⚠️ El resumen mostraba las notas internas del modelo

### M7 — Verificación de la v0.7.2 en modo `deep` (local, 3 corridas)
| Corrida | Resultado | Costo | Tiempo |
|---|---|---|---|
| Recordatorios 1 | 3 comentarios para 3 problemas, 2 duplicados unidos, anclas correctas | $0.043 | 39 s |
| Recordatorios 2 | 3 comentarios para 3 problemas, 2 duplicados unidos, **1 ancla en una línea ajena** (línea 9 en vez de la 21) | $0.029 | 38 s |
| Clientes (limpio) | 0 hallazgos | $0.036 | 34 s |

- ✅ **Un problema, un comentario:** en producción, el mismo PR había recibido 6 comentarios. Sin hallazgos extra de baja confianza en estas corridas.
- ⚠️ **Ancla incorrecta:** el anclaje por texto citado coincidió con un fragmento de un identificador en una línea de la interfaz, e ignoró los rangos de evidencia que dio el propio modelo. Está anotado para la v0.7.3.
- El costo de `deep` en un PR chico quedó entre $0.029 y $0.043, dentro de lo estimado. Son 3 corridas: no es un rango.

### M8 — Verificación de la v0.7.3 en modo `deep` (local, 5 corridas, $0.144)
| Corrida | Resultado | Costo |
|---|---|---|
| Recordatorios 1, 2 y 3 | 3 comentarios para 3 problemas en cada una, sin duplicados, **9 de 9 anclas correctas** | $0.022 a $0.025 |
| Exportar CSV | Los 2 problemas por chequeo, en su lugar; más 2 hallazgos extra de baja confianza sin juzgar | $0.040 |
| Clientes (limpio) | 0 hallazgos | $0.034 |

- ✅ El defecto de la línea ajena (línea 9 en vez de la 21) no reapareció: el anclaje ahora respeta los rangos de evidencia del modelo.
- ✅ Un hallazgo del modelo que repetía el comentario ya detectado por el chequeo se descartó como duplicado.
- ⚠️ En una corrida, el texto "Also at line 10" del encabezado apunta a una línea que no es el encabezado: las ubicaciones extra no se validan.
- ⚠️ `deep` sigue agregando hallazgos extra de baja confianza (2 en CSV) que no estaban sembrados. No se sabe si son ruido o algo útil.

### M9 — Chequeos mecánicos en producción (v0.7.3, 2026-09-26)
| Paso | Resultado |
|---|---|
| PR #8: agrega las líneas `check:` a 4 reglas | ✅ Sin hallazgos; la App avisó que usó las reglas de la rama base |
| PR #9: un componente que importa el repositorio, sin test y con un comentario en español | ✅ 3 comentarios en 36 s: 2 por chequeo (import prohibido y test faltante), 1 por el modelo (el comentario) |

- ✅ Es la primera vez que los chequeos corren en producción. Las líneas fueron las correctas (1, 1 y 3), sin duplicados, y el resumen indicó el origen ("2 from checks, 1 from the model").
- ⚠️ **Mi expectativa era incorrecta:** esperaba que el chequeo de acentos marcara el comentario, pero el texto que puse no tenía ningún acento. Lo detectó el modelo. Es justo el caso para el que se diseñó la cobertura parcial (v0.7.1): el chequeo no ve el español sin acentos y el modelo sí.

### M10 — Verificación de la v0.7.4 (local, 3 corridas, $0.074)
| Corrida | Resultado | Estimado / real |
|---|---|---|
| Recordatorios `deep` 1 | 3 comentarios para 3 problemas, anclas correctas | 0.055 / 0.035 (1,6×) |
| Recordatorios `deep` 2 | 3 comentarios para 3 problemas; el encabezado anclado 2 líneas arriba (línea 10 en vez de la 12), con la 12 en "Also at" | 0.055 / 0.030 (1,9×) |
| Exportar CSV `standard` | Los 2 problemas por chequeo, en su lugar | 0.015 / 0.010 (1,6×) |

- ✅ **Lectura del commit correcto:** el clon estuvo siempre en la rama base y las revisiones dieron lo esperado, sin abrir la rama revisada.
- ✅ **La estimación previa ahora queda entre 1,6 y 1,9 veces del costo real** (antes era unas 10 veces).
- ✅ **"Also at" no mostró ubicaciones engañosas.**
- ⚠️ **Una ancla dos líneas arriba:** el modelo dio un rango de evidencia equivocado (9 a 11) y otro correcto (12), y al unir las pasadas ganó el de la pasada con mayor severidad. Anotado para la v0.8.0.

### M11 — Cobertura visible en cada revisión (v0.8.0, local, 4 corridas, $0.080)
| Corrida | Línea de cobertura | Hallazgos |
|---|---|---|
| Recordatorios `standard` y `deep` | completa, 7 de 7 archivos, 5 reglas (2 por chequeo y 3 por el modelo) | 3, igual que antes |
| Exportar CSV `standard` | completa, 5 de 5 archivos | 2, ambos por chequeo |
| Clientes (limpio) | completa, 8 de 8 archivos | ninguno |

- ✅ **La tabla de reglas coincidió con la realidad en las 20 filas.** Por ejemplo, donde la regla de arquitectura se cumplía dice "check: nada encontrado (solo patrón) · modelo: ok", y donde se violaba dice "check: 1 violación · modelo: violación, no publicada" (el modelo coincidió con el chequeo y no lo repitió).
- ✅ **Los rótulos cumplen su función:** "solo patrón" aparece cuando un chequeo parcial no encontró nada, para que ese silencio no se lea como garantía; la leyenda aclara que lo del modelo "puede estar equivocado" y que la cobertura dice qué se miró, no que se haya mirado bien.
- ✅ Los hallazgos publicados no cambiaron y la cobertura no agrega llamadas al modelo.
- ⚠️ **No verificado en real:** el empaquetado por archivos completos con un diff de más de 200.000 caracteres, los estados de archivos eliminados, ignorados o sin diff (solo en la nube) y el bloque plegado de baja confianza de `deep`. Están probados con tests, no con corridas reales.

### M12 — Cobertura en producción, PR de prueba con etiqueta `standard` (v0.8.0, 2026-09-27)
| Qué se esperaba | Resultado |
|---|---|
| Línea de cobertura y bloque plegado en el comentario | ✅ "Coverage: complete · 1 of 1 changed file reviewed · 5 rules in scope: 2 by checks, 3 by the model" y el bloque "What was reviewed" con las tablas y la leyenda |
| Tabla de reglas fiel al caso | ✅ Los resultados por regla coinciden con lo sembrado |
| 3 comentarios para 3 problemas | ⚠️ **5 comentarios**: los 3 esperados, más un segundo comentario del modelo por la misma violación de arquitectura (línea 5, el uso del repositorio) y una observación de severidad baja |

- ✅ Es la primera vez que la cobertura se ve en un PR real. Tiempo de la etiqueta a la revisión: 23 s.
- ⚠️ **El duplicado se cuela** porque, para una regla con chequeo parcial, un hallazgo del modelo solo se descarta si está a 3 líneas o menos del hallazgo del chequeo, y el import (línea 1) y su uso (línea 5) están a 4. La misma revisión en la v0.7.3 había dado 3 comentarios: el modelo varía entre corridas y la regla de deduplicación es la que deja pasar el caso. Anotado como v0.8.1.

### M6 — `guardrails init` (derivar reglas de un repo)
| Repo | Reglas propuestas | Descartadas por ya estar cubiertas | Tiempo | Costo |
|---|---|---|---|---|
| App de causas | 5 | 4 (no-console, no-any, TypeScript estricto, hooks) | 14 s | $0.0005 |
| claudeStarter (ronda inicial) | 26 | 2 | varios minutos | $0.011 |
| claudeStarter (tras los arreglos) | 13 a 15 (tope) | — | 13 a 27 s | $0.003 a $0.026 |

Se pierden unas 12 reglas de menor prioridad por el tope de 15. Los scopes que salían recortados (`seeds.config.` sin `json`) se arreglaron y ahora se validan contra los archivos reales del repo.

---

## 3. Cuándo pasa bien y cuándo mal (patrones)

**Pasa bien cuando:**
- La regla es concreta y verificable en el diff: un comentario en español, un archivo largo, un import prohibido, un test que falta.
- El PR es chico o limpio: no inventa problemas.
- Hay un bug de lógica localizable (un comparador mal escrito): lo encuentra y explica la causa.
- La regla se puede comprobar con código: da siempre el mismo resultado.

**Pasa mal cuando:**
- Una regla tiene **varias ubicaciones** y el modelo se conforma con la primera (comentario en español, v0.6.0).
- Un **chequeo parcial** se toma como si cubriera toda la regla (regresión de la v0.7.0, corregida).
- El modelo **afirma una ausencia sin comprobarla** ("no existe el test"). Se corrigió con una verificación contra el repo.
- **Dos pasadas** analizan lo mismo: aparecían duplicados (`deep`; resuelto en la v0.7.2).
- El **anclaje por texto** se confundía con fragmentos de identificadores y movía el comentario a una línea ajena (1 de 6 en la v0.7.2; resuelto en la v0.7.3).
- El modelo **inventa el identificador de una regla**: antes se perdía el hallazgo, ahora se conserva sin la etiqueta.
- El proveedor cambia la salida: Z.ai borraba el texto `json` en modo JSON.

---

## 4. Incidentes y su estado

| Incidente | Versión del arreglo | Estado |
|---|---|---|
| Violación de regla descartada por ser de tipo `style` | v0.4.0 | ✅ Resuelto |
| Hallazgos perdidos por `ruleId` inventado | v0.4.0 | ✅ Resuelto |
| Nombres recortados (`.json`) por el modo JSON de Z.ai | v0.4.0 | ✅ Resuelto |
| `init` de varios minutos | v0.4.0 | ✅ Resuelto (13 a 27 s) |
| Falsos positivos por afirmar que falta un archivo | v0.5.1 | ✅ Resuelto (verificación contra el repo) |
| Comentario en español no detectado | v0.6.1 | ✅ Resuelto |
| Regresión del encabezado sin acentos | v0.7.1 | ✅ Resuelto |
| Duplicados en `deep` | v0.7.2 | ✅ Resuelto en local (pendiente de subir) |
| Ancla en una línea ajena (1 de 6) | v0.7.3 | ✅ Resuelto en local (pendiente de subir) |
| Un subagente cortado por límite de sesión de Anthropic | — | ✅ Se retomó sin repetir trabajo |
| Subagente bloqueado dos veces por el clasificador de permisos | — | ✅ Se resolvió con la autorización explícita del usuario |

---

## 5. Lo que estos números **no** prueban

1. **Muestras pequeñas.** Son 6 PRs y 7 escenarios, con una corrida por celda. Ningún porcentaje de arriba es una tasa estadística.
2. **Los problemas están sembrados a propósito** y son bastante claros. Los bugs reales suelen ser más sutiles.
3. **Un solo repo y un solo dominio** (una app de causas). No sabemos cómo se comporta con otros lenguajes o arquitecturas.
4. **Un solo modelo** (GLM-5.3, razonamiento en nivel bajo). Con Claude o con otro modelo el resultado puede ser distinto.
5. **Sin bugs reales.** Los 25 casos reales del set de evaluación (B11) los tenés que curar vos, y el corredor y el juez de la Fase 0 (B14 a B17) nunca se construyeron. La decisión formal de si el agente supera al modo simple con un modelo de producción no se tomó.
6. **Los costos son estimaciones** desde los tokens reportados. GLM informa 0 tokens de razonamiento aunque razona, así que pueden estar subestimados. El dato verdadero está en el panel de Z.ai.
7. **Los chequeos mecánicos** se probaron en producción una sola vez (M9), con un componente sembrado de tres violaciones. Falta ver falsos positivos con PRs reales de más variedad.

## 6. Conclusión

Para reglas concretas y PRs chicos el producto funciona y no inventa problemas. Los fallos encontrados se detectaron midiendo y se corrigieron rápido, salvo los hallazgos extra de baja confianza de `deep`, que no se sabe si aportan. Lo que falta para decir "todo bien" con confianza es medir con **casos reales** y con **un modelo de producción**, y mirar el **costo real** en el panel de Z.ai.
