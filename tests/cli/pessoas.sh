#!/usr/bin/env bash
# dgclaw pessoa listar|desligar|religar: o estado da pessoa no papeis.json, os agentes dela e a entrega da memoria.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar
export DGCLAW_TEMPO_PARADA=3   # espera de 3 s em vez de 90 s, para o teste ser rapido

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
afirma "parou os dois agentes dela" bash -c "grep -q '^podman stop .*dgclaw-ana' '$STUB_LOG' && grep -q '^podman stop .*dgclaw-edu' '$STUB_LOG'"
nega "nao parou o agente de outra pessoa" grep -q '^podman stop .*dgclaw-bia' "$STUB_LOG"
E="$LIB/bases/entrega-marta"
afirma "a memoria da Ana foi para a base entrega-marta" bash -c "grep -q 'dia 5' '$E/ana/MEMORY.md' && grep -q conciliei '$E/ana/working-memory.md' && [ -f '$E/ana/memory/2026-11-07.md' ]"
nega "json de relacoes e atalho nao vao" bash -c "[ -e '$E/ana/memory/relationships.json' ] || [ -e '$E/ana/memory/atalho.md' ]"
afirma "a casa da Ana continua inteira" test -f "$H/MEMORY.md"
afirma "pasta da entrega e de root com 700 e arquivos 600" bash -c "[ \"\$(stat -c '%a %u' '$E')\" = '700 0' ] && [ \"\$(stat -c %a '$E/ana/MEMORY.md')\" = 600 ]"
afirma "a base entrou no catalogo no escopo do grupo dela" jq -e '.bases["entrega-marta"].escopo == "grupo" and .bases["entrega-marta"].grupo == "financeiro"' "$ETC/bases.json"
nega "pessoa inexistente recusada" dgclaw pessoa desligar fantasma --sim
nega "nome invalido recusado" dgclaw pessoa desligar "Marta;rm" --sim

echo "desligar de novo nao reabre uma base que o dono estreitou"
jq '.bases["entrega-marta"].escopo = "privada" | .bases["entrega-marta"].pessoa = "marta" | del(.bases["entrega-marta"].grupo)' "$ETC/bases.json" >"$TMP/b.json" && cp "$TMP/b.json" "$ETC/bases.json"
printf '%s\n' '- nova regra' >>"$H/MEMORY.md"
afirma "desligar marta de novo" dgclaw pessoa desligar marta --sim
afirma "o catalogo ficou como o dono deixou (privada)" jq -e '.bases["entrega-marta"].escopo == "privada" and .bases["entrega-marta"].pessoa == "marta" and (.bases["entrega-marta"].grupo == null)' "$ETC/bases.json"
afirma "mas os arquivos foram copiados de novo" grep -q 'nova regra' "$E/ana/MEMORY.md"

echo "nome longo: a base nao cabe no catalogo, e nada muda"
LONGA="pessoa-com-nome-muito-comprido-demais-x"
jq --arg n "$LONGA" '.pessoas[$n] = {"grupos": ["financeiro"]} | .agentes.zoe = {"pessoa": $n, "papel": "analista"}' "$PAP" >"$TMP/p.json" && cp "$TMP/p.json" "$PAP"
mkdir -p "$LIB/agentes/zoe/home"; printf 'z\n' >"$LIB/agentes/zoe/home/MEMORY.md"
: >"$STUB_LOG"
nega "entrega-<nome longo> passa de 40 e e recusado ANTES de mudar algo" dgclaw pessoa desligar "$LONGA" --sim
igual "a pessoa continua ativa" "ativa" "$(jq -r --arg n "$LONGA" '.pessoas[$n].estado // "ativa"' "$PAP")"
nega "nenhum agente foi parado" grep -q '^podman stop' "$STUB_LOG"
afirma "com --base cabe" dgclaw pessoa desligar "$LONGA" --sim --base entrega-zoe
afirma "base entrega-zoe no catalogo" jq -e '.bases["entrega-zoe"].escopo == "grupo"' "$ETC/bases.json"
afirma "o catalogo continua valido para o Web" node -e '
  const { validaBases } = require(process.argv[1]); const fs = require("node:fs");
  process.exit(validaBases(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))).ok ? 0 : 1);' "$REPO/web/lib/bases.js" "$ETC/bases.json"
