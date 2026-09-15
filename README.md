# FinAIssistent

Assistente financeiro pessoal pelo Telegram, com Actual Budget como fonte dos dados.

## Marco atual

Fases 0, 1A e 1B: um responsável, uma residência, um orçamento e consultas financeiras com valores calculados em centavos. A fila de entrada, a saída de mensagens e snapshots ficam no SQLite. O SDK Actual funciona em um worker exclusivo. Comandos e perguntas simples funcionam por regras locais; Ollama opcional interpreta outras perguntas de leitura.

As fases seguintes do MVP acrescentam categorização confirmada, desfazer, relatórios agendados, alertas e recorrências. E-mail, cofre, portais e Gemini são posteriores.

## Executar

Requer Node.js 24. Instale as versões do lockfile:

```sh
npm ci
npm test
```

Copie `config.example.json` para `config.json`. Substitua os IDs do responsável/chat e o Sync ID do orçamento Actual. Crie os arquivos de segredo `telegram-token` e `actual-password` na pasta `secrets`, acessíveis somente ao usuário que executa o processo. Se o orçamento usar criptografia, configure `encryptionPasswordRef` com outro arquivo. Não coloque o conteúdo desses arquivos no JSON.

```sh
npm start
```

Para Docker, ajuste `dataDir` para `/data`, `secretDir` para `/run/secrets` e `actual.serverURL` para um endereço alcançável pelo container. A imagem usa UID/GID 1000; os segredos montados precisam permitir leitura a esse usuário.

```sh
docker compose up --build -d
docker compose -f compose.test.yaml run --build --rm tests
```

Antes de conectar dados reais, siga o [runbook](docs/runbook.md). O exemplo rejeita o Sync ID de substituição; é necessário configurar o orçamento intencionalmente.

## Comandos

| Comando | Resultado neste marco |
| --- | --- |
| `/status` | Estado local, última leitura e contagem de entregas/operações incertas |
| `/contas` | Saldos até o fim do período, com rótulos de conta fora do orçamento, encerrada e incluída/excluída |
| `/resumo` ou `/gastos mes` | Despesas brutas, estornos identificados, líquido, receitas, reversões e entradas ambíguas |
| `/gastos hoje` | Movimento de hoje até a leitura; o dia está em andamento |
| `/orcamento` | Envelope mensal do Actual, saldo, disponibilidade calculada e limites zero/ausentes |
| `/sem_categoria` | Lançamentos sem categoria e IDs; transferências e pais de splits excluídos |
| `/ralos` | Categorias ordenadas por despesa líquida; pistas para revisão humana |
| `/escopo padrao\|encerradas\|fora_orcamento\|todas` | Preferência persistente de contas incluídas nas consultas |

O período padrão começa no primeiro dia do mês e termina hoje. Também são aceitos `2026-08-01 2026-08-31`, `mes passado` e `ultimos 6 meses` (seis meses de calendário incluindo o atual). Listas têm dez itens por página e fornecem o próximo comando, por exemplo `/sem_categoria 2026-08-01 2026-08-31 pagina 2`. A paginação não limita o conjunto usado nas somas.

Um snapshot incompleto não produz totais. Se o Actual ficar indisponível, somente um snapshot com período, identidade e escopo iguais pode fornecer valores, destacados como **desatualizados**; caso contrário, a resposta mostra a indisponibilidade sem total. Uma consulta nova sempre tenta ler novamente o Actual, refletindo alterações retroativas.

Ollama fica desligado no exemplo. Consulte a [configuração local e privacidade](docs/routing.md) antes de habilitar um modelo. A IA recebe apenas a pergunta e a data de referência; valores, IDs e cálculos vêm do código e do Actual. Nenhum comando deste marco altera o orçamento.

## Exemplo fictício verificável

O fixture em `test/fixtures/financial.mjs` contém compra de cartão, pagamento entre contas, split, estorno, reversão de receita e contas excluídas. Nos testes, `/resumo 2026-09-01 2026-09-15` produz:

```text
Despesas brutas: R$ 340,00.
Estornos identificados: R$ 20,00.
Despesas líquidas: R$ 320,00.
Receitas categorizadas: R$ 1.000,00; reversões: R$ 10,00; líquidas: R$ 990,00.
Entradas sem classificação suficiente: R$ 50,00.
Movimento líquido elegível: R$ 720,00.
```

`Quanto gastei hoje?` e `resumo nos últimos seis meses` dispensam o modelo. `/orcamento` preserva o carryover booleano informado pelo Actual e identifica separadamente as diferenças calculadas a partir de saldo/alocação. Os exemplos rodam sem credenciais reais:

```sh
node --test --test-isolation=none test/finance.test.mjs test/periods.test.mjs test/queries.test.mjs
```

## Documentação

- [Escopo e critérios de aceite](docs/scope.md)
- [Arquitetura e contratos](docs/architecture.md)
- [Autorização e privacidade](docs/authorization.md)
- [Operação e recuperação](docs/runbook.md)
- [Regras financeiras e consultas](docs/finance.md)
- [Interpretação local e privacidade](docs/routing.md)

Os testes usam dados sintéticos e adaptadores simulados, além do teste isolado do SDK fixado. Não comprovam conexão ao orçamento, bot ou servidor de produção.
