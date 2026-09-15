# FinAIssistent

Assistente financeiro pessoal pelo Telegram, com Actual Budget como fonte dos dados.

## Marco atual

O MVP reúne as fases 0 a 1D e 2: um responsável, uma residência, um orçamento, consultas financeiras em centavos, categorização confirmada, relatórios/alertas opcionais e calendário mensal de contas por unidade. A fila, as mensagens, as propostas, as operações e o calendário ficam no SQLite. O SDK Actual funciona em um worker exclusivo. Comandos, relatórios e alertas usam regras locais; Ollama opcional interpreta outras perguntas de leitura.

Unidades, recorrências e registros manuais de pagamento exigem confirmação no Telegram. Lembretes de datas cadastradas e consultas ao calendário funcionam mesmo sem Actual ou modelo disponíveis. E-mail, cofre, portais e Gemini ficam fora deste MVP; não há execução de pagamento bancário. [Escopo e provas](docs/scope.md).

O carregamento do SDK inclui uma [proteção verificada para a versão fixada](docs/actual-contract.md#proteção-contra-execução-automática-de-agendas): consultas não acionam o serviço automático de agendas do Actual. Uma versão ou arquivo diferente bloqueia o adaptador até nova revisão; não atualize o SDK isoladamente.

## Instalar no Docker

No terminal Bash do servidor onde o projeto já está instalado, execute:

```bash
cd ~/FinAIssistent && git pull --ff-only origin main && bash scripts/setup-docker.sh
```

O [assistente de configuração](docs/docker-install.md#configuração-guiada) pergunta os dados necessários. Docker Engine e Compose precisam estar instalados; Actual e Ollama continuam nos serviços que você já utiliza. Não é necessária chave Gemini/OpenAI para este MVP. O [guia](docs/docker-install.md) também contém configuração manual, diagnóstico e testes pelo Telegram.

Se o build terminou, mas apareceu `startup_failed` com `CONFIG_INVALID`, comece pela [configuração e diagnóstico](docs/docker-install.md#o-que-significa-o-erro-apresentado). Um build bem-sucedido não comprova que `config.json` e os segredos estejam preenchidos.

## Executar com Node.js

Requer Node.js 24. Instale as versões do lockfile:

```sh
npm ci
npm test
```

Copie `config.example.json` para `config.json`. Substitua os IDs do responsável/chat e o Sync ID do orçamento Actual. Crie os arquivos de segredo `telegram-token` e `actual-password` na pasta `secrets`, acessíveis somente ao usuário que executa o processo. Crie também `data/actual`, gravável por esse usuário. Se o orçamento usar criptografia, configure `encryptionPasswordRef` com outro arquivo. Não coloque o conteúdo desses arquivos no JSON.

```sh
npm run preflight
npm start
```

Inicie somente se o pré-teste passar. Ele verifica configuração, segredos e acesso local aos diretórios, sem conectar aos serviços. O exemplo rejeita o Sync ID de substituição; é necessário configurar o orçamento intencionalmente. Para recuperação e uso real, siga o [runbook](docs/runbook.md).

## Comandos

| Comando | Resultado neste marco |
| --- | --- |
| `/status` | Estado local, última leitura e contagem de entregas/operações incertas |
| `/relatorio` | Relatório imediato com saldos, dia/mês, orçamento, incomuns e ações; não ativa a agenda |
| `/preferencias` | Consulta e configura diário, alertas, fuso da agenda, dias, hora, detalhe e limites |
| `/contas` | Saldos até o fim do período, com rótulos de conta fora do orçamento, encerrada e incluída/excluída |
| `/resumo` ou `/gastos mes` | Despesas brutas, estornos identificados, líquido, receitas, reversões e entradas ambíguas |
| `/gastos hoje` | Movimento de hoje até a leitura; o dia está em andamento |
| `/orcamento` | Envelope mensal do Actual, saldo, disponibilidade calculada e limites zero/ausentes |
| `/sem_categoria` | Lançamentos sem categoria e IDs; transferências e pais de splits excluídos |
| `/ralos` | Categorias ordenadas por despesa líquida; pistas para revisão humana |
| `/escopo padrao\|encerradas\|fora_orcamento\|todas` | Preferência persistente de contas incluídas nas consultas |
| `/comparar` | Compara categorias entre os dois últimos meses completos; base zero é identificada |
| `/categorias [pagina 2]` | Catálogo visível com grupos e IDs para escolher uma categoria |
| `/sugerir <transactionId>` | Até três sugestões locais com fonte e escore de evidência |
| `/categorizar <transactionId> <categoryId>` | Prepara uma proposta; nenhum dado é alterado nesta etapa |
| `/confirmar <código>` ou botão | Consome a proposta uma vez e executa a simulação ou a alteração autorizada |
| `/cancelar <código>` ou botão | Cancela a proposta |
| `/operacoes [operationId]` | Lista operações ou consulta novamente o resultado de uma operação |
| `/reconciliar <operationId>` | Lê o estado atual sem repetir a alteração |
| `/desfazer <operationId>` | Prepara uma nova proposta de restauração da categoria anterior |
| `/unidades` e `/unidade cadastrar nome="Apartamento"` | Lista unidades ou prepara uma unidade local |
| `/recorrencias` | Cadastros mensais vigentes e versões futuras; `/recorrencias ajuda` mostra os campos |
| `/recorrencias pendencias` ou `candidatos` | Relê o histórico e mostra atribuições de unidade pendentes ou hipóteses sem ativação automática |
| `/recorrencias favorecidos` ou `agendamentos` | IDs do catálogo Actual e agendas observadas como fonte |
| `/recorrencias atualizar` | Relê e confronta lançamentos com ocorrências, sem marcar pagamento |
| `/recorrencia cadastrar`, `editar`, `atribuir`, `rejeitar` ou `pausar` | Prepara alteração local; veja a [gramática completa](docs/recurrences.md) |
| `/recorrencia confirmar <código>` ou botão | Confirma uma proposta local, inclusive com `dryRun:true` |
| `/recorrencia cancelar_proposta <código>` | Cancela uma proposta local pendente |
| `/proximos_vencimentos [YYYY-MM]` e `/ocorrencia <id>` | Calendário e detalhes locais; não dependem de nova leitura Actual |
| `/pago <id> [data=YYYY-MM-DD]`, `/reabrir <id>`, `/cancelar_ocorrencia <id>` | Prepara mudança de estado local, sem movimentar dinheiro |

O período padrão começa no primeiro dia do mês e termina hoje. Também são aceitos `2026-08-01 2026-08-31`, `mes passado` e `ultimos 6 meses` (seis meses de calendário incluindo o atual). Listas de consultas financeiras têm dez itens por página e fornecem o próximo comando, por exemplo `/sem_categoria 2026-08-01 2026-08-31 pagina 2`. Listas de recorrências têm cinco registros por página. A paginação não limita o conjunto usado nas somas.

Um snapshot incompleto não produz totais. Se o Actual ficar indisponível, somente um snapshot com período, identidade e escopo iguais pode fornecer valores, destacados como **desatualizados**; caso contrário, a resposta mostra a indisponibilidade sem total. Uma consulta nova sempre tenta ler novamente o Actual, refletindo alterações retroativas.

`/gastos com Mercado | ultimos 6 meses` filtra a categoria pelo nome do catálogo. Se houver categorias homônimas, a resposta pede uma escolha por grupo; não soma destinos ambíguos. Perguntas sobre uma nova parcela ou um plano de economia pedem os dados necessários e não aprovam crédito ou decisões de gasto.

Ollama fica desligado no exemplo. Consulte a [configuração local e privacidade](docs/routing.md) antes de habilitar um modelo. A IA recebe apenas a pergunta e a data de referência; valores, IDs e cálculos vêm do código e do Actual. O modelo não participa da confirmação nem recebe snapshots para categorizar.

## Categorização e recuperação

`dryRun` é `true` por padrão. Nesse modo, confirmar **categorização** registra uma simulação, sem alterar o Actual nem alimentar exemplos confirmados. Confirmações de unidades, recorrências e ocorrências persistem no SQLite mesmo nesse modo; a proposta explica o efeito local. Para escrita real de categoria, configure `dryRun: false` e `backup.keyRef` com o nome de um arquivo secreto contendo uma chave aleatória de 32 bytes em hexadecimal (64 dígitos). O valor da chave não pertence ao JSON. Consulte [backups cifrados](docs/backups.md) para proteção, retenção e recuperação local.

Uma proposta mostra data, valor, conta, favorecido, grupos, IDs e a categoria anterior/nova. Ela dura 15 minutos, pertence ao responsável/chat/orçamento configurados e autoriza somente o campo categoria daquele lançamento. Pais e filhos de splits, transferências, saldo inicial, contas encerradas e contas fora do orçamento são bloqueados para escrita. Mudanças no lançamento, no destino ou na política invalidam a confirmação.

Antes do patch, a aplicação persiste a aprovação e o registro da operação, bloqueia repetição do job e cria backups cifrados do SQLite e do orçamento Actual. Um resultado `applied` exige releitura e sincronização explícita. Se houver timeout, reinício ou resultado não comprovado, a operação fica `uncertain` e o patch não é repetido.

`/reconciliar` distingue `observed_before` e `observed_after`: são estados observados agora, sem prova de quem executou a alteração. `observed_after` permite preparar uma nova proposta `/desfazer`, inclusive para restaurar categoria nula. Uma aplicação já verificada conserva seu resultado histórico mesmo que uma leitura posterior encontre edição externa. Desfazer exige o fingerprint posterior ainda igual e a operação mais recente do alvo; não restaura outros campos. O SDK não fornece compare-and-swap entre clientes: edições externas concorrentes, inclusive ciclos A→B→A, continuam um limite. Veja [autorização](docs/authorization.md) e [contrato Actual](docs/actual-contract.md).

As sugestões seguem regras explícitas locais, exemplos confirmados ativos e histórico de até 12 meses, nessa ordem. Não há aplicação automática nem criação de regras no Actual. O escore mede evidência, não probabilidade. Confiança alta exige regra sem conflito ou ao menos cinco exemplos únicos em acordo sem conflito; 5/5 pode ser alta, 9/10 fica conservadoramente média. O modelo local não sugere categorias nesta fase. Exemplo de regra configurada, com IDs reais escolhidos pelo operador:

```json
"categorization": {
  "rules": [{ "id": "mercado", "payeeId": "ID_FAVORECIDO", "accountId": "ID_CONTA", "categoryId": "ID_CATEGORIA" }]
}
```

`accountId` é opcional; o favorecido é comparado por ID exato. Regras conflitantes têm confiança baixa. Destinos ausentes/ocultos não são oferecidos. Uma nova tentativa real desativa o exemplo anterior do alvo até uma aplicação comprovada; simulações e reconciliações não criam exemplos.

## Relatórios e alertas opcionais

Diário e alertas começam **desligados**, inclusive após instalar a atualização. Configure pelo chat privado autorizado e ative cada rotina explicitamente:

```text
/preferencias fuso America/Sao_Paulo
/preferencias dias seg,ter,qua,qui,sex
/preferencias horario 08:00
/preferencias detalhe resumido
/preferencias relatorio ativar
/preferencias saldo ID_CONTA 10000
/preferencias alertas ativar
```

O exemplo de saldo configura R$ 100,00 para um ID real copiado de `/contas`; o catálogo é conferido antes de salvar. Sem essa escolha, saldo baixo fica desligado. `/preferencias relatorio desativar` e `/preferencias alertas desativar` cancelam trabalhos e mensagens ainda pendentes da rotina. Uma mensagem já enviada ou com entrega incerta não pode ser retirada por essa configuração.

O diário usa os dias/horário/fuso escolhidos. Alertas verificam condições a cada 15 minutos, todos os dias, e avisam entrada ou aumento de severidade; a margem de saída evita repetição perto do limite. A data financeira vem do instante agendado no fuso do orçamento. No reinício, cada rotina considera apenas sua última ocorrência perdida, sem enviar as anteriores nem datas anteriores à ativação. Alterar detalhe ou limites não repete um diário já reservado.

Os relatórios tentam reler 12 meses do Actual. As mensagens organizam valores, datas, atualização e escopo em seções curtas; identificadores de leitura e métricas técnicas permanecem nos metadados internos. A falta de leitura completa não atualiza nem resolve alertas financeiros. Um relatório diário/manual pode mostrar cache estritamente compatível, marcado como desatualizado. A seção de vencimentos recebe o calendário local; `/proximos_vencimentos` continua disponível quando faltam dados para um relatório financeiro. `dryRun` protege alterações no Actual e permite relatórios e alertas explicitamente ativados. Veja [agenda e recuperação](docs/scheduling.md) e [regras dos relatórios](docs/reporting.md).

## Recorrências por unidade

Crie e confirme uma unidade, copie seus IDs e os de conta/favorecido dos catálogos, e prepare um cadastro. Este exemplo é fictício e precisa dos IDs exibidos pelo bot:

```text
/unidade cadastrar nome="Apartamento"
/unidades
/contas
/recorrencias favorecidos
/recorrencia cadastrar nome="Energia" unidade=ID_UNIDADE favorecido=ID_FAVORECIDO conta=ID_CONTA inicio=2026-09 dia=10 mes_offset=1 tipo_data=confirmado valor_centavos=10000 lembretes=sim
```

Confirme cada proposta antes de seguir. Nesse exemplo, a competência setembro vence em 10 de outubro, com referência de R$ 100,00. Mês curto usa o último dia e preserva o dia escolhido para o seguinte. Se o vencimento for desconhecido, escolha `tipo_data=estimado`; se faltar valor, use `valor_centavos=desconhecido`. A estimativa fica identificada.

Lembretes e variação começam desligados por cadastro; `lembretes=sim` ativa avisos de 7/3/1 dias, às 08:00 no fuso financeiro, somente após a confirmação. Essas políticas são separadas de `/preferencias` dos relatórios. O calendário local mantém os avisos quando o Actual está indisponível; nova evidência de lançamento e alertas de variação dependem de leitura completa. Variação exige **mais de 20% e mais de R$ 20,00**, com limites configuráveis e controle de repetição.

Três meses consecutivos de histórico com unidade/IDs resolvidos podem gerar um candidato inativo. Uma agenda Actual também pode servir de fonte observada; o cadastro local é mensal e não copia silenciosamente regras semanais, anuais, fim após N ocorrências ou ajustes de fim de semana. Um lançamento compatível nunca marca uma conta paga. `/pago`, `/reabrir` e cancelamento são novas propostas locais; documento permanece não verificado. Veja [cadastro, estados, edição e recuperação](docs/recurrences.md).

## Exemplo fictício verificável

O fixture em `test/fixtures/financial.mjs` contém compra de cartão, pagamento entre contas, split, estorno, reversão de receita e contas excluídas. Com esses dados fictícios, `/resumo 2026-09-01 2026-09-15` começa assim:

```text
RESUMO FINANCEIRO
01/09/2026 a 15/09/2026

Despesas líquidas: R$ 320,00.
Receitas líquidas: R$ 990,00.
Movimento líquido elegível: R$ 720,00.

Detalhes do período
Despesas brutas: R$ 340,00.
Estornos identificados: R$ 20,00 (entradas em categorias de despesa).
Receitas categorizadas: R$ 1.000,00; reversões: R$ 10,00.
Entradas sem classificação suficiente: R$ 50,00.
```

`Quanto gastei hoje?` e `resumo nos últimos seis meses` dispensam o modelo. `/orcamento` preserva o carryover booleano informado pelo Actual e identifica separadamente as diferenças calculadas a partir de saldo/alocação. Os exemplos rodam sem credenciais reais:

```sh
node --test --test-isolation=none test/finance.test.mjs test/periods.test.mjs test/queries.test.mjs
```

## Documentação

- [Instalação Docker, credenciais e testes reais](docs/docker-install.md)
- [Escopo e critérios de aceite](docs/scope.md)
- [Arquitetura e contratos](docs/architecture.md)
- [Autorização e privacidade](docs/authorization.md)
- [Operação e recuperação](docs/runbook.md)
- [Regras financeiras e consultas](docs/finance.md)
- [Interpretação local e privacidade](docs/routing.md)
- [Contrato Actual e limitações de escrita](docs/actual-contract.md)
- [Backups cifrados](docs/backups.md)
- [Agenda, preferências e recuperação dos alertas](docs/scheduling.md)
- [Regras de relatórios e anomalias](docs/reporting.md)
- [Recorrências, unidades e calendário local](docs/recurrences.md)
- [Regras de histórico, calendário e compatibilidade](docs/recurrence-domain.md)

Os testes usam dados sintéticos e adaptadores simulados, além do teste isolado do SDK fixado. Não comprovam conexão ao orçamento, bot ou servidor de produção.
