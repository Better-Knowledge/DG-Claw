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
# papeis.json (outro comando, o dono no editor) nao ser perdida entre a leitura e a escrita. Alem da trava da CLI
# (flock), toma a MESMA trava do Web (a pasta papeis.json.trava, web/lib/papeis-editor.js): o painel /acessos e a
# CLI nunca gravam ao mesmo tempo. Trava com mais de 10 s e de processo que morreu.
_pessoas_mudar_estado() {
    local novo trava="$DG_PAPEIS_JSON.trava" i=0 ino_trava marca_antes marca_depois
    while ! mkdir "$trava" 2>/dev/null; do
        # trava velha (processo morto): so remove se ainda for A MESMA pasta que medimos (inode igual), para nao
        # derrubar uma trava recem-criada por outro processo no meio do caminho
        ino_trava="$(stat -c %i "$trava" 2>/dev/null || echo '')"
        if [ -n "$ino_trava" ] && [ "$(( $(date +%s) - $(stat -c %Y "$trava" 2>/dev/null || date +%s) ))" -gt 10 ]; then
            [ "$(stat -c %i "$trava" 2>/dev/null || echo '')" = "$ino_trava" ] && rmdir "$trava" 2>/dev/null \
                || { i=$((i + 1)); [ "$i" -le 100 ] || falha "a trava $trava nao e uma pasta vazia e nao consegui remove-la." "confira e apague-a a mao: ls -la $trava"; sleep 0.1; }
            continue
        fi
        i=$((i + 1)); [ "$i" -le 100 ] || falha "o painel esta editando ${DG_PAPEIS_JSON#"$R"} agora (trava $trava)." "espere alguns segundos e rode de novo"
        sleep 0.1
    done
    # EXIT, nao RETURN: esta funcao roda no subshell do com_trava, e o `falha` sai com exit (o RETURN nao dispararia).
    # shellcheck disable=SC2064 # expandir agora e de proposito: a variavel local nao existe mais quando o EXIT dispara
    trap "rmdir '$trava' 2>/dev/null || true" EXIT
    marca_antes="$(stat -c '%i:%Y:%s' "$DG_PAPEIS_JSON" 2>/dev/null || echo ausente)"
    novo="$(jq --arg n "$1" --arg e "$2" '.pessoas[$n].estado = $e' "$DG_PAPEIS_JSON")" \
        || falha "nao consegui editar ${DG_PAPEIS_JSON#"$R"} (o jq recusou o conteudo)." "confira com: jq . $DG_PAPEIS_JSON"
    marca_depois="$(stat -c '%i:%Y:%s' "$DG_PAPEIS_JSON" 2>/dev/null || echo ausente)"
    [ "$marca_antes" = "$marca_depois" ] || falha "o arquivo de papeis mudou enquanto eu o editava (o painel ou outro comando gravou)." "rode de novo"
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

# pessoas_escopo_entrega <pessoa> <base>: imprime o escopo em que a memoria vai ficar ("grupo:<g>", "empresa"
# ou "privada:<pessoa>") e falha se nao da. A memoria de trabalho e "interno" e do grupo da pessoa; se a base ja
# esta no catalogo (o dono escolheu --base, ou e a segunda rodada do desligar), o escopo dela e mantido, mas so
# se nao abre a memoria para mais gente do que o padrao: grupo igual ao primeiro grupo da pessoa; empresa so
# para quem nao tem grupo; privada so da propria pessoa. Publica ou qualquer outro caso e recusado. Tambem
# confere que o catalogo atual e valido: um catalogo invalido faria a entrega falhar depois de a pessoa ja
# estar desligada. Chamado ANTES de qualquer mudanca.
pessoas_escopo_entrega() {
    local nome="$1" base="$2" grupo atual escopo_atual grupo_atual pessoa_atual
    grupo="$(jq -r --arg n "$nome" '(.pessoas[$n].grupos // [])[0] // ""' "$DG_PAPEIS_JSON" 2>/dev/null)"
    _bases_validar "$(bases_ler)"
    atual="$(bases_obter "$base")"
    if [ -z "$atual" ]; then
        if [ -n "$grupo" ]; then printf 'grupo:%s' "$grupo"; else printf 'empresa'; fi
        return 0
    fi
    escopo_atual="$(jq -r '.escopo // ""' <<<"$atual")"
    grupo_atual="$(jq -r '.grupo // ""' <<<"$atual")"
    pessoa_atual="$(jq -r '.pessoa // ""' <<<"$atual")"
    case "$escopo_atual" in
        grupo)   [ -n "$grupo" ] && [ "$grupo_atual" = "$grupo" ] || falha "a base '$base' ja existe no escopo grupo:$grupo_atual, e o grupo de $nome e '${grupo:-nenhum}'; a memoria dela nao pode ir para o grupo de outros." "use outro nome: dgclaw pessoa desligar $nome --base entrega-<nome-curto>"
                 printf 'grupo:%s' "$grupo_atual" ;;
        empresa) [ -z "$grupo" ] || falha "a base '$base' ja existe no escopo empresa, e $nome tem grupo ($grupo); a memoria dela so vai para o grupo dela." "use outro nome: dgclaw pessoa desligar $nome --base entrega-<nome-curto>"
                 printf 'empresa' ;;
        privada) [ "$pessoa_atual" = "$nome" ] || falha "a base '$base' ja existe como privada de '$pessoa_atual'; a memoria de $nome nao pode ir para la." "use outro nome: dgclaw pessoa desligar $nome --base entrega-<nome-curto>"
                 printf 'privada:%s' "$nome" ;;
        *)       falha "a base '$base' ja existe no escopo '$escopo_atual'; a memoria de trabalho de uma pessoa nunca vai para uma base publica." "use outro nome: dgclaw pessoa desligar $nome --base entrega-<nome-curto>" ;;
    esac
}

