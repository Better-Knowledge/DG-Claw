#!/usr/bin/env bash
# lib/skills.sh: o catalogo de skills compartilhadas, em /var/lib/dgclaw/skills (web/docs/SKILLS-POR-ESCOPO.md).
#
#   globais/<skill>/SKILL.md          toda pessoa, se o papel do agente liberar
#   grupos/<grupo>/<skill>/SKILL.md   as pessoas do grupo, se o papel liberar
#   agentes/<slug>/<skill>/SKILL.md   so aquele agente
#
# A pasta e montada SO LEITURA em /run/dgclaw/skills dentro de cada container; o que o agente enxerga em
# ~/.claude/skills sao links para as skills que o papel dele (e os grupos da pessoa) liberam. Skill e codigo
# que o modelo le e segue: so o dono publica nos escopos compartilhados; o agente propoe (pela rota de dados,
# com aprovacao). Arquivos ficam legiveis por todos (755/644): o agente e um uid comum dentro do container e
# precisa ler; por isso NENHUM segredo entra numa skill (o publicar recusa o que parecer segredo).
# Precisa de lib/comum.sh carregado antes, e do jq.

RX_NOME_SKILL='^[a-z][a-z0-9-]{0,39}$'
SKILL_MAX_BYTES=2097152   # 2 MB por skill (pasta inteira)
# A copia do DG Claw de onde vem a lista de segredos e os nomes das skills da imagem: APP_DIR no dgclaw,
# SCRIPT_DIR no instalador (que carrega esta lib para criar as pastas).
SKILLS_APP="${APP_DIR:-${SCRIPT_DIR:-/opt/dgclaw/app}}"
# Os padroes de segredo vivem num arquivo so, lido tambem pelo Web (web/lib/dados-fontes/skills.js).
SKILLS_SEGREDOS_REGEX="${DGCLAW_SEGREDOS_REGEX:-$SKILLS_APP/lib/segredos.regex}"

# As skills que vida_script liga em todo agente (bin/dgclaw): lista fixa, para o nome continuar reservado mesmo
# se a pasta skills/ da copia do app faltar. A mesma lista esta em web/lib/dados-fontes/skills.js.
SKILLS_RESERVADAS_FIXAS=" dgclaw agenda lembretes aprender avisos memory foco avatar report slide-animado site-animado video-animado groq-audio gemini-gratuito visuais-na-conversa "

# skills_nome_reservado <nome>: 0 se o nome e de uma skill da imagem ou do Admin (as pastas de skills/ do
# DG Claw, mais a lista fixa acima): uma skill compartilhada com esse nome tomaria o lugar da nativa em todo
# agente. Sem a pasta skills/ na copia do app, a copia esta incompleta e o publicar falha (skills_publicar).
skills_nome_reservado() {
    case "$SKILLS_RESERVADAS_FIXAS" in *" $1 "*) return 0 ;; esac
    [ -d "$SKILLS_APP/skills/$1" ]
}

skills_garantir_pastas() {
    local d
    for d in "$DG_SKILLS_DIR" "$DG_SKILLS_DIR/globais" "$DG_SKILLS_DIR/grupos" "$DG_SKILLS_DIR/agentes"; do
        if [ ! -d "$d" ]; then
            if [ "$ENSAIO" = 1 ]; then printf '   [ensaio] criaria a pasta %s (modo 755)\n' "$d"; continue; fi
            mkdir -p "$d" && chmod 755 "$d"
        fi
    done
}

# skills_escopo_pasta <escopo>: imprime a pasta do escopo (global | grupo:<g> | agente:<slug>) ou falha.
skills_escopo_pasta() {
    case "$1" in
        global) printf '%s/globais' "$DG_SKILLS_DIR" ;;
        grupo:*) local g="${1#grupo:}"; [[ "$g" =~ ^[a-z][a-z0-9_-]{0,39}$ ]] || falha "o grupo '$g' nao e um nome valido." "use o nome do grupo como esta em /etc/dgclaw/papeis.json (ex.: --escopo grupo:financeiro)"
            printf '%s/grupos/%s' "$DG_SKILLS_DIR" "$g" ;;
        agente:*) local s="${1#agente:}"; [[ "$s" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || falha "o agente '$s' nao e um slug valido." "veja os agentes com: dgclaw agente listar"
            printf '%s/agentes/%s' "$DG_SKILLS_DIR" "$s" ;;
        *) falha "o escopo '$1' nao existe." "use --escopo global, --escopo grupo:<grupo> ou --escopo agente:<slug>" ;;
    esac
}

