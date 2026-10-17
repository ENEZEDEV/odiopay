# Preparação para operação real

Em 17/10/2026, o responsável confirmou que deseja cobranças reais com Mercado Pago e informou possuir credenciais de produção e conta habilitada. Essa disponibilidade foi informada, não verificada por uma chamada autenticada. Não há segredos neste documento.

## Implementação desta atualização

`src/mp-intents.js` introduz persistência de intenção de pagamento independente do simulador. SQLite schema 4. IDs aleatórios gerados pelo servidor, chave única por lojista/ambiente, hash normalizado do pedido, comissão original preservada em replays e reserva atômica de envio no banco. Não há deduplicação exclusivamente em memória.

Um envio interrompido fica em `requires_reconciliation`. Nunca volta automaticamente para `created`. Duas conexões ao mesmo banco não podem reservar a mesma intenção. Token de cartão e e-mail não são persistidos por este componente; somente o hash do pedido. A comissão deve ser fornecida por política comercial confiável do backend. Os preços do simulador ainda não constituem essa política.

Este é um componente interno, sem rota pública e sem chamadas financeiras. Ainda não é uma outbox completa: não há worker, envio integrado, conclusão autoritativa, pesquisa de pagamentos ou processamento de eventos neste módulo. O marcador `production` separa intenções no banco; não habilita o transporte do Mercado Pago. A aplicação existente continua no modo de teste.

## Evidência

`node scripts/check.js`: 110 testes aprovados, verificação de sintaxe e demonstração original aprovadas. Cinco testes novos exercitam conflito de payload durante envio, persistência de tarifa em replay, isolamento entre lojas/ambientes, reserva exclusiva entre conexões, recuperação de envio interrompido e ausência de dados de checkout persistidos. Nenhum pagamento real efetuado.

## Trabalho restante

1. Cadastro/login e sessões persistentes reais; recuperação de acesso e limitação de tentativas.
2. Hospedagem do backend com HTTPS, persistência de banco e backups; URL de retorno OAuth e webhook.
3. Configuração privada das credenciais; OAuth de produção com renovação, revogação e isolamento por ambiente.
4. Integração da intenção com envio e reconciliação; inbox de webhooks e tratamento de estorno parcial/total e contestação.
5. Checkout Pix e cartão com SDK do provedor; painel sem dados fictícios e sem promessa de carteira própria.
6. Validação ponta a ponta antes de habilitar cobranças; piloto real acompanhado pelo responsável.

O projeto ainda não está pronto para publicação financeira. Não remover os bloqueios existentes como substituto para essas implementações.