# pessoas_entregar_memoria <pessoa> <base> <escopo>: copia a memoria dos agentes dela para a base (a pasta e
# o escopo ja conferidos por pessoas_escopo_entrega). Imprime quantos arquivos copiou (so isso no stdout;
# avisos vao para o stderr) e devolve 1 se qualquer passo falhou, para quem chama nao dizer "ok" a toa.
# Base que JA ESTA no catalogo fica como esta (o escopo dela foi conferido antes).
pessoas_entregar_memoria() {
    local nome="$1" base="$2" escopo="$3" grupo="" destino slug casa arq n=0 rel ja_existe=""
    [ -n "$base" ] && [ -n "$escopo" ] || return 1
    case "$escopo" in grupo:*) grupo="${escopo#grupo:}" ;; esac
    ja_existe="$(bases_obter "$base")"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] copiaria a memoria dos agentes de $nome para a base $base (escopo $escopo${ja_existe:+, que ja esta no catalogo e fica como esta})" >&2; return 0; fi
    # O escopo foi conferido antes da confirmacao; o catalogo pode ter mudado enquanto a pessoa digitava ou os
    # agentes paravam. Reconfere agora, com a mesma regra; o falha de dentro so derruba o subshell, e cai no return.
    [ "$(pessoas_escopo_entrega "$nome" "$base" 2>/dev/null)" = "$escopo" ] \
        || { aviso "o catalogo de bases mudou desde a confirmacao: a base $base ja nao esta no escopo $escopo; nada foi copiado"; return 1; }
    [ -z "$ja_existe" ] || aviso "a base $base ja esta no catalogo; o escopo e os campos dela ficam como estao (so os arquivos entram)"
    destino="$DG_BASES_DIR/$base"
    for slug in $(pessoas_agentes "$nome"); do
        casa="$DG_CASAS/$slug/home"
        [ -d "$casa" ] || continue
        { mkdir -p "$destino/$slug" && chmod 700 "$destino" "$destino/$slug"; } || { aviso "nao consegui criar ${destino#"$R"}/$slug"; return 1; }
        for arq in MEMORY.md working-memory.md; do
            [ -f "$casa/$arq" ] && [ ! -L "$casa/$arq" ] || continue
            { cp -- "$casa/$arq" "$destino/$slug/$arq" && chmod 600 "$destino/$slug/$arq"; } || { aviso "nao consegui copiar $arq do agente $slug"; return 1; }
            n=$((n + 1))
        done
        if [ -d "$casa/memory" ] && [ ! -L "$casa/memory" ]; then
            { mkdir -p "$destino/$slug/memory" && chmod 700 "$destino/$slug/memory"; } || { aviso "nao consegui criar ${destino#"$R"}/$slug/memory"; return 1; }
            while IFS= read -r rel; do
                [ -n "$rel" ] || continue
                { cp -- "$casa/memory/$rel" "$destino/$slug/memory/$rel" && chmod 600 "$destino/$slug/memory/$rel"; } || { aviso "nao consegui copiar memory/$rel do agente $slug"; return 1; }
                n=$((n + 1))
            done < <(find "$casa/memory" -maxdepth 1 -type f -name '*.md' -printf '%f\n' 2>/dev/null)
        fi
    done
    if [ "$n" -gt 0 ]; then
        chown -R 0:0 "$destino" || return 1
        bases_garantir_arquivo
        if [ -z "$ja_existe" ]; then
            local obj
            obj="$(jq -nc --arg e "${escopo%%:*}" --arg g "${grupo}" --arg t "Entrega de $nome" '{escopo: $e, nome: $t, classificacao: "interno", finalidade: "memoria de trabalho dos agentes de uma pessoa desligada, para o sucessor"} + (if $g != "" then {grupo: $g} else {} end)')"
            # com_trava roda num subshell: a falha de la nao derruba este processo, por isso o retorno e testado.
            bases_registrar "$base" "$obj" || return 1
        fi
    fi
    printf '%s\n' "$n"
}