# skills_conferir_pasta <pasta de origem> <nome>: recusa o que nao pode virar skill compartilhada.
skills_conferir_pasta() {
    local origem="$1" nome="$2" bytes achado
    [ -d "$origem" ] || falha "a pasta '$origem' nao existe." "aponte a pasta da skill (a que tem o SKILL.md)"
    [ -f "$origem/SKILL.md" ] || falha "a pasta '$origem' nao tem SKILL.md." "uma skill e uma pasta com SKILL.md dentro"
    if find "$origem" -type l | grep -q .; then falha "a pasta '$origem' tem atalho (link simbolico), e skill compartilhada nao pode ter." "troque o atalho pelo arquivo"; fi
    if find "$origem" -type f ! -name '*.md' ! -name '*.txt' ! -name '*.json' ! -name '*.csv' ! -name '*.yaml' ! -name '*.yml' ! -name '*.html' ! -name '*.py' ! -name '*.sh' ! -name '*.mjs' ! -name '*.js' | grep -q .; then
        falha "a pasta '$origem' tem arquivo de tipo que a skill compartilhada nao aceita (so texto: md, txt, json, csv, yaml, html, py, sh, js, mjs)." "tire os outros arquivos"
    fi
    bytes="$(du -sb "$origem" | cut -f1)"
    [ "$bytes" -le "$SKILL_MAX_BYTES" ] || falha "a pasta '$origem' tem $bytes bytes; o teto de uma skill compartilhada e $SKILL_MAX_BYTES (2 MB)." "tire o que nao e roteiro"
    # O nome no frontmatter precisa ser o nome da pasta (e o que o Claude Code mostra).
    achado="$(sed -n '1,/^---$/{s/^name:[[:space:]]*//p}' "$origem/SKILL.md" | head -1 | tr -d '\r')"
    [ "$achado" = "$nome" ] || falha "o SKILL.md diz 'name: ${achado:-(nada)}', mas a skill se chama '$nome'." "corrija o name no frontmatter do SKILL.md para $nome"
    # Segredo nunca entra em skill: o arquivo fica legivel por todo agente que a recebe. Padroes em lib/segredos.regex.
    [ -s "$SKILLS_SEGREDOS_REGEX" ] || falha "nao achei a lista de padroes de segredo em $SKILLS_SEGREDOS_REGEX." "a copia do DG Claw esta incompleta; reinstale"
    # Linha vazia ou comentario no arquivo de padroes nao vira padrao (vazio casaria qualquer linha); o Web
    # (carregaSegredos) descarta as mesmas linhas, para os dois lados lerem a lista igual.
    if grep -Ev '^[[:space:]]*(#|$)' "$SKILLS_SEGREDOS_REGEX" | grep -rEIin -f - "$origem" >/dev/null; then
        falha "a pasta '$origem' parece ter um segredo (chave, token ou senha)." "tire o valor; a skill diz ONDE pegar a chave (no cofre), nunca o valor"
    fi
}

