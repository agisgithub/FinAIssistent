# Interpretação local de consultas — fase 1B

Comandos e consultas reconhecidas deterministicamente funcionam sem IA. O adaptador opcional `OllamaIntentClient` classifica somente a pergunta atual em uma intenção de leitura. Ele recebe texto limitado e a data de referência; não recebe histórico, snapshots, contas, lançamentos ou um resolvedor de segredos. Valores, saldos e demais resultados são calculados a partir do Actual pelo código financeiro.

## Contrato

`interpret(text,{today})` retorna `{intent,metadata}`. Uma consulta contém `{kind,period:{start,end},page}`. `kind` é um dos valores `summary`, `spending`, `budget`, `uncategorized`, `leaks`, `accounts` ou `comparison`; o período é inclusivo, válido, não futuro e limitado a 24 meses; a página vai de 1 a 100000. Apenas `spending` admite `categoryName` opcional (1–500 caracteres, sem controles), copiado da pergunta. A categoria é resolvida posteriormente no catálogo real; nome não encontrado ou ambíguo exige escolha, sem substituir o filtro por um total geral. `comparison` exige a faixa do primeiro dia do mês anterior até hoje; o código compara os dias disponíveis em cada mês.

Planejamento de parcela/financiamento ou economia usa `{kind:'needs_info',topic:'installment'|'savings'}`, sem valores ou períodos; o chamador pede os dados necessários, sem afirmar viabilidade. Para escrita, pedido fora do escopo ou interpretação insuficiente, o schema permite `{kind:'unsupported'}` sem campos adicionais; o chamador explica o limite sem consultar o Actual. Campos extras, IDs, valores monetários, métodos SDK, ferramentas e ações são recusados. A validação local continua obrigatória mesmo com JSON Schema no modelo.

Metadados retornados: provedor `ollama`, nome de modelo selecionado, motivo `local_intent`, duração em milissegundos e contagem observada de tokens de entrada/saída/total. Ausência ou contador inválido vira `null`, não zero. No Telegram, uma linha curta informa quando o Ollama foi usado e qual modelo foi selecionado; duração e contagens permanecem nos metadados. Falhas de interpretação mostram o código e mantêm disponíveis os comandos explícitos. Metadados não contêm a pergunta nem a resposta bruta. O logger geral continua com sua lista permitida; não registra automaticamente esses objetos.

## Configuração

O bloco `ollama` é opcional e desabilitado por padrão. Não existe modelo padrão: configure o nome/tag exato de um modelo instalado e compatível. Para habilitar:

1. Configure o servidor confiável com `OLLAMA_NO_CLOUD=1` ou `disable_ollama_cloud:true`, reinicie e confira que os recursos cloud estão desativados.
2. Confira modelo local, capacidade de conclusão, suporte ao schema e recursos de hardware com entrada sintética.
3. Defina `ollama.model`, `enabled:true` e `localOnlyConfirmed:true`. Esta última opção registra confirmação operacional; não detecta nem altera a configuração do servidor.

São aceitos loopback, `localhost`, `host.docker.internal` e, somente com `allowPrivateAddress:true`, um IP literal RFC1918 ou IPv6 ULA. Não são aceitos domínio público, credenciais na URL, query, fragmento ou prefixo de caminho. O host privado deve ser administrado e protegido pelo operador; HTTP em LAN não cifra a pergunta. Em Docker, loopback é o próprio container; `host.docker.internal` depende da configuração da plataforma.

Antes de enviar texto, toda interpretação consulta `GET /api/tags` e `POST /api/show`. Exige um modelo único instalado com tamanho/digest e metadados GGUF locais, capacidade `completion`, contexto suficiente, e ausência de `remote_model`/`remote_host`. Nomes cloud são recusados. O chat também é conferido contra redirecionamento remoto e modelo diferente. As chamadas de descoberta transportam apenas o nome do modelo.

**Limite de confiança:** localhost sozinho não prova execução local. As verificações são defesa contra configuração equivocada; servidor malicioso, alias trocado entre descoberta e geração, proxy ou host comprometido continuam sendo fronteiras de confiança. A implantação deve desabilitar cloud no Ollama e restringir saída de rede conforme sua política. `localOnlyConfirmed` não é uma prova criptográfica de isolamento. Nenhum provedor externo/Gemini está implementado e `privacy.externalProviders` permanece `false`.

## Limites e falhas

| Opção | Padrão | Faixa |
| --- | --- | --- |
| `timeoutMs` | 30000 | 1000–120000 |
| `maxInputBytes` | 4096 | 64–4096 |
| `maxResponseBytes` | 131072 | 1024–1048576 |
| `contextTokens` | 8192 | 4096–32768 |
| `outputTokens` | 256 | 64–1024 |

Um único deadline cobre descoberta, geração e leitura de corpo. Não há repetição automática. O request usa `stream:false`, `format` com schema, `num_ctx`, `num_predict` e desativa thinking. O orçamento de entrada em bytes inclui instrução/schema e reserva de saída/margem; é um limite conservador da aplicação, não contagem exata do tokenizer. O contexto mínimo de 4096 comporta a instrução fixa, uma pergunta mínima e a maior reserva de saída permitida; configurações menores são recusadas na validação. Perguntas maiores ainda precisam caber no orçamento total, mesmo abaixo de `maxInputBytes`. O servidor/modelo deve suportar essas opções; incompatibilidade gera erro controlado.

Respostas HTTP e conteúdo JSON têm limite de bytes. Conclusão incompleta, schema inválido, ferramenta inesperada, erro remoto, timeout ou indisponibilidade produzem somente um código permitido (`OLLAMA_*`). O chamador mantém disponíveis comandos explícitos e pode pedir reformulação. Não repassa erro bruto nem inventa uma consulta quando a classificação falha.

## Evidências e validação

- [Ollama chat](https://docs.ollama.com/api/chat): `/api/chat`, `format`, `stream`, opções e contadores.
- [Inventário](https://docs.ollama.com/api/tags) e [detalhes](https://docs.ollama.com/api-reference/show-model-details): `/api/tags`, `/api/show`, capacidades e contexto.
- [Tipos oficiais](https://github.com/ollama/ollama/blob/main/api/types.go): campos `remote_model` e `remote_host` de inventário, detalhes e chat. Esse contrato deve ser conferido ao atualizar a versão do servidor.
- [FAQ Ollama](https://docs.ollama.com/faq): execução local e `OLLAMA_NO_CLOUD`.
- [Saídas estruturadas](https://docs.ollama.com/capabilities/structured-outputs): uso de JSON Schema; cloud não oferece o mesmo contrato.

Os testes usam HTTP simulado, incluindo modelos remotos, metadados ausentes, pergunta injetada, IDs/métodos forjados, datas inválidas, resposta enorme, deadline e canários. Não foi executado um modelo Ollama real neste ambiente; qualidade de classificação, latência, suporte ao schema e configuração local precisam da prova sintética no servidor escolhido antes do uso pessoal.
