# Plano de MVP — Plataforma de Avaliação Prática (Cloud/API Engineering)

> Documento gerado a partir de sessão de grilling sobre o plano de negócio original. Consolida todas as decisões de escopo, arquitetura e produto para o v1 (MVP).

## Visão de longo prazo (contexto)

Plataforma de avaliação prática de engenharia de software — não ensina via cursos, valida se o profissional constrói soluções de nível produção. Diferencial: enquanto LeetCode avalia algoritmos, esta plataforma avalia engenharia real (APIs, cloud, sistemas distribuídos). Visão completa envolve Cloud Challenges (AssumeRole em conta AWS real), Distributed Systems Challenges, Corporate Academy, Hiring Platform — mas o MVP corta drasticamente esse escopo (ver "Fora do escopo do v1").

## Equipe e contexto

- Dupla de desenvolvedores, dedicação e orçamento em aberto (sem número fechado).
- Prazo em aberto — sem meta de data definida. Escopo do v1 foi mantido "cheio" mesmo sabendo que isso estica o prazo.

## Escopo do v1 (MVP)

Só **API Challenges**: usuário hospeda sua própria API em algum lugar (Render, Fly, EC2, etc.) e submete apenas a **URL**. A plataforma nunca builda nem executa código do usuário — atua só como cliente HTTP externo batendo testes contra a URL fornecida.

### Fora do escopo do v1 (adiado)

- Cloud Challenges / AssumeRole / Discovery Engine multi-serviço AWS.
- Testes de segurança ofensiva (SQL Injection, XSS, mass assignment).
- Testes de performance/stress/load (latência, throughput, spike).
- Testes de resiliência (timeout, retry, circuit breaker, fallback, cache).
- Testes de concorrência (race conditions, deadlocks).
- Contribuição externa de challenges (curadoria de terceiros).
- Anti-fraude para multi-contas burlando o plano grátis.
- Azure, Google Cloud, Kubernetes, Distributed Systems Challenges, Corporate Academy, Hiring Platform, White Label.

## Submissão

- Usuário fornece apenas a **URL** da API (sem envio de código/repositório no v1).
- Checkbox obrigatório no momento da submissão: usuário confirma que possui ou tem autorização para testar a URL informada.

## Segurança (obrigatória, pré-requisito do v1)

A plataforma faz requests HTTP automatizados contra URL arbitrária fornecida por terceiros — isso é superfície de SSRF por padrão. Mitigações obrigatórias:

- **SSRF-guard**: resolver DNS da URL e bloquear ranges privados/loopback/link-local (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, incluindo o endpoint de metadata de cloud). Revalidar a cada redirect HTTP, não só na URL original.
- **Isolamento do worker**: execução do validation engine roda em ambiente com rede restrita, sem acesso a infraestrutura interna da plataforma.
- **Timeout agressivo** por request e por challenge completo.
- **Rate limit** por request e por challenge, evitando uso da plataforma como proxy de flood contra terceiros.

## Motor de desafios (Rule Engine)

- Desafios descritos em **YAML declarativo** desde o v1 (não hardcoded em código).
- Gramática do v1 cobre 4 categorias:
  1. CRUD
  2. Contrato (OpenAPI / JSON Schema)
  3. Status code / headers
  4. Autenticação básica (JWT válido, expirado, claims)
- Categorias mais pesadas (segurança ofensiva, performance, resiliência, concorrência) exigem subsistemas próprios (gerador de carga, injetor de falha) e ficam para v2 do motor.
- **5 a 8 challenges** escritos pela própria dupla para o lançamento, cobrindo as 4 categorias. Sem curadoria de conteúdo externo no v1.

## Arquitetura técnica