# skills_publicar <pasta> <escopo> [nome]: copia a skill para o catalogo (755/644, root), substituindo a versao anterior.
skills_publicar() {
    local origem="$1" escopo="$2" nome="${3:-$(basename "$1")}" destino pasta tmp
    [[ "$nome" =~ $RX_NOME_SKILL ]] || falha "o nome '$nome' nao serve: use de 1 a 40 caracteres entre letras minusculas, numeros e hifen, comecando por letra." "exemplo: fechamento-mensal"
    [ -d "$SKILLS_APP/skills" ] || falha "nao achei a pasta skills/ da copia do DG Claw em $SKILLS_APP; sem ela nao da para saber quais nomes sao das skills da imagem." "a copia do DG Claw esta incompleta; reinstale ou rode: dgclaw atualizar"
    skills_nome_reservado "$nome" && falha "o nome '$nome' e de uma skill da imagem do DG Claw (ou do Admin); uma skill compartilhada com esse nome tomaria o lugar dela em todo agente." "escolha outro nome (ex.: $nome-da-empresa)"
    pasta="$(skills_escopo_pasta "$escopo")"
    [ -d "$origem" ] || falha "a pasta '$origem' nao existe." "aponte a pasta da skill (a que tem o SKILL.md)"
    destino="$pasta/$nome"
    # A origem pode ser enorme (uma pasta que o agente escreve); pre-checagem barata antes de copiar.
    # A conferencia de verdade e feita na copia (skills_conferir_pasta).
    local pre; pre="$(du -sbl "$origem" 2>/dev/null | cut -f1)"   # -l: cada hardlink conta (o cp grava cada um inteiro)
    [ -z "$pre" ] || [ "$pre" -le "$SKILL_MAX_BYTES" ] || falha "a pasta '$origem' tem $pre bytes; o teto de uma skill compartilhada e $SKILL_MAX_BYTES (2 MB)." "tire o que nao e roteiro"
    # O mesmo nome em outro escopo confunde quem recebe as duas (na vista, a mais especifica vence).
    local outra
    for outra in "$DG_SKILLS_DIR"/globais/"$nome" "$DG_SKILLS_DIR"/grupos/*/"$nome" "$DG_SKILLS_DIR"/agentes/*/"$nome"; do
        [ -d "$outra" ] && [ "$outra" != "$destino" ] && aviso "ja existe uma skill '$nome' em ${outra#"$DG_SKILLS_DIR/"}; para quem recebe as duas, a mais especifica (agente > grupo > global) vence."
    done
    if [ "$ENSAIO" = 1 ]; then skills_conferir_pasta "$origem" "$nome"; info "[ensaio] publicaria a skill $nome em ${destino#"$R"} (755/644, root)"; return 0; fi
    skills_garantir_pastas
    mkdir -p "$pasta" && chmod 755 "$pasta"
    # Copia PRIMEIRO para uma pasta de root e confere a copia: a origem pode ser uma pasta que o agente escreve
    # (a skill aprendida na casa dele), e entre conferir e copiar ele poderia trocar um arquivo por atalho ou fifo.
    tmp="$(mktemp -d "$pasta/.$nome.XXXXXX")"
    # ulimit -f (em blocos de 1024): nenhum arquivo copiado passa do teto, mesmo que a origem cresca durante a copia.
    if ! ( ulimit -f $((SKILL_MAX_BYTES / 1024 + 1)); cp -R --no-dereference --preserve=mode "$origem/." "$tmp/" ) 2>/dev/null; then rm -rf "$tmp"; falha "nao consegui copiar a pasta '$origem' (ou um arquivo dela passa de $SKILL_MAX_BYTES bytes)." "confira o tamanho, a permissao e o espaco em disco"; fi
    if find "$tmp" ! -type f ! -type d | grep -q .; then rm -rf "$tmp"; falha "a pasta '$origem' tem atalho, fifo ou outro arquivo que nao e comum; skill compartilhada so tem arquivos e pastas." "troque o atalho pelo arquivo"; fi
    SKILLS_TMP_LIMPAR="$tmp"; trap '[ -n "${SKILLS_TMP_LIMPAR:-}" ] && rm -rf "$SKILLS_TMP_LIMPAR"' EXIT
    skills_conferir_pasta "$tmp" "$nome"
    SKILLS_TMP_LIMPAR=""; trap - EXIT
    find "$tmp" -type d -exec chmod 755 {} +
    find "$tmp" -type f -exec chmod 644 {} +
    chown -R 0:0 "$tmp"
    rm -rf "$destino"
    mv "$tmp" "$destino"
}

# skills_remover <nome> <escopo>: tira a skill do catalogo (a pasta vai para skills-aposentadas).
skills_remover() {
    local nome="$1" escopo="$2" pasta destino
    [[ "$nome" =~ $RX_NOME_SKILL ]] || falha "o nome '$nome' nao e valido." "veja as skills com: dgclaw skill listar"
    pasta="$(skills_escopo_pasta "$escopo")"
    [ -d "$pasta/$nome" ] || falha "nao ha a skill '$nome' no escopo $escopo." "veja as skills com: dgclaw skill listar"
    destino="$DG_LIB/skills-aposentadas/$nome-$(date +%Y%m%d-%H%M%S)"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] moveria ${pasta#"$R"}/$nome para ${destino#"$R"}"; return 0; fi
    mkdir -p "$(dirname "$destino")" && chmod 700 "$(dirname "$destino")"
    mv "$pasta/$nome" "$destino"
}

