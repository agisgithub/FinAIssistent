# Escopo e aceite

Projeto novo. Baseline: Node.js 24, ESM, `@actual-app/api` 26.9.0 e `better-sqlite3` 12.11.1. Um responsável, uma residência, um orçamento e BRL.

## Mapa de requisitos

| Requisito | Prova | Marco |
| --- | --- | --- |
| Configuração e identidade inequívocas | `config.test.mjs`: inválidos falham sem refletir dados | 1A |
| Segredos fora de configuração/logs | `config.test.mjs`, `telegram.test.mjs`: referências montadas e canários | 1A |
| Mensagem privada do responsável | `telegram.test.mjs`: usuário/grupo/bot/callback inválidos recusados | 1A |
| Deduplicação e recuperação duráveis | `storage.test.mjs`: replay, crash lógico, atomicidade da outbox e restauração | 1A |
| Exclusividade do cache Actual | `storage.test.mjs` e testes Actual: lock liberável, serialização e timeout | 1A |
| Leituras rastreáveis e completas | Testes Actual e Telegram: snapshot normalizado, sync falho e cobertura incompleta | 1A |
| Inicialização executável | `main.test.mjs`: polling, fila e entrega simulados com encerramento | 1A |
| Cálculos, períodos e intenções locais | Implementação e fixtures financeiras completas | 1B |
| Categorização confirmada e desfazer | Journal, precondições, patch de campo único e recuperação | 1C |
| Relatório diário e alertas | Agenda persistente, ocorrência única e mudanças de severidade | 1D |
| Recorrências confirmadas | Calendário, variações e pagamento vinculado | 2 |

Gemini é uma fase opcional separada. E-mail, cofre, portais e automação sem confirmação são posteriores. O executor inicial não aceita pagamentos, transferências, exportação pelo chat nem métodos arbitrários.

## Limites do marco 1A

`/gastos` informa apenas despesas brutas do mês corrente. A classificação e o abatimento de estornos pertencem ao marco financeiro seguinte. Os callbacks são autenticados e persistidos, mas ainda respondem como indisponíveis. Trabalhos de comando são leituras repetíveis neste marco; ao adicionar mutações, a aprovação/operação persistente deve controlar sua idempotência e reconciliação.

Os testes locais não substituem validação da imagem Linux/UID de produção, compatibilidade com o servidor Actual e demonstração controlada com o bot do responsável.
