# Plan: shadcn/ vs ui/ Component Restructure

**Stand:** 2026-05-08
**Vorgänger:** [2026-05-08-plan-platform-admin-and-loose-ends.md](./2026-05-08-plan-platform-admin-and-loose-ends.md)
**Trigger:** Review-Feedback auf PR #15 — vermischen von shadcn-Defaults und projekt-spezifischen UI-Komponenten unter einem Ordner macht „custom verändern" zu einer riskanten Operation.

## Ausgangslage

Aktuell liegt alles unter `app/components/ui/`:

```text
app/components/ui/
  badge/{Badge.vue, index.ts}
  button/{Button.vue, index.ts}
  card/{Card.vue, …}
  command/{…}
  dialog/{…}
  input/{Input.vue, index.ts}
  popover/{…}
  select/{…}
  table/{Table.vue, TableBody.vue, …, index.ts}
```

Das sind alles **unmodifizierte shadcn-vue-Defaults**, die per `pnpm dlx
shadcn-vue@latest add <component>` generiert wurden. `components.json` zeigt
auf `~/components` mit dem Default-Output unter `~/components/ui/`.

Nuxt registriert sie via Path-Prefix als `<UiButton>`, `<UiInput>`,
`<UiTable>` usw. (lokal verifizierbar nach `pnpm dev` oder
`pnpm exec nuxi prepare` über `.nuxt/components.d.ts` —
generierte Datei, nicht eingecheckt.)

26 bestehende Files importieren Komponenten als named export aus diesen
Pfaden:

```ts
import { Button } from "~/components/ui/button";
```

Das funktioniert, weil `index.ts` die Komponente als Named-Export
re-exportiert. In Templates kommt entweder der explizit-importierte Name
(`<Button>`) oder der Auto-Import (`<UiButton>`) zum Einsatz — beides
existiert nebeneinander.

## Problem

- **Kein Layer für Project-Customisations.** Wenn wir `<Button>` projektweit
  z.B. mit Default-`size="sm"` oder einer anderen Loading-Spinner-Variante
  ausstatten wollen, gibt es keinen sauberen Slot dafür. Wir müssten direkt
  in der shadcn-Component editieren — und dann verliert `shadcn-vue add`
  beim nächsten Update entweder die Änderungen oder bricht die Datei mit
  einem Merge-Konflikt.
- **Verwechselbarkeit.** Der Name "ui" deutet auf "unsere UI-Komponenten"
  hin, ist aber tatsächlich "fremde Library-Defaults". Neuer Code wird sie
  unbedacht ändern.

## Ziel-Layout

```text
app/components/
  shadcn/                  ← unmodifizierte shadcn-Defaults (regenerierbar)
    badge/{Badge.vue, index.ts}
    button/{Button.vue, index.ts}
    …
  ui/                      ← project-spezifische Wrapper (anfangs LEER)
    Button.vue             ← entsteht erst, wenn projekt-Defaults nötig sind
    …
```

**Auto-Import-Namen:**
- `<ShadcnButton>` — direkter Zugriff auf den shadcn-Default. **Default-
  Wahl** für neuen Code, solange keine Customisation existiert.
- `<UiButton>` — projekt-spezifischer Wrapper. Existiert nur, wenn jemand
  ihn aktiv angelegt hat. Solange `app/components/ui/Button.vue` nicht
  existiert, ist `<UiButton>` schlicht nicht registriert.

**Regel:** App-Code nutzt `<ShadcnButton>` standardmäßig. Sobald für eine
Component projekt-Defaults gewünscht sind (z.B. immer `size="sm"`,
Loading-Spinner-Pattern), wird ein Wrapper unter `app/components/ui/`
angelegt UND alle Call-Sites werden in einem dedizierten Commit auf
`<UiButton>` umgestellt. Dieser Wechsel ist dann sichtbar im Diff und
review-bar; ein No-Op-Wrapper im Voraus wäre nur Indirection ohne Nutzen.

## Effort

Phase 1 (Move + No-Op-Wrapper): ~1.5h. Phase 2 (Custom-Defaults eintragen):
ad-hoc, wenn Bedarf entsteht — kein definierter Aufwand.

## Migrations-Schritte

### Phase 1 — Reines Verschieben (keine Funktionsänderung)

**Ziel:** Layout umstellen, Build grün, kein UI-Verhaltenswechsel.

#### 1.1 Verschieben mit Git-Historie

```bash
git mv app/components/ui app/components/shadcn
```

→ verify: `ls app/components/shadcn/button/Button.vue` existiert.

#### 1.2 components.json updaten

[components.json](../../components.json) — die shadcn-CLI nutzt das, um zu
wissen wo neue Components hinkommen.

```diff
   "aliases": {
-    "components": "~/components",
+    "components": "~/components",
+    "ui": "~/components/shadcn",
     "utils": "~/lib/utils"
   }
```

> **Hinweis:** Der `ui`-Alias in components.json ist die shadcn-CLI-Konvention
> (sie schreibt nach `<components>/<ui>`). Der Pfad zeigt jetzt auf
> `shadcn/`, nicht `ui/`. Damit landet ein zukünftiges
> `pnpm dlx shadcn-vue@latest add <foo>` im richtigen Ordner.

→ verify: `pnpm dlx shadcn-vue@latest add separator --yes` schreibt nach
`app/components/shadcn/separator/`. (Optional — nur ausführen, wenn man
ohnehin `separator` braucht.)

#### 1.3 Imports in 26 Files umbiegen