# skills_listar_tsv: escopo<TAB>nome<TAB>caminho relativo, uma por linha.
skills_listar_tsv() {
    local d n
    [ -d "$DG_SKILLS_DIR" ] || return 0
    # A ordem dos globs e a ordem da vista (a ultima de mesmo nome vence): fixa em C para nao depender da locale
    # de quem rodou (o dono no terminal e o Admin no servico podiam montar vistas diferentes).
    local LC_ALL=C
    for d in "$DG_SKILLS_DIR"/globais/*/; do [ -f "$d/SKILL.md" ] && printf 'global\t%s\tglobais/%s\n' "$(basename "$d")" "$(basename "$d")"; done
    for d in "$DG_SKILLS_DIR"/grupos/*/*/; do [ -f "$d/SKILL.md" ] && n="$(basename "$d")" && printf 'grupo:%s\t%s\tgrupos/%s/%s\n' "$(basename "$(dirname "$d")")" "$n" "$(basename "$(dirname "$d")")" "$n"; done
    for d in "$DG_SKILLS_DIR"/agentes/*/*/; do [ -f "$d/SKILL.md" ] && n="$(basename "$d")" && printf 'agente:%s\t%s\tagentes/%s/%s\n' "$(basename "$(dirname "$d")")" "$n" "$(basename "$(dirname "$d")")" "$n"; done
    return 0
}