nega "--base invalido recusado" dgclaw pessoa desligar caio --sim --base "Maiuscula"
nega "--base sem nome recusado" dgclaw pessoa desligar caio --sim --base
nega "--base vazio recusado" dgclaw pessoa desligar caio --sim --base ""
nega "--base= vazio recusado" dgclaw pessoa desligar caio --sim --base=

echo "--base apontando para uma base que abriria a memoria para mais gente: recusado antes de mudar algo"
afirma "base da empresa existe" dgclaw base criar manual-rh --escopo empresa
afirma "base publica existe" dgclaw base criar site --escopo publica
afirma "base privada de outra pessoa existe" dgclaw base criar diario-caio --escopo pessoa:caio
jq '.pessoas.marta.estado = "ativa"' "$PAP" >"$TMP/p2.json" && cp "$TMP/p2.json" "$PAP"
: >"$STUB_LOG"
nega "marta (grupo financeiro) para base empresa: recusado" dgclaw pessoa desligar marta --sim --base manual-rh
nega "para base publica: recusado" dgclaw pessoa desligar marta --sim --base site
nega "para a privada de outra pessoa: recusado" dgclaw pessoa desligar marta --sim --base diario-caio
igual "marta continua ativa" "ativa" "$(jq -r '.pessoas.marta.estado' "$PAP")"
nega "nenhum agente parado" grep -q '^podman stop' "$STUB_LOG"
nega "nada foi copiado para a base da empresa" test -e "$LIB/bases/manual-rh/ana"
mkdir -p "$LIB/agentes/bia/home"; printf 'x\n' >"$LIB/agentes/bia/home/MEMORY.md"
afirma "caio (sem grupo) para base empresa: pode" dgclaw pessoa desligar caio --sim --base manual-rh
afirma "copiou para la" test -f "$LIB/bases/manual-rh/bia/MEMORY.md"
jq '.pessoas.caio.estado = "ativa"' "$PAP" >"$TMP/p3.json" && cp "$TMP/p3.json" "$PAP"

echo "agente preso em stopping: o container e removido (a casa fica) e a entrega segue, sem religar o agente"
jq '.pessoas.marta.estado = "ativa"' "$PAP" >"$TMP/p4.json" && cp "$TMP/p4.json" "$PAP"
echo running >"$STUB_ESTADO/c-dgclaw-ana"; echo sempre >"$STUB_ESTADO/stop-trava-dgclaw-ana"
rm -rf "$LIB/bases/entrega-marta"; : >"$STUB_LOG"
dgclaw pessoa desligar marta --sim >"$TMP/preso.txt" 2>&1
afirma "desligar com um agente preso em stopping completa" test $? -eq 0
afirma "removeu so o container (rm -f)" grep -q '^podman rm -f dgclaw-ana' "$STUB_LOG"
nega "o container nao existe mais" test -e "$STUB_ESTADO/c-dgclaw-ana"
nega "nao religou o agente" grep -q '^podman start' "$STUB_LOG"
afirma "a memoria foi entregue" test -f "$LIB/bases/entrega-marta/ana/MEMORY.md"
afirma "diz ao sucessor como voltar o agente" grep -q 'dgclaw agente recriar ana --forcar' "$TMP/preso.txt"
afirma "a casa da Ana continua inteira" test -f "$H/MEMORY.md"
rm -f "$STUB_ESTADO/stop-trava-dgclaw-ana"; echo exited >"$STUB_ESTADO/c-dgclaw-ana"
jq '.pessoas.marta.estado = "ativa"' "$PAP" >"$TMP/p5.json" && cp "$TMP/p5.json" "$PAP"

