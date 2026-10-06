# Dashboard vivo de economia

## Acesso

Abra a conversa privada com o bot e diga **dashboard** (também aceita “abrir painel”). O bot devolve o link de `/dashboard`, no mesmo servidor HTTPS do cadastro. Ele fica vinculado ao usuário do Telegram e à base selecionada naquele momento. Não compartilhe esse link.

O link é de uso único e vence em 10 minutos. Depois de aberto, um cookie HttpOnly, Secure e SameSite=Strict mantém o acesso por 12 horas. Um novo login na mesma base encerra o login anterior. Sair revoga o cookie no servidor. Trocar a base no Telegram não muda um painel já aberto: peça outro link para a nova base. O cabeçalho identifica o ambiente.

O piloto utiliza IP da rede local e certificado local. Acesso fora dessa rede depende da VPN existente; o dashboard não abre portas no roteador nem publica os dados na internet. Não envie senhas ou chaves no chat.

## Leitura financeira

O objetivo é entender gastos pessoais e oportunidades de economia, não reproduzir saldos acumulados de envelopes do Actual.

- **Entradas de renda:** categorias de receita, descontadas reversões.
- **Gasto pessoal líquido:** despesas menos créditos classificados como estorno/reembolso nas categorias de despesa. Saídas sem categoria também contam; entradas sem categoria não viram renda automaticamente.
- **Renda menos gastos:** resultado dos dois indicadores anteriores. Não é saldo bancário e não representa necessariamente desembolso de caixa no período.
- **Variação:** diferença de gastos líquidos frente ao período anterior. Mês atual usa dias transcorridos, limitado ao último dia do mês anterior; meses históricos comparam meses completos. “Últimos 30 dias” compara com os 30 dias anteriores.

Transferências vinculadas, saldos iniciais e pais de divisões são excluídos. Filhos de divisões contam uma vez. Contas fora do orçamento e encerradas seguem a preferência `finance_scope` já existente, exibida no painel. Despesas ocultas continuam incluídas. Compras no cartão contam na data registrada, não no pagamento da fatura.

Categorias técnicas obedecem à preferência `financial_report_policy` específica da base. Na HML2, foram configurados créditos de fatura/financiamento, movimentações a conciliar e principal de empréstimos recebidos/pagos. Juros/tarifas continuam despesa. A categoria especial **Consumo** permanece independente; o dashboard não reclassifica nada.

Categorias não identificadas, política ausente e volumes técnicos aparecem em “Números com contexto”. Um zero pode significar falta de registros; o painel não comprova a completude da importação bancária. Toda a série e os indicadores dependem da qualidade da classificação existente.

## Como explorar

1. Escolha um mês ou os últimos 30 dias.
2. Consulte os maiores pesos e aumentos. São sugestões de investigação, não indicação automática de cortar saúde, família ou qualquer outra categoria.
3. Clique numa categoria/grupo para abrir os lançamentos. Busque por favorecido, nota, categoria ou conta; nomes são exibidos sem IDs técnicos.
4. Consulte a frequência de pagamentos e saídas de até R$ 50; estas somas são brutas, antes de reembolsos, conforme indicado.
5. Use o simulador de redução de 0% a 50% de **uma categoria por vez**. Ele calcula economia hipotética sobre o gasto líquido positivo observado e o efeito no resultado do período. Não faz projeção anual, não presume recorrência, não escreve metas nem altera orçamento.

## Atualização e falhas

Com a aba visível, consulta automática após cada ciclo de 20 segundos. Dados do mesmo usuário/base/período podem ser reutilizados por até 15 segundos; chamadas simultâneas compartilham a leitura. A fila do cliente Actual é a mesma usada pelo bot. Trocar período ou pressionar Atualizar consulta a API; a pequena janela de cache ainda se aplica.

O horário apresentado é o término da leitura bem-sucedida. Se houver erro, a página conserva os números anteriores **com aviso explícito**. Não zera os valores nem apresenta a falha como ausência de gastos. Quando a aba fica oculta, suspende as consultas; ao voltar, atualiza.

“Vivo” significa refletir mudanças já sincronizadas no servidor Actual após o próximo ciclo concluído. Não é push instantâneo nem sincronização bancária em tempo real. Pluggy e o banco mantêm seus próprios horários. Não há novo cron nem outro conciliador para o dashboard.

## Implementação e reprodução

`src/dashboard/data.mjs` reutiliza `periodReportSnapshot` de `src/skills/period-report.mjs` — mesma semântica do relatório do bot. Uma leitura cobre período, comparação e seis meses de trajetória. A API é somente leitura. Os gráficos são SVG local, sem CDN e sem envio dos dados a um provedor de IA.

`src/dashboard/access.mjs` guarda apenas hashes dos tokens em duas tabelas do registro existente (`dashboard_links`, `dashboard_sessions`). Nenhuma credencial do Actual é devolvida ao navegador. Cada requisição confere usuário, base e orçamento no runtime ativo. O endpoint não aceita um orçamento escolhido pelo navegador.

O frontend está em `web/dashboard.html`, `web/dashboard.css`, `web/dashboard.js`. A integração reutiliza `src/onboarding/http.mjs`, `main.mjs` e `gateway.mjs`. Não há nova dependência npm. Cada usuário do cadastro pode pedir seu link; políticas técnicas de uma base não são copiadas automaticamente para outra.

### Verificações

`test/dashboard.test.mjs`: intervalos, soma dos componentes, divisões, transferências, Consumo, reembolsos, empréstimos, acesso entre usuários, expiração/uso único, origem HTTP, saída, falha do Actual, cache e mudança refletida após expirar o cache. A suíte existente também deve passar.

`scripts/dashboard-preview.mjs` é apenas QA com dados fictícios, fora da imagem de execução; não deixar o container de preview ligado depois dos testes. `scripts/dashboard-operator.mjs check BASE` testa o servidor HTTPS com o certificado local, usando a HML2 e sem alteração financeira; os períodos desse smoke são exemplos fixos de junho/setembro de 2026. `notify BASE` envia ao proprietário um novo link privado, sem imprimir tokens em logs.

### Implantação e rollback da aplicação

Construir a imagem e iniciar com o procedimento existente de `scripts/enable-onboarding.sh`, preservando `config.json`, segredos e volumes. Para voltar, execute o mesmo procedimento com a imagem anterior. As duas tabelas aditivas podem permanecer: a versão anterior as ignora. Este deploy não altera lançamentos, regras ou categorias e não exige rollback financeiro.

## Evolução / decisões futuras

Registrar novas definições com data, necessidade, regra de cálculo, escopo por base e teste correspondente. Não transformar hipóteses em regras globais. Pontos possíveis: orçamento-alvo por categoria, revisão assistida de recorrências, escolha explícita de contas encerradas, domínio/certificado público e acesso remoto apropriado. Essas extensões **não estão implementadas nesta versão**.
