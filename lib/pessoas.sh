#!/usr/bin/env bash
# lib/pessoas.sh: as pessoas de /etc/dgclaw/papeis.json vistas pela CLI: listar, desligar e religar.
# Desligar uma pessoa (docs/PROPRIEDADE-DO-CONHECIMENTO.md) e o passo que fecha tudo o que derivava dela:
#   1. estado: "desligada" no papeis.json (o Web nega toda fonte, base, ferramenta e skill na hora, e
#      revoga os pedidos pendentes dos agentes dela);
#   2. os agentes dela sao parados (a casa fica inteira; nada e apagado);
#   3. a memoria de trabalho de cada agente dela (MEMORY.md, working-memory.md, memory/*.md) e copiada para
#      a base de conhecimento "entrega-<pessoa>", no escopo do grupo dela (ou da empresa, se nao tem grupo),
#      para o sucessor consultar o que era da empresa.
# O papeis.json e editado com jq, campo a campo, e o resultado passa pelo mesmo validador do Web antes de
# ser gravado. Precisa de lib/comum.sh, lib/agentes.sh e lib/bases.sh carregados antes.

RX_NOME_PESSOA='^[a-z][a-z0-9_-]{0,39}$'

# pessoas_listar_tsv: pessoa<TAB>estado<TAB>grupos<TAB>agentes, uma por linha.
pessoas_listar_tsv() {
    [ -s "$DG_PAPEIS_JSON" ] || return 0
    jq -r '
        . as $p
        | ($p.pessoas // {}) | to_entries[]
        | .key as $n
        | [$n, (.value.estado // "ativa"), ((.value.grupos // []) | join(" ")),
           ([($p.agentes // {}) | to_entries[] | select(.value.pessoa == $n) | .key] | join(" "))]
        | @tsv' "$DG_PAPEIS_JSON" 2>/dev/null
}

# pessoas_agentes <pessoa>: os slugs dos agentes dela, um por linha.
pessoas_agentes() {
    [ -s "$DG_PAPEIS_JSON" ] || return 0
    jq -r --arg n "$1" '(.agentes // {}) | to_entries[] | select(.value.pessoa == $n) | .key' "$DG_PAPEIS_JSON" 2>/dev/null
}

# _pessoas_validar_e_gravar <json>: passa o papeis.json resultante pelo validaPapeis do Web e grava (600).
_pessoas_validar_e_gravar() {
    local novo="$1" erro_val
    erro_val="$(printf '%s' "$novo" | node -e '
        const { validaPapeis } = require(process.argv[1]);
        let t = ""; process.stdin.on("data", (c) => { t += c; }).on("end", () => {
          const r = validaPapeis(JSON.parse(t)); if (!r.ok) { process.stdout.write(r.erros.join(" ")); process.exit(1); } });' "$APP_DIR/web/lib/papeis.js" 2>&1)" \
        || falha "o arquivo de papeis ficaria invalido: $erro_val" "nada foi gravado; confira ${DG_PAPEIS_JSON#"$R"}"
    printf '%s\n' "$novo" | escrever_arquivo "$DG_PAPEIS_JSON" 600
}

# _pessoas_mudar_estado <pessoa> <estado>: le, edita e grava DENTRO da trava, para uma edicao concorrente do
# papeis.json (outro comando, o dono no editor) nao ser perdida entre a leitura e a escrita.
_pessoas_mudar_estado() {
    local novo
    novo="$(jq --arg n "$1" --arg e "$2" '.pessoas[$n].estado = $e' "$DG_PAPEIS_JSON")" \
        || falha "nao consegui editar ${DG_PAPEIS_JSON#"$R"} (o jq recusou o conteudo)." "confira com: jq . $DG_PAPEIS_JSON"
    _pessoas_validar_e_gravar "$novo"
}

# pessoas_estado <pessoa> <ativa|desligada>: troca so o campo estado da pessoa.
pessoas_estado() {
    local nome="$1" estado="$2"
    [[ "$nome" =~ $RX_NOME_PESSOA ]] || falha "o nome '$nome' nao e valido." "veja as pessoas com: dgclaw pessoa listar"
    [ -s "$DG_PAPEIS_JSON" ] || falha "nao existe ${DG_PAPEIS_JSON#"$R"}." "crie o arquivo de papeis (web/docs/DADOS-POR-PAPEL.md)"
    jq -e --arg n "$nome" '.pessoas[$n] != null' "$DG_PAPEIS_JSON" >/dev/null 2>&1 \
        || falha "a pessoa '$nome' nao esta em ${DG_PAPEIS_JSON#"$R"}." "veja as pessoas com: dgclaw pessoa listar"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] poria estado=$estado na pessoa $nome em ${DG_PAPEIS_JSON#"$R"}"; return 0; fi
    com_trava _pessoas_mudar_estado "$nome" "$estado"
}

# pessoas_base_entrega <pessoa> [base]: o nome da base que recebe a memoria (entrega-<pessoa> por padrao).
# O catalogo aceita nomes de ate 40 caracteres; "entrega-" mais um nome de pessoa longo passa disso, e um
# catalogo invalido fecharia TODAS as bases. Por isso o nome e conferido ANTES de qualquer mudanca.
pessoas_base_entrega() {
    local base="${2:-entrega-$1}"
    [[ "$base" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] \
        || falha "o nome da base de entrega '$base' nao serve (ate 40 caracteres entre a-z, 0-9, _ e -, comecando por letra)." "escolha um nome curto com: dgclaw pessoa desligar $1 --base entrega-<nome-curto>"
    printf '%s' "$base"
}

# pessoas_entregar_memoria <pessoa> [base]: copia a memoria dos agentes dela para a base (entrega-<pessoa>).
# Imprime quantos arquivos copiou (so isso no stdout; avisos vao para o stderr). A base nasce no escopo do
# primeiro grupo da pessoa (ou empresa). Base que JA ESTA no catalogo fica como esta: o dono pode ter
# estreitado o escopo dela (para privada, por exemplo), e rodar o desligar de novo nao pode reabri-la.
pessoas_entregar_memoria() {
    local nome="$1" base grupo escopo destino slug casa arq n=0 rel
    base="$(pessoas_base_entrega "$nome" "${2:-}")" || return 1
    grupo="$(jq -r --arg n "$nome" '(.pessoas[$n].grupos // [])[0] // ""' "$DG_PAPEIS_JSON" 2>/dev/null)"
    if [ -n "$grupo" ]; then escopo="grupo:$grupo"; else escopo=empresa; fi
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] copiaria a memoria dos agentes de $nome para a base $base (escopo $escopo)" >&2; return 0; fi
    destino="$DG_BASES_DIR/$base"
    for slug in $(pessoas_agentes "$nome"); do
        casa="$DG_CASAS/$slug/home"
        [ -d "$casa" ] || continue
        mkdir -p "$destino/$slug" && chmod 700 "$destino" "$destino/$slug"
        for arq in MEMORY.md working-memory.md; do
            [ -f "$casa/$arq" ] && [ ! -L "$casa/$arq" ] || continue
            cp -- "$casa/$arq" "$destino/$slug/$arq" && chmod 600 "$destino/$slug/$arq" && n=$((n + 1))
        done
        if [ -d "$casa/memory" ] && [ ! -L "$casa/memory" ]; then
            mkdir -p "$destino/$slug/memory" && chmod 700 "$destino/$slug/memory"
            while IFS= read -r rel; do
                [ -n "$rel" ] || continue
                cp -- "$casa/memory/$rel" "$destino/$slug/memory/$rel" && chmod 600 "$destino/$slug/memory/$rel" && n=$((n + 1))
            done < <(find "$casa/memory" -maxdepth 1 -type f -name '*.md' -printf '%f\n' 2>/dev/null)
        fi
    done
    if [ "$n" -gt 0 ]; then
        chown -R 0:0 "$destino"
        bases_garantir_arquivo
        local obj
        obj="$(jq -nc --arg e "${escopo%%:*}" --arg g "${grupo}" --arg t "Entrega de $nome" '{escopo: $e, nome: $t, classificacao: "interno", finalidade: "memoria de trabalho dos agentes de uma pessoa desligada, para o sucessor"} + (if $g != "" then {grupo: $g} else {} end)')"
        if [ -n "$(bases_obter "$base")" ]; then
            aviso "a base $base ja estava no catalogo; mantive o escopo e os campos dela como estavam (so os arquivos foram copiados)"
        else
            bases_registrar "$base" "$obj"
        fi
    fi
    printf '%s\n' "$n"
}
