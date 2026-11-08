#!/usr/bin/env bash
# dgclaw pessoa listar|desligar|religar: o estado da pessoa no papeis.json, os agentes dela e a entrega da memoria.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

PAP="$ETC/papeis.json"
cat >"$PAP" <<'EOF'
{"versao": 1,
 "grupos": {"financeiro": {"tipo": "departamento"}},
 "pessoas": {"marta": {"grupos": ["financeiro"], "fontes": {"agenda": "leitura"}}, "caio": {}},
 "papeis": {"analista": {"fontes": {"agenda": "leitura"}}},
 "agentes": {"ana": {"pessoa": "marta", "papel": "analista"}, "edu": {"pessoa": "marta", "papel": "analista"}, "bia": {"pessoa": "caio", "papel": "analista"}}}
EOF
chmod 600 "$PAP"

echo "listar"
dgclaw pessoa listar >"$TMP/l.txt" 2>&1
afirma "lista marta com grupo e agentes" grep -qE '^marta +ativa +financeiro +ana edu' "$TMP/l.txt"
afirma "lista caio sem grupo" grep -qE '^caio +ativa +- +bia' "$TMP/l.txt"

echo "desligar"
criar_agente ana --nome "Ana"
criar_agente edu --nome "Edu"
H="$LIB/agentes/ana/home"
printf '# Memoria da Ana\n- regra: fechamento todo dia 5\n' >"$H/MEMORY.md"
printf '## Hoje\n- conciliei o caixa\n' >"$H/working-memory.md"
mkdir -p "$H/memory"; printf 'diario\n' >"$H/memory/2026-11-07.md"; printf '{}' >"$H/memory/relationships.json"
ln -s /etc/passwd "$H/memory/atalho.md"
nega "sem --sim e sem terminal recusa" dgclaw pessoa desligar marta
igual "ainda ativa" "ativa" "$(jq -r '.pessoas.marta.estado // "ativa"' "$PAP")"
: >"$STUB_LOG"
afirma "desligar --sim" dgclaw pessoa desligar marta --sim
igual "estado desligada no papeis.json" "desligada" "$(jq -r .pessoas.marta.estado "$PAP")"
afirma "o resto do arquivo ficou" jq -e '.pessoas.caio and .agentes.ana.papel == "analista" and .grupos.financeiro' "$PAP"
afirma "papeis.json continua 600" test "$(stat -c %a "$PAP")" = 600
afirma "parou os dois agentes dela" bash -c "grep -q '^podman stop dgclaw-ana' '$STUB_LOG' && grep -q '^podman stop dgclaw-edu' '$STUB_LOG'"
nega "nao parou o agente de outra pessoa" grep -q '^podman stop dgclaw-bia' "$STUB_LOG"
E="$LIB/bases/entrega-marta"
afirma "a memoria da Ana foi para a base entrega-marta" bash -c "grep -q 'dia 5' '$E/ana/MEMORY.md' && grep -q conciliei '$E/ana/working-memory.md' && [ -f '$E/ana/memory/2026-11-07.md' ]"
nega "json de relacoes e atalho nao vao" bash -c "[ -e '$E/ana/memory/relationships.json' ] || [ -e '$E/ana/memory/atalho.md' ]"
afirma "a casa da Ana continua inteira" test -f "$H/MEMORY.md"
afirma "pasta da entrega e de root com 700 e arquivos 600" bash -c "[ \"\$(stat -c '%a %u' '$E')\" = '700 0' ] && [ \"\$(stat -c %a '$E/ana/MEMORY.md')\" = 600 ]"
afirma "a base entrou no catalogo no escopo do grupo dela" jq -e '.bases["entrega-marta"].escopo == "grupo" and .bases["entrega-marta"].grupo == "financeiro"' "$ETC/bases.json"
nega "pessoa inexistente recusada" dgclaw pessoa desligar fantasma --sim
nega "nome invalido recusado" dgclaw pessoa desligar "Marta;rm" --sim

echo "desligar quem nao tem grupo: base da empresa"
: >"$STUB_LOG"
mkdir -p "$LIB/agentes/bia/home"; printf 'x\n' >"$LIB/agentes/bia/home/MEMORY.md"
afirma "desligar caio" dgclaw pessoa desligar caio --sim
afirma "base entrega-caio no escopo empresa" jq -e '.bases["entrega-caio"].escopo == "empresa"' "$ETC/bases.json"

echo "religar"
afirma "religar marta" dgclaw pessoa religar marta
igual "estado ativa" "ativa" "$(jq -r .pessoas.marta.estado "$PAP")"
nega "religar inexistente" dgclaw pessoa religar fantasma

echo "ensaio e papeis invalido"
afirma "ensaio nao grava" dgclaw --ensaio pessoa desligar marta --sim
igual "ensaio: continua ativa" "ativa" "$(jq -r .pessoas.marta.estado "$PAP")"
cp "$PAP" "$TMP/pap.ok"; printf '{ quebrado' >"$PAP"
nega "papeis.json quebrado: desligar recusa" dgclaw pessoa desligar marta --sim
igual "arquivo quebrado nao foi tocado" "{ quebrado" "$(cat "$PAP")"
cp "$TMP/pap.ok" "$PAP"
nega "'pessoa nada' recusado" dgclaw pessoa nada

echo "ajuda"
dgclaw --ajuda >"$TMP/ajuda.txt" 2>&1
afirma "a ajuda documenta dgclaw pessoa desligar" grep -q 'dgclaw pessoa desligar' "$TMP/ajuda.txt"
fim
