#!/usr/bin/env bash
# dgclaw skill publicar|listar|remover|aplicar: o catalogo /var/lib/dgclaw/skills e os links por papel.
set -uo pipefail
# shellcheck source=tests/cli/_comum.sh
. "$(dirname "$0")/_comum.sh"
preparar

SK="$LIB/skills"
mk_skill() { # mk_skill <pasta> <nome>
    mkdir -p "$1"
    printf -- '---\nname: %s\ndescription: roteiro de teste\n---\n\n# %s\n\n1. passo\n' "$2" "$2" >"$1/SKILL.md"
}

echo "publicar"
mk_skill "$TMP/fechamento-mensal" fechamento-mensal
afirma "publica no escopo global" dgclaw skill publicar "$TMP/fechamento-mensal" --escopo global
afirma "pasta do catalogo 755" test "$(stat -c %a "$SK")" = 755
afirma "SKILL.md copiado com 644 e dono root" test "$(stat -c '%a %u' "$SK/globais/fechamento-mensal/SKILL.md")" = "644 0"
mk_skill "$TMP/conciliacao" conciliacao
afirma "publica no escopo de grupo" dgclaw skill publicar "$TMP/conciliacao" --escopo grupo:financeiro
afirma "ficou em grupos/financeiro" test -f "$SK/grupos/financeiro/conciliacao/SKILL.md"
mk_skill "$TMP/so-da-ana" so-da-ana
afirma "publica no escopo de um agente" dgclaw skill publicar "$TMP/so-da-ana" --escopo agente:ana
afirma "ficou em agentes/ana" test -f "$SK/agentes/ana/so-da-ana/SKILL.md"
printf 'linha nova\n' >>"$TMP/fechamento-mensal/SKILL.md"
afirma "publicar de novo substitui" dgclaw skill publicar "$TMP/fechamento-mensal" --escopo global
afirma "versao nova no catalogo" grep -q 'linha nova' "$SK/globais/fechamento-mensal/SKILL.md"

echo "publicar: recusas"
nega "sem --escopo" dgclaw skill publicar "$TMP/fechamento-mensal"
nega "escopo inexistente" dgclaw skill publicar "$TMP/fechamento-mensal" --escopo todos
nega "pasta sem SKILL.md" bash -c "mkdir -p '$TMP/vazia' && '$CLI' skill publicar '$TMP/vazia' --escopo global"
mk_skill "$TMP/nome-errado" outro-nome
nega "name do frontmatter diferente da pasta" dgclaw skill publicar "$TMP/nome-errado" --escopo global
mk_skill "$TMP/com-atalho" com-atalho; ln -s /etc/passwd "$TMP/com-atalho/passwd"
nega "atalho dentro da skill" dgclaw skill publicar "$TMP/com-atalho" --escopo global
mk_skill "$TMP/com-binario" com-binario; printf '\x00\x01' >"$TMP/com-binario/foto.png"
nega "arquivo que nao e texto" dgclaw skill publicar "$TMP/com-binario" --escopo global
mk_skill "$TMP/com-segredo" com-segredo; printf 'use api_key = "abcdefghijklmnopqrstuvwxyz123"\n' >>"$TMP/com-segredo/SKILL.md"
nega "segredo no texto" dgclaw skill publicar "$TMP/com-segredo" --escopo global
mk_skill "$TMP/Maiuscula" Maiuscula
nega "nome com maiuscula" dgclaw skill publicar "$TMP/Maiuscula" --escopo global
nega "nada disso entrou" bash -c "ls '$SK/globais' | grep -qE 'nome-errado|com-|Maiuscula'"

echo "listar"
dgclaw skill listar >"$TMP/l.txt" 2>&1
afirma "lista os tres escopos" bash -c "grep -q '^global .*fechamento-mensal' '$TMP/l.txt' && grep -q '^grupo:financeiro .*conciliacao' '$TMP/l.txt' && grep -q '^agente:ana .*so-da-ana' '$TMP/l.txt'"

echo "permitidas pela politica"
cat >"$ETC/papeis.json" <<'EOF'
{"versao": 1,
 "grupos": {"financeiro": {"tipo": "departamento"}},
 "pessoas": {"marta": {"grupos": ["financeiro"], "skills": {"conciliacao": "negado"}}, "caio": {}, "lia": {"estado": "desligada", "grupos": ["financeiro"]}},
 "papeis": {"analista": {"skills": ["*"]}, "estagiario": {"skills": ["fechamento-mensal"]}},
 "agentes": {"ana": {"pessoa": "marta", "papel": "analista"}, "bia": {"pessoa": "caio", "papel": "analista"}, "edu": {"pessoa": "marta", "papel": "estagiario"}, "lu": {"pessoa": "lia", "papel": "analista"}}}
