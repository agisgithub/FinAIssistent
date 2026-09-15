# FinAIssistent

Assistente financeiro pessoal pelo Telegram, com Actual Budget como fonte dos dados.

## Marco atual

Fundação das fases 0 e 1A: um responsável, uma residência, um orçamento e leituras por `/status`, `/contas` e `/gastos`. O estado da aplicação, a fila de entrada e a saída de mensagens ficam no SQLite. O SDK Actual funciona em um worker exclusivo. Consultas não dependem de IA.

As fases seguintes do MVP acrescentam cálculos completos, perguntas locais, categorização confirmada, desfazer, relatórios, alertas e recorrências. E-mail, cofre, portais e Gemini não fazem parte deste marco.

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
| `/contas` | Contas do Actual com saldos atuais, incluindo rótulos fora do orçamento/encerrada |
| `/gastos` | Despesas brutas do mês até hoje nas contas abertas dentro do orçamento; exclui transferências/pais de splits; ainda não abate estornos |

Um snapshot incompleto não produz totais. Mensagens longas são divididas em partes persistentes. Nenhum comando deste marco altera o orçamento.

## Documentação

- [Escopo e critérios de aceite](docs/scope.md)
- [Arquitetura e contratos](docs/architecture.md)
- [Autorização e privacidade](docs/authorization.md)
- [Operação e recuperação](docs/runbook.md)

Os testes usam dados sintéticos e adaptadores simulados, além do teste isolado do SDK fixado. Não comprovam conexão ao orçamento, bot ou servidor de produção.