- **Node.js**: backend/API principal — autenticação, banco de dados, orquestração, catálogo de challenges, endpoint de webhook.
- **Java**: validation engine — executa a interpretação do YAML contra a URL do usuário.
- **Integração Node ↔ Java**: assíncrona via webhook, sem fila/broker (Redis/RabbitMQ/SQS) no v1.
  - Node chama Java, que responde "aceito" de imediato e processa em background.
  - Ao terminar, Java chama de volta um endpoint (webhook) no Node com o resultado.
  - Frontend faz polling no Node para status/resultado.
  - Motivo: evita conexão HTTP longa presa (opção síncrona) sem exigir operar mais uma peça de infraestrutura (fila de verdade), adequado ao volume esperado do v1.
- **Banco de dados**: Postgres (presumido), de propriedade exclusiva do Node.
  - Java tem **credencial de banco restrita**: write-only na tabela de resultados, sem acesso a tabelas de usuários, credenciais ou billing. Reduz o blast radius do componente que lida com input não confiável (URL de terceiro).
- **Hosting**: PaaS gerenciado (Railway, Render ou Fly.io) — Node, Java e Postgres gerenciado. Sem VPS/AWS próprio no v1; menor custo operacional para dupla sem tempo de DevOps dedicado.
- **Frontend**: Next.js (React) — login, catálogo de challenges, submissão de URL, resultado/score, feedback IA, perfil.

## Autenticação

- Login **só via GitHub OAuth** no v1. Sem fluxo de email/senha (evita construir reset de senha, verificação de email, hashing).

## AI Feedback Engine

- Incluído no v1: uma chamada de LLM (Claude/OpenAI) por submissão, com prompt único gerando feedback textual a partir do resultado estruturado dos testes. Sem fine-tuning, sem agente complexo.
- Feedback é **gerado em toda tentativa** (dado sempre existe e é armazenado).
- Exibição por plano:
  - **Free**: só visualiza o feedback da tentativa mais recente; tentativas anteriores ficam trancadas (gancho de upsell).
  - **Pago**: histórico completo de feedback de todas as tentativas.

## Ranking / Perfil público

- Incluído no v1 (mantido no escopo apesar da recomendação inicial de adiar por falta de massa crítica de usuários).

## Monetização

- Modelo **freemium**:
  - Conta grátis: 2 challenges desbloqueados à escolha do usuário, com **10 tentativas** cada.
  - Assinatura paga: catálogo completo + tentativas ilimitadas.
- **Preço configurável via painel admin** (não hardcoded no código).
- Gateway de pagamento: **Stripe** para o v1, mas implementado atrás de uma interface `PaymentProvider` (princípio de inversão de dependência), expondo operações como:
  - `createCheckoutSession`
  - `handleWebhookEvent`
  - `cancelSubscription`
  - `getSubscriptionStatus`
  - Objetivo: trocar de provedor de pagamento no futuro sem reescrever a regra de negócio.
- Mudança de preço no admin **só afeta assinantes novos**; assinante já ativo mantém o preço vigente no momento da assinatura (Stripe Price é imutável — mudar preço cria novo Price object).

## Painel Admin

- Novo módulo do v1, com duas telas:
  1. Configuração de preço da assinatura.
  2. Cadastro/edição de Termos de Uso (ToS).
- Acesso: **allowlist fixa** (as 2 contas GitHub da dupla marcadas com flag `is_admin`), sem sistema de RBAC/papéis — desnecessário para 2 administradores fixos.

## Termos de Uso (ToS)

- Conteúdo editável via painel admin.
- **Aceite rastreado** no cadastro: checkbox de aceite + versão do ToS + timestamp gravados no banco. Mudança futura no texto não força re-aceite retroativo de usuários já cadastrados.

## Itens em aberto / riscos conhecidos (não bloqueiam o v1)

- Preço exato da assinatura ainda não definido (fica configurável, mas valor inicial não decidido).
- Prazo/timeline real do projeto: em aberto, sem meta de data.
- Multi-conta para burlar o limite do plano grátis: identificado como risco de baixo custo, ignorado deliberadamente no v1.
- ToS jurídico completo: o checkbox de aceite é o mínimo viável, não substitui revisão jurídica formal do texto.