echo "agente pausado: despausa, para e entrega"
echo paused >"$STUB_ESTADO/c-dgclaw-ana"; rm -rf "$LIB/bases/entrega-marta"; : >"$STUB_LOG"
afirma "desligar com agente pausado completa" dgclaw pessoa desligar marta --sim
afirma "despausou antes de parar" bash -c "grep -q '^podman unpause dgclaw-ana' '$STUB_LOG' && grep -q '^podman stop .*dgclaw-ana' '$STUB_LOG'"
igual "container parado" "exited" "$(cat "$STUB_ESTADO/c-dgclaw-ana")"
afirma "a memoria foi entregue" test -f "$LIB/bases/entrega-marta/ana/MEMORY.md"
jq '.pessoas.marta.estado = "ativa"' "$PAP" >"$TMP/p5b.json" && cp "$TMP/p5b.json" "$PAP"

echo "agente que o podman nao consegue parar: a memoria nao e copiada com ele vivo"
echo running >"$STUB_ESTADO/c-dgclaw-ana"; touch "$STUB_ESTADO/stop-nao-para-dgclaw-ana"; rm -rf "$LIB/bases/entrega-marta"
nega "desligar com um agente que continua running: falha" dgclaw pessoa desligar marta --sim
igual "a pessoa FICA desligada (o acesso ja foi negado pelo Web)" "desligada" "$(jq -r .pessoas.marta.estado "$PAP")"
nega "nada foi copiado" test -e "$LIB/bases/entrega-marta/ana"
rm -f "$STUB_ESTADO/stop-nao-para-dgclaw-ana"; echo exited >"$STUB_ESTADO/c-dgclaw-ana"
afirma "rodar de novo com o agente parado completa a entrega" dgclaw pessoa desligar marta --sim
afirma "agora copiou" test -f "$LIB/bases/entrega-marta/ana/MEMORY.md"
jq '.pessoas.marta.estado = "ativa"' "$PAP" >"$TMP/p5c.json" && cp "$TMP/p5c.json" "$PAP"

echo "podman que nao responde: nada e copiado (erro nao vale como 'parado')"
rm -rf "$LIB/bases/entrega-marta"
echo running >"$STUB_ESTADO/c-dgclaw-ana"; touch "$STUB_ESTADO/podman-quebrado"
nega "desligar com podman devolvendo 125 em tudo: falha" dgclaw pessoa desligar marta --sim
nega "nada foi copiado" test -e "$LIB/bases/entrega-marta/ana"
rm -f "$STUB_ESTADO/podman-quebrado"; echo exited >"$STUB_ESTADO/c-dgclaw-ana"
jq '.pessoas.marta.estado = "ativa"' "$PAP" >"$TMP/p6.json" && cp "$TMP/p6.json" "$PAP"

echo "o catalogo muda entre a confirmacao e a copia: a copia e recusada"
entregar() { APP_DIR="$REPO" DGCLAW_RAIZ="$DGCLAW_RAIZ" ENSAIO=0 bash -c ". '$REPO/lib/comum.sh'; . '$REPO/lib/agentes.sh'; . '$REPO/lib/bases.sh'; . '$REPO/lib/pessoas.sh'; pessoas_entregar_memoria \"\$@\"" _ "$@"; }
afirma "a base vira publica depois da confirmacao" dgclaw base criar entrega-x --escopo publica
nega "a copia com o escopo conferido antes (grupo) e recusada" entregar marta entrega-x grupo:financeiro
nega "nada foi copiado para la" test -e "$LIB/bases/entrega-x/ana"

echo "catalogo de bases invalido: desligar recusa antes de mudar algo (a entrega falharia depois)"
cp "$ETC/bases.json" "$TMP/bases.ok"
jq '.bases["Nome Invalido"] = {"escopo": "empresa"}' "$ETC/bases.json" >"$TMP/b2.json" && cp "$TMP/b2.json" "$ETC/bases.json"
: >"$STUB_LOG"
nega "desligar marta com catalogo invalido: recusado" dgclaw pessoa desligar marta --sim
igual "marta continua ativa" "ativa" "$(jq -r '.pessoas.marta.estado' "$PAP")"
nega "nenhum agente parado" grep -q '^podman stop' "$STUB_LOG"
cp "$TMP/bases.ok" "$ETC/bases.json"

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
dgclaw --ensaio pessoa desligar marta --sim >"$TMP/ens.txt" 2>&1
afirma "ensaio nao grava" test $? -eq 0
afirma "o ensaio mostra o passo da entrega" grep -q 'copiaria a memoria' "$TMP/ens.txt"
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