# skills_permitidas <slug>: os caminhos relativos (globais/x, grupos/g/x, agentes/slug/x) que o agente recebe,
# um por linha, pela politica de /etc/dgclaw/papeis.json: o papel lista as skills (ou "*"); a pessoa pode
# negar; as do grupo exigem a pessoa no grupo; as do proprio agente sempre entram. Pessoa desligada: nada.
# Sem papeis.json valido ou agente fora dele: so as proprias.
skills_permitidas() {
    local slug="$1" linha escopo nome rel grupo
    [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || return 0
    local pol="" pessoa="" papel="" estado="ativa" grupos="" papel_skills="" pessoa_skills=""
    # So confia no papeis.json que o Web aceitaria: arquivo que o Web rejeita libera so as proprias.
    local papeis_ok=0
    if [ -s "$DG_PAPEIS_JSON" ] && node -e '
        const { validaPapeis } = require(process.argv[1]); const fs = require("node:fs");
        try { process.exit(validaPapeis(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))).ok ? 0 : 1); } catch (e) { process.exit(1); }' "$SKILLS_APP/web/lib/papeis.js" "$DG_PAPEIS_JSON" 2>/dev/null; then papeis_ok=1; fi
    if [ "$papeis_ok" = 1 ] && pol="$(jq -c --arg s "$slug" '
        (.agentes[$s] // null) as $a
        | if $a == null then null else
          {pessoa: $a.pessoa, papel: $a.papel,
           estado: (.pessoas[$a.pessoa].estado // "ativa"),
           grupos: ((.pessoas[$a.pessoa].grupos // []) | join(" ")),
           papel_skills: ((.papeis[$a.papel].skills // []) | join(" ")),
           pessoa_skills: ((.pessoas[$a.pessoa].skills // {}) | to_entries | map("\(.key)=\(.value)") | join(" "))} end' "$DG_PAPEIS_JSON" 2>/dev/null)" && [ "$pol" != null ]; then
        pessoa="$(jq -r .pessoa <<<"$pol")"; papel="$(jq -r .papel <<<"$pol")"; estado="$(jq -r .estado <<<"$pol")"
        grupos="$(jq -r .grupos <<<"$pol")"; papel_skills="$(jq -r .papel_skills <<<"$pol")"; pessoa_skills="$(jq -r .pessoa_skills <<<"$pol")"
    fi
    [ "$estado" != desligada ] || { skills_listar_tsv | awk -F'\t' -v s="agente:$slug" '$1 == s && 0'; return 0; }
    while IFS=$'\t' read -r escopo nome rel; do
        [ -n "$nome" ] || continue
        case "$escopo" in
            agente:*) [ "$escopo" = "agente:$slug" ] && printf '%s\n' "$rel"; continue ;;
        esac
        [ -n "$papel" ] || continue
        # a pessoa nega por nome?
        case " $pessoa_skills " in *" $nome=negado "*) continue ;; esac
        # o papel libera por nome ou por "*"?
        case " $papel_skills " in *" $nome "*|*" * "*) ;; *) continue ;; esac
        if [ "$escopo" != global ]; then
            grupo="${escopo#grupo:}"
            case " $grupos " in *" $grupo "*) ;; *) continue ;; esac
        fi
        printf '%s\n' "$rel"
    done < <(skills_listar_tsv)
}

# skills_montar_vista <slug>: monta /var/lib/dgclaw/skills/.vistas/<slug>/<nome> com copias das skills que a
# politica libera para o agente. E ESSA pasta (e so ela) que o container monta em /run/dgclaw/skills: o agente
# nao enxerga as skills dos outros escopos. Refeita na criacao, no reparar, no iniciar e no skill aplicar.
#
# ATENCAO: a pasta da vista NUNCA e apagada e recriada. Um bind mount do podman e do inode, nao do caminho: se o
# host fizesse rm -rf + mv, o container ligado continuaria montado no inode antigo (vazio e orfao) e nunca veria
# a vista nova. Por isso a pasta e criada uma vez e so o CONTEUDO dela e trocado; com o mesmo inode, o container
# enxerga a mudanca na hora, mesmo montado so leitura. Nao "simplifique" de volta para rm -rf + mv.
skills_montar_vista() {
    local slug="$1" vista rel nome tmp
    [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || return 1
    skills_garantir_pastas
    vista="$DG_SKILLS_DIR/.vistas/$slug"
    if [ "$ENSAIO" = 1 ]; then info "[ensaio] montaria a vista de skills do agente $slug em ${vista#"$R"} com: $(skills_permitidas "$slug" | tr '\n' ' ')"; return 0; fi
    mkdir -p "$DG_SKILLS_DIR/.vistas" && chmod 700 "$DG_SKILLS_DIR/.vistas"
    if [ -L "$vista" ] || { [ -e "$vista" ] && [ ! -d "$vista" ]; }; then rm -f "$vista"; fi
    mkdir -p "$vista" && chmod 755 "$vista" && chown 0:0 "$vista"
    tmp="$(mktemp -d "$DG_SKILLS_DIR/.vistas/.$slug.XXXXXX")"
    # skills_permitidas lista globais, depois grupos, depois as do proprio agente: com o mesmo nome em escopos
    # diferentes, a ultima (mais especifica) toma o lugar da anterior. A privada do agente nunca perde.
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        [[ "$rel" =~ ^(globais|grupos/[a-z][a-z0-9_-]{0,39}|agentes/[a-z0-9][a-z0-9-]{1,30})/[a-z][a-z0-9-]{0,39}$ ]] || continue
        nome="${rel##*/}"
        [ -f "$DG_SKILLS_DIR/$rel/SKILL.md" ] || continue
        rm -rf "$tmp/$nome"
        cp -R --no-dereference "$DG_SKILLS_DIR/$rel" "$tmp/$nome"
    done < <(skills_permitidas "$slug")
    find "$tmp" -type d -exec chmod 755 {} +
    find "$tmp" -type f -exec chmod 644 {} +
    chown -R 0:0 "$tmp"
    # Troca so o conteudo, mantendo o inode da vista (veja o aviso acima).
    find "$vista" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    find "$tmp" -mindepth 1 -maxdepth 1 -exec mv -t "$vista" {} +
    rmdir "$tmp"
}

# skills_vista_nomes <slug>: os nomes das skills na vista montada, um por linha.
skills_vista_nomes() {
    local d
    for d in "$DG_SKILLS_DIR/.vistas/$1"/*/; do [ -f "$d/SKILL.md" ] && basename "$d"; done
    return 0
}