EOF
# skills_permitidas roda num bash separado: carregar lib/comum.sh aqui trocaria o ok/mal do proprio teste.
permitidas() { APP_DIR="$REPO" DGCLAW_RAIZ="$DGCLAW_RAIZ" ENSAIO=0 bash -c ". '$REPO/lib/comum.sh'; . '$REPO/lib/skills.sh'; skills_permitidas \"\$1\"" _ "$1"; }
igual "ana: global + a propria; a do grupo esta negada na pessoa" "agentes/ana/so-da-ana globais/fechamento-mensal" "$(permitidas ana | sort | tr '\n' ' ' | sed 's/ $//')"
igual "bia: so a global (nao esta no financeiro)" "globais/fechamento-mensal" "$(permitidas bia | tr '\n' ' ' | sed 's/ $//')"
igual "edu: so a listada no papel" "globais/fechamento-mensal" "$(permitidas edu | tr '\n' ' ' | sed 's/ $//')"
igual "lu (pessoa desligada): nada" "" "$(permitidas lu | tr '\n' ' ')"
igual "fora dos papeis: so as proprias" "" "$(permitidas zed | tr '\n' ' ')"
printf '{ quebrado' >"$ETC/papeis.json.bak"
cp "$ETC/papeis.json" "$TMP/papeis.ok"; printf '{ quebrado' >"$ETC/papeis.json"
igual "papeis.json invalido: so as proprias" "agentes/ana/so-da-ana" "$(permitidas ana | tr '\n' ' ' | sed 's/ $//')"
cp "$TMP/papeis.ok" "$ETC/papeis.json"

echo "publicar: nomes reservados e origem que o agente escreve"
mk_skill "$TMP/memory" memory
nega "nome de skill da imagem recusado" dgclaw skill publicar "$TMP/memory" --escopo global
nega "nem com --nome" dgclaw skill publicar "$TMP/fechamento-mensal" --escopo global --nome aprender
mk_skill "$TMP/da-ana" da-ana; mkfifo "$TMP/da-ana/fifo"
nega "fifo na origem recusado (sem travar)" timeout 10 "$CLI" skill publicar "$TMP/da-ana" --escopo global
nega "a pasta temporaria nao sobrou no catalogo" bash -c "ls -a '$SK/globais' | grep -q '^\\.da-ana'"

echo "aplicar (a vista por agente e o script que vai para dentro do container)"
criar_agente ana --nome "Ana"
afirma "o container nasce com a VISTA do agente montada so leitura, nao o catalogo inteiro" grep -q -- "$SK/.vistas/ana:/run/dgclaw/skills:ro" "$STUB_LOG"
afirma "a vista tem so as skills da ana (global + a propria), copiadas" bash -c "[ -f '$SK/.vistas/ana/fechamento-mensal/SKILL.md' ] && [ -f '$SK/.vistas/ana/so-da-ana/SKILL.md' ] && [ ! -e '$SK/.vistas/ana/conciliacao' ]"
afirma "a vista e de root, 755/644, e a pasta .vistas e 700" bash -c "[ \"\$(stat -c '%a %u' '$SK/.vistas/ana')\" = '755 0' ] && [ \"\$(stat -c %a '$SK/.vistas/ana/so-da-ana/SKILL.md')\" = 644 ] && [ \"\$(stat -c %a '$SK/.vistas')\" = 700 ]"
afirma "a criacao ja liga as skills compartilhadas" grep -q 'skills compartilhadas:' "$STUB_LOG.stdin"
afirma "a lista do agente foi para dentro (so nomes)" grep -q 'PERMITIDAS=" fechamento-mensal so-da-ana"' "$STUB_LOG.stdin"
afirma "o script nao troca link que aponta para a imagem" grep -q 'ja e uma skill da imagem' "$STUB_LOG.stdin"
: >"$STUB_LOG.stdin"
afirma "skill aplicar ana" dgclaw skill aplicar ana
afirma "mandou o script de links por STDIN" grep -q 'ln -sfn "/run/dgclaw/skills/$nome"' "$STUB_LOG.stdin"
afirma "remove link antigo que nao esta mais na lista" grep -q 'rm -f "$alvo"' "$STUB_LOG.stdin"
afirma "skill aplicar sem slug passa por todos os agentes" dgclaw skill aplicar
# a politica muda (ana perde o papel): a vista fica so com a propria skill
printf '{"versao": 1, "pessoas": {"marta": {}}, "papeis": {"nada": {}}, "agentes": {"ana": {"pessoa": "marta", "papel": "nada"}}}\n' >"$ETC/papeis.json"
afirma "skill aplicar depois de tirar o papel" dgclaw skill aplicar ana
afirma "a vista ficou so com a propria skill" bash -c "[ -f '$SK/.vistas/ana/so-da-ana/SKILL.md' ] && [ ! -e '$SK/.vistas/ana/fechamento-mensal' ]"
nega "slug invalido recusado" dgclaw skill aplicar "a;b"

echo "remover"
afirma "remover do grupo" dgclaw skill remover conciliacao --escopo grupo:financeiro
nega "saiu do catalogo" test -e "$SK/grupos/financeiro/conciliacao"
apos="$(find "$LIB/skills-aposentadas" -maxdepth 1 -name 'conciliacao-*' | head -1)"
afirma "foi para skills-aposentadas" test -f "$apos/SKILL.md"
nega "remover sem escopo" dgclaw skill remover fechamento-mensal
nega "remover inexistente" dgclaw skill remover fantasma --escopo global
nega "'skill nada' recusado" dgclaw skill nada

echo "ensaio"
mk_skill "$TMP/ensaio" ensaio
afirma "ensaio nao grava" dgclaw --ensaio skill publicar "$TMP/ensaio" --escopo global
nega "ensaio nao criou" test -e "$SK/globais/ensaio"

echo "ajuda"
dgclaw --ajuda >"$TMP/ajuda.txt" 2>&1
afirma "a ajuda documenta dgclaw skill publicar" grep -q 'dgclaw skill publicar' "$TMP/ajuda.txt"
fim
