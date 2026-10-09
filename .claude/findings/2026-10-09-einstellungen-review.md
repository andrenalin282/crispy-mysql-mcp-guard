# Einstellungen-Review 2026-10-09 (Projekt crispy-mysql-mcp-guard)

Claude Code 2.1.295. Globaler Review am selben Tag: `~/.claude/findings/2026-10-09-einstellungen-review-global.md`.

- Projekt-Settings/Hooks/Skills/Agenten: keine vorhanden, nichts zu bereinigen (kleines TS-Projekt, Toolchain `npm`, `package-lock.json`).
- `.lemoncrow/.ignore` angelegt (`*.min.js`, `*.min.css`, `*.map`, `/dist/`, `/node_modules/`); Projekt hat keine eingecheckten Fremdbibliotheken. `.lemoncrow/` ist gitignored, die Datei bleibt lokal.
- `.gitnexus/` ist in `.gitignore`; kein `vault/`.
- Telegram-Plugin: global aus, im Projekt nichts gesetzt.
- Release-Prozess: Versionen per annotiertem Tag `vX.Y.Z` (`v0.2.0` = `mysql_dump`), `package.json` vorher hochzählen; README nennt den gepinnten `npx`-Aufruf.
- Offen: kein Projekt-CLAUDE.md. Test-DB-Anleitung steht nur im Kopf von `test/db.test.ts`; bei Bedarf dorthin/ins README.
