# Guardrails — clon de Greptile (versión cloud primero)

Fuente del análisis: greptile.com, su pricing, docs y blog (consultado 2026-09-23).
Código en `guardrails/`.

## 1. Qué es Greptile

Revisor de PRs con IA que analiza cada pull request con **contexto de todo el codebase**, no solo del diff.

| Área | Qué hace |
|---|---|
| Indexado | Grafo del codebase: funciones, clases, dependencias |
| Agente | Agente propio que navega el filesystem del repo con la terminal para juntar contexto; multi-modelo (no publican cuáles) |
| Review | Agentes en paralelo: diff, impacto fuera de lo modificado, problemas entre archivos |
| Filtro de ruido | Embeddings por equipo de comentarios aceptados/rechazados; bloquea los parecidos a 3+ rechazados. Subió la tasa de atención de 19% a 55%+ |
| Reglas | Custom rules en lenguaje natural con scope y severidad; style guides del propio repo; reglas sugeridas tras ~10 PRs |
| Config | `strictness` 1–3, `commentTypes`, triggers, filtros de PR, `ignorePatterns`, `instructions`, contexto multi-repo |
| Ejecución | Cloud (SOC 2) o self-hosted (Docker/K8s). El agente corre en contenedor rootless de Podman |
| Integraciones | MCP, plugin de Claude Code, Cursor, Codex, Devin |
| Precio | Free 1 dev · Pro $30/seat · Enterprise custom · 1 crédito = 1 review |

No tienen rule sets predefinidos. Eso queda como oportunidad de diferenciación.

## 2. Modelo de ejecución

No corre dentro de GitHub/GitLab. Es un **servicio externo** que se conecta por webhooks y API.

```
PR abierto/actualizado
   │  webhook (firmado)
   ▼
API (recibe, verifica firma, encola)
   ▼
Worker en sandbox efímero
   1. clona el repo (token de GitHub App, scope al repo, corta duración)
   2. corre el agente con tools: read_file, grep, find_references
   3. el agente llama al LLM por API (el LLM solo ve lo que el agente le pide)
   4. filtra ruido (confianza + feedback previo)
   5. postea el review inline en el PR por la API de GitHub
   6. destruye el sandbox
   ▼
Persistente: Postgres + pgvector (índice, embeddings, reglas, feedback)
```

- K8s/EKS no hace falta para SaaS. Solo si se vende self-hosting.
- Sandbox: Vercel Sandbox o contenedores propios (Fly/ECS). No una función serverless común.
- LLM vía AI Gateway / AI SDK, intercambiable.

## 3. Decisiones de arquitectura

1. **El núcleo es una librería que no sabe de GitHub:** `reviewDiff({ repoPath, diff, config })`. Todo lo demás son envoltorios:
   - Cloud: webhook → worker → núcleo → comentarios en el PR.
   - CLI local (después): `guardrails review` sobre el diff local, para pre-push.
2. **Cloud primero**, porque es el punto de control del equipo y lo que se cobra. El CLI local reusa el núcleo.
3. **Escalera de contexto** (cuanto más contexto, menos input del usuario):
   1. Automático: README, `CONTRIBUTING.md`, linters, tsconfig, convenciones del repo.
   2. Aprendido: comentarios de PRs pasados y feedback → reglas propuestas.
   3. Explícito: reglas en lenguaje natural; un LLM las estructura a `{id, rule, scope, severity}` y el usuario aprueba.
   4. Ajuste fino: strictness, ignores, filtros.

## 4. Configuración del usuario (`.guardrails/config.json`)

```json
{
  "strictness": 2,
  "commentTypes": ["logic", "security", "style"],
  "ignorePatterns": ["dist/**", "**/*.generated.ts"],
  "instructions": "Preferimos composición sobre herencia.",
  "rules": [
    {
      "id": "no-raw-sql",
      "rule": "Use parameterized queries. Never interpolate user input into SQL.",
      "scope": ["src/db/**"],
      "severity": "high"
    }
  ],
  "files": [{ "path": "CONTRIBUTING.md" }]
}
```

Config por directorio con herencia en cascada (fase posterior).

## 5. Stack

- TypeScript, Next.js (API + dashboard), Postgres + pgvector
- Cola: Inngest / Trigger.dev / Vercel Workflow
- tree-sitter para parsing (Fase 2)
- LLM: Claude vía AI SDK / AI Gateway
- Octokit (`@octokit/app`) para la GitHub App

## 6. Fases

### Fase 0 — Núcleo + evaluación (en curso)
- Librería `core`: config (zod), tipos, `reviewDiff`, contrato del LLM.
- Set de evaluación: PRs con bugs conocidos para medir bugs vs. ruido.

### Fase 1 — Cloud MVP (en curso)
- GitHub App + endpoint de webhook con verificación de firma.
- Cola y worker: clonar, correr el núcleo, postear review inline.
- Contexto simple: archivos cambiados + archivos vecinos + reglas del config.
- Un agente + filtro de confianza.
- Dashboard mínimo: repos y reviews.

### Fase 2 — Contexto de codebase y filtro por feedback
- Indexado tree-sitter, grafo de símbolos, embeddings en pgvector; reindexado incremental.
- Tools `find_references`, `search_code`.
- Agentes especializados en paralelo + verificador que intenta refutar.
- Filtro de ruido por embeddings de feedback (aceptados/rechazados).

### Fase 3 — Aprendizaje y reglas
- Reglas en lenguaje natural estructuradas por LLM con aprobación.
- Reglas sugeridas desde comentarios de PRs pasados.
- Chat en el PR (`@bot re-review`, explicar).

### Fase 4 — Producto
- Billing por créditos, multi-org, métricas, GitLab, MCP server.
- Packs de reglas predefinidos (seguridad/OWASP, React, Next.js, SQL).

### Fase 5 — CLI local y enterprise
- CLI `guardrails review` + hook pre-push sobre el mismo núcleo.
- Agente de tests en sandbox, auto-fix, self-hosting, SSO, SOC 2.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Ruido / falsos positivos | Verificador, umbral de confianza, feedback loop, set de evaluación desde Fase 0 |
| Costo por review | Triage con modelo barato, prompt caching, tope de tokens por PR |
| Repos enormes | Indexado incremental, presupuesto de contexto |
| Código del cliente | Sandbox efímero, token de corta duración, borrar el clon, retención mínima |
| Competencia | Packs de reglas, menos configuración, precio, integración con agentes |

## 8. Decisiones abiertas
- ¿Producto para vender o proyecto propio?
- Lenguajes objetivo del MVP (sugerido: TS/JS y Python).
- Precio: por seat o por review.
- Proveedor del sandbox.