```bash
# regex find-replace, dry-run zuerst
grep -rln '"~/components/ui/' app/

# dann ersetzen
find app/ -name '*.vue' -o -name '*.ts' | xargs \
  sed -i 's|"~/components/ui/|"~/components/shadcn/|g'
```

→ verify: `grep -rln '"~/components/ui/' app/` ist leer.

#### 1.4 `app/components/ui/` bleibt leer (kein Wrapper-Vorrat)

`ui/` ist der Slot für künftige projekt-spezifische Wrapper. Wir legen
ihn aber **nicht prophylaktisch** mit Pass-Through-Files voll — ein
Wrapper der nur `<slot/>` weitergibt ist toter Code, der nichts erklärt
und einer Indirection-Schicht ohne Funktion entspricht.

Stattdessen: Templates, die heute `<UiButton>`, `<UiTable>` etc.
verwenden (in PR #15 die Admin-Pages und Onboarding), werden in 1.3 auf
`<ShadcnButton>` etc. umgestellt. Ein Wrapper unter `ui/` entsteht erst
in Phase 2, wenn jemand konkret „alle Buttons im Projekt sollen X
machen" implementiert.

→ verify: `pnpm dev`, alle Pages rendern ohne Console-Errors. Im Code
gibt es keine `<UiX>`-Tags mehr (`grep -rln '<Ui[A-Z]' app/` ist leer).

#### 1.5 Templates-Cleanup (optional, Cosmetic)

Existierende Files mit Pattern `import { Button } from "~/components/shadcn/button"`
+ Template-Tag `<Button>` könnten auf den Auto-Import-Namen
`<ShadcnButton>` umgestellt und der Import gedroppt werden. **Nicht
zwingend nötig** — der explizite Import ist syntaktisch valide. Lohnt
sich nur, wenn eh am File gearbeitet wird.

#### 1.6 Test

```bash
pnpm test          # 339 sollten weiter passen
pnpm exec nuxi typecheck 2>&1 | grep "components/ui\|components/shadcn"
# erwartet: keine zusätzlichen Errors gegenüber Baseline
```

→ verify: Build clean, kein Visual Regression auf den Hauptseiten.

### Phase 2 — Tatsächliche Customisations einziehen (later, on-demand)

Wenn z.B. der Default-Button-Look projektweit angepasst werden soll:

```vue
<!-- app/components/ui/Button.vue -->
<script setup lang="ts">
import { Button as ShadcnButton, type ButtonVariants } from "~/components/shadcn/button";

interface Props {
  variant?: ButtonVariants["variant"];
  size?: ButtonVariants["size"];
  loading?: boolean;
}
const props = withDefaults(defineProps<Props>(), { size: "sm" });
</script>

<template>
  <ShadcnButton :variant="variant" :size="size" :disabled="loading || $attrs.disabled">
    <Loader2 v-if="loading" class="size-4 animate-spin" />
    <slot />
  </ShadcnButton>
</template>
```

Solche Wrapper landen on-demand. Phase 1 schafft nur den Slot dafür.

## Pitfalls

- **shadcn-CLI re-add überschreibt.** Wenn jemand
  `pnpm dlx shadcn-vue@latest add button --yes` aufruft, schreibt die CLI
  in den `aliases.ui`-Pfad — nach 1.2 also nach `shadcn/button/`. Wenn
  jemand ohne `--yes` ausführt, fragt die CLI nach overwrite — bestätigen
  ist OK, da `shadcn/` per Definition unmodifiziert ist. Das `ui/`-Layer
  bleibt unangetastet.
- **`<UiButton>` zeigt jetzt auf den Wrapper, nicht den Default.** Wer
  bisher angenommen hat, `<UiButton>` rendert „raw shadcn", muss nach
  Phase 2 mit Wrapper-Defaults rechnen. Das ist gewünscht (= ganzer Sinn
  des Refactors), aber sollte im Migration-Commit-Message erwähnt sein.
- **Auto-Import-Konflikt.** Wenn Phase 1 sowohl ein
  `app/components/ui/Button.vue` als auch ein
  `app/components/shadcn/button/Button.vue` registriert, generiert Nuxt
  beide: `<UiButton>` und `<ShadcnButton>`. Kein Konflikt. Aber wenn jemand
  einen flachen `app/components/Button.vue` anlegt, kollidiert der
  Top-Level-Auto-Import. Konvention dokumentieren: Top-Level-Components
  unter `app/components/` sind Page-spezifisch (z.B. `AnthropicOAuthCard`),
  nie generic UI-Primitives.
- **`components.json`-Alias-Format.** Der shadcn-CLI-`ui`-Alias erwartet
  einen `~`-rooted Path. Falsch konfiguriert (relative path o.ä.) findet
  die CLI den Output-Ordner nicht und legt nach Default ab.

## PR-Strategie

Phase 1 als ein einziger PR: „refactor(components): split shadcn defaults
from custom UI layer". Tests + dev-Smoke vor Merge. Phase 2 läuft
inkrementell, wann immer ein Wrapper konkret ergänzt wird — kein
Sammel-PR.

## Out-of-Scope (für später)

- **Lucide-Icons auto-import.** Aktuell explizit importiert. Falls
  gewünscht, separat über `unplugin-icons` oder ein vergleichbares
  Auto-Import-Plugin. Eigener Mini-PR.
- **Existierende `<Button>`-Templates auf `<UiButton>` migrieren.**
  Cosmetic, nicht funktional. Kann pro File mitlaufen wenn ohnehin daran
  gearbeitet wird.
